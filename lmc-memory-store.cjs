const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { ROOT } = require("./cloud-memory-client.cjs");
const { publicProviderStatus } = require("./lmc-provider-config.cjs");

// LMC-5 core copy, adapted to this bridge's file-based storage.
// Source architecture: https://github.com/wuxuyun0606-collab/lmc-5
// MIT licensed. This module keeps the same lifecycle concepts:
// raw_events -> event_chunks -> curated_memories -> relations -> recall/patrol.
const LMC_ROOT = path.join(ROOT, "memory-docs", "lmc");
const LMC_DIRS = {
  raw_event: path.join(LMC_ROOT, "raw-events"),
  event_chunk: path.join(LMC_ROOT, "event-chunks"),
  curated_memory: path.join(LMC_ROOT, "curated-memories"),
  relation: path.join(LMC_ROOT, "relations"),
  patrol_suggestion: path.join(LMC_ROOT, "patrol-suggestions")
};

const LMC_STATE_PATH = path.join(LMC_ROOT, "state.json");
const RAW_CHUNK_GAP_MS = Math.max(
  5 * 60 * 1000,
  Number.parseInt(process.env.LMC_RAW_CHUNK_GAP_MS || "1800000", 10) ||
    1800000
);
const RAW_CHUNK_MAX_EVENTS = Math.max(
  2,
  Number.parseInt(process.env.LMC_RAW_CHUNK_MAX_EVENTS || "12", 10) || 12
);
const RAW_CHUNK_MAX_CHARS = Math.max(
  1000,
  Number.parseInt(process.env.LMC_RAW_CHUNK_MAX_CHARS || "5000", 10) || 5000
);
const RAW_CHUNK_MIN_CHARS = Math.max(
  20,
  Number.parseInt(process.env.LMC_RAW_CHUNK_MIN_CHARS || "160", 10) || 160
);
const LMC_RECALL_BUDGET_CHARS = Math.max(
  800,
  Number.parseInt(process.env.LMC_RECALL_BUDGET_CHARS || "3600", 10) || 3600
);
const MAX_LMC_CURATED_RECALLS = Math.max(
  1,
  Number.parseInt(process.env.LMC_MAX_CURATED_RECALLS || "3", 10) || 3
);
const MAX_LMC_CHUNK_RECALLS = Math.max(
  1,
  Number.parseInt(process.env.LMC_MAX_CHUNK_RECALLS || "4", 10) || 4
);
const TEMPORARY_FACT_TTL_DAYS = Math.max(
  1,
  Number.parseInt(process.env.LMC_TEMPORARY_FACT_TTL_DAYS || "14", 10) || 14
);
const SEARCH_EVIDENCE_TTL_DAYS = Math.max(
  7,
  Number.parseInt(process.env.LMC_SEARCH_EVIDENCE_TTL_DAYS || "90", 10) || 90
);

const CURATED_STATUSES = new Set([
  "current",
  "review",
  "superseded",
  "historical",
  "archived",
  "expired",
  "search_only"
]);
const TEMPORAL_TYPES = new Set(["stable", "temporary", "event", "search_only"]);

const SAFE_RELATION_TYPES = new Set([
  "same_topic",
  "same_event",
  "temporal_sequence",
  "derived_from",
  "elaborates",
  "supersedes"
]);
const REVIEW_RELATION_TYPES = new Set(["contradicts", "supports", "cause_effect"]);
const RELATION_TYPES = new Set([...SAFE_RELATION_TYPES, ...REVIEW_RELATION_TYPES]);
const SYMMETRIC_RELATION_TYPES = new Set(["same_topic", "same_event"]);

const STOP_TOKENS = new Set([
  "the",
  "and",
  "that",
  "this",
  "with",
  "from",
  "have",
  "what",
  "why",
  "这个",
  "那个",
  "现在",
  "还是",
  "就是",
  "真的",
  "可以",
  "我们",
  "你们"
]);

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function ensureLmcStructure() {
  ensureDir(LMC_ROOT);
  for (const dirPath of Object.values(LMC_DIRS)) {
    ensureDir(dirPath);
  }
}

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(filePath, value) {
  ensureDir(path.dirname(filePath));
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(temporaryPath, filePath);
}

function nowIso() {
  return new Date().toISOString();
}

function parseTime(value) {
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeIso(value) {
  const parsed = parseTime(value);
  return parsed ? new Date(parsed).toISOString() : "";
}

function addDaysIso(value, days) {
  const base = parseTime(value) || Date.now();
  return new Date(base + Math.max(0, Number(days) || 0) * 86400000).toISOString();
}

function normalizeTemporalType(value, fallback = "stable") {
  const text = String(value || "").trim().toLowerCase().replace(/[-\s]+/g, "_");
  if (text === "temp" || text === "short_term" || text === "current_state") {
    return "temporary";
  }
  if (text === "episode" || text === "life_event") {
    return "event";
  }
  if (text === "evidence" || text === "search") {
    return "search_only";
  }
  return TEMPORAL_TYPES.has(text) ? text : fallback;
}

function normalizeCuratedStatus(value, fallback = "current") {
  const text = String(value || "").trim().toLowerCase().replace(/[-\s]+/g, "_");
  return CURATED_STATUSES.has(text) ? text : fallback;
}

function defaultExpiresAtFor(temporalType, observedAt) {
  // Temporary facts and search-only evidence should fade automatically; stable
  // memories stay available until an explicit newer fact supersedes them.
  if (temporalType === "temporary") {
    return addDaysIso(observedAt, TEMPORARY_FACT_TTL_DAYS);
  }
  if (temporalType === "search_only") {
    return addDaysIso(observedAt, SEARCH_EVIDENCE_TTL_DAYS);
  }
  return "";
}

function temporalDeadline(record) {
  return normalizeIso(record.expiresAt || record.validUntil);
}

function isTemporalExpired(record, nowMs = Date.now()) {
  const deadline = parseTime(temporalDeadline(record));
  return Boolean(deadline && deadline <= nowMs);
}

function effectiveStatus(record, nowMs = Date.now()) {
  // Treat expired time-bound facts as expired at read time even before the next
  // status pass writes that state to disk.
  const status = normalizeCuratedStatus(record.status, "current");
  if ((status === "current" || status === "review") && isTemporalExpired(record, nowMs)) {
    return "expired";
  }
  return status;
}

function createId(prefix) {
  return `${prefix}_${crypto.randomBytes(10).toString("hex")}`;
}

function hashText(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

function safeFilePart(value) {
  return String(value || "")
    .replace(/[:.]/g, "-")
    .replace(/[^a-zA-Z0-9\u4e00-\u9fa5_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "lmc";
}

function fileNameFor(record) {
  const created = String(record.createdAt || nowIso()).replace("T", "_").replace("Z", "");
  return `${safeFilePart(created)}__${safeFilePart(record.id)}.json`;
}

function kindDir(kind) {
  const dirPath = LMC_DIRS[kind];
  if (!dirPath) {
    throw new Error(`Unsupported LMC kind: ${kind}`);
  }
  return dirPath;
}

function normalizeRecord(kind, record) {
  const timestamp = nowIso();
  return {
    id: String(record.id || createId(kind)),
    kind,
    createdAt: String(record.createdAt || timestamp),
    updatedAt: String(record.updatedAt || timestamp),
    status: String(record.status || "current"),
    ...record
  };
}

function saveRecord(kind, record) {
  ensureLmcStructure();
  const normalized = normalizeRecord(kind, record);
  const dirPath = kindDir(kind);
  const existingPath =
    normalized.filePath && path.dirname(normalized.filePath) === dirPath
      ? normalized.filePath
      : path.join(dirPath, fileNameFor(normalized));
  const diskRecord = {
    ...normalized,
    filePath: undefined,
    storageKind: undefined
  };
  writeJsonAtomic(existingPath, diskRecord);
  return {
    ...normalized,
    storageKind: kind,
    filePath: existingPath
  };
}

function listRecords(kind) {
  ensureLmcStructure();
  const dirPath = kindDir(kind);
  if (!fs.existsSync(dirPath)) {
    return [];
  }
  return fs
    .readdirSync(dirPath)
    .filter((name) => name.endsWith(".json"))
    .map((name) => {
      const filePath = path.join(dirPath, name);
      const record = readJson(filePath, null);
      return record && record.id ? { ...record, storageKind: kind, filePath } : null;
    })
    .filter(Boolean)
    .sort((left, right) => parseTime(left.createdAt) - parseTime(right.createdAt));
}

function updateRecord(record, updates) {
  if (!record || !record.filePath) {
    throw new Error("Cannot update LMC record without kind and filePath.");
  }
  return saveRecord(record.storageKind || record.kind, {
    ...record,
    ...updates,
    updatedAt: nowIso()
  });
}

function loadState() {
  ensureLmcStructure();
  return readJson(LMC_STATE_PATH, { version: 1 });
}

function saveState(state) {
  writeJsonAtomic(LMC_STATE_PATH, {
    version: 1,
    ...(state || {}),
    updatedAt: nowIso()
  });
}

function normalizeRelationType(value) {
  const text = String(value || "").trim().toLowerCase();
  if (text === "contradiction") return "contradicts";
  if (text === "same-topic") return "same_topic";
  if (text === "same-event") return "same_event";
  return text;
}

function logRawEvent(event) {
  const content = String(event.content || "").trim();
  if (!content) {
    return null;
  }
  const metadata = event.metadata && typeof event.metadata === "object"
    ? event.metadata
    : {};
  const hash = hashText(
    [
      event.channel || "telegram",
      event.chatId || "",
      event.turnId || "",
      event.role || "",
      content,
      JSON.stringify(metadata)
    ].join("\u0000")
  );
  const existing = listRecords("raw_event").find((item) => item.hash === hash);
  if (existing) {
    return existing;
  }
  return saveRecord("raw_event", {
    id: createId("raw"),
    role: String(event.role || "note"),
    content,
    channel: String(event.channel || "telegram"),
    chatId: String(event.chatId || ""),
    turnId: String(event.turnId || ""),
    at: String(event.at || nowIso()),
    hash,
    metadata,
    attachments: Array.isArray(event.attachments) ? event.attachments : []
  });
}

function logTelegramTurn({ chatId, userText, assistantText, userAt, assistantAt, metadata }) {
  const turnId = hashText(
    [chatId, userAt || "", assistantAt || "", userText || "", assistantText || ""].join("\u0000")
  ).slice(0, 24);
  const shared = {
    channel: "telegram",
    chatId,
    turnId,
    metadata: {
      source: "telegram-gem-bridge",
      ...(metadata || {})
    }
  };
  const userEvent = logRawEvent({
    ...shared,
    role: "user",
    content: userText,
    at: userAt
  });
  const assistantEvent = logRawEvent({
    ...shared,
    role: "assistant",
    content: assistantText,
    at: assistantAt
  });
  return [userEvent, assistantEvent].filter(Boolean);
}

function renderEvent(event) {
  const speaker = event.role === "assistant" ? "Assistant" : "User";
  return `${speaker}: ${event.content}`;
}

function eventChunkText(events) {
  return events.map(renderEvent).join("\n");
}

function compactText(value, maxLength) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}...` : text;
}

function chunkAlreadyCovers(rawEventIds) {
  const idSet = new Set(rawEventIds);
  return listRecords("event_chunk").some((chunk) =>
    Array.isArray(chunk.rawEventIds) &&
    chunk.rawEventIds.length === rawEventIds.length &&
    chunk.rawEventIds.every((id) => idSet.has(id))
  );
}

function consolidateRawEvents({ channel = "telegram", chatId = "" } = {}) {
  const chunkedEventIds = new Set();
  for (const chunk of listRecords("event_chunk")) {
    for (const id of Array.isArray(chunk.rawEventIds) ? chunk.rawEventIds : []) {
      chunkedEventIds.add(String(id));
    }
  }

  const events = listRecords("raw_event")
    .filter((event) => !chunkedEventIds.has(event.id))
    .filter((event) => !channel || event.channel === channel)
    .filter((event) => !chatId || String(event.chatId || "") === String(chatId))
    .sort((left, right) => parseTime(left.at || left.createdAt) - parseTime(right.at || right.createdAt));

  const created = [];
  let current = [];
  let currentChars = 0;

  const flush = () => {
    if (!current.length) return;
    const text = eventChunkText(current);
    const rawEventIds = current.map((event) => event.id);
    const ready =
      current.length >= 2 ||
      text.length >= RAW_CHUNK_MIN_CHARS ||
      current.some((event) => event.role === "user");
    if (ready && !chunkAlreadyCovers(rawEventIds)) {
      created.push(
        saveRecord("event_chunk", {
          id: createId("chunk"),
          channel,
          chatId: String(chatId || current[0].chatId || ""),
          rawEventIds,
          startAt: current[0].at || current[0].createdAt,
          endAt: current[current.length - 1].at || current[current.length - 1].createdAt,
          status: "pending",
          title: `Telegram event chunk ${current[0].at || current[0].createdAt || ""}`.trim(),
          text,
          summary: "",
          tags: [],
          metadata: {
            source: "lmc-consolidate",
            eventCount: current.length,
            approximateChars: text.length
          }
        })
      );
    }
    current = [];
    currentChars = 0;
  };

  for (const event of events) {
    const eventChars = renderEvent(event).length + 1;
    const previous = current[current.length - 1];
    const previousAt = previous ? parseTime(previous.at || previous.createdAt) : 0;
    const currentAt = parseTime(event.at || event.createdAt);
    const gapMs = previousAt && currentAt ? currentAt - previousAt : 0;
    const exceeds =
      current.length > 0 &&
      (current.length >= RAW_CHUNK_MAX_EVENTS ||
        currentChars + eventChars > RAW_CHUNK_MAX_CHARS ||
        gapMs > RAW_CHUNK_GAP_MS);
    if (exceeds) {
      flush();
    }
    current.push(event);
    currentChars += eventChars;
  }
  flush();

  return { created, scannedRawEventCount: events.length };
}

function listPendingChunks({ channel = "telegram", chatId = "", limit = 8 } = {}) {
  return listRecords("event_chunk")
    .filter((chunk) => chunk.status !== "processed")
    .filter((chunk) => !channel || chunk.channel === channel)
    .filter((chunk) => !chatId || String(chunk.chatId || "") === String(chatId))
    .slice(0, limit);
}

function addRelation({ sourceId, targetId, relationType, strength = 1, reason = "" }) {
  const normalized = normalizeRelationType(relationType);
  if (!RELATION_TYPES.has(normalized)) {
    throw new Error(`Unsupported relation type: ${relationType}`);
  }
  if (!sourceId || !targetId || sourceId === targetId) {
    throw new Error("LMC relation endpoints must be non-empty and different.");
  }
  let left = String(sourceId);
  let right = String(targetId);
  if (SYMMETRIC_RELATION_TYPES.has(normalized) && left > right) {
    [left, right] = [right, left];
  }
  const boundedStrength = Math.max(0, Math.min(1, Number(strength) || 0));
  const duplicate = listRecords("relation").find(
    (item) =>
      item.sourceId === left &&
      item.targetId === right &&
      item.relationType === normalized
  );
  if (duplicate) return duplicate;
  return saveRecord("relation", {
    id: createId("rel"),
    sourceId: left,
    targetId: right,
    relationType: normalized,
    strength: boundedStrength,
    reason: String(reason || ""),
    status: SAFE_RELATION_TYPES.has(normalized) ? "current" : "review"
  });
}

function addCuratedMemory(memory) {
  const factKey = String(memory.factKey || "").trim();
  const category = String(memory.category || "other");
  const fallbackTemporalType = category === "plan" ? "temporary" : "stable";
  const temporalType = normalizeTemporalType(memory.temporalType, fallbackTemporalType);
  const observedAt =
    normalizeIso(memory.observedAt) ||
    normalizeIso(memory.validFrom) ||
    normalizeIso(memory.metadata && memory.metadata.observedAt) ||
    nowIso();
  const validFrom = normalizeIso(memory.validFrom) || observedAt;
  const validUntil = normalizeIso(memory.validUntil);
  const expiresAt =
    normalizeIso(memory.expiresAt) ||
    validUntil ||
    defaultExpiresAtFor(temporalType, observedAt);
  let status = normalizeCuratedStatus(
    memory.status,
    temporalType === "event"
      ? "historical"
      : temporalType === "search_only"
        ? "search_only"
        : "current"
  );
  if ((status === "current" || status === "review") && isTemporalExpired({ expiresAt, validUntil })) {
    status = "expired";
  }
  const activeFact =
    Boolean(memory.activeFact || factKey) &&
    temporalType !== "event" &&
    temporalType !== "search_only" &&
    status === "current";
  const evidenceIds = Array.isArray(memory.evidenceIds)
    ? memory.evidenceIds.map(String).filter(Boolean)
    : [];
  const sourceRawEventIds = Array.isArray(memory.sourceRawEventIds)
    ? memory.sourceRawEventIds.map(String).filter(Boolean)
    : [];
  const record = saveRecord("curated_memory", {
    id: createId("mem"),
    title: String(memory.title || "Curated memory"),
    content: String(memory.content || "").trim(),
    category,
    tags: Array.isArray(memory.tags) ? memory.tags.map(String).filter(Boolean) : [],
    factKey,
    activeFact,
    temporalType,
    observedAt,
    validFrom,
    validUntil,
    expiresAt,
    status,
    sourceChunkIds: Array.isArray(memory.sourceChunkIds)
      ? memory.sourceChunkIds.map(String).filter(Boolean)
      : [],
    evidenceIds,
    sourceRawEventIds,
    confidence: Number.isFinite(Number(memory.confidence)) ? Number(memory.confidence) : 0.7,
    importance: Number.isFinite(Number(memory.importance)) ? Number(memory.importance) : 0.6,
    metadata: {
      ...(memory.metadata && typeof memory.metadata === "object" ? memory.metadata : {}),
      temporalType,
      observedAt,
      validFrom,
      validUntil,
      expiresAt
    }
  });

  // Copy LMC-5's Z-axis rule: only one active fact per fact_key should influence
  // normal recall. Older active facts stay on disk as superseded audit history.
  if (factKey && activeFact && status === "current") {
    for (const existing of listRecords("curated_memory")) {
      if (
        existing.id !== record.id &&
        existing.factKey === factKey &&
        existing.activeFact &&
        effectiveStatus(existing) === "current"
      ) {
        updateRecord(existing, {
          status: "superseded",
          activeFact: false,
          supersededBy: record.id,
          supersededAt: nowIso()
        });
        addRelation({
          sourceId: record.id,
          targetId: existing.id,
          relationType: "supersedes",
          strength: 1,
          reason: `same fact_key: ${factKey}`
        });
      }
    }
  }

  for (const chunkId of record.sourceChunkIds) {
    try {
      addRelation({
        sourceId: record.id,
        targetId: chunkId,
        relationType: "derived_from",
        strength: 1,
        reason: "curated memory proposed from event chunk"
      });
    } catch {}
  }
  return record;
}

function markChunkProcessed(chunk, updates = {}) {
  return updateRecord(chunk, {
    ...updates,
    status: "processed",
    hippocampusProcessedAt: nowIso()
  });
}

function expireStaleMemories({ apply = false } = {}) {
  const now = nowIso();
  const expired = [];
  for (const memory of listRecords("curated_memory")) {
    const status = normalizeCuratedStatus(memory.status, "current");
    if (
      (status === "current" || status === "review") &&
      isTemporalExpired(memory)
    ) {
      expired.push(memory);
      if (apply) {
        updateRecord(memory, {
          status: "expired",
          activeFact: false,
          expiredAt: memory.expiredAt || now
        });
      }
    }
  }
  return expired;
}

function normalizeText(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function tokenize(value) {
  const text = normalizeText(value);
  const tokens = new Set();
  for (const word of text.match(/[a-z0-9][a-z0-9_.-]{1,}/g) || []) {
    if (!STOP_TOKENS.has(word)) tokens.add(word);
  }
  for (const sequence of text.match(/[\u3400-\u9fff]{2,}/g) || []) {
    for (let index = 0; index < sequence.length - 1; index += 1) {
      const token = sequence.slice(index, index + 2);
      if (!STOP_TOKENS.has(token)) tokens.add(token);
    }
  }
  return tokens;
}

function lexicalScore(query, text) {
  const queryTokens = tokenize(query);
  if (!queryTokens.size) return 0;
  const textTokens = tokenize(text);
  if (!textTokens.size) return 0;
  let overlap = 0;
  for (const token of queryTokens) {
    if (textTokens.has(token)) overlap += token.length > 2 ? 1.4 : 1;
  }
  return overlap / Math.sqrt(queryTokens.size * textTokens.size);
}

function recencyScore(record) {
  const timestamp = parseTime(record.endAt || record.updatedAt || record.createdAt);
  if (!timestamp) return 0;
  const ageDays = Math.max(0, (Date.now() - timestamp) / 86400000);
  return Math.exp(-ageDays / 60);
}

function wantsHistoricalEvidence(query) {
  // Only surface historical/search-only evidence when the user sounds like they
  // are asking to remember or investigate the past, not in every normal reply.
  return /(?:以前|之前|上次|那次|当时|过去|曾经|原来|还记得|记不记得|找一下|查一下|搜索|我们说过|previous|earlier|before|history|remember|search)/i.test(
    String(query || "")
  );
}

function shouldSurfaceChunk(chunk, { allowSearchEvidence = false } = {}) {
  if (chunk.status !== "processed" || !(chunk.summary || chunk.text)) {
    return false;
  }
  if (isTemporalExpired(chunk)) {
    return false;
  }
  if (chunk.searchOnly || chunk.temporalType === "search_only") {
    return allowSearchEvidence;
  }
  return true;
}

function shouldSurfaceCuratedMemory(memory, { allowHistorical = false } = {}) {
  const status = effectiveStatus(memory);
  if (
    status === "current" &&
    (!memory.factKey || memory.activeFact !== false) &&
    memory.temporalType !== "search_only"
  ) {
    return true;
  }
  if (!allowHistorical) {
    return false;
  }
  return ["historical", "superseded", "expired", "review"].includes(status);
}

function lmcSearchableRecords(options = {}) {
  const allowHistorical = Boolean(options.allowHistorical);
  const allowSearchEvidence = Boolean(options.allowSearchEvidence || allowHistorical);
  const chunks = listRecords("event_chunk")
    .filter((chunk) => shouldSurfaceChunk(chunk, { allowSearchEvidence }))
    .map((chunk) => ({
      id: chunk.id,
      section: "lmc_event_chunk",
      kind: chunk.searchOnly || chunk.temporalType === "search_only"
        ? "search_evidence"
        : "life_event",
      title: chunk.title || "Life event",
      content: chunk.summary || compactText(chunk.text, 600),
      metadata: {
        tags: chunk.tags || [],
        importance: chunk.importance || 0.5,
        confidence: chunk.confidence || 0.7,
        temporalType: chunk.temporalType || (chunk.searchOnly ? "search_only" : "event"),
        status: chunk.status || "processed",
        searchOnly: Boolean(chunk.searchOnly),
        source: "lmc",
        channel: chunk.channel,
        startAt: chunk.startAt,
        endAt: chunk.endAt,
        expiresAt: chunk.expiresAt || ""
      },
      updatedAt: chunk.updatedAt,
      createdAt: chunk.createdAt,
      lastMessageAt: chunk.endAt || chunk.updatedAt
    }));
  const memories = listRecords("curated_memory")
    .filter((memory) => shouldSurfaceCuratedMemory(memory, { allowHistorical }))
    .map((memory) => ({
      id: memory.id,
      section: "lmc_curated_memory",
      kind: "curated_memory",
      title: memory.title || "Curated memory",
      content: memory.content,
      metadata: {
        tags: memory.tags || [],
        importance: memory.importance || 0.7,
        confidence: memory.confidence || 0.7,
        category: memory.category || "other",
        factKey: memory.factKey || "",
        temporalType: memory.temporalType || "stable",
        status: effectiveStatus(memory),
        validFrom: memory.validFrom || "",
        validUntil: memory.validUntil || "",
        expiresAt: memory.expiresAt || "",
        supersededAt: memory.supersededAt || "",
        supersededBy: memory.supersededBy || "",
        source: "lmc"
      },
      updatedAt: memory.updatedAt,
      createdAt: memory.createdAt,
      lastMessageAt: memory.observedAt || memory.updatedAt
    }));
  const kinds = Array.isArray(options.kinds)
    ? new Set(options.kinds.map(String))
    : null;
  const excludedKinds = new Set(
    Array.isArray(options.excludeKinds) ? options.excludeKinds.map(String) : []
  );
  return [...memories, ...chunks].filter(
    (record) =>
      record.content &&
      (!kinds || kinds.has(record.kind)) &&
      !excludedKinds.has(record.kind)
  );
}

async function recallLmcContext(query, options = {}) {
  const queryText = String(query || "").trim();
  const allowHistorical = wantsHistoricalEvidence(queryText);
  const records = lmcSearchableRecords({
    allowHistorical,
    allowSearchEvidence: allowHistorical,
    kinds: options.kinds,
    excludeKinds: options.excludeKinds
  });
  if (!queryText || !records.length) {
    return {
      lines: [],
      records: [],
      diagnostics: { candidateCount: records.length, selected: [] }
    };
  }

  let vectorSimilarities = new Map();
  if (!options.skipVector) {
    try {
      const { getVectorSimilarities } = require("./memory-vector.cjs");
      vectorSimilarities = await getVectorSimilarities(
        queryText,
        records,
        options.queryVector
      );
    } catch {}
  }

  const ranked = records
    .map((record) => {
      const text = [record.title, record.content, ...(record.metadata.tags || [])].join("\n");
      const lexical = lexicalScore(queryText, text);
      const semantic = vectorSimilarities.get(record.id) || 0;
      const importance = Number(record.metadata.importance) || 0.5;
      const score =
        lexical * 1.8 +
        Math.max(0, semantic - 0.35) * 1.1 +
        recencyScore(record) * 0.18 +
        importance * 0.14;
      return { record, lexical, semantic, score };
    })
    .sort((left, right) => right.score - left.score);

  const curated = [];
  const chunks = [];
  for (const item of ranked) {
    if (item.score < 0.22 && item.semantic < 0.48 && item.lexical < 0.08) {
      continue;
    }
    if (item.record.kind === "curated_memory") {
      if (curated.length < MAX_LMC_CURATED_RECALLS) curated.push(item);
    } else if (chunks.length < MAX_LMC_CHUNK_RECALLS) {
      chunks.push(item);
    }
    if (
      curated.length >= MAX_LMC_CURATED_RECALLS &&
      chunks.length >= MAX_LMC_CHUNK_RECALLS
    ) {
      break;
    }
  }

  const selected = [...curated, ...chunks].sort((left, right) => right.score - left.score);
  const lines = [];
  let budget = LMC_RECALL_BUDGET_CHARS;
  function pushLine(line) {
    const text = String(line || "");
    if (budget - text.length < 0) return false;
    lines.push(text);
    budget -= text.length;
    return true;
  }
  function lineLabel(record) {
    const temporalType = record.metadata && record.metadata.temporalType;
    const status = record.metadata && record.metadata.status;
    if (status && !["current", "processed"].includes(status)) {
      return `[${status}] `;
    }
    if (temporalType === "temporary") {
      const until = record.metadata && (record.metadata.validUntil || record.metadata.expiresAt);
      return until ? `[temporary until ${until}] ` : "[temporary] ";
    }
    if (record.kind === "search_evidence") {
      return "[search evidence] ";
    }
    return "";
  }

  if (curated.length) {
    pushLine("- LMC curated memories:");
    for (const item of curated) {
      pushLine(`  - ${lineLabel(item.record)}${item.record.content}`);
    }
  }
  if (chunks.length) {
    pushLine("- LMC shared life events and searchable evidence:");
    for (const item of chunks) {
      pushLine(`  - ${lineLabel(item.record)}${item.record.content}`);
    }
  }

  return {
    lines,
    records: selected.map((item) => item.record),
    diagnostics: {
      candidateCount: records.length,
      vectorUsed: vectorSimilarities.size > 0,
      vectorMatchCount: vectorSimilarities.size,
      selected: selected.map((item) => ({
        id: item.record.id,
        kind: item.record.kind,
        title: item.record.title,
        content: String(item.record.content || item.record.summary || "").slice(0, 200),
        temporalType: item.record.metadata && item.record.metadata.temporalType,
        status: item.record.metadata && item.record.metadata.status,
        score: Math.round(item.score * 1000) / 1000,
        lexicalScore: Math.round(item.lexical * 1000) / 1000,
        semanticSimilarity: Math.round(item.semantic * 1000) / 1000
      }))
    }
  };
}

function patrol() {
  const suggestions = [];
  const currentFacts = new Map();
  for (const memory of listRecords("curated_memory")) {
    if (
      (memory.status === "current" || memory.status === "review") &&
      isTemporalExpired(memory)
    ) {
      suggestions.push({
        kind: "expired_current_fact",
        severity: "info",
        reason: `Temporary fact has passed its validity window: ${memory.factKey || memory.title || memory.id}`,
        ids: [memory.id]
      });
    }
    if (effectiveStatus(memory) !== "current" || !memory.activeFact || !memory.factKey) {
      continue;
    }
    const list = currentFacts.get(memory.factKey) || [];
    list.push(memory);
    currentFacts.set(memory.factKey, list);
  }
  for (const [factKey, memories] of currentFacts.entries()) {
    if (memories.length > 1) {
      suggestions.push({
        kind: "duplicate_current_fact",
        severity: "warning",
        reason: `Multiple current active facts share fact_key=${factKey}`,
        ids: memories.map((item) => item.id)
      });
    }
  }

  const knownIds = new Set([
    ...listRecords("event_chunk").map((item) => item.id),
    ...listRecords("curated_memory").map((item) => item.id)
  ]);
  for (const relation of listRecords("relation")) {
    if (relation.sourceId === relation.targetId) {
      suggestions.push({
        kind: "relation_self_loop",
        severity: "warning",
        reason: "Relation points to itself.",
        ids: [relation.id]
      });
    }
    if (!knownIds.has(relation.sourceId) || !knownIds.has(relation.targetId)) {
      suggestions.push({
        kind: "orphan_relation",
        severity: "warning",
        reason: "Relation points to a missing event chunk or curated memory.",
        ids: [relation.id, relation.sourceId, relation.targetId]
      });
    }
  }

  return suggestions;
}

function getLmcStatus() {
  ensureLmcStructure();
  expireStaleMemories({ apply: true });
  const rawEvents = listRecords("raw_event");
  const eventChunks = listRecords("event_chunk");
  const curatedMemories = listRecords("curated_memory");
  const relations = listRecords("relation");
  const suggestions = patrol();
  const processedChunks = eventChunks.filter((chunk) => chunk.status === "processed");
  const pendingChunks = eventChunks.filter((chunk) => chunk.status !== "processed");
  const currentCuratedMemories = curatedMemories.filter(
    (memory) => effectiveStatus(memory) === "current"
  );
  const latestRaw = rawEvents[rawEvents.length - 1] || null;
  const latestChunk = eventChunks[eventChunks.length - 1] || null;
  const latestCurated = curatedMemories[curatedMemories.length - 1] || null;
  return {
    root: LMC_ROOT,
    rawEventCount: rawEvents.length,
    eventChunkCount: eventChunks.length,
    pendingChunkCount: pendingChunks.length,
    processedChunkCount: processedChunks.length,
    curatedMemoryCount: curatedMemories.length,
    currentCuratedMemoryCount: currentCuratedMemories.length,
    currentFactCount: currentCuratedMemories.filter((memory) => memory.activeFact).length,
    temporaryMemoryCount: curatedMemories.filter(
      (memory) => memory.temporalType === "temporary"
    ).length,
    expiredMemoryCount: curatedMemories.filter(
      (memory) => effectiveStatus(memory) === "expired"
    ).length,
    supersededMemoryCount: curatedMemories.filter(
      (memory) => memory.status === "superseded"
    ).length,
    historicalMemoryCount: curatedMemories.filter(
      (memory) => memory.status === "historical"
    ).length,
    searchOnlyChunkCount: eventChunks.filter(
      (chunk) => chunk.searchOnly || chunk.temporalType === "search_only"
    ).length,
    relationCount: relations.length,
    patrolSuggestionCount: suggestions.length,
    provider: publicProviderStatus(),
    latestRawEventAt: latestRaw ? latestRaw.at || latestRaw.createdAt : "",
    latestChunkAt: latestChunk ? latestChunk.updatedAt || latestChunk.createdAt : "",
    latestCuratedAt: latestCurated
      ? latestCurated.updatedAt || latestCurated.createdAt
      : ""
  };
}

module.exports = {
  LMC_ROOT,
  addCuratedMemory,
  addRelation,
  consolidateRawEvents,
  ensureLmcStructure,
  expireStaleMemories,
  listPendingChunks,
  listRecords,
  lmcSearchableRecords,
  getLmcStatus,
  loadState,
  logRawEvent,
  logTelegramTurn,
  markChunkProcessed,
  patrol,
  recallLmcContext,
  saveRecord,
  saveState,
  updateRecord,
  wantsHistoricalEvidence
};
