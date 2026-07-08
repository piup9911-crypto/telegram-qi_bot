const fs = require("fs");
const path = require("path");
const {
  CHAT_VECTOR_INDEX_PATH,
  indexChatSources
} = require("../src/memory/chat-vector-memory.cjs");

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
  const result = await indexChatSources(sources);
  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        indexPath: CHAT_VECTOR_INDEX_PATH,
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
    // This is a one-shot maintenance command. Exit after the index is safely
    // written instead of waiting for Ollama's reusable HTTP connection.
    process.exit(0);
  })
  .catch((error) => {
    process.stderr.write(`${error.stack || error}\n`);
    process.exit(1);
  });
