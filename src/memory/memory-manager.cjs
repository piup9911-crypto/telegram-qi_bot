const fs = require("fs");
const http = require("http");
const path = require("path");

const {
  deleteExpiredTrash,
  deleteRecord,
  ensureMemoryStructure,
  getRecordById: getCoreRecordById,
  listRecords: listCoreRecords,
  moveRecordToTrash,
  updateRecord: updateCoreRecord
} = require("./core-memory-store.cjs");
const {
  ensureLmcStructure,
  listRecords: listLmcRecords,
  lmcSearchableRecords,
  updateRecord: updateLmcRecord
} = require("../memory/lmc-memory-store.cjs");
const { indexMemoryRecords } = require("../memory/memory-vector.cjs");
const { syncSharedMemory } = require("../memory/shared-memory-sync.cjs");

const HOST = process.env.MEMORY_MANAGER_HOST || "127.0.0.1";
const PORT = Math.max(1, Number.parseInt(process.env.MEMORY_MANAGER_PORT || "4142", 10) || 4142);
const PAGE_PATH = path.join(path.resolve(__dirname, "..", ".."), "ui", "memory-manager.html");
const MAX_REQUEST_BYTES = 1024 * 1024;

function log(...args) {
  process.stderr.write(`[memory-manager] ${args.map(String).join(" ")}\n`);
}

function json(res, status, payload) {
  res.writeHead(status, {
    "Cache-Control": "no-store, max-age=0",
    "Content-Type": "application/json; charset=utf-8"
  });
  res.end(`${JSON.stringify(payload, null, 2)}\n`);
}

function lmcSection(record) {
  if (record.kind === "long_term") return "longTerm";
  if (record.temporalType === "temporary") return "lmcTemporary";
  if (record.temporalType === "search_only" || record.searchOnly) return "lmcSearchOnly";
  if (record.storageKind === "event_chunk" || record.temporalType === "event") return "lmcEvent";
  return "lmcStable";
}

function managerRecord(record) {
  const isChunk = record.storageKind === "event_chunk";
  return {
    id: record.id,
    section: lmcSection(record),
    title: record.title || (isChunk ? "Life event" : "LMC memory"),
    content: isChunk ? record.summary || record.text || "" : record.content || "",
    createdAt: record.createdAt || "",
    updatedAt: record.updatedAt || "",
    kind: record.kind,
    temporalType: record.temporalType || "stable",
    lmc: true
  };
}

function listAllSections() {
  const sections = {
    longTerm: [],
    privateMemory: listCoreRecords("private"),
    trash: listCoreRecords("trash"),
    lmcStable: [],
    lmcTemporary: [],
    lmcEvent: [],
    lmcSearchOnly: []
  };
  const lmcRecords = [
    ...listLmcRecords("curated_memory"),
    ...listLmcRecords("event_chunk")
  ];
  for (const record of lmcRecords) {
    const item = managerRecord(record);
    sections[item.section].push(item);
  }
  return sections;
}

function findLmcRecord(id) {
  return [
    ...listLmcRecords("curated_memory"),
    ...listLmcRecords("event_chunk")
  ].find((record) => record.id === id) || null;
}

async function readJsonBody(req) {
  return await new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > MAX_REQUEST_BYTES) {
        reject(new Error("Request body too large."));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

async function rebuildReadableMemory() {
  try {
    return await syncSharedMemory();
  } catch (error) {
    log("non-fatal sync warning", error && error.message ? error.message : error);
    return null;
  }
}

async function handleListMemory(res) {
  deleteExpiredTrash();
  await rebuildReadableMemory();
  json(res, 200, { sections: listAllSections() });
}

async function handleUpdateRecord(req, res, recordId) {
  const payload = await readJsonBody(req);
  const content = typeof payload.content === "string" ? payload.content.trim() : "";
  if (!content) {
    json(res, 400, { error: "Memory content cannot be empty." });
    return;
  }

  const lmcRecord = findLmcRecord(recordId);
  if (lmcRecord) {
    const contentField = lmcRecord.storageKind === "event_chunk"
      ? (lmcRecord.summary ? "summary" : "text")
      : "content";
    const saved = updateLmcRecord(lmcRecord, { [contentField]: content });
    const indexRecord = lmcSearchableRecords({
      allowHistorical: true,
      allowSearchEvidence: true
    }).find((record) => record.id === saved.id);
    if (indexRecord) await indexMemoryRecords([indexRecord]);
    await rebuildReadableMemory();
    json(res, 200, { record: managerRecord(saved) });
    return;
  }

  const coreRecord = getCoreRecordById(recordId);
  if (!coreRecord) {
    json(res, 404, { error: "Memory record not found." });
    return;
  }
  const saved = updateCoreRecord(coreRecord, {
    title: typeof payload.title === "string" ? payload.title : coreRecord.title,
    content
  });
  json(res, 200, { record: saved });
}

async function handleTrashRecord(res, recordId) {
  const record = getCoreRecordById(recordId);
  if (!record) {
    json(res, 400, { error: "Only private/core records can be moved to trash." });
    return;
  }
  const saved = moveRecordToTrash(record, { trashedBy: "memory-manager" });
  json(res, 200, { record: saved });
}

async function handleDeleteRecord(res, recordId) {
  const record = getCoreRecordById(recordId);
  if (!record || record.section !== "trash") {
    json(res, 400, { error: "Only trash records can be permanently deleted." });
    return;
  }
  json(res, deleteRecord(record) ? 200 : 500, { ok: true, deletedId: record.id });
}

async function routeRequest(req, res) {
  const url = new URL(req.url || "/", `http://${req.headers.host || `${HOST}:${PORT}`}`);
  if (req.method === "OPTIONS") {
    res.writeHead(204, { Allow: "GET, PATCH, POST, DELETE, OPTIONS" });
    res.end();
    return;
  }
  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/memory")) {
    res.writeHead(200, { "Cache-Control": "no-store", "Content-Type": "text/html; charset=utf-8" });
    res.end(fs.readFileSync(PAGE_PATH, "utf8"));
    return;
  }
  if (req.method === "GET" && url.pathname === "/health") {
    json(res, 200, { ok: true, service: "memory-manager", host: HOST, port: PORT });
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/memory") {
    await handleListMemory(res);
    return;
  }
  const recordMatch = url.pathname.match(/^\/api\/memory\/([^/]+)$/);
  if (recordMatch && req.method === "PATCH") {
    await handleUpdateRecord(req, res, decodeURIComponent(recordMatch[1]));
    return;
  }
  const trashMatch = url.pathname.match(/^\/api\/memory\/([^/]+)\/trash$/);
  if (trashMatch && req.method === "POST") {
    await handleTrashRecord(res, decodeURIComponent(trashMatch[1]));
    return;
  }
  if (recordMatch && req.method === "DELETE") {
    await handleDeleteRecord(res, decodeURIComponent(recordMatch[1]));
    return;
  }
  json(res, 404, { error: "Not found" });
}

async function main() {
  ensureMemoryStructure();
  ensureLmcStructure();
  deleteExpiredTrash();
  await rebuildReadableMemory();
  const server = http.createServer((req, res) => {
    routeRequest(req, res).catch((error) => {
      log(error && error.stack ? error.stack : error);
      json(res, 500, { error: error && error.message ? error.message : String(error) });
    });
  });
  server.listen(PORT, HOST, () => log(`listening on http://${HOST}:${PORT}`));
}

if (require.main === module) {
  main().catch((error) => {
    log(error && error.stack ? error.stack : error);
    process.exitCode = 1;
  });
}

module.exports = { listAllSections, managerRecord, routeRequest };
