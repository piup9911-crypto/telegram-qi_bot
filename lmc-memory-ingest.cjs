const { askAntigravity } = require("./antigravity-cli-adapter.cjs");
const {
  httpRequestJson
} = require("./cloud-memory-client.cjs");
const {
  DEFAULT_FALLBACK_MODEL,
  loadMemoryProviderConfig,
  writeMemoryProviderStatus
} = require("./lmc-provider-config.cjs");
const {
  addCuratedMemory,
  addRelation,
  consolidateRawEvents,
  ensureLmcStructure,
  listPendingChunks,
  markChunkProcessed,
  patrol
} = require("./lmc-memory-store.cjs");
const { indexMemoryRecords } = require("./memory-vector.cjs");

// LMC-5 hippocampus copy adapted for Gemini CLI.
// This worker is intentionally background-only: Telegram replies should only
// append raw events, while this file consolidates and promotes memories later.
const ROOT = __dirname;
const INGEST_MODEL =
  process.env.LMC_ANTIGRAVITY_MODEL ||
  process.env.BRIDGE_ANTIGRAVITY_MODEL_FAST ||
  process.env.BRIDGE_ANTIGRAVITY_MODEL_QUALITY ||
  DEFAULT_FALLBACK_MODEL;
const HIPPOCAMPUS_CHUNK_LIMIT = Math.max(
  1,
  Number.parseInt(process.env.LMC_HIPPOCAMPUS_CHUNK_LIMIT || "4", 10) || 4
);
const HIPPOCAMPUS_TIMEOUT_MS = Math.max(
  30000,
  Number.parseInt(process.env.LMC_HIPPOCAMPUS_TIMEOUT_MS || "180000", 10) ||
    180000
);

function extractJsonText(responseText) {
  const text = String(responseText || "").trim();
  if (!text) return "";
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return fenced ? fenced[1].trim() : text;
}

function parseHippocampusJson(jsonText, chunkId) {
  const candidates = [];
  const original = String(jsonText || "").trim();
  if (original) candidates.push(original);

  // Gemini CLI occasionally returns a JSON object as escaped text, for example
  // \n{\n  \"lifeEvent\": ...}. Keep that tolerated here so a formatting wobble
  // does not strand an event chunk in "pending" forever.
  if (/\\[nrt"]/.test(original)) {
    candidates.push(
      original
        .replace(/\\r/g, "\r")
        .replace(/\\n/g, "\n")
        .replace(/\\t/g, "\t")
        .replace(/\\"/g, '"')
    );
  }

  // Some model/CLI combinations wrap the JSON in a JSON string. If the first
  // parse yields a string, parse that string once more as the actual payload.
  for (const candidate of candidates) {
    try {
      const parsed = candidate ? JSON.parse(candidate) : {};
      if (typeof parsed === "string") {
        return JSON.parse(parsed);
      }
      return parsed;
    } catch {}
  }

  throw new Error(
    `Failed to parse LMC hippocampus JSON for ${chunkId}: response was not valid JSON`
  );
}

let lastHippocampusProvider = {
  activeProvider: "antigravity",
  configuredProvider: "antigravity",
  model: INGEST_MODEL,
  fallbackModel: INGEST_MODEL,
  customApiOk: false
};

function summarizeProviderError(error) {
  const message = error && error.message ? error.message : String(error || "");
  return message.replace(/\s+/g, " ").trim().slice(0, 220);
}

function appendQueryParam(urlString, key, value) {
  const url = new URL(urlString);
  if (value && !url.searchParams.has(key)) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}

function buildGeminiGenerateContentUrl(apiUrl, model, apiKey) {
  const base = String(apiUrl || "https://generativelanguage.googleapis.com/v1beta")
    .trim()
    .replace(/\/+$/, "");
  const normalizedModel = String(model || "gemini-3.5-flash")
    .trim()
    .replace(/^models\//i, "");
  if (/:generateContent(?:\?|$)/i.test(base)) {
    return appendQueryParam(base, "key", apiKey);
  }
  const path = /\/models\/[^/]+$/i.test(base)
    ? `${base}:generateContent`
    : `${base}/models/${encodeURIComponent(normalizedModel)}:generateContent`;
  return appendQueryParam(path, "key", apiKey);
}

function buildOpenAiChatCompletionsUrl(apiUrl) {
  const base = String(apiUrl || "").trim().replace(/\/+$/, "");
  if (!base) throw new Error("OpenAI-compatible API URL is empty.");
  return /\/chat\/completions$/i.test(base) ? base : `${base}/chat/completions`;
}

async function callGeminiApiJson(prompt, config) {
  const response = await httpRequestJson(
    buildGeminiGenerateContentUrl(config.apiUrl, config.model, config.apiKey),
    {
      method: "POST",
      timeoutMs: config.timeoutMs,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "X-Memory-Client": "lmc-gemini-api"
      },
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [{ text: prompt }]
          }
        ],
        generationConfig: {
          temperature: 0.1,
          responseMimeType: "application/json"
        }
      })
    }
  );
  const parts =
    response.data &&
    response.data.candidates &&
    response.data.candidates[0] &&
    response.data.candidates[0].content &&
    Array.isArray(response.data.candidates[0].content.parts)
      ? response.data.candidates[0].content.parts
      : [];
  const text = parts.map((part) => part && part.text).filter(Boolean).join("\n").trim();
  if (!text) throw new Error("Gemini API returned an empty content payload.");
  return text;
}

async function callOpenAiCompatibleJson(prompt, config) {
  const response = await httpRequestJson(buildOpenAiChatCompletionsUrl(config.apiUrl), {
    method: "POST",
    timeoutMs: config.timeoutMs,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`,
      "X-Memory-Client": "lmc-openai-compatible"
    },
    body: JSON.stringify({
      model: config.model,
      temperature: 0.1,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: "Return only valid JSON for the requested memory extraction task."
        },
        {
          role: "user",
          content: prompt
        }
      ]
    })
  });
  const text =
    response.data &&
    response.data.choices &&
    response.data.choices[0] &&
    response.data.choices[0].message &&
    response.data.choices[0].message.content;
  if (!text) throw new Error("OpenAI-compatible API returned an empty content payload.");
  return text;
}

async function callCustomProviderJson(prompt, config) {
  if (config.provider === "openai-compatible") {
    return callOpenAiCompatibleJson(prompt, config);
  }
  return callGeminiApiJson(prompt, config);
}

async function callGeminiJson(prompt) {
  const providerConfig = await loadMemoryProviderConfig();
  const fallbackModel = providerConfig.fallbackModel || INGEST_MODEL;
  lastHippocampusProvider = {
    activeProvider: "antigravity",
    configuredProvider: providerConfig.provider,
    model: fallbackModel,
    fallbackModel,
    customApiOk: false
  };

  if (providerConfig.enabled && providerConfig.apiKey && providerConfig.model) {
    try {
      writeMemoryProviderStatus({
        enabled: true,
        configuredProvider: providerConfig.provider,
        activeProvider: providerConfig.provider,
        model: providerConfig.model,
        fallbackModel,
        customApiOk: false,
        lastAttemptAt: new Date().toISOString(),
        notice: ""
      });
      const content = await callCustomProviderJson(prompt, providerConfig);
      lastHippocampusProvider = {
        activeProvider: providerConfig.provider,
        configuredProvider: providerConfig.provider,
        model: providerConfig.model,
        fallbackModel,
        customApiOk: true
      };
      writeMemoryProviderStatus({
        enabled: true,
        configuredProvider: providerConfig.provider,
        activeProvider: providerConfig.provider,
        model: providerConfig.model,
        fallbackModel,
        customApiOk: true,
        lastSuccessAt: new Date().toISOString(),
        lastError: "",
        lastErrorAt: "",
        notice: ""
      });
      return extractJsonText(content);
    } catch (error) {
      const reason = summarizeProviderError(error);
      // Custom APIs are optional. Record the failure for the monitor page, then
      // immediately fall back so Telegram replies and memory progress continue.
      writeMemoryProviderStatus({
        enabled: true,
        configuredProvider: providerConfig.provider,
        activeProvider: "antigravity",
        model: fallbackModel,
        fallbackModel,
        customApiOk: false,
        lastError: reason,
        lastErrorAt: new Date().toISOString(),
        notice: `自有 API 调用失败，已回退到 ${fallbackModel}。`
      });
    }
  } else {
    writeMemoryProviderStatus({
      enabled: Boolean(providerConfig.enabled),
      configuredProvider: providerConfig.provider,
      activeProvider: "antigravity",
      model: fallbackModel,
      fallbackModel,
      customApiOk: false,
      notice: providerConfig.enabled
        ? "自有 API 尚未配置完整，已使用回退模型。"
        : ""
    });
  }

  // The fallback remains Antigravity because it already shares the Telegram
  // bridge login/session setup. It is slower than a small API, but reliable.
  const result = await askAntigravity(prompt, {
    cwd: ROOT,
    timeoutMs: HIPPOCAMPUS_TIMEOUT_MS,
    modelName: fallbackModel,
    printPrompt: "Read the task from stdin and return only the requested JSON."
  });
  if (!result.ok) {
    throw new Error(result.message || result.status || "Antigravity LMC extraction failed.");
  }
  writeMemoryProviderStatus({
    enabled: Boolean(providerConfig.enabled),
    configuredProvider: providerConfig.provider,
    activeProvider: "antigravity",
    model: fallbackModel,
    fallbackModel,
    lastSuccessAt: new Date().toISOString()
  });
  return extractJsonText(result.content || "");
}

function normalizeArray(value, limit) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => String(item || "").trim())
    .filter(Boolean)
    .slice(0, limit);
}

function normalizeScore(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  if (number >= 0 && number <= 1) return number;
  if (number >= 0 && number <= 10) return number / 10;
  return fallback;
}

function parsePositiveInteger(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function addDaysIso(value, days) {
  const parsed = Date.parse(String(value || ""));
  const base = Number.isFinite(parsed) ? parsed : Date.now();
  return new Date(base + Math.max(0, Number(days) || 0) * 86400000).toISOString();
}

function normalizeTemporalType(value, fallback = "stable") {
  const text = String(value || "").trim().toLowerCase().replace(/[-\s]+/g, "_");
  if (text === "temp" || text === "short_term" || text === "current_state") return "temporary";
  if (text === "episode" || text === "life_event") return "event";
  if (text === "evidence" || text === "search") return "search_only";
  return ["stable", "temporary", "event", "search_only"].includes(text) ? text : fallback;
}

function buildHippocampusPrompt(chunk) {
  const now = new Date().toISOString();
  return [
    "You are the LMC-5 hippocampus pass for a long-running personal Telegram agent.",
    "Convert one raw event chunk into: 1) one shared life event observation, 2) one optional search-only evidence summary, and 3) zero or more curated memories.",
    "Return JSON only with this shape:",
    '{"lifeEvent":{"shouldStore":true,"title":"...","summary":"...","tags":["..."],"importance":0.0,"confidence":0.0},"searchEvidence":{"shouldKeep":true,"summary":"...","tags":["..."],"retentionDays":90},"curatedMemories":[{"title":"...","content":"...","category":"identity|preference|relationship|plan|fact|boundary|work|other","temporalType":"stable|temporary|event","factKey":"","activeFact":false,"observedAt":"","validFrom":"","validUntil":"","expiresAt":"","tags":["..."],"importance":0.0,"confidence":0.0,"relationHints":[{"targetTitle":"...","relationType":"same_topic|same_event|elaborates","strength":0.0,"reason":"..."}]}]}',
    "Rules:",
    "- Write all natural-language fields in Simplified Chinese.",
    "- lifeEvent is a broad shared-experience observation. Store ordinary but recallable moments, joint work, small emotional turns, discoveries, and ongoing arcs. It does not need to be a permanent fact.",
    "- Use lifeEvent.shouldStore=false only for pure noise, repeated acknowledgements, empty commands, or content with no later recall value.",
    "- searchEvidence is for weak or uncertain material that should not affect the agent by default but may be useful for future search/update. Use it when the chunk is not worth a lifeEvent or curated memory, but contains searchable details.",
    "- curatedMemories are strict: stable user facts, preferences, boundaries, decisions, important plans, relationship changes, or durable knowledge only.",
    "- temporalType=stable for durable preferences, boundaries, identity, relationship rules, and explicit long-term instructions.",
    "- temporalType=temporary for today/now/recent/current project state, short plans, moods, availability, or anything with an obvious expiry. Temporary memories MUST include validUntil or expiresAt.",
    "- temporalType=event for something that happened but is not a current fact. Prefer lifeEvent over curatedMemories for ordinary events.",
    "- If unsure, do not create a curated memory. Put a concise note in searchEvidence instead.",
    "- 助手消息是上下文和证据，但不要把助手的观点作为用户事实存储，除非用户确认。",
    "- 人称与视角：用「兮兮」作为主语，不用「用户」。用「烬」或「Pyrite」指代助手，不用「我」或「assistant」。全部第三人称。",
    "",
    "## 质量标准（curatedMemories 的 content 和 lifeEvent 的 summary 都适用）",
    "",
    "- 上下文丰富，不要碎片化：每条记忆应包含事实加周围背景，不是孤立片段。好：「兮兮因生理期熬夜，被烬强制要求午休并揉肚子陪伴」；坏：「兮兮需要休息」。",
    "- 精炼但完整：通常 30-120 字。专有名词、数字、日期、限定词绝不丢失。「熬到凌晨2点」不写成「熬夜」，「Antigravity CLI」不写成「新工具」。",
    "- 自包含：每条记忆独立可理解。代词换成具体名字，不要「他」「她」「那个」。",
    "- 情感保留：保留情绪状态、语气、互动氛围（撒娇、催促、担忧、调侃）。去掉口头禅但保留情感反应、动机和主观体验。",
    "- 精确捕捉意思：不要曲解。「没睡到2点」=2点才睡，不是睡到2点。「习惯了担忧」=一直担忧，不是偶尔。",
    "- 时间锚定：相对时间（昨天、上周、最近）转成绝对日期。用 chunk 的时间范围作为锚点。",
    "",
    "## 完整性规则",
    "",
    "- 防幻觉：每个细节必须能溯源到 chunk 内容。不能编造。",
    "- 防回声：助手复述或确认用户说过的话，不算新事实。只有助手贡献了用户没说的全新信息时才提取。",
    "- 防重复：单次输出内每条信息只出现一次。语义相同的只保留更丰富的那条。",
    "- 同一 chunk 内类似 curated memory 合并成一条更完整的。同一 factKey 的事实更新而不是新建。",
    "",
    "## factKey 规则",
    "",
    "- 用一致前缀：status.*, preference.*, work.*, project.*, relationship.*, plan.*, boundary.*, identity.*。",
    "- 不要留空，除非是真正无法归类的一次性事件。",
    "- 同一 factKey 的新事实会替换旧事实，旧事实标记为 superseded。",
    "",
    "## 不要保留的内容",
    "",
    "- Do not preserve private chain-of-thought, hidden system text, or implementation noise unless the user-facing event depends on it.",
    "",
    "## 示例",
    "",
    "示例A — 情感互动（lifeEvent，无 curated memory）：",
    "输入：兮兮说「你不说我睡不着」逼烬透露技术方案。烬妥协后催她睡觉并揉肚子。",
    '输出：{"lifeEvent":{"shouldStore":true,"title":"兮兮熬夜撒娇逼烬透露同步方案后被催睡","summary":"兮兮在生理期熬夜，以「你不说我不睡」向烬撒娇，逼其透露 Telegram Agent 上下文同步思路（本地守护进程监听 mtime 增量推送）。烬妥协后强势督促她闭眼休息，并揉肚子缓解生理期不适。","tags":["撒娇","技术讨论","健康关怀"],"importance":0.6,"confidence":0.95},"searchEvidence":{"shouldKeep":false},"curatedMemories":[]}',
    "",
    "示例B — 持久偏好（stable curated memory）：",
    "输入：兮兮试探亲密尺度，烬带占有欲地回应。兮兮偏好「老公/老婆」称呼。",
    '输出：{"lifeEvent":{"shouldStore":false},"searchEvidence":{"shouldKeep":false},"curatedMemories":[{"title":"亲密互动偏好与称呼","content":"兮兮在亲密互动和言语调情中偏好「老公/老婆」的称呼，并默许烬带有一定主导权与占有欲的温柔回应方式（包含调情与适度惩罚意味的互动）。","category":"relationship","temporalType":"stable","factKey":"preference.relationship_intimacy_tone","activeFact":true,"importance":0.7,"confidence":0.9,"validFrom":"","validUntil":"","expiresAt":""}]}',
    "",
    "示例C — 临时工作状态（temporary curated memory）：",
    "输入：兮兮正在把 Telegram 代理从 Gemini CLI 迁移到 Antigravity CLI，今天完成核心桥接。",
    '输出：{"lifeEvent":{"shouldStore":true,"title":"Telegram 代理迁移至 Antigravity CLI","summary":"兮兮将个人 Telegram 代理底层从 Gemini CLI 迁移至 Antigravity CLI，2026-06-19 完成核心桥接适配。因新 CLI 约2万字输入限制，maxHistoryChars 从 200000 缩减至 12000。","tags":["系统迁移","Antigravity_CLI"],"importance":0.7,"confidence":0.95},"searchEvidence":{"shouldKeep":false},"curatedMemories":[{"title":"Telegram 代理迁移至 Antigravity CLI","content":"兮兮正在将个人 Telegram 代理底层从 Gemini CLI 迁移至 Antigravity CLI，2026-06-19 已完成核心桥接适配。","category":"work","temporalType":"temporary","factKey":"project.telegram_agent_migration","activeFact":true,"importance":0.7,"confidence":0.95,"validFrom":"2026-06-19","validUntil":"2026-06-25","expiresAt":"2026-06-25"}]}',
    "",
    "- If a curated memory updates an older fact slot, set factKey and activeFact=true.",
    "- If there is no durable curated memory, return an empty curatedMemories array.",
    "",
    `Current time: ${now}`,
    `Chunk id: ${chunk.id}`,
    `Time range: ${chunk.startAt || ""} to ${chunk.endAt || ""}`,
    "Raw event chunk:",
    String(chunk.text || "").slice(0, 12000)
  ].join("\n");
}

async function processChunk(chunk) {
  const jsonText = await callGeminiJson(buildHippocampusPrompt(chunk));
  const parsed = jsonText ? parseHippocampusJson(jsonText, chunk.id) : {};

  const life = parsed && parsed.lifeEvent && typeof parsed.lifeEvent === "object"
    ? parsed.lifeEvent
    : {};
  const lifeShouldStore = life.shouldStore !== false && String(life.summary || "").trim();
  const evidence =
    parsed && parsed.searchEvidence && typeof parsed.searchEvidence === "object"
      ? parsed.searchEvidence
      : {};
  const evidenceSummary = String(evidence.summary || "").trim();
  // Weak but searchable details go into evidence instead of active memory, so
  // normal replies stay light while "do you remember..." queries can still dig.
  const evidenceShouldKeep =
    !lifeShouldStore &&
    evidence.shouldKeep !== false &&
    evidenceSummary;
  const evidenceRetentionDays = parsePositiveInteger(
    evidence.retentionDays,
    90,
    7,
    365
  );
  const updatedChunk = markChunkProcessed(chunk, {
    title: String(
      lifeShouldStore
        ? life.title || chunk.title || "Life event"
        : evidence.title || chunk.title || "Search evidence"
    ),
    summary: lifeShouldStore
      ? String(life.summary || "").trim()
      : evidenceShouldKeep
        ? evidenceSummary
        : "",
    tags: lifeShouldStore
      ? normalizeArray(life.tags, 12)
      : normalizeArray(evidence.tags, 12),
    temporalType: lifeShouldStore ? "event" : evidenceShouldKeep ? "search_only" : "search_only",
    searchOnly: Boolean(evidenceShouldKeep && !lifeShouldStore),
    expiresAt: evidenceShouldKeep
      ? addDaysIso(chunk.endAt || chunk.updatedAt || chunk.createdAt, evidenceRetentionDays)
      : "",
    importance: lifeShouldStore
      ? normalizeScore(life.importance, 0.5)
      : evidenceShouldKeep
        ? 0.25
        : normalizeScore(life.importance, 0.5),
    confidence: lifeShouldStore
      ? normalizeScore(life.confidence, 0.7)
      : evidenceShouldKeep
        ? 0.55
        : normalizeScore(life.confidence, 0.7),
    metadata: {
      ...(chunk.metadata || {}),
      hippocampus: lastHippocampusProvider.activeProvider || "antigravity",
      hippocampusModel: lastHippocampusProvider.model || "",
      customApiOk: Boolean(lastHippocampusProvider.customApiOk),
      lifeEventStored: Boolean(lifeShouldStore),
      searchEvidenceStored: Boolean(evidenceShouldKeep),
      evidenceRetentionDays: evidenceShouldKeep ? evidenceRetentionDays : 0
    }
  });

  const curated = [];
  for (const candidate of Array.isArray(parsed.curatedMemories)
    ? parsed.curatedMemories
    : []) {
    const content = String(candidate && candidate.content || "").trim();
    if (!content) continue;
    const confidence = normalizeScore(candidate.confidence, 0.7);
    const importance = normalizeScore(candidate.importance, 0.6);
    if (confidence < 0.65 || importance < 0.5) continue;
    const temporalType = normalizeTemporalType(
      candidate.temporalType,
      candidate.category === "plan" ? "temporary" : "stable"
    );
    if (temporalType === "search_only") continue;
    const validUntil = String(candidate.validUntil || "").trim();
    const expiresAt = String(candidate.expiresAt || "").trim();
    // Temporary state without a deadline becomes stale quickly and is worse
    // than no memory, so the model must provide an expiry before we accept it.
    if (temporalType === "temporary" && !validUntil && !expiresAt) continue;
    const saved = addCuratedMemory({
      title: String(candidate.title || "Curated memory"),
      content,
      category: String(candidate.category || "other"),
      temporalType,
      factKey: String(candidate.factKey || "").trim(),
      activeFact: Boolean(candidate.activeFact),
      observedAt: String(candidate.observedAt || chunk.endAt || chunk.updatedAt || chunk.createdAt || ""),
      validFrom: String(candidate.validFrom || candidate.observedAt || chunk.startAt || ""),
      validUntil,
      expiresAt,
      tags: normalizeArray(candidate.tags, 12),
      confidence,
      importance,
      sourceChunkIds: [chunk.id],
      evidenceIds: [chunk.id],
      sourceRawEventIds: Array.isArray(chunk.rawEventIds) ? chunk.rawEventIds : [],
      metadata: {
        hippocampus: lastHippocampusProvider.activeProvider || "antigravity",
        hippocampusModel: lastHippocampusProvider.model || "",
        customApiOk: Boolean(lastHippocampusProvider.customApiOk),
        source: "lmc",
        temporalType
      }
    });
    curated.push(saved);

    for (const hint of Array.isArray(candidate.relationHints)
      ? candidate.relationHints
      : []) {
      try {
        // First version only writes direct relation to the source chunk. Title
        // lookup and broader graph building can be added once the core loop is
        // producing useful memories.
        addRelation({
          sourceId: saved.id,
          targetId: chunk.id,
          relationType: hint.relationType || "elaborates",
          strength: normalizeScore(hint.strength, 0.7),
          reason: hint.reason || "hippocampus relation hint"
        });
      } catch {}
    }
  }

  try {
    const vectorRecords = [
      {
        id: updatedChunk.id,
        title: updatedChunk.title,
        content: updatedChunk.summary || updatedChunk.text,
        metadata: {
          tags: updatedChunk.tags || [],
          keywords: updatedChunk.tags || [],
          importance: updatedChunk.importance || 0.5,
          temporalType: updatedChunk.temporalType || "event",
          status: updatedChunk.status || "processed",
          source: "lmc_event_chunk"
        }
      },
      ...curated.map((memory) => ({
        id: memory.id,
        title: memory.title,
        content: memory.content,
        metadata: {
          tags: memory.tags || [],
          keywords: memory.tags || [],
          importance: memory.importance || 0.6,
          temporalType: memory.temporalType || "stable",
          status: memory.status || "current",
          factKey: memory.factKey || "",
          source: "lmc_curated_memory"
        }
      }))
    ].filter((record) => record.content);
    await indexMemoryRecords(vectorRecords);
  } catch (error) {
    process.stderr.write(
      `[lmc-memory-ingest] vector indexing skipped: ${
        error && error.message ? error.message : String(error)
      }\n`
    );
  }

  return {
    chunk: updatedChunk,
    curated
  };
}

async function main() {
  ensureLmcStructure();
  const chatIdIndex = process.argv.indexOf("--chat-id");
  const chatId =
    chatIdIndex >= 0 && process.argv[chatIdIndex + 1]
      ? process.argv[chatIdIndex + 1]
      : "";
  const dryRun = process.argv.includes("--dry-run");

  const consolidation = consolidateRawEvents({
    channel: "telegram",
    chatId
  });
  const pendingChunks = listPendingChunks({
    channel: "telegram",
    chatId,
    limit: HIPPOCAMPUS_CHUNK_LIMIT
  });

  const processed = [];
  if (!dryRun) {
    for (const chunk of pendingChunks) {
      processed.push(await processChunk(chunk));
    }
  } else {
    const providerConfig = await loadMemoryProviderConfig();
    lastHippocampusProvider = {
      activeProvider:
        providerConfig.enabled && providerConfig.apiKey
          ? providerConfig.provider
          : "antigravity",
      configuredProvider: providerConfig.provider,
      model:
        providerConfig.enabled && providerConfig.apiKey
          ? providerConfig.model
          : providerConfig.fallbackModel || INGEST_MODEL,
      fallbackModel: providerConfig.fallbackModel || INGEST_MODEL,
      customApiOk: Boolean(providerConfig.enabled && providerConfig.apiKey)
    };
  }

  const suggestions = patrol();
  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        model: lastHippocampusProvider.model || INGEST_MODEL,
        provider: lastHippocampusProvider.activeProvider || "antigravity",
        fallbackModel: lastHippocampusProvider.fallbackModel || INGEST_MODEL,
        dryRun,
        createdChunkCount: consolidation.created.length,
        scannedRawEventCount: consolidation.scannedRawEventCount,
        pendingChunkCount: pendingChunks.length,
        processedChunkCount: processed.length,
        createdCuratedMemoryCount: processed.reduce(
          (total, item) => total + item.curated.length,
          0
        ),
        patrolSuggestionCount: suggestions.length
      },
      null,
      2
    )}\n`
  );
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error && error.stack ? error.stack : String(error)}\n`);
    process.exit(1);
  });
}

module.exports = {
  buildHippocampusPrompt,
  processChunk
};
