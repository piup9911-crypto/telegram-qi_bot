const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { ROOT } = require("./cloud-memory-client.cjs");
const {
  VECTOR_ENABLED,
  VECTOR_MODEL,
  cosineSimilarity,
  embedTexts
} = require("./memory-vector.cjs");

const CHAT_VECTOR_INDEX_PATH = path.join(
  ROOT,
  "bridge-state",
  "chat-vector-index.json"
);
const CHAT_CHUNK_TARGET_CHARS = Math.max(
  800,
  Number.parseInt(process.env.CHAT_VECTOR_CHUNK_TARGET_CHARS || "1400", 10) ||
    1400
);
const CHAT_CHUNK_MAX_CHARS = Math.max(
  CHAT_CHUNK_TARGET_CHARS,
  Number.parseInt(process.env.CHAT_VECTOR_CHUNK_MAX_CHARS || "4200", 10) ||
    4200
);
const CHAT_CHUNK_MAX_TURNS = Math.max(
  1,
  Number.parseInt(process.env.CHAT_VECTOR_CHUNK_MAX_TURNS || "2", 10) || 2
);
const CHAT_CHUNK_GAP_MS = Math.max(
  5 * 60 * 1000,
  Number.parseInt(process.env.CHAT_VECTOR_CHUNK_GAP_MS || "1800000", 10) ||
    1800000
);
const CHAT_VECTOR_BATCH_SIZE = Math.max(
  1,
  Number.parseInt(process.env.CHAT_VECTOR_BATCH_SIZE || "12", 10) || 12
);
const MAX_CHAT_RECALLS = Math.max(
  1,
  Number.parseInt(process.env.CHAT_VECTOR_MAX_RECALLS || "3", 10) || 3
);
const MIN_CHAT_RECALL_SCORE = Number.parseFloat(
  process.env.CHAT_VECTOR_MIN_SCORE || "0.48"
);
const CHAT_RECALL_SCORE_WINDOW = Math.max(
  0.02,
  Number.parseFloat(process.env.CHAT_VECTOR_SCORE_WINDOW || "0.09") || 0.09
);
const CHAT_QUERY_CONTEXT_GAP_MS = Math.max(
  5 * 60 * 1000,
  Number.parseInt(process.env.CHAT_VECTOR_QUERY_CONTEXT_GAP_MS || "1800000", 10) ||
    1800000
);
const CHAT_VECTOR_RECENT_EXCLUDE_MS = Math.max(
  0,
  Number.parseInt(
    process.env.CHAT_VECTOR_RECENT_EXCLUDE_MS || "172800000",
    10
  ) || 172800000
);
const CHAT_STOP_TOKENS = new Set([
  "真的",
  "可是",
  "但是",
  "就是",
  "这个",
  "那个",
  "然后",
  "所以",
  "知道",
  "觉得",
  "现在",
  "已经",
  "还是",
  "可以",
  "没有",
  "什么",
  "怎么"
]);
const CHAT_MEANINGFUL_SINGLE_TOKENS = new Set([
  "爱",
  "怕",
  "哭",
  "累",
  "痛",
  "病",
  "猫"
]);

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
    version: 1,
    provider: "ollama",
    model: VECTOR_MODEL,
    updatedAt: "",
    records: {}
  };
}

function loadChatVectorIndex() {
  const raw = readJson(CHAT_VECTOR_INDEX_PATH, createEmptyIndex());
  if (
    !raw ||
    raw.version !== 1 ||
    raw.provider !== "ollama" ||
    raw.model !== VECTOR_MODEL ||
    !raw.records ||
    typeof raw.records !== "object"
  ) {
    return createEmptyIndex();
  }
  return raw;
}

function normalizeMessage(message) {
  if (!message || !message.content) {
    return null;
  }
  const role = message.role === "assistant" ? "assistant" : "user";
  const content = String(message.content).replace(/\s+/g, " ").trim();
  if (!content) {
    return null;
  }
  return {
    role,
    content,
    at: message.at || ""
  };
}

function renderMessage(message) {
  return `${message.role === "assistant" ? "Assistant" : "User"}: ${message.content}`;
}

function splitLongMessage(message) {
  if (!message || message.content.length <= CHAT_CHUNK_MAX_CHARS) {
    return message ? [message] : [];
  }
  const segments = [];
  let remaining = message.content;
  while (remaining.length > CHAT_CHUNK_MAX_CHARS) {
    const window = remaining.slice(0, CHAT_CHUNK_MAX_CHARS);
    const candidates = [
      window.lastIndexOf("。"),
      window.lastIndexOf("！"),
      window.lastIndexOf("？"),
      window.lastIndexOf(". "),
      window.lastIndexOf("! "),
      window.lastIndexOf("? ")
    ];
    const naturalBoundary = Math.max(...candidates);
    const splitAt =
      naturalBoundary >= Math.floor(CHAT_CHUNK_TARGET_CHARS * 0.65)
        ? naturalBoundary + 1
        : CHAT_CHUNK_MAX_CHARS;
    segments.push({
      ...message,
      content: remaining.slice(0, splitAt).trim()
    });
    remaining = remaining.slice(splitAt).trim();
  }
  if (remaining) {
    segments.push({ ...message, content: remaining });
  }
  return segments;
}

function parseTime(value) {
  const timestamp = Date.parse(String(value || ""));
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function chunkId(sourceId, startIndex, endIndex) {
  return crypto
    .createHash("sha256")
    .update(`${sourceId}\u0000${startIndex}\u0000${endIndex}`)
    .digest("hex")
    .slice(0, 24);
}

function chunkFingerprint(text, retrievalText) {
  return crypto
    .createHash("sha256")
    .update(`${text}\u0000${retrievalText}`)
    .digest("hex");
}

function compactRetrievalMessage(value, maxChars) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars - 1)}...`;
}

function buildRetrievalText(messages) {
  const userMessages = messages
    .filter((message) => message.role === "user")
    .map((message) => compactRetrievalMessage(message.content, 900))
    .filter(Boolean);
  const assistantExcerpts = messages
    .filter((message) => message.role === "assistant")
    .map((message) => compactRetrievalMessage(message.content, 220))
    .filter(Boolean);

  // The embedding should represent the user's experience, not the assistant's
  // recurring role-play vocabulary. Assistant text remains fully available in
  // `text` after a hit; it is used only for orphan assistant-only fragments.
  if (userMessages.length) {
    return userMessages.join("\n");
  }
  return assistantExcerpts.join("\n");
}

function hasMeaningfulRetrievalText(value) {
  const meaningfulCharacters =
    String(value || "").match(/[a-z0-9\u3400-\u9fff]/gi) || [];
  return meaningfulCharacters.length >= 2;
}

function buildDialogueTurns(messages) {
  const turns = [];
  let current = null;

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (message.role === "user") {
      if (current && current.messages.length) turns.push(current);
      current = { startIndex: index, endIndex: index, messages: [message] };
      continue;
    }

    if (!current) {
      current = { startIndex: index, endIndex: index, messages: [message] };
    } else {
      current.messages.push(message);
      current.endIndex = index;
    }
  }
  if (current && current.messages.length) turns.push(current);
  return turns;
}

function buildChatChunks(sources) {
  const chunks = [];
  for (const source of Array.isArray(sources) ? sources : []) {
    const messages = (Array.isArray(source.messages) ? source.messages : [])
      .map(normalizeMessage)
      .filter(Boolean);
    const turns = buildDialogueTurns(messages);
    let currentTurns = [];
    let currentChars = 0;

    const flush = () => {
      if (!currentTurns.length) return;
      const chunkMessages = currentTurns.flatMap((turn) => turn.messages);
      const text = chunkMessages.map(renderMessage).join("\n");
      const retrievalText = buildRetrievalText(chunkMessages);
      const startIndex = currentTurns[0].startIndex;
      const endIndex = currentTurns[currentTurns.length - 1].endIndex;
      chunks.push({
        id: chunkId(source.sourceId, startIndex, endIndex),
        fingerprint: chunkFingerprint(text, retrievalText),
        text,
        retrievalText,
        chatId: String(source.chatId || ""),
        sourceId: String(source.sourceId || ""),
        sourceKind: String(source.sourceKind || "active"),
        sourceRef: String(source.sourceRef || ""),
        startIndex,
        endIndex,
        firstAt: chunkMessages[0].at || "",
        lastAt: chunkMessages[chunkMessages.length - 1].at || "",
        messageCount: chunkMessages.length,
        turnCount: currentTurns.length
      });
      currentTurns = [];
      currentChars = 0;
    };

    for (const turn of turns) {
      const turnChars = turn.messages.reduce(
        (total, message) => total + renderMessage(message).length + 1,
        0
      );
      const previousTurn = currentTurns[currentTurns.length - 1];
      const previousAt =
        previousTurn &&
        previousTurn.messages[previousTurn.messages.length - 1] &&
        previousTurn.messages[previousTurn.messages.length - 1].at;
      const currentAt = turn.messages[0] && turn.messages[0].at;
      const gapMs =
        parseTime(previousAt) && parseTime(currentAt)
          ? parseTime(currentAt) - parseTime(previousAt)
          : 0;
      const exceedsChunk =
        currentTurns.length > 0 &&
        (currentTurns.length >= CHAT_CHUNK_MAX_TURNS ||
          gapMs > CHAT_CHUNK_GAP_MS ||
          currentChars + turnChars > CHAT_CHUNK_MAX_CHARS);

      if (exceedsChunk) flush();
      currentTurns.push(turn);
      currentChars += turnChars;

      // A very long single turn stays intact for faithful recall, but it should
      // not pull an unrelated following turn into the same embedding chunk.
      if (currentChars >= CHAT_CHUNK_TARGET_CHARS) flush();
    }
    flush();
  }
  return chunks;
}

async function indexChatSources(sources) {
  if (!VECTOR_ENABLED) {
    return { enabled: false, indexed: 0, removed: 0, chunkCount: 0 };
  }
  // Symbol-only legacy messages such as "????" create unstable generic
  // embeddings and should never compete with real conversational memories.
  const chunks = buildChatChunks(sources).filter((chunk) =>
    hasMeaningfulRetrievalText(chunk.retrievalText)
  );
  const index = loadChatVectorIndex();
  const validIds = new Set(chunks.map((chunk) => chunk.id));
  const refreshedSourceIds = new Set(
    (Array.isArray(sources) ? sources : []).map((source) =>
      String(source.sourceId || "")
    )
  );
  let removed = 0;

  for (const id of Object.keys(index.records)) {
    if (
      refreshedSourceIds.has(String(index.records[id].sourceId || "")) &&
      !validIds.has(id)
    ) {
      delete index.records[id];
      removed += 1;
    }
  }

  const pending = chunks.filter((chunk) => {
    const existing = index.records[chunk.id];
    return !existing || existing.fingerprint !== chunk.fingerprint;
  });

  for (let offset = 0; offset < pending.length; offset += CHAT_VECTOR_BATCH_SIZE) {
    const batch = pending.slice(offset, offset + CHAT_VECTOR_BATCH_SIZE);
    const vectors = await embedTexts(
      batch.map((chunk) => chunk.retrievalText || chunk.text),
      120000
    );
    if (vectors.length !== batch.length) {
      throw new Error("Ollama returned an unexpected number of chat embeddings.");
    }
    batch.forEach((chunk, indexInBatch) => {
      index.records[chunk.id] = {
        ...chunk,
        vector: vectors[indexInBatch],
        updatedAt: new Date().toISOString()
      };
    });
  }

  index.updatedAt = new Date().toISOString();
  writeJson(CHAT_VECTOR_INDEX_PATH, index);
  return {
    enabled: true,
    indexed: pending.length,
    removed,
    chunkCount: chunks.length
  };
}

function tokenize(value) {
  const normalized = String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
  const tokens = new Set(normalized.match(/[a-z0-9][a-z0-9_.-]{1,}/g) || []);
  for (const sequence of normalized.match(/[\u3400-\u9fff]{2,}/g) || []) {
    for (const character of sequence) {
      if (CHAT_MEANINGFUL_SINGLE_TOKENS.has(character)) {
        tokens.add(character);
      }
    }
    for (let index = 0; index < sequence.length - 1; index += 1) {
      const token = sequence.slice(index, index + 2);
      if (!CHAT_STOP_TOKENS.has(token)) {
        tokens.add(token);
      }
    }
  }
  return tokens;
}

function lexicalSimilarity(query, text) {
  const queryTokens = tokenize(query);
  const textTokens = tokenize(text);
  if (!queryTokens.size || !textTokens.size) return 0;
  const matchedTokens = [];
  for (const token of queryTokens) {
    if (textTokens.has(token)) matchedTokens.push(token);
  }
  if (
    matchedTokens.length < 2 &&
    !matchedTokens.some((token) => CHAT_MEANINGFUL_SINGLE_TOKENS.has(token))
  ) {
    return 0;
  }
  return matchedTokens.length / Math.sqrt(queryTokens.size * textTokens.size);
}

function textOverlapSimilarity(left, right) {
  const leftTokens = tokenize(left);
  const rightTokens = tokenize(right);
  if (!leftTokens.size || !rightTokens.size) return 0;
  let overlap = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) overlap += 1;
  }
  return overlap / Math.min(leftTokens.size, rightTokens.size);
}

function recencyBonus(lastAt) {
  const timestamp = parseTime(lastAt);
  if (!timestamp) return 0;
  const ageDays = Math.max(0, (Date.now() - timestamp) / 86400000);
  return Math.exp(-ageDays / 120) * 0.04;
}

function hasUsefulChatRecallSignal(record) {
  return (
    record.semanticSimilarity >= 0.66 ||
    record.lexicalScore >= 0.12 ||
    (record.semanticSimilarity >= 0.56 && record.lexicalScore >= 0.08)
  );
}

async function searchChatHistory(query, chatId, options = {}) {
  const queryText = String(query || "").trim();
  if (!VECTOR_ENABLED || !queryText) {
    return [];
  }
  const index = loadChatVectorIndex();
  const records = Object.values(index.records).filter(
    (record) =>
      String(record.chatId || "") === String(chatId || "") &&
      (!CHAT_VECTOR_RECENT_EXCLUDE_MS ||
        !parseTime(record.lastAt) ||
        parseTime(record.lastAt) <
          Date.now() - CHAT_VECTOR_RECENT_EXCLUDE_MS)
  );
  if (!records.length) {
    return [];
  }
  const queryVector = Array.isArray(options.queryVector)
    ? options.queryVector
    : (await embedTexts([queryText], 5000))[0];
  if (!queryVector) {
    return [];
  }

  const measured = records.map((record) => ({
    ...record,
    semanticSimilarity: cosineSimilarity(queryVector, record.vector),
    lexicalScore: lexicalSimilarity(
      queryText,
      record.retrievalText || record.text
    )
  }));
  const semanticRank = new Map(
    [...measured]
      .sort((left, right) => right.semanticSimilarity - left.semanticSimilarity)
      .map((record, index) => [record.id, index + 1])
  );
  const lexicalRank = new Map(
    measured
      .filter((record) => record.lexicalScore > 0)
      .sort((left, right) => right.lexicalScore - left.lexicalScore)
      .map((record, index) => [record.id, index + 1])
  );
  const ranked = measured
    .map((record) => {
      const semanticPosition = semanticRank.get(record.id);
      const lexicalPosition = lexicalRank.get(record.id);
      const reciprocalRank =
        (semanticPosition ? 1 / (60 + semanticPosition) : 0) +
        (lexicalPosition ? 1 / (60 + lexicalPosition) : 0);
      return {
        ...record,
        // Hybrid rank fusion rewards agreement between meaning and concrete
        // wording without requiring both scores to share one numeric scale.
        score:
          record.semanticSimilarity * 0.72 +
          Math.min(1, record.lexicalScore * 2.5) * 0.12 +
          reciprocalRank * 4 +
          recencyBonus(record.lastAt)
      };
    })
    .filter(hasUsefulChatRecallSignal)
    .sort((left, right) => right.score - left.score);
  if (!ranked.length || ranked[0].score < MIN_CHAT_RECALL_SCORE) {
    return [];
  }

  // A score window is safer than one strict threshold: subtle daily-chat
  // references often cluster just below the old 0.57 cutoff.
  const cutoff = Math.max(
    MIN_CHAT_RECALL_SCORE,
    ranked[0].score - CHAT_RECALL_SCORE_WINDOW
  );
  const eligible = ranked.filter((record) => record.score >= cutoff);
  const selected = [];
  while (eligible.length && selected.length < MAX_CHAT_RECALLS) {
    let bestIndex = -1;
    let bestDiversifiedScore = Number.NEGATIVE_INFINITY;
    for (let index = 0; index < eligible.length; index += 1) {
      const candidate = eligible[index];
      const duplicate = selected.some(
        (existing) =>
          textOverlapSimilarity(
            existing.retrievalText || existing.text,
            candidate.retrievalText || candidate.text
          ) >= 0.7
      );
      if (duplicate) continue;
      const maxVectorOverlap = selected.reduce(
        (maximum, existing) =>
          Math.max(maximum, cosineSimilarity(existing.vector, candidate.vector)),
        0
      );
      // This light MMR penalty keeps near-identical emotional scenes from
      // occupying every raw-history slot while relevance remains primary.
      const diversifiedScore = candidate.score - maxVectorOverlap * 0.1;
      if (diversifiedScore > bestDiversifiedScore) {
        bestDiversifiedScore = diversifiedScore;
        bestIndex = index;
      }
    }
    if (bestIndex < 0) break;
    const [next] = eligible.splice(bestIndex, 1);
    selected.push(next);
  }
  return selected;
}

function buildChatRetrievalQuery(latestUserMessage, history) {
  const current = String(latestUserMessage || "").replace(/\s+/g, " ").trim();
  if (!current) return "";

  // Most retrieval queries should express only the user's current intent.
  // Previous assistant prose is intentionally excluded because its emotional
  // vocabulary can overpower a short user message in embedding space.
  const needsPriorUserContext =
    current.length <= 12 ||
    /(?:这个|那个|它|刚才|之前|继续|然后呢|还记得|那件事|怎么回事)/.test(
      current
    );
  if (!needsPriorUserContext) {
    return current.slice(0, 600);
  }

  const previousUser = [...(Array.isArray(history) ? history : [])]
    .reverse()
    .map(normalizeMessage)
    .find(
      (message) =>
        message &&
        message.role === "user" &&
        message.content !== current
    );
  return [
    previousUser ? `Previous user context: ${previousUser.content.slice(0, 260)}` : "",
    `Current user focus: ${current.slice(0, 600)}`
  ]
    .filter(Boolean)
    .join("\n");
}

function buildContextualChatRetrievalQuery(latestUserMessage, history) {
  const current = String(latestUserMessage || "").replace(/\s+/g, " ").trim();
  if (!current) return "";

  const needsPriorUserContext =
    current.length <= 80 ||
    /^(?:可是|但是|然后|所以|那|这个|那个|它|他|她|继续|后来|之前|刚才|还|嗯|哎|唉)/.test(
      current
    );
  if (!needsPriorUserContext) {
    return current.slice(0, 600);
  }

  // Two recent user messages usually contain enough referential context for
  // short replies such as "可是呢" without importing the assistant's long
  // emotional prose into the embedding query.
  const normalizedHistory = (Array.isArray(history) ? history : [])
    .map(normalizeMessage)
    .filter(Boolean);
  const currentIndex = normalizedHistory.findLastIndex(
    (message) => message.role === "user" && message.content === current
  );
  const currentMessage =
    currentIndex >= 0 ? normalizedHistory[currentIndex] : null;
  const currentAt = parseTime(currentMessage && currentMessage.at);
  const historyBeforeCurrent =
    currentIndex >= 0
      ? normalizedHistory.slice(0, currentIndex)
      : normalizedHistory;
  const previousUsers = [...historyBeforeCurrent]
    .reverse()
    .filter(
      (message) =>
        message &&
        message.role === "user" &&
        message.content !== current &&
        (!currentAt ||
          !parseTime(message.at) ||
          currentAt - parseTime(message.at) <= CHAT_QUERY_CONTEXT_GAP_MS)
    )
    .slice(0, 2)
    .reverse();
  return [
    ...previousUsers.map(
      (message) => message.content.slice(0, 320)
    ),
    current.slice(0, 600)
  ]
    .filter(Boolean)
    .join("\n");
}

module.exports = {
  CHAT_VECTOR_INDEX_PATH,
  buildChatChunks,
  buildChatRetrievalQuery: buildContextualChatRetrievalQuery,
  indexChatSources,
  loadChatVectorIndex,
  searchChatHistory
};
