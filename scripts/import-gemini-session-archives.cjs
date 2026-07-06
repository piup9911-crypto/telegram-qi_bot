const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const CHAT_ID = process.env.GEM_CHAT_IMPORT_CHAT_ID || "7541487750";
const ARCHIVE_DIR = path.join(ROOT, "bridge-state", "chat-archives", CHAT_ID);
const SESSION_DIRS = [
  path.join(ROOT, "bridge-home", ".gemini", "tmp", "telegram-bridge", "chats")
];

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function parseTime(value) {
  const time = Date.parse(value || "");
  return Number.isFinite(time) ? time : 0;
}

function archiveIdFromDate(value) {
  const date = new Date(parseTime(value) || Date.now());
  const stamp = date
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\..+$/, "")
    .replace("T", "-");
  return `archive-${stamp}`;
}

function textFromContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((item) => {
      if (!item || typeof item !== "object") return "";
      return typeof item.text === "string" ? item.text : "";
    })
    .filter(Boolean)
    .join("\n\n");
}

function normalizeRole(type) {
  if (type === "user") return "user";
  if (type === "gemini" || type === "assistant" || type === "model") return "assistant";
  return "";
}

function normalizeMessage(item) {
  const role = normalizeRole(item && item.type);
  const content = textFromContent(item && item.content).trim();
  const at = item && (item.timestamp || item.at || item.createdAt);
  if (!role || !content || !at) return null;
  return {
    role,
    content,
    at,
    source: "gemini-session-import"
  };
}

function readJsonSession(filePath) {
  const raw = readJson(filePath);
  const messages = Array.isArray(raw.messages)
    ? raw.messages.map(normalizeMessage).filter(Boolean)
    : [];
  return {
    sessionId: raw.sessionId || path.basename(filePath).replace(/\.(json|jsonl)$/i, ""),
    startTime: raw.startTime || (messages[0] && messages[0].at) || "",
    lastUpdated: raw.lastUpdated || (messages[messages.length - 1] && messages[messages.length - 1].at) || "",
    messages
  };
}

function readJsonlSession(filePath) {
  const lines = fs
    .readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim());
  let header = {};
  const messages = [];
  for (const line of lines) {
    let item;
    try {
      item = JSON.parse(line);
    } catch {
      continue;
    }
    if (item && item.sessionId && item.startTime) {
      header = { ...header, ...item };
      continue;
    }
    const message = normalizeMessage(item);
    if (message) messages.push(message);
  }
  return {
    sessionId: header.sessionId || path.basename(filePath).replace(/\.(json|jsonl)$/i, ""),
    startTime: header.startTime || (messages[0] && messages[0].at) || "",
    lastUpdated: header.lastUpdated || (messages[messages.length - 1] && messages[messages.length - 1].at) || "",
    messages
  };
}

function readSession(filePath) {
  return filePath.endsWith(".jsonl") ? readJsonlSession(filePath) : readJsonSession(filePath);
}

function uniqueMessages(messages) {
  const seen = new Set();
  return messages.filter((message) => {
    const key = `${message.role}\0${message.at}\0${message.content}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function archivePathFor(session) {
  let archiveId = archiveIdFromDate(session.startTime || session.lastUpdated);
  let archivePath = path.join(ARCHIVE_DIR, `${archiveId}.json`);
  let bump = 1;
  while (fs.existsSync(archivePath)) {
    const date = new Date((parseTime(session.startTime || session.lastUpdated) || Date.now()) + bump * 1000);
    archiveId = archiveIdFromDate(date.toISOString());
    archivePath = path.join(ARCHIVE_DIR, `${archiveId}.json`);
    bump += 1;
  }
  return { archiveId, archivePath };
}

function sessionFiles() {
  const files = [];
  for (const dir of SESSION_DIRS) {
    if (!fs.existsSync(dir)) continue;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isFile() && /^session-.+\.(json|jsonl)$/i.test(entry.name)) {
        files.push(path.join(dir, entry.name));
      }
    }
  }
  return files.sort();
}

function main() {
  fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
  const imported = [];
  const skipped = [];

  for (const filePath of sessionFiles()) {
    const session = readSession(filePath);
    const history = uniqueMessages(session.messages).sort((a, b) => parseTime(a.at) - parseTime(b.at));
    if (history.length === 0) {
      skipped.push({ file: filePath, reason: "no displayable messages" });
      continue;
    }

    const { archiveId, archivePath } = archivePathFor(session);
    const firstAt = history[0] && history[0].at;
    const lastAt = history[history.length - 1] && history[history.length - 1].at;
    const state = {
      chatId: CHAT_ID,
      history,
      archivedAt: new Date().toISOString(),
      archiveId,
      title: `导入旧记录 ${firstAt ? firstAt.slice(0, 10) : archiveId}`,
      sessionId: null,
      lastUserMessage: [...history].reverse().find((item) => item.role === "user")?.content || "",
      lastAssistantMessage: [...history].reverse().find((item) => item.role === "assistant")?.content || "",
      thinkingMode: "hidden",
      modelMode: "quality",
      customModel: null,
      completedTurnsSinceMemoryIngest: 0,
      lastMemoryIngestAt: "",
      updatedAt: lastAt || session.lastUpdated || new Date().toISOString(),
      importedFrom: path.relative(ROOT, filePath),
      importedSessionId: session.sessionId
    };
    fs.writeFileSync(archivePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    imported.push({ archiveId, messages: history.length, source: path.relative(ROOT, filePath) });
  }

  console.log(JSON.stringify({ ok: true, imported, skippedCount: skipped.length }, null, 2));
}

main();
