const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { ROOT } = require("./cloud-memory-client.cjs");

// core-memory-store now only owns generated CORE_MEMORY.md output. Legacy
// non-LMC memory regions were retired after the LMC migration.
const MEMORY_ROOT = path.join(ROOT, "memory-docs");
const GENERATED_DIR = path.join(MEMORY_ROOT, "generated");
const CORE_MEMORY_INDEX_PATH = path.join(MEMORY_ROOT, "index.json");

const MEMORY_META_OPEN = "<!-- MEMORY_META";
const MEMORY_META_CLOSE = "-->";

const SECTION_TO_DIR = {};
const MEMORY_SECTIONS = Object.freeze(Object.keys(SECTION_TO_DIR));

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

function ensureMemoryStructure() {
  ensureDir(GENERATED_DIR);
}

function readText(filePath, fallback = "") {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return fallback;
  }
}

function writeText(filePath, value) {
  ensureDir(path.dirname(filePath));
  writeTextFileSyncWithRetry(filePath, value, "utf8");
}

function writeJson(filePath, value) {
  ensureDir(path.dirname(filePath));
  writeTextFileSyncWithRetry(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function createMemoryId() {
  return crypto.randomBytes(16).toString("hex");
}

function safeSlug(input) {
  return String(input || "")
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "memory";
}

function buildMemoryFileName(record) {
  const createdAt = String(record.createdAt || new Date().toISOString())
    .replace(/[:.]/g, "-")
    .replace("T", "_")
    .replace("Z", "");
  const slug = safeSlug(record.title || record.kind || record.section);
  return `${createdAt}__${slug}__${String(record.id || "").slice(0, 8)}.md`;
}

function normalizeRecord(record) {
  const now = new Date().toISOString();
  return {
    id: String(record.id || createMemoryId()),
    section: String(record.section || "private"),
    kind: String(record.kind || record.section || "private"),
    title: String(record.title || ""),
    content: String(record.content || "").trim(),
    createdAt: String(record.createdAt || now),
    updatedAt: String(record.updatedAt || now),
    trashedAt: record.trashedAt ? String(record.trashedAt) : "",
    sourceChannel: String(record.sourceChannel || ""),
    sourceRef: String(record.sourceRef || ""),
    firstMessageAt: String(record.firstMessageAt || ""),
    lastMessageAt: String(record.lastMessageAt || ""),
    batchStart: Number.isInteger(record.batchStart) ? record.batchStart : null,
    batchEnd: Number.isInteger(record.batchEnd) ? record.batchEnd : null,
    messageCount: Number.isInteger(record.messageCount) ? record.messageCount : 0,
    copiedFrom: String(record.copiedFrom || ""),
    derivedFrom: Array.isArray(record.derivedFrom)
      ? record.derivedFrom.map((item) => String(item || "")).filter(Boolean)
      : [],
    generationSignature: String(record.generationSignature || ""),
    // Keep the physical file identity outside serialized metadata. Updates must
    // rewrite the existing Markdown file instead of creating another file with
    // the same logical memory id whenever its title changes.
    filePath: record.filePath ? String(record.filePath) : "",
    metadata: record.metadata && typeof record.metadata === "object"
      ? record.metadata
      : {}
  };
}

function serializeRecord(record) {
  const normalized = normalizeRecord(record);
  // Store metadata inside an HTML comment so each memory remains a normal
  // editable Markdown file while still carrying lifecycle fields for the tools.
  const metadata = {
    id: normalized.id,
    section: normalized.section,
    kind: normalized.kind,
    title: normalized.title,
    createdAt: normalized.createdAt,
    updatedAt: normalized.updatedAt,
    trashedAt: normalized.trashedAt,
    sourceChannel: normalized.sourceChannel,
    sourceRef: normalized.sourceRef,
    firstMessageAt: normalized.firstMessageAt,
    lastMessageAt: normalized.lastMessageAt,
    batchStart: normalized.batchStart,
    batchEnd: normalized.batchEnd,
    messageCount: normalized.messageCount,
    copiedFrom: normalized.copiedFrom,
    derivedFrom: normalized.derivedFrom,
    generationSignature: normalized.generationSignature,
    metadata: normalized.metadata
  };

  return [
    MEMORY_META_OPEN,
    JSON.stringify(metadata, null, 2),
    MEMORY_META_CLOSE,
    "",
    normalized.content,
    ""
  ].join("\n");
}

function parseRecordText(text) {
  const normalizedText = String(text || "");
  if (!normalizedText.startsWith(MEMORY_META_OPEN)) {
    return null;
  }

  const closeIndex = normalizedText.indexOf(MEMORY_META_CLOSE);
  if (closeIndex === -1) {
    return null;
  }

  const metadataText = normalizedText
    .slice(MEMORY_META_OPEN.length, closeIndex)
    .trim();
  const body = normalizedText.slice(closeIndex + MEMORY_META_CLOSE.length).trim();

  try {
    const metadata = JSON.parse(metadataText);
    return normalizeRecord({
      ...metadata,
      content: body
    });
  } catch {
    return null;
  }
}

function getSectionDirectory(section) {
  const directory = SECTION_TO_DIR[section];
  if (!directory) {
    return null;
  }
  return directory;
}

function listSectionFiles(section) {
  const directory = getSectionDirectory(section);
  if (!fs.existsSync(directory)) {
    return [];
  }
  return fs
    .readdirSync(directory)
    .filter((name) => name.endsWith(".md"))
    .map((name) => path.join(directory, name));
}

function readRecord(filePath) {
  const parsed = parseRecordText(readText(filePath, ""));
  if (!parsed) {
    return null;
  }

  return {
    ...parsed,
    filePath
  };
}

function listRecords(section) {
  const records = listSectionFiles(section)
    .map((filePath) => readRecord(filePath))
    .filter(Boolean);
  const latestById = new Map();
  for (const record of records) {
    const existing = latestById.get(record.id);
    const existingTime = Date.parse(
      existing && (existing.updatedAt || existing.createdAt)
    );
    const recordTime = Date.parse(record.updatedAt || record.createdAt);
    if (
      !existing ||
      (Number.isFinite(recordTime) ? recordTime : 0) >=
        (Number.isFinite(existingTime) ? existingTime : 0)
    ) {
      latestById.set(record.id, record);
    }
  }
  return [...latestById.values()]
    .sort((left, right) => {
      const leftTime = new Date(left.lastMessageAt || left.createdAt || 0).getTime();
      const rightTime = new Date(right.lastMessageAt || right.createdAt || 0).getTime();
      return leftTime - rightTime;
    });
}

function saveRecord(record, preferredDirectory) {
  const normalized = normalizeRecord(record);
  const directory = preferredDirectory || getSectionDirectory(normalized.section);
  if (!directory) {
    throw new Error(`Legacy memory section is retired: ${normalized.section}`);
  }
  const fileName =
    normalized.filePath && path.dirname(normalized.filePath) === directory
      ? path.basename(normalized.filePath)
      : buildMemoryFileName(normalized);
  const filePath = path.join(directory, fileName);

  writeText(filePath, serializeRecord(normalized));
  return {
    ...normalized,
    filePath
  };
}

function createRecord(record) {
  ensureMemoryStructure();
  return saveRecord(record);
}

function updateRecord(record, updates = {}) {
  return saveRecord({
    ...record,
    ...updates,
    updatedAt: new Date().toISOString()
  });
}

function moveRecordToTrash(record, extraMetadata = {}) {
  throw new Error("Legacy trash storage is retired; active memory now lives in LMC.");
}

function cloneRecordToSection(record, section, overrides = {}) {
  // Cloning intentionally creates a new independent memory. The copiedFrom field
  // is only provenance metadata; edits must never propagate back to the source.
  return createRecord({
    ...record,
    ...overrides,
    id: createMemoryId(),
    section,
    kind: section,
    copiedFrom: record.id,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    trashedAt: "",
    filePath: undefined
  });
}

function createGenerationSignature(recordIds) {
  return crypto
    .createHash("sha256")
    .update(recordIds.join("|"))
    .digest("hex");
}

function loadIndex() {
  return readText(CORE_MEMORY_INDEX_PATH, "").trim()
    ? JSON.parse(readText(CORE_MEMORY_INDEX_PATH, "{}"))
    : {};
}

function saveIndex(index) {
  writeJson(CORE_MEMORY_INDEX_PATH, index);
}

function listAllRecords() {
  return [];
}

function getRecordById(recordId) {
  const normalizedId = String(recordId || "").trim();
  if (!normalizedId) {
    return null;
  }

  return listAllRecords().find((record) => record.id === normalizedId) || null;
}

function deleteRecord(record) {
  const target = typeof record === "string" ? getRecordById(record) : record;
  if (!target || !target.filePath) {
    return false;
  }

  try {
    fs.unlinkSync(target.filePath);
    return true;
  } catch {
    return false;
  }
}

function deleteExpiredTrash() {
  ensureMemoryStructure();
  return [];
}

module.exports = {
  GENERATED_DIR,
  CORE_MEMORY_INDEX_PATH,
  MEMORY_SECTIONS,
  MEMORY_ROOT,
  cloneRecordToSection,
  createGenerationSignature,
  createRecord,
  deleteExpiredTrash,
  deleteRecord,
  ensureMemoryStructure,
  getRecordById,
  listRecords,
  moveRecordToTrash,
  normalizeRecord,
  parseRecordText,
  readRecord,
  saveRecord,
  serializeRecord,
  updateRecord,
  writeText
};
