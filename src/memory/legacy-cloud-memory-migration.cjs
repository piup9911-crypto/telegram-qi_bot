const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const {
  ROOT,
  fetchSharedMemoryBundle,
  getSharedMemoryConfig
} = require("../adapters/cloud-memory-client.cjs");
const {
  MEMORY_SECTIONS,
  createRecord,
  ensureMemoryStructure,
  listRecords
} = require("./core-memory-store.cjs");
const {
  listRecords: listLmcRecords,
  saveRecord: saveLmcRecord
} = require("../memory/lmc-memory-store.cjs");

const MIGRATION_STATE_PATH = path.join(
  ROOT,
  "bridge-state",
  "legacy-cloud-memory-migration.json"
);
const DEFAULT_PENDING_TARGET = "private";

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(filePath, value) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function hashText(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

function normalizeContent(value) {
  return String(value || "")
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function normalizeTitle(value, fallback) {
  return String(value || fallback || "legacy memory").trim().slice(0, 80);
}

function extractEntryContent(entry) {
  if (typeof entry === "string") {
    return normalizeContent(entry);
  }

  if (!entry || typeof entry !== "object") {
    return "";
  }

  // The old cloud API has changed shape during development. Keep this extractor
  // intentionally tolerant so the one-time migration can rescue old approved /
  // pending text without depending on one exact historical schema.
  const directFields = [
    "memory",
    "content",
    "text",
    "summary",
    "value",
    "note",
    "description"
  ];
  for (const field of directFields) {
    if (typeof entry[field] === "string" && entry[field].trim()) {
      return normalizeContent(entry[field]);
    }
  }

  if (entry.memory && typeof entry.memory === "object") {
    return extractEntryContent(entry.memory);
  }

  return "";
}

function getEntryExternalId(entry) {
  if (!entry || typeof entry !== "object") {
    return "";
  }

  return String(
    entry.id ||
      entry.uuid ||
      entry.key ||
      entry.createdAt ||
      entry.updatedAt ||
      ""
  ).trim();
}

function getEntryTitle(entry, fallback) {
  if (!entry || typeof entry !== "object") {
    return fallback;
  }

  return normalizeTitle(entry.title || entry.name || entry.label, fallback);
}

function normalizePendingTarget(value) {
  const target = String(value || DEFAULT_PENDING_TARGET).trim();
  if (target === "private" || target === "trash" || target === "long_term") {
    return target;
  }
  return DEFAULT_PENDING_TARGET;
}

function loadMigrationState() {
  return readJson(MIGRATION_STATE_PATH, {
    version: 1,
    completedAt: "",
    runs: []
  });
}

function saveMigrationState(state) {
  writeJson(MIGRATION_STATE_PATH, {
    version: 1,
    ...state
  });
}

function collectExistingLegacyMarkers() {
  const keys = new Set();
  const contentHashes = new Set();

  for (const section of MEMORY_SECTIONS) {
    for (const record of listRecords(section)) {
      const metadata = record.metadata || {};
      if (metadata.legacyCloudKey) {
        keys.add(String(metadata.legacyCloudKey));
      }
      const contentHash = hashText(normalizeContent(record.content));
      if (contentHash) {
        contentHashes.add(contentHash);
      }
    }
  }
  for (const record of listLmcRecords("curated_memory")) {
    const metadata = record.metadata || {};
    if (metadata.legacyCloudKey) keys.add(String(metadata.legacyCloudKey));
    const contentHash = hashText(normalizeContent(record.content));
    if (contentHash) contentHashes.add(contentHash);
  }

  return { keys, contentHashes };
}

function buildLegacyKey(status, entry, content) {
  const externalId = getEntryExternalId(entry);
  return [
    "legacy-cloud",
    status,
    externalId || hashText(content).slice(0, 24)
  ].join(":");
}

function toRecordSpec(status, entry, options = {}) {
  const content = extractEntryContent(entry);
  if (!content) {
    return null;
  }

  const pendingTarget = normalizePendingTarget(options.pendingTarget);
  const section =
    status === "approved" || status === "shared_content"
      ? "long_term"
      : pendingTarget;
  const now = new Date().toISOString();
  const legacyKey = buildLegacyKey(status, entry, content);

  return {
    section,
    kind: section,
    title: getEntryTitle(
      entry,
      status === "approved" || status === "shared_content"
        ? "legacy approved memory"
        : "legacy pending memory"
    ),
    content,
    createdAt:
      entry && typeof entry === "object" && entry.createdAt
        ? String(entry.createdAt)
        : now,
    updatedAt: now,
    trashedAt: section === "trash" ? now : "",
    sourceChannel: "legacy_cloud",
    sourceRef: legacyKey,
    metadata: {
      migratedFromLegacyCloud: true,
      legacyStatus: status,
      legacyCloudKey: legacyKey,
      legacyExternalId: getEntryExternalId(entry),
      pendingTarget: status === "pending" ? pendingTarget : ""
    }
  };
}

function collectLegacyRecordSpecs(bundle, options = {}) {
  const specs = [];
  const approvedEntries = Array.isArray(bundle && bundle.approvedEntries)
    ? bundle.approvedEntries
    : [];
  const pendingEntries = Array.isArray(bundle && bundle.pendingEntries)
    ? bundle.pendingEntries
    : [];
  const sharedContent = normalizeContent(bundle && bundle.content);

  for (const entry of approvedEntries) {
    const spec = toRecordSpec("approved", entry, options);
    if (spec) specs.push(spec);
  }

  // Older versions stored one plain shared-memory string instead of structured
  // entries. Treat that as long-term memory so it is not lost when the old
  // pending/approved system is retired.
  if (sharedContent) {
    const spec = toRecordSpec(
      "shared_content",
      {
        id: `shared-content:${hashText(sharedContent).slice(0, 16)}`,
        title: "legacy shared memory",
        content: sharedContent,
        updatedAt: bundle && bundle.updatedAt
      },
      options
    );
    if (spec) specs.push(spec);
  }

  for (const entry of pendingEntries) {
    const spec = toRecordSpec("pending", entry, options);
    if (spec) specs.push(spec);
  }

  return specs;
}

async function migrateLegacyCloudMemoryOnce(options = {}) {
  ensureMemoryStructure();
  const state = loadMigrationState();
  if (state.completedAt && !options.force) {
    return {
      ok: true,
      skipped: true,
      reason: "Legacy cloud memory migration already completed.",
      statePath: MIGRATION_STATE_PATH
    };
  }

  const config = getSharedMemoryConfig();
  if (!config.apiUrl || !config.syncToken) {
    return {
      ok: false,
      skipped: true,
      reason: "Legacy cloud memory API is not configured."
    };
  }

  const bundle = await fetchSharedMemoryBundle({
    clientName: options.clientName || "legacy-cloud-memory-migration",
    timeoutMs: options.timeoutMs || 10000
  });
  if (!bundle.ok) {
    return bundle;
  }

  const markers = collectExistingLegacyMarkers();
  const specs = collectLegacyRecordSpecs(bundle, {
    pendingTarget: options.pendingTarget || DEFAULT_PENDING_TARGET
  });
  const createdRecords = [];
  let skippedDuplicateCount = 0;

  for (const spec of specs) {
    const legacyKey = spec.metadata && spec.metadata.legacyCloudKey;
    const contentHash = hashText(spec.content);
    if (markers.keys.has(legacyKey) || markers.contentHashes.has(contentHash)) {
      skippedDuplicateCount += 1;
      continue;
    }

    const saved = options.dryRun
      ? spec
      : spec.section === "long_term"
        ? saveLmcRecord("curated_memory", {
            ...spec,
            kind: "long_term",
            status: "current"
          })
        : createRecord(spec);
    createdRecords.push(saved);
    markers.keys.add(legacyKey);
    markers.contentHashes.add(contentHash);
  }

  const run = {
    at: new Date().toISOString(),
    dryRun: Boolean(options.dryRun),
    pendingTarget: normalizePendingTarget(options.pendingTarget),
    approvedCount: Array.isArray(bundle.approvedEntries)
      ? bundle.approvedEntries.length
      : 0,
    pendingCount: Array.isArray(bundle.pendingEntries)
      ? bundle.pendingEntries.length
      : 0,
    hadSharedContent: Boolean(normalizeContent(bundle.content)),
    createdCount: createdRecords.length,
    skippedDuplicateCount
  };

  const nextState = {
    ...state,
    completedAt: options.dryRun ? state.completedAt || "" : run.at,
    runs: [...(Array.isArray(state.runs) ? state.runs : []), run].slice(-20)
  };
  if (!options.dryRun) {
    saveMigrationState(nextState);
  }

  return {
    ok: true,
    skipped: false,
    statePath: MIGRATION_STATE_PATH,
    ...run,
    createdRecords: createdRecords.map((record) => ({
      id: record.id,
      section: record.section,
      title: record.title,
      filePath: record.filePath || ""
    }))
  };
}

async function main() {
  const args = process.argv.slice(2);
  const force = args.includes("--force");
  const dryRun = args.includes("--dry-run");
  const pendingTargetArg = args.find((arg) => arg.startsWith("--pending-target="));
  const pendingTarget = pendingTargetArg
    ? pendingTargetArg.slice("--pending-target=".length)
    : DEFAULT_PENDING_TARGET;

  const result = await migrateLegacyCloudMemoryOnce({
    force,
    dryRun,
    pendingTarget,
    timeoutMs: 15000,
    clientName: "legacy-cloud-memory-migration-cli"
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exit(result.ok ? 0 : 2);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(
      `${error && error.stack ? error.stack : String(error)}\n`
    );
    process.exit(1);
  });
}

module.exports = {
  MIGRATION_STATE_PATH,
  collectLegacyRecordSpecs,
  migrateLegacyCloudMemoryOnce
};
