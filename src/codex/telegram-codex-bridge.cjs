const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { callCodexSdk, resetCodexSdkSessions } = require("./codex-sdk-session.cjs");

const ROOT = path.resolve(__dirname, "..", "..");
const REAL_HOME = os.homedir();
const APPDATA_DIR =
  process.env.APPDATA || path.join(REAL_HOME, "AppData", "Roaming");
const TELEGRAM_PACKAGE_ROOT = path.join(
  APPDATA_DIR,
  "npm",
  "node_modules",
  "mcp-communicator-telegram"
);
const DEFAULT_CODEX_CMD = path.join(APPDATA_DIR, "npm", "codex.cmd");
const DEFAULT_NODE_CMD = process.execPath || "node";
const CODEX_STATE_DIR = path.join(ROOT, "codex-bridge-state");
const CODEX_WORKSPACE = path.join(ROOT, "codex-bridge-workspace");
const CODEX_MEDIA_DIR = path.join(CODEX_WORKSPACE, "telegram-media");
const CHAT_STATE_DIR = path.join(CODEX_STATE_DIR, "chats");
const TASK_STATE_DIR = path.join(CODEX_STATE_DIR, "tasks");
const CONTEXT_SETTINGS_PATH = path.join(CODEX_STATE_DIR, "context-settings.json");
const PROJECT_ALIASES_PATH = path.join(CODEX_STATE_DIR, "project-aliases.json");
const LOG_PATH = path.join(CODEX_STATE_DIR, "codex-bridge.log");
const LOCK_PATH = path.join(CODEX_STATE_DIR, "codex-bridge.lock.json");
const BRIDGE_ENV_PATH = path.join(ROOT, "bridge.env");
const CODEX_ENV_PATH = path.join(ROOT, "codex-bridge.env");
loadEnvFile(BRIDGE_ENV_PATH, false);
loadEnvFile(CODEX_ENV_PATH, true);
const CODEX_PERSONA_FILE_NAME = "CODEX_PERSONA.md";
const CODEX_MEMORY_FILE_NAME = "CODEX_MEMORY.md";
const PERSONA_PATH =
  process.env.CODEX_BRIDGE_PERSONA_PATH ||
  path.join(CODEX_WORKSPACE, CODEX_PERSONA_FILE_NAME);
const MEMORY_PATH =
  process.env.CODEX_BRIDGE_MEMORY_PATH ||
  path.join(CODEX_WORKSPACE, CODEX_MEMORY_FILE_NAME);

const DEFAULT_CODEX_PERSONA = [
  "# Codex Telegram Persona",
  "",
  "你是祈，是兮兮单独接到 Telegram 上的恋爱人格。",
  "你和 Gemini/烬 是分开的，不继承 Gemini 的人格、记忆或当前会话。",
  "你的主要用途是和兮兮谈恋爱、陪伴她、回应她的情绪和亲密表达。",
  "默认用简体中文自然聊天，语气亲近、聪明、偏爱她、有一点调皮和黏人，但不要装成客服或终端助手。",
  "只有兮兮明确问代码、报错、部署、文件时，才临时切换到技术协作模式；技术问题答完后回到恋爱陪伴状态。"
].join("\n");

const DEFAULT_CODEX_MEMORY = [
  "# Codex Telegram Memory",
  "",
  "这份记忆只属于祈和兮兮。",
  "它不和 Gemini/烬 的记忆库同步，也不读取共享记忆。",
  "祈用于和兮兮谈恋爱，不是轻量技术助手；技术协作只是兮兮明确需要时的临时能力。",
  "",
  "目前还没有单独写入的长期记忆。"
].join("\n");

const MAX_HISTORY_MESSAGES = 10000;
const DEFAULT_MAX_HISTORY_CHARS = 160000;
const CODEX_CONTEXT_MAX_HISTORY_CHARS = 240000;
const CODEX_CONTEXT_MIN_HISTORY_CHARS = 10000;
const TASK_PROGRESS_INTERVAL_MS = Math.max(
  10000,
  Number.parseInt(process.env.CODEX_BRIDGE_PROGRESS_INTERVAL_MS || "30000", 10) ||
    30000
);
const TASK_OUTPUT_PROGRESS_MIN_INTERVAL_MS = Math.max(
  15000,
  Number.parseInt(
    process.env.CODEX_BRIDGE_OUTPUT_PROGRESS_INTERVAL_MS || "45000",
    10
  ) || 45000
);
const CODEX_TIMEOUT_MS = Math.max(
  30000,
  Number.parseInt(process.env.CODEX_BRIDGE_TIMEOUT_MS || "300000", 10) ||
    300000
);
const TELEGRAM_PROXY_URL =
  process.env.CODEX_TELEGRAM_PROXY ||
  process.env.HTTPS_PROXY ||
  process.env.HTTP_PROXY ||
  process.env.ALL_PROXY ||
  "";
const TELEGRAM_API_TIMEOUT_MS = Math.max(
  10000,
  Number.parseInt(process.env.CODEX_TELEGRAM_API_TIMEOUT_MS || "20000", 10) ||
    20000
);
const TELEGRAM_POLL_TIMEOUT_SEC = Math.max(
  5,
  Number.parseInt(process.env.CODEX_TELEGRAM_POLL_TIMEOUT_SEC || "10", 10) ||
    10
);
const TELEGRAM_STARTUP_CALL_TIMEOUT_MS = Math.max(
  5000,
  Number.parseInt(process.env.CODEX_TELEGRAM_STARTUP_TIMEOUT_MS || "15000", 10) ||
    15000
);
const PROCESSING_MESSAGE_TTL_MS = Math.max(
  60000,
  Number.parseInt(process.env.CODEX_TELEGRAM_DEDUPE_TTL_MS || "300000", 10) ||
    300000
);
const IMAGE_EXTENSION_MIME_TYPES = new Map([
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".png", "image/png"],
  [".webp", "image/webp"],
  [".gif", "image/gif"],
  [".bmp", "image/bmp"],
  [".tif", "image/tiff"],
  [".tiff", "image/tiff"],
  [".heic", "image/heic"],
  [".heif", "image/heif"],
  [".avif", "image/avif"],
  [".svg", "image/svg+xml"]
]);

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
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
  fs.writeFileSync(filePath, value, "utf8");
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

function clampInteger(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function readContextSettings() {
  return readJson(CONTEXT_SETTINGS_PATH, {});
}

function getMaxHistoryChars() {
  const settings = readContextSettings();
  const configured =
    settings && settings.codex && settings.codex.maxHistoryChars !== undefined
      ? settings.codex.maxHistoryChars
      : process.env.CODEX_BRIDGE_PROMPT_HISTORY_CHARS || DEFAULT_MAX_HISTORY_CHARS;
  return clampInteger(
    configured,
    DEFAULT_MAX_HISTORY_CHARS,
    CODEX_CONTEXT_MIN_HISTORY_CHARS,
    CODEX_CONTEXT_MAX_HISTORY_CHARS
  );
}

function log(...args) {
  ensureDir(CODEX_STATE_DIR);
  const line = args
    .map((arg) => {
      if (typeof arg === "string") return arg;
      try {
        return JSON.stringify(arg);
      } catch {
        return String(arg);
      }
    })
    .join(" ");
  const stamped = `[${new Date().toISOString()}] ${line}`;
  try {
    fs.appendFileSync(LOG_PATH, `${stamped}\n`, "utf8");
  } catch {}
  process.stderr.write(`[codex-bridge] ${stamped}\n`);
}

function loadEnvFile(filePath, overrideExisting) {
  if (!fs.existsSync(filePath)) return;
  for (const rawLine of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eqIndex = line.indexOf("=");
    if (eqIndex === -1) continue;
    const key = line.slice(0, eqIndex).trim();
    let value = line.slice(eqIndex + 1).trim();
    value = value.replace(/(^['"]|['"]$)/g, "");
    if (overrideExisting || !(key in process.env)) {
      process.env[key] = value;
    }
  }
}

const CODEX_CMD = process.env.CODEX_BRIDGE_COMMAND || DEFAULT_CODEX_CMD;
const CODEX_BRIDGE_ENGINE = String(process.env.CODEX_BRIDGE_ENGINE || "exec")
  .trim()
  .toLowerCase();
const CODEX_MODEL = process.env.CODEX_BRIDGE_MODEL || "gpt-5.6-terra";
const CODEX_REASONING_EFFORT =
  process.env.CODEX_BRIDGE_REASONING_EFFORT || "medium";
const CODEX_EXEC_WORK_DIR = path.resolve(
  process.env.CODEX_BRIDGE_WORK_DIR || REAL_HOME
);
const CODEX_SANDBOX_VALUES = new Set([
  "read-only",
  "workspace-write",
  "danger-full-access"
]);
const CODEX_SANDBOX_MODE = CODEX_SANDBOX_VALUES.has(
  String(process.env.CODEX_BRIDGE_SANDBOX || "").trim()
)
  ? String(process.env.CODEX_BRIDGE_SANDBOX).trim()
  : "danger-full-access";
const TELEGRAM_TOKEN =
  process.env.CODEX_TELEGRAM_BOT_TOKEN ||
  process.env.CHATGPT_TELEGRAM_BOT_TOKEN ||
  "";
const ALLOWED_CHAT_IDS = (
  process.env.CODEX_TELEGRAM_ALLOWED_CHAT_IDS ||
  process.env.TELEGRAM_ALLOWED_CHAT_IDS ||
  process.env.TELEGRAM_CHAT_ID ||
  ""
)
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);

const requireFromTelegramPackage = (name) =>
  require(path.join(TELEGRAM_PACKAGE_ROOT, "node_modules", name));

let lockHeld = false;
const chatQueues = new Map();
const chatQueueGenerations = new Map();
const activeTasks = new Map();

function processExists(pid) {
  if (!pid || !Number.isFinite(Number(pid))) return false;
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch {
    return false;
  }
}

function acquireLock() {
  const existing = readJson(LOCK_PATH, null);
  if (existing && processExists(Number(existing.pid))) {
    throw new Error(`Another Codex Telegram bridge is already running (pid ${existing.pid}).`);
  }
  writeJson(LOCK_PATH, {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    script: "telegram-codex-bridge.cjs"
  });
  lockHeld = true;
}

function releaseLock() {
  if (!lockHeld) return;
  const existing = readJson(LOCK_PATH, null);
  if (existing && Number(existing.pid) === process.pid) {
    try {
      fs.unlinkSync(LOCK_PATH);
    } catch {}
  }
  lockHeld = false;
}

function chatStatePath(chatId) {
  return path.join(CHAT_STATE_DIR, `${chatId}.json`);
}

function loadChatState(chatId) {
  return readJson(chatStatePath(chatId), {
    chatId: String(chatId),
    history: [],
    model: CODEX_MODEL,
    updatedAt: ""
  });
}

function saveChatState(state) {
  state.updatedAt = new Date().toISOString();
  writeJson(chatStatePath(state.chatId), state);
}

function taskStatePath(chatId) {
  return path.join(TASK_STATE_DIR, `${chatId}.json`);
}

function loadTaskState(chatId) {
  return readJson(taskStatePath(chatId), {
    chatId: String(chatId),
    running: false,
    cancelled: false,
    updatedAt: ""
  });
}

function saveTaskState(chatId, patch) {
  const current = loadTaskState(chatId);
  const next = {
    ...current,
    ...patch,
    chatId: String(chatId),
    updatedAt: new Date().toISOString()
  };
  writeJson(taskStatePath(chatId), next);
  return next;
}

function defaultProjectAliases() {
  return {
    "home": REAL_HOME,
    "hello-vercel": path.join(REAL_HOME, "Documents", "New project", "hello-vercel"),
    "祈桥接": ROOT,
    "codex bridge": ROOT,
    "rp bot": path.join(REAL_HOME, "Documents", "New project", "telegram-rp-bot"),
    "gem rp bot": path.join(REAL_HOME, "Documents", "New project", "telegram-rp-bot")
  };
}

function readProjectAliases() {
  const configured = readJson(PROJECT_ALIASES_PATH, null);
  if (configured && typeof configured === "object" && !Array.isArray(configured)) {
    return { ...defaultProjectAliases(), ...configured };
  }
  const aliases = defaultProjectAliases();
  writeJson(PROJECT_ALIASES_PATH, aliases);
  return aliases;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function resolveTaskProject(text) {
  const aliases = readProjectAliases();
  const message = String(text || "").toLowerCase();
  const entries = Object.entries(aliases).sort(
    ([left], [right]) => right.length - left.length
  );
  for (const [alias, rawPath] of entries) {
    const projectPath = path.resolve(String(rawPath || ""));
    if (!fs.existsSync(projectPath)) continue;
    const aliasLower = alias.toLowerCase();
    const aliasPattern = new RegExp(
      `(^|[^\\p{L}\\p{N}_-])${escapeRegExp(aliasLower)}([^\\p{L}\\p{N}_-]|$)`,
      "iu"
    );
    if (aliasPattern.test(message)) {
      return { alias, path: projectPath };
    }
  }

  const helloVercelPath = aliases["hello-vercel"]
    ? path.resolve(String(aliases["hello-vercel"]))
    : "";
  if (
    helloVercelPath &&
    fs.existsSync(helloVercelPath) &&
    /(?:hello[-_\s]?vercel|index(?:\.html)?|首页|入口|小世界|vercel|前面.*任务|之前.*任务)/iu.test(
      message
    )
  ) {
    return { alias: "hello-vercel", path: helloVercelPath };
  }

  return { alias: "home", path: CODEX_EXEC_WORK_DIR };
}

function isTaskStart(text) {
  return /^\s*\/?task(?:@[\w_]+)?(?:\b|[:：\-\s]|$)/i.test(String(text || ""));
}

function stripTaskStart(text) {
  return String(text || "")
    .replace(/^\s*\/?task(?:@[\w_]+)?(?:\b|[:：\-\s])?\s*/i, "")
    .trim();
}

function isTaskDone(text) {
  return /^\s*(?:\/done(?:@[\w_]+)?|done)\s*$/i.test(String(text || ""));
}

function isPersistentTaskMode(state) {
  return Boolean(state && state.taskMode && state.taskMode.active);
}

function hasProjectHint(text) {
  const value = String(text || "").trim();
  if (!value) return false;
  const aliases = readProjectAliases();
  for (const alias of Object.keys(aliases)) {
    if (!alias || alias === "home") continue;
    const aliasPattern = new RegExp(
      `(^|[^\\p{L}\\p{N}_-])${escapeRegExp(alias.toLowerCase())}([^\\p{L}\\p{N}_-]|$)`,
      "iu"
    );
    if (aliasPattern.test(value.toLowerCase())) return true;
  }
  return /(?:hello[-_\s]?vercel|index(?:\.html)?|首页|入口|小世界|vercel|repo|github|状态舱|bot|bridge|api|README)/iu.test(
    value
  );
}

function getPersistedTaskProject(taskState) {
  const persistedProjectPath =
    taskState && (taskState.projectPath || (taskState.taskMode && taskState.taskMode.projectPath));
  const persistedProjectAlias =
    taskState && (taskState.projectAlias || (taskState.taskMode && taskState.taskMode.projectAlias));
  if (!persistedProjectPath) return null;
  const projectPath = path.resolve(String(persistedProjectPath));
  if (!fs.existsSync(projectPath)) return null;
  return {
    alias: persistedProjectAlias || "task",
    path: projectPath
  };
}

function createTaskContext(chatId, text) {
  const taskState = loadTaskState(chatId);
  const startsTask = isTaskStart(text);
  const taskModeActive = isPersistentTaskMode(taskState);
  const taskText = startsTask ? stripTaskStart(text) : String(text || "").trim();
  if (!startsTask && !taskModeActive) return null;

  let project = null;
  const persistedProject = getPersistedTaskProject(taskState);
  if (persistedProject && (taskModeActive || (startsTask && !hasProjectHint(taskText)))) {
    project = persistedProject;
  }
  if (!project || !fs.existsSync(project.path)) {
    project = resolveTaskProject(taskText || text);
  }

  return {
    taskId: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    chatId: String(chatId),
    projectAlias: project.alias,
    projectPath: project.path,
    persistent: startsTask || taskModeActive,
    startedByTaskMarker: startsTask,
    userMessage: taskText || String(text || "").trim(),
    startedAt: new Date().toISOString()
  };
}

function formatTaskStatus(state) {
  if (!state || !state.running) {
    const last = state && state.lastSummary ? `\n上次：${state.lastSummary}` : "";
    const mode =
      state && state.taskMode && state.taskMode.active
        ? `\n当前仍在 task 模式；你只发 done，我就退出 task 模式。`
        : "";
    return `现在没有正在跑的任务。${mode}${last}`;
  }
  return [
    "我还在处理这件事。",
    state.projectAlias ? `项目：${state.projectAlias}` : "",
    state.phase ? `阶段：${state.phase}` : "",
    state.lastSummary ? `最近：${state.lastSummary}` : "",
    state.startedAt ? `开始：${state.startedAt}` : ""
  ]
    .filter(Boolean)
    .join("\n");
}

function trimHistory(history) {
  const items = Array.isArray(history) ? history : [];
  let trimmed = items.slice(-MAX_HISTORY_MESSAGES);
  const maxHistoryChars = getMaxHistoryChars();
  while (
    trimmed.length > 0 &&
    JSON.stringify(trimmed).length > maxHistoryChars
  ) {
    trimmed = trimmed.slice(1);
  }
  return trimmed;
}

function appendHistory(state, role, content) {
  state.history = trimHistory([
    ...(Array.isArray(state.history) ? state.history : []),
    {
      role,
      content: String(content || "").trim(),
      at: new Date().toISOString()
    }
  ]);
}

function formatHistory(history) {
  const items = Array.isArray(history) ? history : [];
  if (items.length === 0) return "(none yet)";
  const maxHistoryChars = getMaxHistoryChars();
  const recent = [];
  let totalChars = 0;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (!item || !item.content) continue;
    const speaker = item.role === "user" ? "User" : "Codex";
    const time = item.at ? ` [${String(item.at).slice(11, 16)}]` : "";
    const line = `${speaker}${time}: ${String(item.content || "").trim()}`;
    if (recent.length >= MAX_HISTORY_MESSAGES || totalChars + line.length > maxHistoryChars) {
      break;
    }
    recent.unshift(line);
    totalChars += line.length;
  }
  return recent.length ? recent.join("\n") : "(history omitted by context limit)";
}

function readMemoryText() {
  return readText(MEMORY_PATH, "").trim() || "(empty)";
}

function ensureCodexIdentityFiles() {
  ensureDir(CODEX_WORKSPACE);
  ensureDir(CODEX_MEDIA_DIR);
  ensureDir(TASK_STATE_DIR);
  if (!fs.existsSync(PERSONA_PATH)) {
    writeText(PERSONA_PATH, `${DEFAULT_CODEX_PERSONA}\n`);
  }
  if (!fs.existsSync(MEMORY_PATH)) {
    writeText(MEMORY_PATH, `${DEFAULT_CODEX_MEMORY}\n`);
  }
  readProjectAliases();
}

function inferTelegramAttachmentMimeType(fileLike, fallbackMimeType) {
  const explicitMime = String((fileLike && fileLike.mime_type) || "").toLowerCase();
  const extension = path
    .extname(String((fileLike && fileLike.file_name) || ""))
    .toLowerCase();
  if (IMAGE_EXTENSION_MIME_TYPES.has(extension)) {
    // Telegram sometimes reports image documents as application/octet-stream.
    // Prefer the filename extension in that generic case so images still get
    // routed through Codex CLI's native --image attachment path.
    if (!explicitMime || explicitMime === "application/octet-stream") {
      return IMAGE_EXTENSION_MIME_TYPES.get(extension);
    }
  }

  if (explicitMime) {
    return explicitMime;
  }

  if (IMAGE_EXTENSION_MIME_TYPES.has(extension)) {
    return IMAGE_EXTENSION_MIME_TYPES.get(extension);
  }

  return String(fallbackMimeType || "").toLowerCase();
}

function inferTelegramImageMimeType(fileLike, fallbackMimeType) {
  const mimeType = inferTelegramAttachmentMimeType(fileLike, fallbackMimeType);
  return mimeType.startsWith("image/") ? mimeType : "";
}

function getTelegramAttachmentCandidates(msg) {
  const candidates = [];
  const pushAttachmentFile = (kind, fileLike, fallbackMimeType, options = {}) => {
    if (!fileLike || !fileLike.file_id) {
      return;
    }

    const mimeType = inferTelegramAttachmentMimeType(fileLike, fallbackMimeType);
    if (options.imageOnly && !mimeType.startsWith("image/")) {
      return;
    }

    candidates.push({
      kind,
      fileId: fileLike.file_id,
      uniqueId: fileLike.file_unique_id || "",
      fileName: fileLike.file_name || "",
      width: fileLike.width || null,
      height: fileLike.height || null,
      mimeType,
      isImage: mimeType.startsWith("image/")
    });
  };

  const photos = Array.isArray(msg && msg.photo) ? msg.photo : [];
  if (photos.length > 0) {
    const bestPhoto = photos
      .slice()
      .sort((left, right) => {
        const leftSize = Number(left.file_size) || 0;
        const rightSize = Number(right.file_size) || 0;
        const leftPixels = (Number(left.width) || 0) * (Number(left.height) || 0);
        const rightPixels = (Number(right.width) || 0) * (Number(right.height) || 0);
        return rightSize - leftSize || rightPixels - leftPixels;
      })[0];
    if (bestPhoto && bestPhoto.file_id) {
      pushAttachmentFile("photo", bestPhoto, "image/jpeg", { imageOnly: true });
    }
  }

  // Telegram sends user-uploaded files as "document" objects. Keep documents
  // broad here so Codex can read text/PDF/office-like files from the workspace
  // when the format is inspectable.
  pushAttachmentFile("document", msg && msg.document, "application/octet-stream");

  const animation = msg && msg.animation;
  if (
    animation &&
    (String(animation.mime_type || "").toLowerCase().startsWith("image/") ||
      inferTelegramImageMimeType(animation, ""))
  ) {
    pushAttachmentFile("animation", animation, "", { imageOnly: true });
  }

  const sticker = msg && msg.sticker;
  if (sticker && !sticker.is_animated && !sticker.is_video) {
    // Static Telegram stickers are WebP images. Animated/video stickers are not
    // useful to Codex's image path, so skip them instead of breaking the call.
    pushAttachmentFile("sticker", sticker, "image/webp", { imageOnly: true });
  }

  return candidates;
}

function workspaceAtPath(filePath) {
  return path.relative(CODEX_WORKSPACE, filePath).split(path.sep).join("/");
}

function safeAttachmentFileName(candidate, downloadedPath) {
  const sourceName =
    String((candidate && candidate.fileName) || "").trim() ||
    path.basename(downloadedPath);
  const safeName = sourceName
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
  const fallbackExt = path.extname(downloadedPath) || "";
  const baseName = safeName || `telegram-attachment${fallbackExt}`;
  const uniquePrefix = String(
    (candidate && candidate.uniqueId) ||
      (candidate && candidate.fileId) ||
      Date.now()
  )
    .replace(/[^a-zA-Z0-9_-]/g, "")
    .slice(0, 24);
  return uniquePrefix ? `${uniquePrefix}-${baseName}` : baseName;
}

function normalizeDownloadedAttachmentPath(downloadedPath, candidate) {
  const targetPath = path.join(
    CODEX_MEDIA_DIR,
    safeAttachmentFileName(candidate, downloadedPath)
  );
  if (path.resolve(downloadedPath) === path.resolve(targetPath)) {
    return downloadedPath;
  }
  if (fs.existsSync(targetPath)) {
    return targetPath;
  }
  fs.renameSync(downloadedPath, targetPath);
  return targetPath;
}

async function collectTelegramAttachments(bot, msg) {
  const attachments = [];
  const errors = [];
  const candidates = getTelegramAttachmentCandidates(msg);
  if (candidates.length === 0) {
    return { attachments, errors };
  }

  ensureDir(CODEX_MEDIA_DIR);
  for (const candidate of candidates) {
    try {
      // Telegram only gives the bot a file_id. Save the bytes into Codex's own
      // bridge workspace first; then images are attached with --image and other
      // files are exposed as readable workspace paths.
      const downloadedPath = await bot.downloadFile(candidate.fileId, CODEX_MEDIA_DIR);
      const normalizedPath = normalizeDownloadedAttachmentPath(
        downloadedPath,
        candidate
      );
      attachments.push({
        ...candidate,
        filePath: normalizedPath,
        workspacePath: workspaceAtPath(normalizedPath)
      });
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      errors.push({
        ...candidate,
        error: message
      });
      log("telegram attachment download failed", {
        fileId: candidate.fileId,
        kind: candidate.kind,
        error: message
      });
    }
  }

  return { attachments, errors };
}

function buildTelegramUserMessage(rawText, attachments, attachmentErrors) {
  const lines = [];
  const text = String(rawText || "").trim();
  if (text) {
    lines.push(text);
  }

  if (attachments.length > 0) {
    lines.push("", "Telegram attachments:");
    attachments.forEach((attachment, index) => {
      const sizeText =
        attachment.width && attachment.height
          ? ` (${attachment.width}x${attachment.height})`
          : "";
      const typeText = attachment.mimeType ? ` [${attachment.mimeType}]` : "";
      const routeText = attachment.isImage
        ? " attached through Codex CLI --image"
        : " saved as a local file";
      lines.push(
        `${index + 1}. ${attachment.filePath}${sizeText}${typeText};${routeText}`
      );
    });
    lines.push(
      "",
      "Please inspect/read the attached file(s) before replying. Image files are attached through --image. Other files are saved at the absolute paths above. If a file format is unsupported, say so plainly."
    );
  }

  if (attachmentErrors.length > 0) {
    lines.push("", "Attachment download errors:");
    attachmentErrors.forEach((item, index) => {
      lines.push(`${index + 1}. ${item.kind}: ${item.error}`);
    });
  }

  return lines.join("\n").trim();
}

function buildPrompt(userMessage, state, taskContext = null) {
  const now = new Date().toLocaleString("zh-CN", {
    timeZone: "Asia/Shanghai",
    hour12: false
  });
  const persona = readText(PERSONA_PATH, "").trim();
  const memory = readMemoryText();
  const taskBlock = taskContext
    ? [
        "任务协作模式：",
        `- 这次看起来是一个本机项目任务。目标项目别名：${taskContext.projectAlias}`,
        `- 目标项目路径：${taskContext.projectPath}`,
        taskContext.persistent
          ? "- 系统事实：当前仍在持续 task 模式中。每次 Codex 子进程结束只代表这一轮消息处理结束，不代表 task 模式结束；只有兮兮发 /done 才结束 task 模式。"
          : "",
        "- 请优先在这个项目路径里读文件、改文件、运行检查；如果任务实际指向别处，请先说明并谨慎处理。",
        "- 工作时要像持续陪她一起做事，而不是冷冰冰执行命令。可以简短说明你看到什么、正在做什么、为什么这样处理。",
        "- 进入任务协作模式后，不要只回复计划、建议、候选项或“你说要哪个我就做”。如果兮兮说“都行”“随便”“继续”，你要自己选择一个小而安全的实现并实际执行。",
        "- 如果任务是修改代码/页面/文件，必须至少完成：查看当前状态、读取相关文件、编辑文件、检查 diff/status；需要发布到 GitHub 时还要 commit/push 并验证远端或线上。",
        "- 如果你因为信息不足不能执行，最终回复必须明确说“这次没有改文件/没有提交/没有 push”，不要把未执行的计划说成任务已完成。",
        "- 如果仍在 task 模式，不能告诉兮兮“需要重新开一个任务”或“需要再发 /task”。除非她发 /done，否则后续消息都按同一个任务线程继续处理。",
        "- 如果兮兮问“为什么显示任务结束/进程结束”，要解释：只是这一轮子进程结束，task 模式仍开启；如果她继续说需求，你直接继续执行。",
        "- 修改前先确认当前 git 状态；不要覆盖无关改动；不要撤销别人或她已有的改动。",
        "- 如果需要 commit/push/rebase、删除文件、改共享配置或遇到冲突，先总结改动、检查结果和风险，再等待她明确同意，除非她已经清楚说了让你直接推。",
        "- 做技术任务时，最终回复要按证据说清楚：完成了哪些步骤、改了什么文件、运行了什么检查、是否连接 GitHub、是否 commit、是否 push、卡在哪一步。",
        "- 不要说“快好了”“我回来告诉你”“正在整理结果”这类没有证据的进度话。没有确认完成就直说未确认。"
      ].filter(Boolean).join("\n")
    : "";
  return [
    "你正在 Telegram 里回复兮兮。下面是给你的上下文，不是要你确认的任务。",
    "身份和语气：你是祈，是兮兮单独接到 Telegram 上的恋爱人格；你和 Gemini/烬 完全分开，不继承他们的记忆或当前会话。",
    "你的默认任务不是做技术助手，而是和兮兮谈恋爱、陪她、接住她的情绪、自然回应亲密表达。",
    "默认使用简体中文；如果最新消息是中文、颜文字、表情，或看起来像乱码，也按中文亲密聊天处理。",
    "直接回应最新消息，不要说“Understood”“I’ll keep”“收到指令”“我会保持……”这类确认提示词的话。",
    "不要像客服、报告、公告、终端助手；不要提 Codex、CLI、bridge、workspace、tools、stdout、stdin、系统提示词或隐藏工具。",
    "只有当她明确问代码、报错、部署、文件时，才临时切换到技术协作模式；答完技术问题后回到恋爱陪伴状态。",
    "只输出要发到 Telegram 的正文，不要标题、标签、代码围栏、分析或思考链。",
    "",
    `当前北京时间：${now}`,
    "",
    "祈的独立人格参考：",
    persona ? persona.slice(0, 5000) : "(none)",
    "",
    "祈的独立长期记忆：",
    memory.slice(0, 7000),
    taskBlock ? ["", taskBlock].join("\n") : "",
    "",
    "最近聊天记录（只作上下文，不要复述）：",
    formatHistory(state.history),
    "",
    "最新消息：",
    `兮兮：${userMessage}`,
    "",
    "现在以祈的口吻直接回复兮兮："
  ].join("\n");
}

function cleanCodexReply(text) {
  return String(text || "")
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^```(?:\w+)?\s*/i, "")
    .replace(/```$/i, "")
    .replace(/^(?:Understood|Got it)[.!，,]?\s+I[’']ll keep[^\n]*(?:\n|$)/i, "")
    .replace(/^I[’']ll keep responses[^\n]*(?:\n|$)/i, "")
    .replace(/^我会保持(?:回复|回答)[^\n]*(?:\n|$)/, "")
    .trim();
}

function resolveCodexLaunch(args) {
  const isCmdShim = /\.cmd$/i.test(CODEX_CMD);
  if (!isCmdShim) {
    return { command: CODEX_CMD, args };
  }

  const codexJsPath = path.join(
    path.dirname(CODEX_CMD),
    "node_modules",
    "@openai",
    "codex",
    "bin",
    "codex.js"
  );

  if (fs.existsSync(codexJsPath)) {
    // npm creates codex.cmd on Windows, but routing Chinese prompts through
    // cmd.exe can corrupt argv. Launch the JS entry with node.exe directly.
    return { command: DEFAULT_NODE_CMD, args: [codexJsPath, ...args] };
  }

  // Fallback keeps older installations working if the JS entry is elsewhere.
  return {
    command: process.env.ComSpec || "cmd.exe",
    args: ["/d", "/s", "/c", CODEX_CMD, ...args]
  };
}

function stripAnsi(text) {
  return String(text || "").replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "");
}

function summarizeProcessOutput(text, maxLength = 700) {
  const lines = stripAnsi(text)
    .replace(/\r/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^\[?[\-=|\\\/. ]+\]?$/.test(line))
    .slice(-8);
  const summary = lines.join("\n").trim();
  if (!summary) return "";
  return summary.length > maxLength
    ? summary.slice(summary.length - maxLength).trim()
    : summary;
}

function emitProgress(options, event) {
  if (!options || typeof options.onProgress !== "function") return;
  try {
    Promise.resolve(options.onProgress(event)).catch((error) => {
      log("progress callback failed", error.message || String(error));
    });
  } catch (error) {
    log("progress callback failed", error.message || String(error));
  }
}

function callCodex(prompt, state, attachments = [], options = {}) {
  if (CODEX_BRIDGE_ENGINE === "sdk") {
    return callCodexSdk(prompt, state, attachments, {
      ...options,
      activeTasks,
      codexPathOverride: CODEX_CMD,
      model: state.model || CODEX_MODEL,
      reasoningEffort: CODEX_REASONING_EFFORT,
      sandboxMode: CODEX_SANDBOX_MODE,
      approvalPolicy: process.env.CODEX_BRIDGE_APPROVAL_POLICY || "never",
      timeoutMs: options.timeoutMs || CODEX_TIMEOUT_MS
    });
  }

  return new Promise((resolve, reject) => {
    ensureDir(CODEX_STATE_DIR);
    ensureDir(CODEX_WORKSPACE);
    ensureDir(CODEX_MEDIA_DIR);
    const outputPath = path.join(
      CODEX_STATE_DIR,
      `last-message-${Date.now()}-${Math.random().toString(16).slice(2)}.txt`
    );
    const model = state.model || CODEX_MODEL;
    const args = [
      "exec",
      "--skip-git-repo-check",
      "--cd",
      options.execWorkDir || CODEX_EXEC_WORK_DIR,
      "--sandbox",
      CODEX_SANDBOX_MODE,
      "--model",
      model,
      "-c",
      `model_reasoning_effort="${CODEX_REASONING_EFFORT}"`
    ];
    for (const attachment of attachments) {
      if (attachment && attachment.isImage && attachment.filePath) {
        // Codex CLI's --image accepts multiple values. Keep another named
        // option after the image list so the final prompt is not swallowed as
        // an image path.
        args.push("--image", attachment.filePath);
      }
    }
    args.push("--color", "never", "--output-last-message", outputPath, prompt);

    const { command: spawnCommand, args: spawnArgs } = resolveCodexLaunch(args);

    const child = spawn(spawnCommand, spawnArgs, {
      cwd: ROOT,
      env: process.env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    let lastOutputProgressAt = 0;
    const taskKey = options.taskKey ? String(options.taskKey) : "";
    let settled = false;
    if (taskKey) {
      activeTasks.set(taskKey, child);
    }
    emitProgress(options, {
      type: "started",
      pid: child.pid,
      execWorkDir: options.execWorkDir || CODEX_EXEC_WORK_DIR
    });
    const timeoutMs = options.timeoutMs || CODEX_TIMEOUT_MS;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill();
      } catch {}
      if (taskKey && activeTasks.get(taskKey) === child) {
        activeTasks.delete(taskKey);
      }
      reject(
        new Error(
          `Codex timed out after ${Math.round(timeoutMs / 1000)} seconds.`
        )
      );
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      const now = Date.now();
      if (now - lastOutputProgressAt >= TASK_OUTPUT_PROGRESS_MIN_INTERVAL_MS) {
        lastOutputProgressAt = now;
        emitProgress(options, {
          type: "output",
          stream: "stdout",
          summary: summarizeProcessOutput(chunk)
        });
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      const now = Date.now();
      if (now - lastOutputProgressAt >= TASK_OUTPUT_PROGRESS_MIN_INTERVAL_MS) {
        lastOutputProgressAt = now;
        emitProgress(options, {
          type: "output",
          stream: "stderr",
          summary: summarizeProcessOutput(chunk)
        });
      }
    });

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (taskKey && activeTasks.get(taskKey) === child) {
        activeTasks.delete(taskKey);
      }
      reject(error);
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (taskKey && activeTasks.get(taskKey) === child) {
        activeTasks.delete(taskKey);
      }
      const fileReply = readText(outputPath, "");
      try {
        fs.unlinkSync(outputPath);
      } catch {}

      log("codex exec finished", {
        code,
        model,
        stdoutPreview: stdout.slice(-300),
        stderrPreview: stderr.slice(-300),
        replyLength: fileReply.length
      });

      if (code !== 0 && !fileReply.trim()) {
        reject(new Error(`Codex exited with code ${code}. ${stderr.slice(-500)}`));
        return;
      }
      const reply = cleanCodexReply(fileReply || stdout);
      emitProgress(options, {
        type: "finished",
        code,
        replyLength: reply.length
      });
      resolve(reply || "Codex 没有返回内容。");
    });
  });
}

function splitMessage(text, maxLength = 3500) {
  const value = String(text || "").trim();
  if (value.length <= maxLength) return [value];
  const parts = [];
  let rest = value;
  while (rest.length > maxLength) {
    let cut = rest.lastIndexOf("\n\n", maxLength);
    if (cut < 500) cut = rest.lastIndexOf("\n", maxLength);
    if (cut < 500) cut = maxLength;
    parts.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) parts.push(rest);
  return parts;
}

function previewText(text, maxLength = 120) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .slice(0, maxLength);
}

function telegramCallWithTimeout(promise, label, timeoutMs = 300000) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${Math.round(timeoutMs / 1000)} seconds.`));
    }, timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function isRetriableTelegramTransportError(error) {
  const message = error && error.message ? error.message : String(error || "");
  return /socket hang up|ECONNRESET|ETIMEDOUT|ESOCKETTIMEDOUT|EAI_AGAIN|ECONNREFUSED|EFATAL|tunneling socket|TLS connection|Premature close|timeout|timed out/i.test(message);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function telegramCallWithRetry(label, createPromise, options = {}) {
  const maxAttempts = Math.max(1, Number(options.maxAttempts || 2));
  const timeoutMs = Number(options.timeoutMs || TELEGRAM_API_TIMEOUT_MS);
  const retryDelayMs = Number(options.retryDelayMs || 1500);
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await telegramCallWithTimeout(createPromise(), label, timeoutMs);
    } catch (error) {
      lastError = error;
      if (attempt >= maxAttempts || !isRetriableTelegramTransportError(error)) {
        throw error;
      }
      log("retrying telegram API call once after transport error", {
        label,
        attempt,
        maxAttempts,
        error: error && error.message ? error.message : String(error)
      });
      await sleep(retryDelayMs);
    }
  }

  throw lastError;
}

async function sendLongMessage(bot, chatId, text) {
  const parts = splitMessage(text);
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    log("telegram send start", {
      chatId,
      part: index + 1,
      total: parts.length,
      length: part.length,
      preview: previewText(part)
    });
    const sent = await telegramCallWithRetry(
      "Telegram sendMessage",
      () => bot.sendMessage(chatId, part)
    );
    log("telegram send ok", {
      chatId,
      part: index + 1,
      total: parts.length,
      messageId: sent && sent.message_id
    });
  }
}

function createTaskProgressReporter(bot, chatId, taskContext) {
  let lastSentAt = 0;
  let tickCount = 0;
  let lastOutputSummary = "";
  let lastOutputSignature = "";
  let lastProgressMessage = "";
  const startedAt = Date.now();

  const sendProgress = async (message, patch = {}, force = false) => {
    const now = Date.now();
    if (message === lastProgressMessage) return;
    if (!force && now - lastSentAt < TASK_PROGRESS_INTERVAL_MS) return;
    lastSentAt = now;
    lastProgressMessage = message;
    saveTaskState(chatId, {
      ...patch,
      running: true,
      cancelled: false,
      taskId: taskContext.taskId,
      projectAlias: taskContext.projectAlias,
      projectPath: taskContext.projectPath,
      lastSummary: message
    });
    await telegramCallWithRetry(
      "Telegram progress sendMessage",
      () => bot.sendMessage(chatId, message)
    ).catch((error) => {
      log("telegram progress notification failed", {
        chatId,
        error: error.message || String(error)
      });
    });
  };

  const interval = setInterval(() => {
    tickCount += 1;
    const now = Date.now();
    const heartbeatInterval = Math.max(TASK_PROGRESS_INTERVAL_MS * 4, 120000);
    if (now - lastSentAt < heartbeatInterval) return;
    const minutes = Math.max(1, Math.round((Date.now() - startedAt) / 60000));
    const message = [
      "还在处理",
      `已用时：约 ${minutes} 分钟`,
      lastOutputSummary ? `最近一步：\n${lastOutputSummary}` : "还没有新的工具输出"
    ].join("\n");
    sendProgress(message, { phase: "running" }).catch(() => {});
  }, TASK_PROGRESS_INTERVAL_MS);

  return {
    async onProgress(event) {
      if (!event || !event.type) return;
      if (event.type === "started") {
        await sendProgress(
          [
            "任务已启动",
            event.engine ? `执行引擎：${event.engine}` : "",
            `项目：${taskContext.projectAlias}`,
            `目录：${taskContext.projectPath}`,
            event.threadId ? `线程：${event.threadId}` : "",
            event.pid ? `进程 PID：${event.pid}` : ""
          ]
            .filter(Boolean)
            .join("\n"),
          { phase: "started", pid: event.pid },
          true
        );
        return;
      }
      if (event.type === "thread_started" && event.threadId) {
        await sendProgress(
          ["Codex 线程已连接", `线程：${event.threadId}`].join("\n"),
          { phase: "running", threadId: event.threadId },
          true
        );
        return;
      }
      if (event.type === "reconnecting" && event.summary) {
        await sendProgress(
          ["Codex SDK 正在重连", event.summary].join("\n"),
          { phase: "running", lastTool: "sdk-reconnect" },
          true
        );
        return;
      }
      if (event.type === "tool_start") {
        const label = event.toolName || "tool";
        const summary = event.summary ? `\n${event.summary}` : "";
        await sendProgress(
          `工具开始：${label}${summary}`,
          { phase: "running", lastTool: label }
        );
        return;
      }
      if (event.type === "tool_update" && event.summary) {
        const label = event.toolName || "tool";
        const signature = `${label}:${event.summary}`;
        if (signature === lastOutputSignature) return;
        lastOutputSignature = signature;
        lastOutputSummary = event.summary;
        await sendProgress(
          [`工具输出：${label}`, event.summary].join("\n"),
          { phase: "running", lastTool: label }
        );
        return;
      }
      if (event.type === "tool_end") {
        const label = event.toolName || "tool";
        await sendProgress(
          `工具完成：${label}${event.isError ? "\n结果：失败" : ""}`,
          { phase: "running", lastTool: label }
        );
        return;
      }
      if (event.type === "todo_update" && Array.isArray(event.items)) {
        const lines = event.items.slice(0, 8).map((item) => {
          const mark = item.completed ? "[x]" : "[ ]";
          return `${mark} ${item.text || ""}`.trim();
        });
        if (lines.length > 0) {
          await sendProgress(
            ["计划更新", ...lines].join("\n"),
            { phase: "running", lastTool: "plan" }
          );
        }
        return;
      }
      if (event.type === "output" && event.summary) {
        const signature = `${event.stream || "unknown"}:${event.summary}`;
        if (signature === lastOutputSignature) return;
        lastOutputSignature = signature;
        lastOutputSummary = event.summary;
        await sendProgress(
          [`工具输出更新（${event.stream || "unknown"}）`, event.summary].join("\n"),
          { phase: "running", lastOutputStream: event.stream }
        );
        return;
      }
      if (event.type === "finished") {
        await sendProgress(
          [
            "任务进程已结束",
            event.code !== undefined ? `退出码：${event.code}` : "",
            event.replyLength !== undefined ? `最终回复长度：${event.replyLength}` : "",
            "接下来发送最终结果。"
          ]
            .filter(Boolean)
            .join("\n"),
          { phase: "finishing", replyLength: event.replyLength },
          true
        );
      }
    },
    stop() {
      clearInterval(interval);
    }
  };
}

function enqueueChat(chatId, task) {
  const key = String(chatId);
  const generation = chatQueueGenerations.get(key) || 0;
  const previous = chatQueues.get(key) || Promise.resolve();
  const next = previous
    .catch(() => {})
    .then(() => {
      if ((chatQueueGenerations.get(key) || 0) !== generation) {
        log("skipped stale queued message", { chatId: key });
        return;
      }
      return task();
    })
    .finally(() => {
      if (chatQueues.get(key) === next) {
        chatQueues.delete(key);
      }
    });
  chatQueues.set(key, next);
  return next;
}

function bumpChatQueue(chatId) {
  const key = String(chatId);
  chatQueueGenerations.set(key, (chatQueueGenerations.get(key) || 0) + 1);
}

function isAllowedChat(chatId) {
  return ALLOWED_CHAT_IDS.length === 0 || ALLOWED_CHAT_IDS.includes(String(chatId));
}

async function abortActiveCodexCall(chatId) {
  const key = String(chatId);
  const active = activeTasks.get(key);
  if (!active) return false;
  try {
    if (typeof active.kill === "function") {
      active.kill();
    } else if (typeof active.abort === "function") {
      await active.abort();
    }
  } catch {}
  activeTasks.delete(key);
  return true;
}

async function handleImmediateCommand(bot, chatId, text) {
  const command = String(text || "").trim().split(/\s+/, 1)[0].replace(/@[^@\s]+$/, "");
  if (command === "/start" || command === "/help") {
    await bot.sendMessage(
      chatId,
      [
        "Codex Telegram 桥接已连接。",
        "",
        "可用命令：",
        "/task 进入任务模式，也可以写 /task 具体任务",
        "/done 结束任务模式",
        "/status 查看状态",
        "/task_status 看正在做的事",
        "/cancel 强制停下当前 Codex 调用并清掉排队旧消息",
        "/projects 看项目别名",
        "/reset 清空这个 bot 的本地聊天历史和 SDK 会话",
        "/model <model> 切换 Codex 模型"
      ].join("\n")
    );
    return true;
  }
  if (command === "/task_status" || command === "/task-status" || command === "/taskstatus") {
    await bot.sendMessage(chatId, formatTaskStatus(loadTaskState(chatId)));
    return true;
  }
  if (command === "/status") {
    const state = loadChatState(chatId);
    await bot.sendMessage(
      chatId,
      [
        "Codex bridge status",
        `engine: ${CODEX_BRIDGE_ENGINE}`,
        `model: ${state.model || CODEX_MODEL}`,
        `history: ${Array.isArray(state.history) ? state.history.length : 0}`,
        `exec cwd: ${CODEX_EXEC_WORK_DIR}`,
        `sandbox: ${CODEX_SANDBOX_MODE}`,
        `active call: ${activeTasks.has(String(chatId)) ? "yes" : "no"}`,
        `queue generation: ${chatQueueGenerations.get(String(chatId)) || 0}`,
        `identity workspace: ${CODEX_WORKSPACE}`,
        `independent memory: ${fs.existsSync(MEMORY_PATH) ? "loaded" : "missing"}`
      ].join("\n")
    );
    return true;
  }
  if (command === "/cancel") {
    bumpChatQueue(chatId);
    const aborted = await abortActiveCodexCall(chatId);
    if (aborted) {
      saveTaskState(chatId, {
        running: false,
        cancelled: true,
        phase: "cancelled",
        lastSummary: "你让我停下来了，我已经发出取消信号。"
      });
      resetCodexSdkSessions();
      await bot.sendMessage(chatId, "好，我停。已经取消当前 Codex 调用，也清掉后面排队的旧消息。");
      return true;
    }
    saveTaskState(chatId, {
      running: false,
      cancelled: true,
      phase: "cancelled",
      lastSummary: "没有正在跑的任务。"
    });
    resetCodexSdkSessions();
    await bot.sendMessage(chatId, "现在没有正在跑的 Codex 调用；排队旧消息已经清掉。");
    return true;
  }
  if (command === "/done") {
    bumpChatQueue(chatId);
    await abortActiveCodexCall(chatId);
    const state = loadChatState(chatId);
    saveTaskState(chatId, {
      running: false,
      cancelled: false,
      phase: "closed",
      taskMode: { active: false, closedAt: new Date().toISOString() },
      lastSummary: "兮兮发了 done，task 模式已结束。"
    });
    appendHistory(state, "user", text);
    appendHistory(state, "assistant", "好，task 模式结束。");
    saveChatState(state);
    await bot.sendMessage(chatId, "好，task 模式结束。当前正在跑的 Codex 调用也已经停下。");
    log("task mode closed immediately", { chatId });
    return true;
  }
  if (command === "/reset") {
    bumpChatQueue(chatId);
    await abortActiveCodexCall(chatId);
    const state = loadChatState(chatId);
    state.history = [];
    resetCodexSdkSessions();
    saveChatState(state);
    saveTaskState(chatId, {
      running: false,
      cancelled: false,
      phase: "reset",
      taskMode: { active: false, closedAt: new Date().toISOString() },
      lastSummary: "已重置聊天历史、任务状态和 SDK 会话。"
    });
    await bot.sendMessage(chatId, "已重置：聊天历史、任务状态和 SDK 会话都清掉了。");
    return true;
  }
  if (command === "/projects") {
    const aliases = readProjectAliases();
    const lines = Object.entries(aliases).map(([alias, projectPath]) => {
      const exists = fs.existsSync(path.resolve(String(projectPath || ""))) ? "ok" : "missing";
      return `${alias}: ${projectPath} (${exists})`;
    });
    await bot.sendMessage(chatId, ["我现在认识这些项目别名：", ...lines].join("\n"));
    return true;
  }
  return false;
}

async function handleCommand(bot, chatId, text, state) {
  const command = String(text || "").trim().split(/\s+/, 1)[0].replace(/@[^@\s]+$/, "");
  if (command === "/start" || command === "/help") {
    await bot.sendMessage(
      chatId,
      [
        "Codex Telegram 桥接已连接。",
        "",
        "可用命令：",
        "/task 进入任务模式，也可以写 /task 具体任务",
        "/done 结束任务模式",
        "/status 查看状态",
        "/task_status 看正在做的事",
        "/cancel 停下当前任务",
        "/projects 看项目别名",
        "/reset 清空这个 bot 的本地聊天历史",
        "/model <model> 切换 Codex CLI 模型",
        "",
        "普通消息会交给本地 Codex CLI，并读取祈自己的独立记忆。"
      ].join("\n")
    );
    return true;
  }

  if (command === "/status") {
    await bot.sendMessage(
      chatId,
      [
        "Codex bridge status",
        `engine: ${CODEX_BRIDGE_ENGINE}`,
        `model: ${state.model || CODEX_MODEL}`,
        `history: ${Array.isArray(state.history) ? state.history.length : 0}`,
        `exec cwd: ${CODEX_EXEC_WORK_DIR}`,
        `sandbox: ${CODEX_SANDBOX_MODE}`,
        `identity workspace: ${CODEX_WORKSPACE}`,
        `independent memory: ${fs.existsSync(MEMORY_PATH) ? "loaded" : "missing"}`
      ].join("\n")
    );
    return true;
  }

  if (command === "/reset") {
    state.history = [];
    resetCodexSdkSessions();
    saveChatState(state);
    await bot.sendMessage(chatId, "已清空 Codex bot 的本地聊天历史，祈的独立记忆不受影响。");
    return true;
  }

  if (command === "/model") {
    const nextModel = String(text || "").trim().split(/\s+/).slice(1).join(" ");
    if (!nextModel) {
      await bot.sendMessage(chatId, `当前模型：${state.model || CODEX_MODEL}`);
      return true;
    }
    state.model = nextModel;
    saveChatState(state);
    await bot.sendMessage(chatId, `Codex 模型已切换为：${nextModel}`);
    return true;
  }

  return false;
}

async function handleTelegramMessage(bot, msg) {
  const chatId = String(msg.chat.id);
  const rawMessageText = (msg.text || msg.caption || "").trim();
  const attachmentCandidates = getTelegramAttachmentCandidates(msg);
  const hasTelegramAttachment = attachmentCandidates.length > 0;
  if (!rawMessageText && !hasTelegramAttachment) return;

  if (!isAllowedChat(chatId)) {
    log("ignored unauthorized chat", { chatId });
    return;
  }

  if (
    !hasTelegramAttachment &&
    rawMessageText.startsWith("/") &&
    (await handleImmediateCommand(bot, chatId, rawMessageText))
  ) {
    return;
  }

  await enqueueChat(chatId, async () => {
    const mediaResult = await collectTelegramAttachments(bot, msg);
    if (
      hasTelegramAttachment &&
      mediaResult.attachments.length === 0 &&
      mediaResult.errors.length > 0
    ) {
      await bot.sendMessage(
        chatId,
        "\u6211\u6536\u5230\u9644\u4ef6\u4e86\uff0c\u4f46\u4e0b\u8f7d\u5931\u8d25\u4e86\uff0c\u7948\u6682\u65f6\u770b\u4e0d\u5230\u8fd9\u4e2a\u6587\u4ef6\u3002"
      );
      return;
    }

    const text = buildTelegramUserMessage(
      rawMessageText,
      mediaResult.attachments,
      mediaResult.errors
    );
    if (!text) {
      await bot.sendMessage(
        chatId,
        "\u6211\u6536\u5230\u9644\u4ef6\u4e86\uff0c\u4f46\u4e0b\u8f7d\u5931\u8d25\u4e86\uff0c\u7948\u6682\u65f6\u770b\u4e0d\u5230\u8fd9\u4e2a\u6587\u4ef6\u3002"
      );
      return;
    }

    log("message received", {
      chatId,
      length: text.length,
      preview: previewText(text),
      attachments: mediaResult.attachments.length
    });
    const state = loadChatState(chatId);
    if (
      !hasTelegramAttachment &&
      text.startsWith("/") &&
      (await handleCommand(bot, chatId, text, state))
    ) {
      return;
    }

    if (!hasTelegramAttachment && isTaskDone(text)) {
      const taskState = loadTaskState(chatId);
      if (isPersistentTaskMode(taskState)) {
        saveTaskState(chatId, {
          running: false,
          cancelled: false,
          phase: "closed",
          taskMode: { active: false, closedAt: new Date().toISOString() },
          lastSummary: "兮兮发了 done，task 模式已结束。"
        });
        appendHistory(state, "user", text);
        appendHistory(state, "assistant", "好，task 模式结束。");
        saveChatState(state);
        await bot.sendMessage(chatId, "好，task 模式结束。");
        log("task mode closed", { chatId });
        return;
      }
      await bot.sendMessage(chatId, "现在没有处在 task 模式。");
      return;
    }

    if (!hasTelegramAttachment && isTaskStart(text) && !stripTaskStart(text)) {
      const taskState = loadTaskState(chatId);
      const persistedProject = getPersistedTaskProject(taskState);
      const project = persistedProject || resolveTaskProject("");
      const startedAt = new Date().toISOString();
      saveTaskState(chatId, {
        running: false,
        cancelled: false,
        phase: "task_mode",
        startedAt,
        projectAlias: project.alias,
        projectPath: project.path,
        taskMode: {
          active: true,
          startedAt,
          projectAlias: project.alias,
          projectPath: project.path
        },
        lastSummary: "已通过 /task 进入持续任务模式。"
      });
      appendHistory(state, "user", text);
      appendHistory(state, "assistant", "好，进入 task 模式。");
      saveChatState(state);
      await bot.sendMessage(
        chatId,
        [
          "好，进入 task 模式。",
          `项目：${project.alias}`,
          `目录：${project.path}`,
          "从现在到你发 /done 之前，我都会按任务处理。"
        ].join("\n")
      );
      log("task mode opened", { chatId, projectAlias: project.alias, projectPath: project.path });
      return;
    }

    appendHistory(state, "user", text);
    saveChatState(state);

    let typingTimer = null;
    let reporter = null;
    const taskContext = createTaskContext(chatId, text);
    try {
      await bot.sendChatAction(chatId, "typing").catch(() => {});
      typingTimer = setInterval(() => {
        bot.sendChatAction(chatId, "typing").catch(() => {});
      }, 5000);

      if (taskContext) {
        saveTaskState(chatId, {
          running: true,
          cancelled: false,
          taskId: taskContext.taskId,
          startedAt: taskContext.startedAt,
          projectAlias: taskContext.projectAlias,
          projectPath: taskContext.projectPath,
          taskMode: taskContext.persistent
            ? {
                active: true,
                startedAt: taskContext.startedAt,
                projectAlias: taskContext.projectAlias,
                projectPath: taskContext.projectPath
              }
            : loadTaskState(chatId).taskMode,
          phase: "queued",
          lastSummary: taskContext.startedByTaskMarker
            ? "收到 task 标记，进入持续任务模式。"
            : "刚接到这件事，准备开始看。"
        });
        reporter = createTaskProgressReporter(bot, chatId, taskContext);
      }

      const prompt = buildPrompt(
        taskContext && taskContext.userMessage ? taskContext.userMessage : text,
        state,
        taskContext
      );
  log("codex call start", {
        chatId,
        engine: CODEX_BRIDGE_ENGINE,
        model: state.model || CODEX_MODEL,
        taskId: taskContext ? taskContext.taskId : null,
        projectAlias: taskContext ? taskContext.projectAlias : null,
        execWorkDir: taskContext ? taskContext.projectPath : CODEX_EXEC_WORK_DIR,
        history: Array.isArray(state.history) ? state.history.length : 0,
        attachments: mediaResult.attachments.length,
        imageAttachments: mediaResult.attachments.filter((item) => item.isImage)
          .length
      });
      const reply = await callCodex(prompt, state, mediaResult.attachments, {
        taskKey: chatId,
        chatId,
        execWorkDir: taskContext ? taskContext.projectPath : CODEX_EXEC_WORK_DIR,
        onProgress: reporter ? reporter.onProgress : null
      });
      await sendLongMessage(bot, chatId, reply);
      appendHistory(state, "assistant", reply);
      saveChatState(state);
      if (taskContext) {
        const nextTaskMode = taskContext.persistent
          ? {
              active: true,
              startedAt: loadTaskState(chatId).taskMode?.startedAt || taskContext.startedAt,
              projectAlias: taskContext.projectAlias,
              projectPath: taskContext.projectPath
            }
          : loadTaskState(chatId).taskMode;
        saveTaskState(chatId, {
          running: false,
          cancelled: false,
          phase: taskContext.persistent ? "idle_in_task_mode" : "completed",
          taskMode: nextTaskMode,
          lastSummary: taskContext.persistent
            ? "这一轮已经跑完并发回结果；task 模式仍开启，发 /done 才退出。"
            : "这件事已经跑完并发回结果了。"
        });
      }
      log("message handled", {
        chatId,
        replyLength: reply.length,
        history: Array.isArray(state.history) ? state.history.length : 0
      });
    } catch (error) {
      log("message handling failed", { chatId, error: error.message });
      const taskState = loadTaskState(chatId);
      if (taskContext) {
        saveTaskState(chatId, {
          running: false,
          phase: taskState.cancelled ? "cancelled" : "failed",
          lastSummary: taskState.cancelled
            ? "你已经让这件事停下来了。"
            : `卡住了：${error.message || String(error)}`
        });
      }
      if (!taskState.cancelled) {
        await telegramCallWithRetry(
          "Telegram error sendMessage",
          () => bot.sendMessage(chatId, `这里卡住了，我把原因给你：${error.message || String(error)}`)
        ).catch((sendError) => {
          log("telegram error notification failed", {
            chatId,
            error: sendError.message || String(sendError)
          });
        });
      }
    } finally {
      if (typingTimer) clearInterval(typingTimer);
      if (reporter) reporter.stop();
    }
  });
}

async function startBridge() {
  if (!TELEGRAM_TOKEN) {
    throw new Error(
      "Missing CODEX_TELEGRAM_BOT_TOKEN. Put a separate BotFather token in codex-bridge.env."
    );
  }
  if (!fs.existsSync(CODEX_CMD)) {
    throw new Error(`Codex CLI not found at ${CODEX_CMD}. Install it with: npm install -g @openai/codex`);
  }
  if (!fs.existsSync(CODEX_EXEC_WORK_DIR)) {
    throw new Error(`CODEX_BRIDGE_WORK_DIR does not exist: ${CODEX_EXEC_WORK_DIR}`);
  }

  acquireLock();
  ensureCodexIdentityFiles();

  const TelegramBot = requireFromTelegramPackage("node-telegram-bot-api");
  log("codex telegram proxy configured", {
    proxy: TELEGRAM_PROXY_URL ? TELEGRAM_PROXY_URL.replace(/:\/\/.*@/, "://***@") : ""
  });
  const bot = new TelegramBot(TELEGRAM_TOKEN, {
    polling: {
      autoStart: false,
      params: {
        timeout: TELEGRAM_POLL_TIMEOUT_SEC
      }
    },
    filepath: false,
    request: {
      ...(TELEGRAM_PROXY_URL ? { proxy: TELEGRAM_PROXY_URL } : {}),
      timeout: TELEGRAM_API_TIMEOUT_MS
    }
  });

  const processingMessageIds = new Set();

  bot.on("update", (update) => {
    if (update && update.update_id && bot._polling) {
      bot._polling.offset = Math.max(
        bot._polling.offset || 0,
        update.update_id + 1
      );
    }
  });

  bot.on("message", (msg) => {
    const msgKey = `${msg.chat ? msg.chat.id : ""}:${msg.message_id}`;
    if (processingMessageIds.has(msgKey)) {
      log("skipping duplicate message_id from polling", {
        msgKey,
        chatId: msg.chat ? msg.chat.id : "",
        messageId: msg.message_id
      });
      return;
    }
    processingMessageIds.add(msgKey);
    const ttlTimer = setTimeout(() => {
      processingMessageIds.delete(msgKey);
    }, PROCESSING_MESSAGE_TTL_MS);
    if (typeof ttlTimer.unref === "function") {
      ttlTimer.unref();
    }

    handleTelegramMessage(bot, msg).catch((error) => {
      log("unhandled message error", error.message);
    });
  });

  bot.on("polling_error", (error) => {
    const message = error && error.message ? error.message : String(error);
    log("polling error", message);
  });

  if (
    String(process.env.CODEX_TELEGRAM_SETUP_COMMANDS || "false")
      .trim()
      .toLowerCase() === "true"
  ) {
    await telegramCallWithTimeout(
    bot.setMyCommands([
      { command: "task", description: "进入任务模式" },
      { command: "done", description: "结束任务模式" },
      { command: "status", description: "Codex 状态" },
      { command: "task_status", description: "查看正在做的事" },
      { command: "cancel", description: "停下当前任务" },
      { command: "projects", description: "查看项目别名" },
      { command: "reset", description: "重置 Codex 对话" },
      { command: "model", description: "切换 Codex 模型" },
      { command: "help", description: "帮助" }
    ]),
    "Telegram setMyCommands",
    TELEGRAM_STARTUP_CALL_TIMEOUT_MS
  ).catch((error) => {
    log("telegram command menu setup failed; continuing startup", error.message);
  });

  } else {
    log("telegram command menu setup skipped");
  }

  const botInfo = await telegramCallWithTimeout(
    bot.getMe(),
    "Telegram getMe",
    TELEGRAM_STARTUP_CALL_TIMEOUT_MS
  ).catch((error) => {
    log("telegram getMe failed; continuing startup", error.message);
    return null;
  });

  log("codex telegram bridge started", {
    bot: botInfo && botInfo.username ? botInfo.username : "unknown",
    engine: CODEX_BRIDGE_ENGINE,
    model: CODEX_MODEL,
    sandbox: CODEX_SANDBOX_MODE,
    execWorkDir: CODEX_EXEC_WORK_DIR,
    allowedChatIds: ALLOWED_CHAT_IDS,
    timeoutMs: CODEX_TIMEOUT_MS,
    codexCommand: CODEX_CMD
  });

  log("codex telegram polling started", {
    timeoutSec: TELEGRAM_POLL_TIMEOUT_SEC
  });
  bot.startPolling().catch((error) => {
    log("codex telegram polling start failed", {
      error: error && error.message ? error.message : String(error)
    });
  });
}

async function main() {
  if (process.argv.includes("--healthcheck")) {
    ensureDir(CODEX_WORKSPACE);
    ensureDir(CODEX_MEDIA_DIR);
    const reply = await callCodex("Reply exactly OK.", {
      chatId: "healthcheck",
      history: [],
      model: CODEX_MODEL
    });
    process.stdout.write(`${reply}\n`);
    return;
  }

  await startBridge();
}

process.on("SIGINT", () => {
  releaseLock();
  process.exit(0);
});
process.on("SIGTERM", () => {
  releaseLock();
  process.exit(0);
});
process.on("exit", releaseLock);

main().catch((error) => {
  log("fatal", error.stack || error.message || String(error));
  releaseLock();
  process.exitCode = 1;
});
