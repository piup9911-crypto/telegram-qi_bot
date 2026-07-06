const fs = require("fs");
const path = require("path");
const { ROOT } = require("./cloud-memory-client.cjs");
const {
  GENERATED_DIR: MEMORY_GENERATED_DIR,
  ensureMemoryStructure,
  writeText
} = require("./core-memory-store.cjs");
const {
  ensureLmcStructure,
  listRecords: listLmcRecords
} = require("./lmc-memory-store.cjs");

const DEFAULT_CACHE_PATH = path.join(ROOT, "bridge-state", "shared-memory-cache.json");
const DEFAULT_BRIDGE_WORKSPACE = path.join(ROOT, "bridge-workspace");
const CORE_MEMORY_FILE_NAME = "CORE_MEMORY.md";
// Compatibility export for callers that have not renamed the imported symbol.
const INDEPENDENT_MEMORY_FILE_NAME = CORE_MEMORY_FILE_NAME;
const MAX_STABLE_CURATED_FOR_MODEL = 20;

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(0, ms));
}

function isRetriableFileWriteError(error) {
  const code = String((error && error.code) || "");
  const message = String((error && error.message) || "");
  return (
    ["EBUSY", "EPERM", "EACCES", "UNKNOWN"].includes(code) ||
    /UNKNOWN: unknown error|resource busy|being used by another process/i.test(message)
  );
}

function writeTextFileSyncWithRetry(filePath, value, encoding = "utf8") {
  let lastError = null;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      fs.writeFileSync(filePath, value, encoding);
      return;
    } catch (error) {
      lastError = error;
      if (!isRetriableFileWriteError(error) || attempt === 19) break;
      sleepSync(50 * (attempt + 1));
    }
  }
  throw lastError;
}

function writeJson(filePath, value) {
  ensureDir(path.dirname(filePath));
  writeTextFileSyncWithRetry(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function normalizeTargets(targets) {
  const unique = new Map();
  for (const target of targets || []) {
    if (!target) continue;
    const resolved = path.resolve(target);
    unique.set(resolved.toLowerCase(), resolved);
  }
  return [...unique.values()];
}

function getRecordTime(record) {
  const parsed = Date.parse(record.updatedAt || record.createdAt || "");
  return Number.isFinite(parsed) ? parsed : 0;
}

function listStableCuratedMemories() {
  const latestByContent = new Map();
  for (const record of listLmcRecords("curated_memory")) {
    if (record.kind !== "curated_memory" || !String(record.content || "").trim()) continue;
    if (record.temporalType && record.temporalType !== "stable") continue;
    const key = String(record.content).replace(/\s+/g, " ").trim().toLowerCase();
    const existing = latestByContent.get(key);
    // LMC is authoritative on duplicates. Within LMC, retain the newest copy.
    if (!existing || getRecordTime(record) >= getRecordTime(existing)) {
      latestByContent.set(key, record);
    }
  }
  return [...latestByContent.values()]
    .sort((left, right) => getRecordTime(left) - getRecordTime(right))
    .slice(-MAX_STABLE_CURATED_FOR_MODEL);
}

function buildCoreMemoryLibrary() {
  const records = listStableCuratedMemories();
  const lines = ["## Core Memory", ""];
  if (!records.length) {
    lines.push("(empty)", "");
  } else {
    lines.push("LMC stable curated memory:");
    for (const record of records) lines.push(`- ${String(record.content).trim()}`);
    lines.push("");
  }
  return `${lines.join("\n").trim()}\n`;
}

const buildIndependentMemoryLibrary = buildCoreMemoryLibrary;

async function syncSharedMemory(options = {}) {
  ensureMemoryStructure();
  ensureLmcStructure();
  const coreMemory = buildCoreMemoryLibrary();
  ensureDir(MEMORY_GENERATED_DIR);

  const generatedPath = path.join(MEMORY_GENERATED_DIR, "core-memory.md");
  writeText(generatedPath, coreMemory);

  const targets = normalizeTargets(options.targets || [DEFAULT_BRIDGE_WORKSPACE]);
  const writtenFiles = targets.map((targetDir) => {
    const filePath = path.join(targetDir, CORE_MEMORY_FILE_NAME);
    writeText(filePath, coreMemory);
    return filePath;
  });

  const stableCuratedCount = listStableCuratedMemories().length;
  const cachePath = options.cachePath || DEFAULT_CACHE_PATH;
  writeJson(cachePath, {
    syncedAt: new Date().toISOString(),
    targets: writtenFiles,
    generated: { coreMemory: generatedPath },
    counts: {
      stableCurated: stableCuratedCount
    }
  });

  return {
    ok: true,
    writtenFiles,
    coreMemoryPath: generatedPath,
    counts: { stableCurated: stableCuratedCount }
  };
}

async function main() {
  const result = await syncSharedMemory();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error && error.stack ? error.stack : String(error)}\n`);
    process.exit(1);
  });
}

module.exports = {
  CORE_MEMORY_FILE_NAME,
  DEFAULT_BRIDGE_WORKSPACE,
  DEFAULT_CACHE_PATH,
  INDEPENDENT_MEMORY_FILE_NAME,
  buildCoreMemoryLibrary,
  buildIndependentMemoryLibrary,
  listStableCuratedMemories,
  syncSharedMemory
};
