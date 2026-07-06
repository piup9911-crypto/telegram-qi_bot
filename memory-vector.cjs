const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const path = require("path");
const { ROOT } = require("./cloud-memory-client.cjs");

const VECTOR_INDEX_PATH = path.join(
  ROOT,
  "bridge-state",
  "memory-vector-index.json"
);
const VECTOR_ENABLED =
  String(process.env.MEMORY_VECTOR_ENABLED || "true").toLowerCase() !== "false";
const VECTOR_MODEL = process.env.MEMORY_VECTOR_MODEL || "bge-m3";
const OLLAMA_BASE_URL =
  process.env.MEMORY_VECTOR_OLLAMA_URL || "http://127.0.0.1:11434";
const VECTOR_KEEP_ALIVE =
  process.env.MEMORY_VECTOR_KEEP_ALIVE === undefined
    ? -1
    : process.env.MEMORY_VECTOR_KEEP_ALIVE;
const QUERY_TIMEOUT_MS = Math.max(
  500,
  Number.parseInt(process.env.MEMORY_VECTOR_QUERY_TIMEOUT_MS || "5000", 10) ||
    5000
);
const INDEX_TIMEOUT_MS = Math.max(
  5000,
  Number.parseInt(process.env.MEMORY_VECTOR_INDEX_TIMEOUT_MS || "120000", 10) ||
    120000
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
    version: 1,
    provider: "ollama",
    model: VECTOR_MODEL,
    updatedAt: "",
    records: {}
  };
}

function loadVectorIndex() {
  const raw = readJson(VECTOR_INDEX_PATH, createEmptyIndex());
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

function recordVectorText(record) {
  const metadata = record && record.metadata || {};
  const fields = [
    record && record.title,
    record && record.content,
    ...(Array.isArray(metadata.keywords) ? metadata.keywords : []),
    ...(Array.isArray(metadata.people) ? metadata.people : []),
    ...(Array.isArray(metadata.activeThreads) ? metadata.activeThreads : [])
  ];
  return fields.map((value) => String(value || "").trim()).filter(Boolean).join("\n");
}

function vectorFingerprint(record) {
  return crypto
    .createHash("sha256")
    .update(recordVectorText(record))
    .digest("hex");
}

function requestJson(urlString, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlString);
    const payload = Buffer.from(JSON.stringify(body), "utf8");
    const request = http.request(
      url,
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "Content-Length": payload.length
        },
        timeout: timeoutMs
      },
      (response) => {
        let raw = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          raw += chunk;
        });
        response.on("end", () => {
          clearTimeout(deadline);
          let parsed = null;
          try {
            parsed = raw ? JSON.parse(raw) : null;
          } catch {}
          if (response.statusCode >= 200 && response.statusCode < 300) {
            resolve(parsed || {});
            return;
          }
          reject(
            new Error(
              parsed && (parsed.error || parsed.message) ||
                raw ||
                `Ollama request failed with ${response.statusCode}`
            )
          );
        });
      }
    );
    // request.setTimeout() measures socket inactivity and can start late while
    // Ollama is queueing work. This wall-clock deadline keeps retrieval latency
    // bounded even when another embedding job is already using the model.
    const deadline = setTimeout(() => {
      request.destroy(new Error("Vector embedding request timed out."));
    }, timeoutMs);
    request.on("timeout", () => {
      request.destroy(new Error("Vector embedding request timed out."));
    });
    request.on("error", (error) => {
      clearTimeout(deadline);
      reject(error);
    });
    request.end(payload);
  });
}

async function embedTexts(texts, timeoutMs) {
  if (!VECTOR_ENABLED || !Array.isArray(texts) || texts.length === 0) {
    return [];
  }
  const payload = await requestJson(
    `${OLLAMA_BASE_URL.replace(/\/$/, "")}/api/embed`,
    {
      model: VECTOR_MODEL,
      input: texts,
      truncate: true,
      // The 1.1 GiB bge-m3 model runs on CPU on this machine. Keeping it loaded
      // avoids paying the multi-second model startup cost on the first message
      // after every idle period.
      keep_alive: VECTOR_KEEP_ALIVE
    },
    timeoutMs
  );
  return Array.isArray(payload.embeddings) ? payload.embeddings : [];
}

function cosineSimilarity(left, right) {
  if (
    !Array.isArray(left) ||
    !Array.isArray(right) ||
    left.length === 0 ||
    left.length !== right.length
  ) {
    return 0;
  }
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    const leftValue = Number(left[index]) || 0;
    const rightValue = Number(right[index]) || 0;
    dot += leftValue * rightValue;
    leftNorm += leftValue * leftValue;
    rightNorm += rightValue * rightValue;
  }
  if (!leftNorm || !rightNorm) {
    return 0;
  }
  return dot / Math.sqrt(leftNorm * rightNorm);
}

async function indexMemoryRecords(records) {
  if (!VECTOR_ENABLED || !Array.isArray(records) || records.length === 0) {
    return { enabled: VECTOR_ENABLED, indexed: 0, skipped: true };
  }

  const index = loadVectorIndex();
  const pending = records.filter((record) => {
    const existing = index.records[record.id];
    return (
      record &&
      record.id &&
      record.content &&
      (!existing || existing.fingerprint !== vectorFingerprint(record))
    );
  });
  if (!pending.length) {
    return { enabled: true, indexed: 0, skipped: true };
  }

  const embeddings = await embedTexts(
    pending.map(recordVectorText),
    INDEX_TIMEOUT_MS
  );
  if (embeddings.length !== pending.length) {
    throw new Error("Ollama returned an unexpected number of memory embeddings.");
  }

  pending.forEach((record, recordIndex) => {
    index.records[record.id] = {
      fingerprint: vectorFingerprint(record),
      vector: embeddings[recordIndex],
      updatedAt: new Date().toISOString()
    };
  });
  index.updatedAt = new Date().toISOString();
  writeJson(VECTOR_INDEX_PATH, index);
  return { enabled: true, indexed: pending.length, skipped: false };
}

async function getVectorSimilarities(query, records, queryVectorOverride) {
  if (!VECTOR_ENABLED || !String(query || "").trim() || !records.length) {
    return new Map();
  }

  const index = loadVectorIndex();
  const queryVector = Array.isArray(queryVectorOverride)
    ? queryVectorOverride
    : (await embedTexts([String(query).trim()], QUERY_TIMEOUT_MS))[0];
  if (!queryVector) {
    return new Map();
  }

  const similarities = new Map();
  for (const record of records) {
    const indexed = index.records[record.id];
    if (!indexed || indexed.fingerprint !== vectorFingerprint(record)) {
      continue;
    }
    const similarity = cosineSimilarity(queryVector, indexed.vector);
    if (Number.isFinite(similarity)) {
      similarities.set(record.id, similarity);
    }
  }
  return similarities;
}

module.exports = {
  VECTOR_ENABLED,
  VECTOR_INDEX_PATH,
  VECTOR_KEEP_ALIVE,
  VECTOR_MODEL,
  cosineSimilarity,
  embedTexts,
  getVectorSimilarities,
  indexMemoryRecords,
  loadVectorIndex,
  recordVectorText,
  vectorFingerprint
};
