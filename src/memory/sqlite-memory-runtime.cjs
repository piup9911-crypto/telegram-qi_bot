const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");

const ROOT = path.resolve(__dirname, "..", "..");
const DEFAULT_DB_PATH = path.join(
  ROOT,
  "bridge-workspace",
  "memory-pipeline-lab",
  "memory-schema-v2-complete.sqlite"
);
const PRODUCER_QUEUE_PATH = path.join(
  ROOT,
  "bridge-workspace",
  "memory-pipeline-lab",
  "memory-producer-queue.cjs"
);
const POLICY_VERSION = "bridge-sqlite-raw-ingest-v1";
const schemaReady = new Set();

function sha256(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

function localDate(iso, timeZone = "Asia/Shanghai") {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    })
      .formatToParts(new Date(iso))
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value])
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function reviewClassification(text) {
  const value = String(text || "");
  const secretPatterns = [
    /\bsk-[A-Za-z0-9_-]{16,}\b/,
    /\bAIza[A-Za-z0-9_-]{20,}\b/,
    /\b(?:ghp|github_pat)_[A-Za-z0-9_]{16,}\b/,
    /\b\d{6,12}:[A-Za-z0-9_-]{20,}\b/,
    /\bntn_[A-Za-z0-9_-]+\b/,
    /\bSCT[A-Za-z0-9_-]+\.send\b/i,
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/
  ];
  if (secretPatterns.some((pattern) => pattern.test(value))) {
    return { status: "raw_only", reason: "contains_secret_or_credential" };
  }
  if (
    /^Create one concise checkpoint summary/i.test(value) ||
    /Return only the bullet list\./i.test(value)
  ) {
    return {
      status: "raw_only",
      reason: "embedded_prompt_or_transcript_artifact"
    };
  }
  return { status: "unreviewed", reason: null };
}

function safeConversationSuffix(value) {
  return String(value || "unknown")
    .replace(/[^A-Za-z0-9_-]+/g, "_")
    .slice(0, 120);
}

function conversationIdForChat(chatId) {
  const value = String(chatId || "");
  const base = value.split("__w_", 1)[0];
  if (value === base) {
    return base === "7541487750"
      ? "telegram_active"
      : `telegram_active_${safeConversationSuffix(base)}`;
  }
  return `telegram_window_${safeConversationSuffix(value)}`;
}

function sourceFileForChat(chatId) {
  return path
    .join("bridge-state", "chats", `${String(chatId)}.json`)
    .replaceAll("\\", "/");
}

function openDatabase(dbPath) {
  if (!fs.existsSync(dbPath)) {
    throw new Error(`SQLite memory database is missing: ${dbPath}`);
  }
  if (!schemaReady.has(dbPath)) {
    const migrationRunnerPath = path.join(
      ROOT,
      "bridge-workspace",
      "memory-pipeline-lab",
      "memory-v1-migrate.cjs"
    );
    const { applyMigrations } = require(migrationRunnerPath);
    applyMigrations(dbPath);
    schemaReady.add(dbPath);
  }
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=2500;");
  return db;
}

function normalizedMessages(chatState, conversationId, timeZone) {
  const history = Array.isArray(chatState && chatState.history)
    ? chatState.history
    : [];
  return history.flatMap((message, index) => {
    if (
      !message ||
      !["user", "assistant", "system"].includes(message.role) ||
      typeof message.content !== "string" ||
      !message.at
    ) {
      return [];
    }
    const timestamp = new Date(message.at).toISOString();
    return [
      {
        id: `${conversationId}:${index}`,
        conversation_id: conversationId,
        message_index: index,
        source_message_index: index,
        speaker: message.role,
        text: message.content,
        timestamp,
        local_date: localDate(timestamp, timeZone),
        text_hash: sha256(message.content)
      }
    ];
  });
}

function enqueueProducerBatch(db, conversationId) {
  if (!fs.existsSync(PRODUCER_QUEUE_PATH)) {
    return { created: false, reason: "producer_queue_module_missing" };
  }
  const { enqueueMemoryBatch } = require(PRODUCER_QUEUE_PATH);
  return enqueueMemoryBatch(db, {
    conversationId,
    triggerKind: "idle_batch",
    provider: "disabled",
    model: null,
    policyVersion: "memory-policy-v1"
  });
}

function syncChatStateToSqlite(chatState, options = {}) {
  const dbPath =
    options.dbPath ||
    process.env.BRIDGE_SQLITE_MEMORY_DB_PATH ||
    DEFAULT_DB_PATH;
  const chatId = String(chatState && chatState.chatId || options.chatId || "");
  if (!chatId) throw new Error("chatState.chatId is required");
  const conversationId =
    options.conversationId || conversationIdForChat(chatId);
  const timeZone = options.timeZone || "Asia/Shanghai";
  const messages = normalizedMessages(chatState, conversationId, timeZone);
  if (!messages.length) {
    return {
      database: dbPath,
      conversation_id: conversationId,
      inserted_messages: 0,
      database_messages: 0,
      queue: { created: false, reason: "empty_history" }
    };
  }

  const importedAt = new Date().toISOString();
  const db = openDatabase(dbPath);
  const existing = db.prepare(
    "SELECT speaker,text_hash,timestamp FROM raw_messages WHERE id=?"
  );
  const insert = db.prepare(`
    INSERT INTO raw_messages(
      id,conversation_id,message_index,source_message_index,speaker,text,timestamp,
      local_date,text_hash,imported_at,memory_review_status,memory_review_reason,
      memory_reviewed_at,memory_policy_version
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `);
  const upsertConversation = db.prepare(`
    INSERT INTO conversations(
      id,source_kind,title,started_at,ended_at,message_count,source_file,
      boundary_reason,imported_at,timezone_name
    ) VALUES (?,?,?,?,?,?,?,'source_stream',?,?)
    ON CONFLICT(id) DO UPDATE SET
      ended_at=excluded.ended_at,
      message_count=excluded.message_count,
      source_file=excluded.source_file,
      imported_at=excluded.imported_at,
      timezone_name=excluded.timezone_name
  `);

  const pending = [];
  for (const message of messages) {
    const before = existing.get(message.id);
    if (!before) {
      pending.push(message);
      continue;
    }
    if (
      before.speaker !== message.speaker ||
      before.text_hash !== message.text_hash ||
      Date.parse(before.timestamp) !== Date.parse(message.timestamp)
    ) {
      db.close();
      throw new Error(`Immutable source message changed: ${message.id}`);
    }
  }

  db.exec("BEGIN IMMEDIATE");
  try {
    upsertConversation.run(
      conversationId,
      conversationId.startsWith("telegram_window_")
        ? "telegram_window"
        : "telegram_active",
      String(chatState.title || conversationId),
      messages[0].timestamp,
      messages.at(-1).timestamp,
      messages.length,
      options.sourceFile || sourceFileForChat(chatId),
      importedAt,
      timeZone
    );
    for (const message of pending) {
      const review = reviewClassification(message.text);
      insert.run(
        message.id,
        message.conversation_id,
        message.message_index,
        message.source_message_index,
        message.speaker,
        message.text,
        message.timestamp,
        message.local_date,
        message.text_hash,
        importedAt,
        review.status,
        review.reason,
        review.reason ? importedAt : null,
        review.reason ? POLICY_VERSION : null
      );
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    db.close();
    throw error;
  }

  let queue = { created: false, reason: "queue_disabled" };
  if (options.enqueue !== false) {
    try {
      queue = enqueueProducerBatch(db, conversationId);
    } catch (error) {
      queue = {
        created: false,
        reason: "queue_error",
        error: error && error.message ? error.message : String(error)
      };
    }
  }
  const result = {
    database: dbPath,
    conversation_id: conversationId,
    inserted_messages: pending.length,
    database_messages: Number(
      db
        .prepare(
          "SELECT count(*) AS n FROM raw_messages WHERE conversation_id=?"
        )
        .get(conversationId).n
    ),
    fts_messages: Number(
      db.prepare("SELECT count(*) AS n FROM raw_messages_fts").get().n
    ),
    queue: queue && queue.job
      ? {
          created: Boolean(queue.created),
          reason: queue.reason || null,
          job_id: queue.job.id,
          status: queue.job.status
        }
      : queue
  };
  db.close();
  return result;
}

function getSqliteMemoryStatus(options = {}) {
  const dbPath =
    options.dbPath ||
    process.env.BRIDGE_SQLITE_MEMORY_DB_PATH ||
    DEFAULT_DB_PATH;
  if (!fs.existsSync(dbPath)) {
    return { available: false, database: dbPath };
  }
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const count = (table) =>
    Number(db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n);
  const latest = db
    .prepare(
      "SELECT max(timestamp) AS latest_at, max(imported_at) AS latest_import_at FROM raw_messages"
    )
    .get();
  const jobs = db
    .prepare(
      "SELECT status,count(*) AS n FROM memory_processing_jobs GROUP BY status"
    )
    .all();
  const status = {
    available: true,
    database: dbPath,
    raw_messages: count("raw_messages"),
    event_summaries: count("event_summaries"),
    memory_cards: count("memory_cards"),
    fact_timelines: count("fact_timelines"),
    event_occurrences: count("event_occurrences"),
    pending_jobs: jobs
      .filter((row) => ["pending", "running", "retry_wait"].includes(row.status))
      .reduce((sum, row) => sum + Number(row.n), 0),
    jobs: Object.fromEntries(jobs.map((row) => [row.status, Number(row.n)])),
    latest_message_at: latest.latest_at || null,
    latest_import_at: latest.latest_import_at || null
  };
  db.close();
  return status;
}

module.exports = {
  DEFAULT_DB_PATH,
  POLICY_VERSION,
  conversationIdForChat,
  getSqliteMemoryStatus,
  reviewClassification,
  syncChatStateToSqlite
};
