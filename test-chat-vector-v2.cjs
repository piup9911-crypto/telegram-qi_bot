const fs = require("fs");
const path = require("path");
const { cosineSimilarity, embedTexts } = require("./memory-vector.cjs");
const { searchChatHistory } = require("./chat-vector-memory.cjs");
const { loadChatVectorV2Index } = require("./chat-vector-memory-v2.cjs");

const ROOT = __dirname;
const CHAT_STATE_DIR = path.join(ROOT, "bridge-state", "chats");
const DEFAULT_LIMIT = 6;
const DEFAULT_CHAT_ID = process.env.TEST_CHAT_ID || findDefaultChatId();
const JSON_MODE = process.argv.includes("--json");

const DEFAULT_QUERIES = [
  "我们之前怎么设计记忆系统？",
  "最近在优化什么？",
  "之前说过小手机和酒馆连接问题吗？",
  "Telegram 图片和附件为什么看不到？",
  "我喜欢怎么称呼？"
];

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function findDefaultChatId() {
  try {
    const candidates = fs
      .readdirSync(CHAT_STATE_DIR, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => {
        const filePath = path.join(CHAT_STATE_DIR, entry.name);
        const state = readJson(filePath, {});
        const historyLength = Array.isArray(state.history) ? state.history.length : 0;
        return {
          chatId: String(state.chatId || path.basename(entry.name, ".json")),
          historyLength
        };
      })
      .sort((left, right) => right.historyLength - left.historyLength);
    return candidates[0] ? candidates[0].chatId : "";
  } catch {
    return "";
  }
}

function parseTime(value) {
  const timestamp = Date.parse(String(value || ""));
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function tokenize(value) {
  const text = String(value || "").toLowerCase();
  const tokens = new Set();
  for (const match of text.matchAll(/[a-z0-9]+|[\u3400-\u9fff]{1,2}/gi)) {
    tokens.add(match[0]);
  }
  return tokens;
}

function lexicalSimilarity(left, right) {
  const leftTokens = tokenize(left);
  const rightTokens = tokenize(right);
  if (!leftTokens.size || !rightTokens.size) return 0;
  let overlap = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) overlap += 1;
  }
  return overlap / Math.sqrt(leftTokens.size * rightTokens.size);
}

function recencyBonus(lastAt) {
  const timestamp = parseTime(lastAt);
  if (!timestamp) return 0;
  const ageDays = Math.max(0, (Date.now() - timestamp) / 86400000);
  return Math.exp(-ageDays / 120) * 0.04;
}

function compactText(value, maxLength) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}...` : text;
}

function summarizeMatches(matches) {
  const sourceKinds = {};
  let firstAt = "";
  let lastAt = "";
  for (const item of matches) {
    const sourceKind = item.sourceKind || "unknown";
    sourceKinds[sourceKind] = (sourceKinds[sourceKind] || 0) + 1;
    const itemFirst = parseTime(item.firstAt);
    const itemLast = parseTime(item.lastAt);
    if (itemFirst && (!firstAt || itemFirst < parseTime(firstAt))) firstAt = item.firstAt;
    if (itemLast && (!lastAt || itemLast > parseTime(lastAt))) lastAt = item.lastAt;
  }
  return {
    count: matches.length,
    sourceKinds,
    firstAt: firstAt ? new Date(parseTime(firstAt)).toISOString().slice(0, 10) : "",
    lastAt: lastAt ? new Date(parseTime(lastAt)).toISOString().slice(0, 10) : "",
    previews: matches.slice(0, 3).map((item) => ({
      sourceKind: item.sourceKind || "unknown",
      date: item.lastAt ? new Date(parseTime(item.lastAt)).toISOString().slice(0, 10) : "",
      score: round(item.score),
      semantic: round(item.semanticSimilarity),
      lexical: round(item.lexicalScore),
      preview: compactText(item.retrievalText || item.text || item.preview, 90)
    }))
  };
}

function verdictFor(result) {
  if (result.error) return "ERROR";
  const v2Count = result.v2.count;
  const v2Top = result.v2.previews[0] || {};
  if (!v2Count) return "WARN no v2 match";
  if (/称呼|喜欢|偏好|人格|设定/.test(result.query) && v2Top.lexical < 0.12) {
    return "NOTE better answered by LMC/core memory";
  }
  if (/称呼|喜欢|偏好|人格|设定/.test(result.query) && v2Top.semantic < 0.62) {
    return "NOTE better answered by LMC/core memory";
  }
  if (v2Top.semantic < 0.5 && v2Top.lexical < 0.12) return "WARN weak top match";
  if (result.v2Ms > 500) return "WARN slow v2";
  return "OK";
}

function printHumanReport(payload) {
  const lines = [];
  lines.push(`Chat vector V2 shadow test`);
  lines.push(`chatId: ${payload.chatId}`);
  lines.push(`queries: ${payload.queryCount}`);
  lines.push("");
  for (const result of payload.results) {
    lines.push(`- ${result.query}`);
    if (result.error) {
      lines.push(`  verdict: ERROR ${result.error}`);
      continue;
    }
    lines.push(`  verdict: ${verdictFor(result)}`);
    lines.push(`  time: embed ${result.embedMs}ms, v1 ${result.v1Ms}ms, v2 ${result.v2Ms}ms`);
    lines.push(
      `  v1: ${result.v1.count} hits, ${JSON.stringify(result.v1.sourceKinds)}, ${result.v1.firstAt || "?"}..${result.v1.lastAt || "?"}`
    );
    lines.push(
      `  v2: ${result.v2.count} hits, ${JSON.stringify(result.v2.sourceKinds)}, ${result.v2.firstAt || "?"}..${result.v2.lastAt || "?"}`
    );
    const top = result.v2.previews[0];
    if (top) {
      lines.push(
        `  v2 top: ${top.date || "?"} ${top.sourceKind} score=${top.score} semantic=${top.semantic} lexical=${top.lexical}`
      );
      lines.push(`  preview: ${top.preview}`);
    }
    lines.push("");
  }
  process.stdout.write(`${lines.join("\n")}\n`);
}

function round(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number * 1000) / 1000 : 0;
}

async function searchV2(query, chatId, queryVector, limit = DEFAULT_LIMIT) {
  const index = loadChatVectorV2Index();
  const records = Object.values(index.records || {}).filter(
    (record) => String(record.chatId || "") === String(chatId || "")
  );

  // This mirrors the current hybrid idea without replacing production code:
  // semantic similarity finds meaning, lexical overlap catches exact names, and
  // a tiny recency bonus prevents very old weak matches from dominating.
  return records
    .map((record) => {
      const text = record.retrievalText || record.text || "";
      const semanticSimilarity = cosineSimilarity(queryVector, record.vector);
      const lexicalScore = lexicalSimilarity(query, text);
      const score =
        semanticSimilarity * 0.72 +
        Math.min(1, lexicalScore * 2.5) * 0.14 +
        recencyBonus(record.lastAt);
      return {
        ...record,
        semanticSimilarity,
        lexicalScore,
        score
      };
    })
    .filter(
      (record) =>
        record.semanticSimilarity >= 0.55 ||
        record.lexicalScore >= 0.1 ||
        (record.semanticSimilarity >= 0.48 && record.lexicalScore >= 0.06)
    )
    .sort((left, right) => right.score - left.score)
    .slice(0, limit);
}

async function runOne(query, chatId) {
  const startedAt = Date.now();
  const [queryVector] = await embedTexts([query], 120000);
  const embedMs = Date.now() - startedAt;
  if (!queryVector) {
    return { query, error: "embedding unavailable" };
  }

  const v1StartedAt = Date.now();
  const v1Matches = await searchChatHistory(query, chatId, { queryVector });
  const v1Ms = Date.now() - v1StartedAt;

  const v2StartedAt = Date.now();
  const v2Matches = await searchV2(query, chatId, queryVector);
  const v2Ms = Date.now() - v2StartedAt;

  return {
    query,
    embedMs,
    v1Ms,
    v2Ms,
    v1: summarizeMatches(v1Matches),
    v2: summarizeMatches(v2Matches)
  };
}

async function main() {
  const queries = process.argv.slice(2).filter((item) => item !== "--json");
  const testQueries = queries.length ? queries : DEFAULT_QUERIES;
  if (!DEFAULT_CHAT_ID) {
    throw new Error("No chat id found. Set TEST_CHAT_ID=<telegram_chat_id> and retry.");
  }

  const results = [];
  for (const query of testQueries) {
    results.push(await runOne(query, DEFAULT_CHAT_ID));
  }

  const payload = {
    ok: true,
    chatId: DEFAULT_CHAT_ID,
    queryCount: testQueries.length,
    results
  };

  if (JSON_MODE) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } else {
    printHumanReport(payload);
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exit(1);
});
