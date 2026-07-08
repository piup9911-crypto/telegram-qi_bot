const fs = require("fs");
const path = require("path");
const { ROOT } = require("../adapters/cloud-memory-client.cjs");
const {
  buildChatChunks,
  loadChatVectorIndex
} = require("../memory/chat-vector-memory.cjs");
const {
  VECTOR_ENABLED,
  VECTOR_MODEL,
  embedTexts
} = require("../memory/memory-vector.cjs");

const CHAT_VECTOR_V2_INDEX_PATH = path.join(
  ROOT,
  "bridge-state",
  "chat-vector-index-v2.json"
);
const CHAT_VECTOR_V2_BATCH_SIZE = Math.max(
  1,
  Number.parseInt(process.env.CHAT_VECTOR_V2_BATCH_SIZE || "12", 10) || 12
);

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(temporaryPath, filePath);
}

function createEmptyIndex() {
  return {
    version: 2,
    provider: "ollama",
    model: VECTOR_MODEL,
    updatedAt: "",
    generatedAt: "",
    stats: {
      sourceCount: 0,
      recordCount: 0,
      reusedFromV1: 0,
      reusedFromV2: 0,
      embedded: 0,
      skipped: 0
    },
    timeline: [],
    sourceTree: [],
    previewSamples: [],
    records: {}
  };
}

function loadChatVectorV2Index() {
  const raw = readJson(CHAT_VECTOR_V2_INDEX_PATH, createEmptyIndex());
  if (
    !raw ||
    raw.version !== 2 ||
    raw.provider !== "ollama" ||
    raw.model !== VECTOR_MODEL ||
    !raw.records ||
    typeof raw.records !== "object"
  ) {
    return createEmptyIndex();
  }
  return raw;
}

function parseTime(value) {
  const timestamp = Date.parse(String(value || ""));
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function dayKey(value) {
  const timestamp = parseTime(value);
  return timestamp ? new Date(timestamp).toISOString().slice(0, 10) : "unknown";
}

function normalizeSourceKind(value) {
  const text = String(value || "").toLowerCase();
  if (text === "archive") return "archive_chat";
  if (text === "active") return "active_chat";
  return text || "unknown";
}

function hasMeaningfulRetrievalText(value) {
  const meaningfulCharacters =
    String(value || "").match(/[a-z0-9\u3400-\u9fff]/gi) || [];
  return meaningfulCharacters.length >= 2;
}

function compactText(value, maxLength) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}...` : text;
}

function buildTimeline(records) {
  const buckets = new Map();
  for (const record of records) {
    const key = dayKey(record.lastAt || record.firstAt);
    const bucket = buckets.get(key) || {
      date: key,
      count: 0,
      active_chat: 0,
      archive_chat: 0,
      unknown: 0
    };
    bucket.count += 1;
    const sourceKind = normalizeSourceKind(record.sourceKind);
    bucket[sourceKind] = (bucket[sourceKind] || 0) + 1;
    buckets.set(key, bucket);
  }
  return [...buckets.values()].sort((left, right) =>
    String(left.date).localeCompare(String(right.date))
  );
}

function buildSourceTree(records) {
  const byKind = new Map();
  for (const record of records) {
    const kind = normalizeSourceKind(record.sourceKind);
    const byChat = byKind.get(kind) || new Map();
    const chatId = String(record.chatId || "unknown");
    byChat.set(chatId, (byChat.get(chatId) || 0) + 1);
    byKind.set(kind, byChat);
  }
  return [...byKind.entries()]
    .sort((left, right) => String(left[0]).localeCompare(String(right[0])))
    .map(([kind, byChat]) => ({
      label: kind,
      count: [...byChat.values()].reduce((total, count) => total + count, 0),
      children: [...byChat.entries()]
        .sort((left, right) => right[1] - left[1])
        .map(([chatId, count]) => ({ label: chatId, count }))
    }));
}

function buildPreviewSamples(records) {
  return records
    .slice()
    .sort((left, right) => parseTime(right.lastAt) - parseTime(left.lastAt))
    .slice(0, 24)
    .map((record) => ({
      id: record.id,
      chatId: record.chatId,
      sourceKind: normalizeSourceKind(record.sourceKind),
      firstAt: record.firstAt || "",
      lastAt: record.lastAt || "",
      messageCount: record.messageCount || 0,
      turnCount: record.turnCount || 0,
      textChars: String(record.text || "").length,
      retrievalChars: String(record.retrievalText || "").length,
      preview: compactText(record.retrievalText || record.text, 180)
    }));
}

function buildV2Record(chunk, vector, reusedFromV1) {
  return {
    id: chunk.id,
    fingerprint: chunk.fingerprint,
    vector,
    chatId: chunk.chatId,
    sourceId: chunk.sourceId,
    sourceKind: normalizeSourceKind(chunk.sourceKind),
    sourceRef: chunk.sourceRef,
    firstAt: chunk.firstAt || "",
    lastAt: chunk.lastAt || "",
    startIndex: chunk.startIndex,
    endIndex: chunk.endIndex,
    messageCount: chunk.messageCount || 0,
    turnCount: chunk.turnCount || 0,
    text: chunk.text,
    retrievalText: chunk.retrievalText,
    textChars: String(chunk.text || "").length,
    retrievalChars: String(chunk.retrievalText || "").length,
    indexedAt: new Date().toISOString(),
    reusedFromV1: Boolean(reusedFromV1)
  };
}

async function buildChatVectorV2Index(sources) {
  if (!VECTOR_ENABLED) {
    return {
      enabled: false,
      indexPath: CHAT_VECTOR_V2_INDEX_PATH,
      indexed: 0,
      reusedFromV1: 0,
      embedded: 0,
      recordCount: 0
    };
  }

  // V2 is intentionally built beside the current v1 index. It lets us inspect
  // timeline/tree/sample quality before we allow the bot to depend on it.
  const chunks = buildChatChunks(sources).filter((chunk) =>
    hasMeaningfulRetrievalText(chunk.retrievalText)
  );
  const previousV2 = loadChatVectorV2Index();
  const v1 = loadChatVectorIndex();
  const index = createEmptyIndex();
  let reusedFromV1 = 0;
  let reusedFromV2 = 0;
  const pending = [];

  for (const chunk of chunks) {
    const previous = previousV2.records[chunk.id];
    if (previous && previous.fingerprint === chunk.fingerprint && Array.isArray(previous.vector)) {
      // Fingerprints make rebuilds cheap: unchanged chunks keep their existing
      // vector, so routine visualization refreshes do not re-embed old chat.
      index.records[chunk.id] = buildV2Record(chunk, previous.vector, previous.reusedFromV1);
      reusedFromV2 += 1;
      continue;
    }

    const v1Record = v1.records && v1.records[chunk.id];
    if (v1Record && v1Record.fingerprint === chunk.fingerprint && Array.isArray(v1Record.vector)) {
      // The first V2 build can borrow v1 vectors when chunk identity matches;
      // only metadata and audit views are new.
      index.records[chunk.id] = buildV2Record(chunk, v1Record.vector, true);
      reusedFromV1 += 1;
      continue;
    }

    pending.push(chunk);
  }

  let embedded = 0;
  for (let offset = 0; offset < pending.length; offset += CHAT_VECTOR_V2_BATCH_SIZE) {
    const batch = pending.slice(offset, offset + CHAT_VECTOR_V2_BATCH_SIZE);
    const vectors = await embedTexts(
      batch.map((chunk) => chunk.retrievalText || chunk.text),
      120000
    );
    if (vectors.length !== batch.length) {
      throw new Error("Ollama returned an unexpected number of chat v2 embeddings.");
    }
    batch.forEach((chunk, indexInBatch) => {
      index.records[chunk.id] = buildV2Record(chunk, vectors[indexInBatch], false);
      embedded += 1;
    });
  }

  const records = Object.values(index.records);
  index.generatedAt = new Date().toISOString();
  index.updatedAt = index.generatedAt;
  // These derived views are small enough for the status page and never include
  // embedding arrays. They answer "when/where did the index come from?" quickly.
  index.stats = {
    sourceCount: Array.isArray(sources) ? sources.length : 0,
    recordCount: records.length,
    reusedFromV1,
    reusedFromV2,
    embedded,
    skipped: Math.max(0, chunks.length - records.length)
  };
  index.timeline = buildTimeline(records);
  index.sourceTree = buildSourceTree(records);
  index.previewSamples = buildPreviewSamples(records);
  writeJson(CHAT_VECTOR_V2_INDEX_PATH, index);

  return {
    enabled: true,
    indexPath: CHAT_VECTOR_V2_INDEX_PATH,
    indexed: records.length,
    reusedFromV1,
    reusedFromV2,
    embedded,
    recordCount: records.length,
    timelineBucketCount: index.timeline.length
  };
}

module.exports = {
  CHAT_VECTOR_V2_INDEX_PATH,
  buildChatVectorV2Index,
  loadChatVectorV2Index
};
