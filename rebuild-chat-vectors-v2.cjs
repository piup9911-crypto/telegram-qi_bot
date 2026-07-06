const fs = require("fs");
const path = require("path");
const {
  CHAT_VECTOR_V2_INDEX_PATH,
  buildChatVectorV2Index
} = require("./chat-vector-memory-v2.cjs");

const ROOT = __dirname;
const CHAT_STATE_DIR = path.join(ROOT, "bridge-state", "chats");
const CHAT_ARCHIVE_DIR = path.join(ROOT, "bridge-state", "chat-archives");

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function listJsonFiles(directory) {
  try {
    return fs
      .readdirSync(directory, { withFileTypes: true })
      .flatMap((entry) => {
        const filePath = path.join(directory, entry.name);
        if (entry.isDirectory()) return listJsonFiles(filePath);
        return entry.isFile() && entry.name.endsWith(".json") ? [filePath] : [];
      });
  } catch {
    return [];
  }
}

function isCanonicalChatFile(filePath) {
  const name = path.basename(filePath);
  // Chat-state folders contain migrations/backups as JSON too. Only canonical
  // chat files should enter the index, otherwise one old conversation may be
  // counted multiple times and distort the timeline.
  return (
    name.endsWith(".json") &&
    ![
      ".delete-",
      ".backup-",
      ".moved-",
      ".rename-",
      ".path-isolation-",
      ".node-migration-"
    ].some((fragment) => name.includes(fragment))
  );
}

function loadSources() {
  const sources = [];
  // Active chats are the current Telegram conversation windows. Archive chats
  // are kept as separate sources so the monitor can show provenance clearly.
  for (const filePath of listJsonFiles(CHAT_STATE_DIR).filter(isCanonicalChatFile)) {
    const state = readJson(filePath, null);
    if (!state || !Array.isArray(state.history)) continue;
    const chatId = String(state.chatId || path.basename(filePath, ".json"));
    sources.push({
      chatId,
      sourceId: `active:${chatId}`,
      sourceKind: "active",
      sourceRef: filePath,
      messages: state.history
    });
  }
  for (const filePath of listJsonFiles(CHAT_ARCHIVE_DIR).filter(isCanonicalChatFile)) {
    const state = readJson(filePath, null);
    if (!state || !Array.isArray(state.history)) continue;
    const chatId = String(
      state.chatId || path.basename(path.dirname(filePath))
    );
    sources.push({
      chatId,
      sourceId: `archive:${chatId}:${path.basename(filePath, ".json")}`,
      sourceKind: "archive",
      sourceRef: filePath,
      messages: state.history
    });
  }
  return sources;
}

async function main() {
  const sources = loadSources();
  const result = await buildChatVectorV2Index(sources);
  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        indexPath: CHAT_VECTOR_V2_INDEX_PATH,
        sourceCount: sources.length,
        ...result
      },
      null,
      2
    )}\n`
  );
}

main()
  .then(() => {
    // One-shot maintenance command. Exit after writing the v2 index instead of
    // waiting for Ollama's keep-alive HTTP connection.
    process.exit(0);
  })
  .catch((error) => {
    process.stderr.write(`${error.stack || error}\n`);
    process.exit(1);
  });
