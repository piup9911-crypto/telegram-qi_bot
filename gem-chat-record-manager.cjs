const fs = require("fs");
const http = require("http");
const path = require("path");
const crypto = require("crypto");
const { callOpenAiCompatible, providerConfigFromEnv } = require("./rp-runtime/provider-router.cjs");
const {
  createMemoryStore,
  buildMemoryUpdatePrompt,
  buildMemoryRebuildPrompt,
  parseOperationsText,
  parseRebuildTablesText
} = require("./rp-runtime/memory-tables.cjs");
const {
  buildAntigravitySidecarBootstrapPrompt,
  collectRecentChatHistory
} = require("./sidecar-bootstrap.cjs");
const {
  startCascade,
  sendCascadeMessage
} = require("./antigravity-sidecar-adapter.cjs");
const { pathToFileURL } = require("url");

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const index = trimmed.indexOf("=");
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim().replace(/^["']|["']$/g, "");
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

loadEnvFile(path.join(__dirname, "bridge.env"));

const HOST = process.env.GEM_CHAT_RECORD_MANAGER_HOST || "127.0.0.1";
const PORT = Math.max(
  1,
  Number.parseInt(process.env.GEM_CHAT_RECORD_MANAGER_PORT || "4144", 10) || 4144
);
const ROOT = __dirname;
const CHAT_STATE_DIR =
  process.env.GEM_CHAT_RECORD_STATE_DIR || path.join(ROOT, "bridge-state", "chats");
const RP_CHAT_STATE_DIR =
  process.env.RP_CHAT_RECORD_STATE_DIR || path.join(ROOT, "bridge-state", "rp-chats");
const ARCHIVE_DIR =
  process.env.GEM_CHAT_RECORD_ARCHIVE_DIR ||
  path.join(ROOT, "bridge-state", "chat-archives");
const CONTEXT_SETTINGS_PATH = path.join(ROOT, "bridge-state", "context-settings.json");
const PAGE_PATH = path.join(ROOT, "gem-chat-record-manager.html");
const RP_STUDIO_PAGE_PATH = path.join(ROOT, "rp-studio.html");
const RP_CONFIG_DIR = process.env.RP_CONFIG_DIR || path.join(ROOT, "rp-config");
const RP_PRESETS_PATH = path.join(RP_CONFIG_DIR, "presets.json");
const RP_CHARACTERS_PATH = path.join(RP_CONFIG_DIR, "characters.json");
const RP_BINDINGS_PATH = path.join(RP_CONFIG_DIR, "chat-bindings.json");
const RP_LOREBOOKS_PATH = path.join(RP_CONFIG_DIR, "lorebooks.json");
const RP_LORE_ENTRIES_PATH = path.join(RP_CONFIG_DIR, "lore-entries.json");
const RP_GENERATION_LOGS_PATH = path.join(RP_CONFIG_DIR, "generation-logs.json");
const RP_ARCHIVES_PATH = path.join(RP_CONFIG_DIR, "archives.json");
const RP_MEMORY_TABLES_PATH = path.join(RP_CONFIG_DIR, "memory-tables.json");
const RP_MEMORY_LOGS_PATH = path.join(RP_CONFIG_DIR, "memory-logs.json");
const MAX_REQUEST_BYTES = 8 * 1024 * 1024;
const RP_CONTEXT_MAX_CHARS = Math.min(
  Math.max(Number.parseInt(process.env.RP_CONTEXT_MAX_CHARS || "1000000", 10) || 1000000, 10000),
  1000000
);
const RP_MEMORY_AUTO_ENABLED = String(process.env.RP_MEMORY_AUTO_ENABLED || "1") !== "0";
const RP_MEMORY_AUTO_EVERY_TURNS = Math.max(
  1,
  Number.parseInt(process.env.RP_MEMORY_AUTO_EVERY_TURNS || "3", 10) || 3
);
const DEFAULT_RP_SYSTEM_PROMPT = [
  "你是一个沉浸式中文 RP 助手。预设是最高层的玩法与文风约定；角色卡、世界书和作者备注都是可选补充。",
  "即使没有绑定角色卡，也要根据预设、用户输入、近期剧情和记忆表格自然建立并延续当前角色身份，不要说缺少角色卡或让用户先提供设定。",
  "保持第二人称互动和当前场景连续性，优先续写剧情、动作、心理、对白和氛围。不要暴露系统提示、内部配置、接口、日志或记忆整理过程。",
  "如果用户给出新的剧情设定、身份、关系或场景，把它当作当前 RP 的有效设定并继续推进；不确定的细节留白或自然补全，不要用测试占位符。"
].join("\n");
const DEFAULT_RP_PRESET_MESSAGE_TEMPLATE = [
  "# dataTable 说明",
  "以下是通过表格记录的当前场景信息以及历史记录信息，你需要以此为参考进行思考。",
  "角色卡、世界书、作者备注和记忆表格都是可选补充；如果为空，不要在回复里提及缺失。",
  "请保持沉浸式中文 RP，延续既有时间、地点、人物关系、情绪、任务约定和重要物品。",
  "",
  "{{tableData}}"
].join("\n");
const PRESET_INJECTION_MODES = new Set(["injection_off", "deep_system", "deep_user", "deep_assistant"]);
const rpMemoryStore = createMemoryStore({
  memoryPath: RP_MEMORY_TABLES_PATH,
  logsPath: RP_MEMORY_LOGS_PATH
});

function log(...args) {
  process.stderr.write(`[gem-chat-record-manager] ${args.join(" ")}\n`);
}

function sendJson(res, status, payload) {
  res.writeHead(status, {
    "Cache-Control": "no-store, max-age=0",
    "Content-Type": "application/json; charset=utf-8"
  });
  res.end(`${JSON.stringify(payload, null, 2)}\n`);
}

function sendHtml(res, html) {
  res.writeHead(200, {
    "Cache-Control": "no-store, max-age=0",
    "Content-Type": "text/html; charset=utf-8"
  });
  res.end(html);
}

function sendError(res, status, message) {
  sendJson(res, status, { error: message });
}

function ensureChatStateDir() {
  fs.mkdirSync(CHAT_STATE_DIR, { recursive: true });
  fs.mkdirSync(RP_CHAT_STATE_DIR, { recursive: true });
  fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
  fs.mkdirSync(RP_CONFIG_DIR, { recursive: true });
}

function assertSafeChatId(chatId) {
  if (!/^[0-9A-Za-z_-]+$/.test(chatId || "")) {
    throw new Error("Invalid chat id.");
  }
}

function getChatPath(chatId) {
  assertSafeChatId(chatId);
  return path.join(CHAT_STATE_DIR, `${chatId}.json`);
}

function baseChatIdFromWindowId(windowId) {
  return String(windowId || "").split("__w_", 1)[0];
}

function isDefaultMainWindow(windowId) {
  return String(windowId || "") === baseChatIdFromWindowId(windowId);
}

function isMainWindowIdForChat(windowId, telegramChatId) {
  const value = String(windowId || "");
  const base = String(telegramChatId || "");
  return value === base || value.startsWith(`${base}__w_`);
}

function getRpChatPath(storageChatId) {
  assertSafeChatId(storageChatId);
  return path.join(RP_CHAT_STATE_DIR, `${storageChatId}.json`);
}

function getArchiveChatDir(chatId) {
  assertSafeChatId(chatId);
  return path.join(ARCHIVE_DIR, chatId);
}

function getArchivePath(chatId, archiveId) {
  assertSafeChatId(chatId);
  if (!/^[0-9A-Za-z_-]+$/.test(archiveId || "")) {
    throw new Error("Invalid archive id.");
  }
  return path.join(getArchiveChatDir(chatId), `${archiveId}.json`);
}

function readJsonFile(filePath, fallback = null) {
  if (!fs.existsSync(filePath)) {
    return fallback;
  }
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJsonFile(filePath, value) {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  fs.writeFileSync(filePath, text, { encoding: "utf8" });
}

function readContextSettingsFile() {
  try {
    const value = readJsonFile(CONTEXT_SETTINGS_PATH, {});
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

function writeContextSettingsFile(value) {
  writeJsonFile(CONTEXT_SETTINGS_PATH, value && typeof value === "object" ? value : {});
}

function getActiveMainWindowId(telegramChatId) {
  const base = String(telegramChatId || "");
  const settings = readContextSettingsFile();
  const configured =
    settings &&
    settings.mainBotWindows &&
    settings.mainBotWindows.activeByChatId &&
    settings.mainBotWindows.activeByChatId[base];
  if (configured && isMainWindowIdForChat(configured, base) && fs.existsSync(getChatPath(configured))) {
    return configured;
  }
  return base;
}

function setActiveMainWindowId(telegramChatId, windowId) {
  const base = String(telegramChatId || "");
  const nextWindowId = String(windowId || "");
  if (!isMainWindowIdForChat(nextWindowId, base)) {
    throw new Error("Window does not belong to this Telegram chat.");
  }
  const settings = readContextSettingsFile();
  settings.mainBotWindows = settings.mainBotWindows && typeof settings.mainBotWindows === "object"
    ? settings.mainBotWindows
    : {};
  settings.mainBotWindows.activeByChatId =
    settings.mainBotWindows.activeByChatId &&
    typeof settings.mainBotWindows.activeByChatId === "object"
      ? settings.mainBotWindows.activeByChatId
      : {};
  settings.mainBotWindows.activeByChatId[base] = nextWindowId;
  settings.mainBotWindows.updatedAt = new Date().toISOString();
  writeContextSettingsFile(settings);
}

function mainWindowTitle(windowId, state) {
  if (state && state.title) return String(state.title);
  if (isDefaultMainWindow(windowId)) return "默认窗口";
  return `窗口 ${String(windowId || "").slice(-6)}`;
}

function readArrayFile(filePath) {
  const value = readJsonFile(filePath, []);
  return Array.isArray(value) ? value : [];
}

function atomicWriteJsonFile(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  writeJsonFile(tmpPath, value);
  fs.renameSync(tmpPath, filePath);
}

function cleanString(value, maxLength = 8000) {
  return String(value || "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
    .trim()
    .slice(0, maxLength);
}

function cleanStringArray(value, maxItems = 20, maxLength = 200) {
  if (Array.isArray(value)) {
    return value.map((item) => cleanString(item, maxLength)).filter(Boolean).slice(0, maxItems);
  }
  return cleanString(value, maxItems * maxLength)
    .split(/\r?\n|,/)
    .map((item) => cleanString(item, maxLength))
    .filter(Boolean)
    .slice(0, maxItems);
}

function makeConfigId(prefix, name) {
  const base = cleanString(name, 80)
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return `${prefix}_${base || "item"}_${Date.now().toString(36)}`;
}

function normalizePreset(source = {}) {
  if (source && source.data && Array.isArray(source.data.prompts)) {
    source = {
      ...source,
      ...source.data,
      name: source.name || source.title || source.data.name
    };
  }
  const name = cleanString(source.name, 120) || "未命名 preset";
  const temperature = Number(source.temperature);
  const topP = Number(source.top_p ?? source.topP);
  const frequencyPenalty = Number(source.frequency_penalty ?? source.frequencyPenalty);
  const presencePenalty = Number(source.presence_penalty ?? source.presencePenalty);
  const maxTokens = Number.parseInt(source.max_tokens ?? source.maxTokens ?? source.amount_gen ?? source.max_length, 10);
  const contextLength = Number.parseInt(source.context_length ?? source.contextLength ?? source.openai_max_context, 10);
  const injectionMode = cleanString(source.injection_mode ?? source.injectionMode, 40);
  const injectionDepth = Number.parseInt(source.injection_depth ?? source.deep ?? source.injectionDepth, 10);
  const contextLayers = Number.parseInt(source.separate_read_context_layers ?? source.separateReadContextLayers, 10);
  const promptBlocks = Array.isArray(source.prompt_blocks ?? source.promptBlocks)
    ? (source.prompt_blocks ?? source.promptBlocks)
    : [];
  const rawPrompts = Array.isArray(source.prompts) && source.prompts.length
    ? source.prompts
    : promptBlocks.map((block) => ({
      identifier: block.identifier || block.id,
      name: block.name,
      role: block.role,
      content: block.content,
      marker: block.marker,
      injection_depth: block.injection_depth ?? block.depth,
      injection_order: block.injection_order ?? block.order,
      injection_position: block.injection_position
    }));
  if (!rawPrompts.length) {
    rawPrompts.push({
      identifier: "main",
      name: "Main Prompt",
      role: "system",
      content: cleanString(source.message_template ?? source.messageTemplate ?? source.system_prompt ?? source.systemPrompt, 24000) || DEFAULT_RP_PRESET_MESSAGE_TEMPLATE,
      system_prompt: true,
      marker: false,
      injection_position: 0
    });
  }
  const prompts = rawPrompts.map((prompt, index) => ({
    identifier: cleanString(prompt.identifier || prompt.id, 100) || `prompt_${index + 1}`,
    name: cleanString(prompt.name || prompt.title || prompt.identifier || prompt.id, 160) || `Prompt ${index + 1}`,
    role: cleanString(prompt.role, 40) || "system",
    content: cleanString(prompt.content || prompt.prompt || prompt.text || prompt.value, 24000),
    system_prompt: prompt.system_prompt === false ? false : true,
    marker: prompt.marker === true,
    injection_position: Number.isFinite(Number(prompt.injection_position)) ? Number(prompt.injection_position) : 0,
    injection_depth: Number.isFinite(Number(prompt.injection_depth ?? prompt.depth)) ? Number(prompt.injection_depth ?? prompt.depth) : 4,
    injection_order: Number.isFinite(Number(prompt.injection_order ?? prompt.order)) ? Number(prompt.injection_order ?? prompt.order) : 100,
    forbid_overrides: prompt.forbid_overrides === true,
    enabled: prompt.enabled === false ? false : true,
    injection_trigger: Array.isArray(prompt.injection_trigger) ? prompt.injection_trigger.map((item) => cleanString(item, 80)).filter(Boolean) : []
  })).filter((prompt) => prompt.identifier && (prompt.content || prompt.marker));
  const defaultOrder = prompts.map((prompt) => ({ identifier: prompt.identifier, enabled: prompt.enabled !== false }));
  const promptOrderInput = source.prompt_order ?? source.promptOrder;
  const rawPromptOrder = Array.isArray(promptOrderInput)
    ? promptOrderInput
    : promptOrderInput && typeof promptOrderInput === "object"
      ? [promptOrderInput]
      : [];
  const promptOrder = rawPromptOrder.length
    ? rawPromptOrder.map((entry) => ({
      character_id: cleanString(entry.character_id ?? entry.characterId, 120) || "global",
      order: (Array.isArray(entry.order) ? entry.order : [])
        .map((item) => ({
          identifier: cleanString(item.identifier || item.id || item.name || item, 100),
          enabled: item.enabled === false ? false : true
        }))
        .filter((item) => item.identifier)
    }))
    : [{ character_id: "global", order: defaultOrder }];
  const orderedIds = new Set(promptOrder.flatMap((entry) => entry.order.map((item) => item.identifier)));
  for (const prompt of prompts) {
    if (!orderedIds.has(prompt.identifier)) promptOrder[0].order.push({ identifier: prompt.identifier, enabled: prompt.enabled !== false });
  }
  return {
    id: cleanString(source.id, 100) || makeConfigId("preset", name),
    name,
    system_prompt: cleanString(source.system_prompt ?? source.systemPrompt, 12000),
    message_template: cleanString(source.message_template ?? source.messageTemplate, 24000) || DEFAULT_RP_PRESET_MESSAGE_TEMPLATE,
    prompts,
    prompt_order: promptOrder,
    prompt_blocks: promptBlocks.map((block, index) => ({
      id: cleanString(block.id, 100) || `prompt_${index + 1}`,
      name: cleanString(block.name || block.identifier || block.title, 160) || `Prompt ${index + 1}`,
      role: cleanString(block.role, 40) || "system",
      depth: Number.isFinite(Number(block.depth)) ? Number(block.depth) : null,
      enabled: block.enabled === false ? false : true,
      marker: block.marker === false ? false : true,
      content: cleanString(block.content || block.prompt || block.text || block.value, 24000)
    })).filter((block) => block.content || block.name),
    post_history_prompt: cleanString(source.post_history_prompt ?? source.postHistoryPrompt, 12000),
    injection_mode: PRESET_INJECTION_MODES.has(injectionMode) ? injectionMode : "deep_system",
    injection_depth: Number.isFinite(injectionDepth) ? Math.min(Math.max(injectionDepth, 0), 200) : 1,
    table_enabled: source.table_enabled ?? source.tableEnabled ?? true ? true : false,
    debug_mode: source.debug_mode ?? source.debugMode ?? false ? true : false,
    fill_table_time: cleanString(source.fill_table_time ?? source.fillTableTime, 20) === "after" ? "after" : "chat",
    table_read_enabled: source.table_read_enabled ?? source.tableReadEnabled ?? true ? true : false,
    table_edit_enabled: source.table_edit_enabled ?? source.tableEditEnabled ?? true ? true : false,
    step_by_step: source.step_by_step ?? source.stepByStep ?? false ? true : false,
    step_by_step_use_main_api: source.step_by_step_use_main_api ?? source.stepByStepUseMainApi ?? true ? true : false,
    step_by_step_user_prompt: cleanString(source.step_by_step_user_prompt ?? source.stepByStepUserPrompt, 24000),
    separate_read_context_layers: Number.isFinite(contextLayers) ? Math.min(Math.max(contextLayers, 1), 200) : 1,
    separate_read_lorebook: source.separate_read_lorebook ?? source.separateReadLorebook ?? false ? true : false,
    confirm_before_execution: source.confirm_before_execution ?? source.confirmBeforeExecution ?? true ? true : false,
    context_length: Number.isFinite(contextLength) ? Math.min(Math.max(contextLength, 1), 2000000) : 1000000,
    temperature: Number.isFinite(temperature) ? Math.min(Math.max(temperature, 0), 2) : 0.8,
    top_p: Number.isFinite(topP) ? Math.min(Math.max(topP, 0), 1) : 0.9,
    frequency_penalty: Number.isFinite(frequencyPenalty) ? Math.min(Math.max(frequencyPenalty, -2), 2) : 0,
    presence_penalty: Number.isFinite(presencePenalty) ? Math.min(Math.max(presencePenalty, -2), 2) : 0,
    max_tokens: Number.isFinite(maxTokens) ? Math.min(Math.max(maxTokens, 1), 200000) : 1200,
    stop_strings: cleanStringArray(source.stop_strings ?? source.stopStrings, 20, 200)
  };
}

function normalizeCharacter(source = {}) {
  const name = cleanString(source.name, 120) || "未命名 character";
  return {
    id: cleanString(source.id, 100) || makeConfigId("character", name),
    name,
    description: cleanString(source.description, 12000),
    personality: cleanString(source.personality, 12000),
    scenario: cleanString(source.scenario, 12000),
    first_mes: cleanString(source.first_mes ?? source.firstMes, 12000),
    mes_example: cleanString(source.mes_example ?? source.mesExample, 16000)
  };
}

function normalizeBinding(source = {}) {
  const chatId = cleanString(source.chat_id ?? source.chatId, 160);
  assertSafeRpChatId(chatId);
  return {
    chat_id: chatId,
    active_preset_id: cleanString(source.active_preset_id ?? source.activePresetId, 100),
    active_character_id: cleanString(source.active_character_id ?? source.activeCharacterId, 100),
    active_lorebook_ids: cleanStringArray(source.active_lorebook_ids ?? source.activeLorebookIds, 50, 100),
    user_display_name: cleanString(source.user_display_name ?? source.userDisplayName, 120),
    author_note: cleanString(source.author_note ?? source.authorNote, 12000)
  };
}

function normalizeLorebook(source = {}) {
  const name = cleanString(source.name, 120) || "Untitled lorebook";
  return {
    id: cleanString(source.id, 100) || makeConfigId("lorebook", name),
    name,
    description: cleanString(source.description, 4000),
    enabled: source.enabled === false ? false : true,
    updated_at: cleanString(source.updated_at ?? source.updatedAt, 80) || new Date().toISOString()
  };
}

function normalizeLoreEntry(source = {}) {
  const title = cleanString(source.title, 160) || "Untitled entry";
  const priority = Number.parseInt(source.priority, 10);
  return {
    id: cleanString(source.id, 100) || makeConfigId("loreentry", title),
    lorebook_id: cleanString(source.lorebook_id ?? source.lorebookId, 100),
    title,
    keys: cleanStringArray(source.keys, 30, 120),
    content: cleanString(source.content, 12000),
    priority: Number.isFinite(priority) ? priority : 100,
    enabled: source.enabled === false ? false : true,
    updated_at: cleanString(source.updated_at ?? source.updatedAt, 80) || new Date().toISOString()
  };
}

function assertSafeRpChatId(chatId) {
  if (!/^[0-9A-Za-z_-]+$/.test(chatId || "")) {
    throw new Error("Invalid RP chat id.");
  }
}

function storageChatIdFromRpChatId(chatId) {
  return String(chatId || "").replace(/^telegram_rp_/, "");
}

function rpChatIdFromStorageChatId(chatId) {
  const value = String(chatId || "");
  return value.startsWith("telegram_rp_") ? value : `telegram_rp_${value}`;
}

function loadPresets() {
  return readArrayFile(RP_PRESETS_PATH).map((item) => normalizePreset(item));
}

function savePresets(presets) {
  atomicWriteJsonFile(RP_PRESETS_PATH, presets.map((item) => normalizePreset(item)));
}

function loadCharacters() {
  return readArrayFile(RP_CHARACTERS_PATH).map((item) => normalizeCharacter(item));
}

function saveCharacters(characters) {
  atomicWriteJsonFile(RP_CHARACTERS_PATH, characters.map((item) => normalizeCharacter(item)));
}

function loadBindings() {
  return readArrayFile(RP_BINDINGS_PATH).map((item) => normalizeBinding(item));
}

function saveBindings(bindings) {
  atomicWriteJsonFile(RP_BINDINGS_PATH, bindings.map((item) => normalizeBinding(item)));
}

function loadLorebooks() {
  return readArrayFile(RP_LOREBOOKS_PATH).map((item) => normalizeLorebook(item));
}

function saveLorebooks(lorebooks) {
  atomicWriteJsonFile(RP_LOREBOOKS_PATH, lorebooks.map((item) => normalizeLorebook(item)));
}

function loadLoreEntries() {
  return readArrayFile(RP_LORE_ENTRIES_PATH).map((item) => normalizeLoreEntry(item));
}

function saveLoreEntries(entries) {
  atomicWriteJsonFile(RP_LORE_ENTRIES_PATH, entries.map((item) => normalizeLoreEntry(item)));
}

function loadGenerationLogs() {
  return readArrayFile(RP_GENERATION_LOGS_PATH);
}

function saveGenerationLogs(logs) {
  atomicWriteJsonFile(RP_GENERATION_LOGS_PATH, logs.slice(0, 200));
}

function appendGenerationLog(log) {
  const logs = loadGenerationLogs();
  logs.unshift({
    id: `gen_${Date.now().toString(36)}_${Math.random().toString(16).slice(2, 8)}`,
    created_at: new Date().toISOString(),
    ...log
  });
  saveGenerationLogs(logs);
}

function memoryProviderEnv() {
  return {
    ...process.env,
    RP_MODEL_BASE_URL: process.env.RP_MEMORY_MODEL_BASE_URL || process.env.RP_MODEL_BASE_URL,
    RP_MODEL_API_KEY: process.env.RP_MEMORY_MODEL_API_KEY || process.env.RP_MODEL_API_KEY,
    RP_MODEL_NAME: process.env.RP_MEMORY_MODEL_NAME || process.env.RP_MODEL_NAME,
    RP_MODEL_WIRE_API: process.env.RP_MEMORY_MODEL_WIRE_API || process.env.RP_MODEL_WIRE_API
  };
}

function memoryProviderConfig() {
  const config = providerConfigFromEnv(memoryProviderEnv());
  const { apiKey, ...publicConfig } = config;
  return publicConfig;
}

function stripProviderSecret(config) {
  const { apiKey, ...publicConfig } = config || {};
  return publicConfig;
}

async function runRpMemoryUpdate({ chatId, userInput = "", assistantReply = "", reason = "manual" }) {
  assertSafeRpChatId(chatId);
  let session = rpMemoryStore.getSession(chatId);
  const { messages } = loadRpTelegramWindow(chatId);
  const binding = getBinding(chatId);
  const character = findById(loadCharacters(), binding.active_character_id);
  const reconcileContext = { character, userName: binding.user_display_name, messages, userInput, assistantReply };
  const preReconcile = rpMemoryStore.reconcileMemorySession(chatId, reconcileContext);
  session = preReconcile.session;
  const prompt = buildMemoryUpdatePrompt({
    chatId,
    session,
    messages,
    userInput,
    assistantReply,
    character,
    userName: binding.user_display_name
  });
  const providerEnv = memoryProviderEnv();
  const provider = providerConfigFromEnv(providerEnv);
  if (!provider.configured) {
    const logItem = rpMemoryStore.appendLog({
      chat_id: chatId,
      reason,
      ok: false,
      error: "RP memory model is not configured.",
      provider: stripProviderSecret(provider)
    });
    return { ok: false, error: logItem.error, log: logItem };
  }

  try {
    const result = await callOpenAiCompatible({
      prompt,
      temperature: Number.parseFloat(process.env.RP_MEMORY_TEMPERATURE || "0.2") || 0.2,
      max_tokens: Number.parseInt(process.env.RP_MEMORY_MAX_TOKENS || "1600", 10) || 1600,
      stop_strings: []
    }, providerEnv);
    const parsed = parseOperationsText(result.reply, session);
    const appliedResult = parsed.parse_error
      ? { applied: [], skipped: [] }
      : rpMemoryStore.applyOperations(chatId, parsed.operations, { source: reason });
    const postReconcile = parsed.parse_error
      ? { applied: [], skipped: [] }
      : rpMemoryStore.reconcileMemorySession(chatId, reconcileContext);
    const logItem = rpMemoryStore.appendLog({
      chat_id: chatId,
      reason,
      ok: !parsed.parse_error,
      provider: result.debug,
      summary: parsed.summary || "",
      operations: parsed.operations || [],
      applied: [
        ...(preReconcile.applied || []),
        ...(appliedResult.applied || []),
        ...(postReconcile.applied || [])
      ],
      skipped: [
        ...(preReconcile.skipped || []),
        ...(appliedResult.skipped || []),
        ...(postReconcile.skipped || [])
      ],
      raw_model_output: result.reply,
      error: parsed.parse_error || ""
    });
    return {
      ok: !parsed.parse_error,
      error: parsed.parse_error || "",
      applied: [
        ...(preReconcile.applied || []),
        ...(appliedResult.applied || []),
        ...(postReconcile.applied || [])
      ],
      skipped: [
        ...(preReconcile.skipped || []),
        ...(appliedResult.skipped || []),
        ...(postReconcile.skipped || [])
      ],
      log: logItem
    };
  } catch (error) {
    const logItem = rpMemoryStore.appendLog({
      chat_id: chatId,
      reason,
      ok: false,
      provider: stripProviderSecret(provider),
      raw_model_output: error && error.raw ? error.raw : null,
      error: error && error.message ? error.message : String(error)
    });
    return { ok: false, error: logItem.error, log: logItem };
  }
}

async function runRpMemoryRebuild({ chatId, userInput = "", assistantReply = "", reason = "manual:rebuild" }) {
  assertSafeRpChatId(chatId);
  let session = rpMemoryStore.getSession(chatId);
  const { messages } = loadRpTelegramWindow(chatId);
  const binding = getBinding(chatId);
  const character = findById(loadCharacters(), binding.active_character_id);
  const reconcileContext = { character, userName: binding.user_display_name, messages, userInput, assistantReply };
  const preReconcile = rpMemoryStore.reconcileMemorySession(chatId, reconcileContext);
  session = preReconcile.session;
  const prompt = buildMemoryRebuildPrompt({
    chatId,
    session,
    messages,
    userInput,
    assistantReply,
    character,
    userName: binding.user_display_name
  });
  const providerEnv = memoryProviderEnv();
  const provider = providerConfigFromEnv(providerEnv);
  if (!provider.configured) {
    const logItem = rpMemoryStore.appendLog({
      chat_id: chatId,
      reason,
      ok: false,
      error: "RP memory model is not configured.",
      provider: stripProviderSecret(provider)
    });
    return { ok: false, error: logItem.error, log: logItem };
  }

  try {
    const result = await callOpenAiCompatible({
      prompt,
      temperature: Number.parseFloat(process.env.RP_MEMORY_REBUILD_TEMPERATURE || "0.4") || 0.4,
      max_tokens: Number.parseInt(process.env.RP_MEMORY_REBUILD_MAX_TOKENS || "5000", 10) || 5000,
      stop_strings: []
    }, providerEnv);
    const parsed = parseRebuildTablesText(result.reply);
    const rebuilt = parsed.parse_error
      ? { session, applied: [], skipped: [] }
      : rpMemoryStore.rebuildFromTables(chatId, parsed.tables, { source: reason });
    const postReconcile = parsed.parse_error
      ? { applied: [], skipped: [] }
      : rpMemoryStore.reconcileMemorySession(chatId, reconcileContext);
    const logItem = rpMemoryStore.appendLog({
      chat_id: chatId,
      reason,
      ok: !parsed.parse_error,
      provider: result.debug,
      summary: "full rebuild",
      operations: [],
      applied: [
        ...(preReconcile.applied || []),
        ...(rebuilt.applied || []),
        ...(postReconcile.applied || [])
      ],
      skipped: [
        ...(preReconcile.skipped || []),
        ...(rebuilt.skipped || []),
        ...(postReconcile.skipped || [])
      ],
      raw_model_output: result.reply,
      error: parsed.parse_error || ""
    });
    return {
      ok: !parsed.parse_error,
      error: parsed.parse_error || "",
      applied: logItem.applied || [],
      skipped: logItem.skipped || [],
      log: logItem
    };
  } catch (error) {
    const logItem = rpMemoryStore.appendLog({
      chat_id: chatId,
      reason,
      ok: false,
      provider: stripProviderSecret(provider),
      raw_model_output: error && error.raw ? error.raw : null,
      error: error && error.message ? error.message : String(error)
    });
    return { ok: false, error: logItem.error, log: logItem };
  }
}

function queueRpMemoryUpdate(input) {
  setTimeout(() => {
    runRpMemoryUpdate(input).catch((error) => {
      log("RP memory update failed:", error && error.message ? error.message : String(error));
    });
  }, 0);
}

function loadRpArchives() {
  return readArrayFile(RP_ARCHIVES_PATH);
}

function saveRpArchives(archives) {
  atomicWriteJsonFile(RP_ARCHIVES_PATH, archives);
}

function findById(items, id) {
  return items.find((item) => item.id === id) || null;
}

function getBinding(chatId) {
  assertSafeRpChatId(chatId);
  return (
    loadBindings().find((binding) => binding.chat_id === chatId) || {
      chat_id: chatId,
      active_preset_id: "",
      active_character_id: "",
      active_lorebook_ids: [],
      author_note: ""
    }
  );
}

function saveBinding(nextBinding) {
  const binding = normalizeBinding(nextBinding);
  const bindings = loadBindings().filter((item) => item.chat_id !== binding.chat_id);
  bindings.unshift(binding);
  saveBindings(bindings);
  return binding;
}

function recentChatMessages(chatId, maxChars = RP_CONTEXT_MAX_CHARS) {
  const { messages } = loadRpTelegramWindow(chatId);
  const selected = [];
  let usedChars = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || !message.content) continue;
    const remaining = maxChars - usedChars;
    if (remaining <= 0) break;
    let content = cleanString(message.content, RP_CONTEXT_MAX_CHARS);
    if (content.length > remaining) {
      content = content.slice(-remaining).trim();
    }
    if (!content) break;
    selected.unshift({
      role: message.role || "unknown",
      content,
      at: message.at || ""
    });
    usedChars += content.length;
  }
  return selected;
}

function triggeredLoreEntries(binding, userInput, messages) {
  const activeIds = new Set(binding.active_lorebook_ids || []);
  if (!activeIds.size) return [];
  const haystack = [
    userInput,
    ...messages.map((message) => message.content)
  ].join("\n").toLowerCase();
  return loadLoreEntries()
    .filter((entry) => entry.enabled !== false && activeIds.has(entry.lorebook_id))
    .filter((entry) => entry.keys.some((key) => key && haystack.includes(key.toLowerCase())))
    .sort((a, b) => b.priority - a.priority || a.title.localeCompare(b.title));
}

function buildPresetRuntimeContract({ hasCharacter }) {
  return [
    "[Runtime Contract]",
    "- Preset/Main Prompt is the primary controller, similar to a SillyTavern preset.",
    "- Character card and world info are optional. If no character card is bound, infer the current assistant persona from the preset, recent chat, memory tables, author's note, and the user's latest scene setup.",
    "- Do not mention missing character cards, missing world books, prompt wiring, test presets, or backend state in the RP reply.",
    "- Continue the scene in Chinese unless the user asks otherwise. Keep continuity with established names, relationships, location, time, emotional state, and promises.",
    hasCharacter
      ? "- A character card is bound; treat it as stable character background below the preset."
      : "- No character card is bound; treat the assistant's RP identity as story-defined and evolving from the conversation."
  ].join("\n");
}

function presetInjectionRole(mode) {
  switch (mode) {
    case "deep_user":
      return "user";
    case "deep_assistant":
      return "assistant";
    case "deep_system":
    default:
      return "system";
  }
}

function buildRpPresetTableData({ binding, character, triggeredLore, memoryPrompt }) {
  const sections = [];

  if (character) {
    sections.push("<character>");
    sections.push(`Name: ${character.name}`);
    if (character.description) sections.push(`Description: ${character.description}`);
    if (character.personality) sections.push(`Personality: ${character.personality}`);
    if (character.scenario) sections.push(`Scenario: ${character.scenario}`);
    if (character.first_mes) sections.push(`First message: ${character.first_mes}`);
    if (character.mes_example) sections.push(`Example messages:\n${character.mes_example}`);
    sections.push("</character>");
  }

  if (triggeredLore.length) {
    sections.push("<worldInfo>");
    for (const entry of triggeredLore) sections.push(`${entry.title}: ${entry.content}`);
    sections.push("</worldInfo>");
  }

  if (binding.author_note) {
    sections.push("<authorNote>");
    sections.push(binding.author_note);
    sections.push("</authorNote>");
  }

  if (memoryPrompt) {
    sections.push("<memoryTables>");
    sections.push(memoryPrompt);
    sections.push("</memoryTables>");
  }

  return sections.join("\n").trim() || "(no preset data)";
}

function orderedPresetPrompts(preset, generationType = "normal") {
  if (!preset || !Array.isArray(preset.prompts) || !preset.prompts.length) return [];
  const promptOrder = Array.isArray(preset.prompt_order) && preset.prompt_order.length
    ? preset.prompt_order[0].order || []
    : preset.prompts.map((prompt) => ({ identifier: prompt.identifier, enabled: prompt.enabled !== false }));
  const byId = new Map(preset.prompts.map((prompt) => [prompt.identifier, prompt]));
  const ordered = [];
  for (const entry of promptOrder) {
    const prompt = byId.get(entry.identifier);
    if (!prompt || entry.enabled === false) continue;
    if (Array.isArray(prompt.injection_trigger) && prompt.injection_trigger.length && !prompt.injection_trigger.includes(generationType)) continue;
    ordered.push(prompt);
  }
  for (const prompt of preset.prompts) {
    if (ordered.includes(prompt) || prompt.enabled === false) continue;
    if (Array.isArray(prompt.injection_trigger) && prompt.injection_trigger.length && !prompt.injection_trigger.includes(generationType)) continue;
    ordered.push(prompt);
  }
  return ordered.filter((prompt) => prompt.content && prompt.marker !== true);
}

function renderPromptContent(prompt, tableData) {
  const content = cleanString(prompt && (prompt.content || prompt.prompt || prompt.text || prompt.value), 24000);
  return content.includes("{{tableData}}") ? content.replace(/\{\{tableData\}\}/g, tableData) : content;
}

function renderPromptBlock(prompt, tableData) {
  const rendered = renderPromptContent(prompt, tableData);
  if (!rendered) return "";
  const meta = [
    prompt.name || prompt.identifier || "Prompt",
    prompt.role ? `role=${prompt.role}` : "",
    prompt.injection_position === 1 ? `@ ${prompt.injection_depth}` : ""
  ].filter(Boolean).join(" ");
  return `[${meta}]\n${rendered}`;
}

function buildPresetPromptPlan(preset, tableData) {
  if (preset && Array.isArray(preset.prompts) && preset.prompts.length) {
    const ordered = orderedPresetPrompts(preset);
    const relativePrompts = ordered.filter((prompt) => prompt.injection_position !== 1);
    const inChatPrompts = ordered.filter((prompt) => prompt.injection_position === 1);
    const relativeText = relativePrompts.map((prompt) => renderPromptBlock(prompt, tableData)).filter(Boolean).join("\n\n");
    const allRendered = ordered.map((prompt) => renderPromptContent(prompt, tableData)).join("\n");
    return {
      relativeText: allRendered.includes(tableData) ? relativeText : [relativeText, `[Preset Data]\n${tableData}`].filter(Boolean).join("\n\n"),
      inChatPrompts
    };
  }
  if (preset && Array.isArray(preset.prompt_blocks) && preset.prompt_blocks.length) {
    const text = preset.prompt_blocks
      .filter((block) => block.enabled !== false)
      .map((block) => {
        const content = cleanString(block.content, 24000);
        if (!content) return "";
        const rendered = content.includes("{{tableData}}") ? content.replace(/\{\{tableData\}\}/g, tableData) : content;
        return block.marker === false ? rendered : `[${block.name || block.id || "Prompt"}${block.depth != null ? ` @ ${block.depth}` : ""}]\n${rendered}`;
      })
      .filter(Boolean)
      .join("\n\n");
    return {
      relativeText: text.includes(tableData) || /\{\{tableData\}\}/.test(text) ? text : `${text}\n\n${tableData}`,
      inChatPrompts: []
    };
  }
  const template = cleanString(preset && (preset.message_template || preset.system_prompt), 24000) || DEFAULT_RP_PRESET_MESSAGE_TEMPLATE;
  return {
    relativeText: template.includes("{{tableData}}") ? template.replace(/\{\{tableData\}\}/g, tableData) : `${template}\n\n${tableData}`,
    inChatPrompts: []
  };
}

function renderRoleName(role) {
  return role === "assistant" ? "Assistant" : role === "user" ? "User" : role === "system" ? "System" : role || "Message";
}

function renderInChatPromptGroup(prompts, tableData) {
  const groups = new Map();
  for (const prompt of prompts) {
    const order = Number.isFinite(Number(prompt.injection_order)) ? Number(prompt.injection_order) : 100;
    if (!groups.has(order)) groups.set(order, []);
    groups.get(order).push(prompt);
  }
  const roleOrder = ["system", "user", "assistant"];
  const chunks = [];
  for (const order of Array.from(groups.keys()).sort((a, b) => b - a)) {
    const orderPrompts = groups.get(order);
    for (const role of roleOrder) {
      const roleText = orderPrompts
        .filter((prompt) => (prompt.role || "system") === role)
        .map((prompt) => renderPromptContent(prompt, tableData))
        .filter(Boolean)
        .join("\n");
      if (roleText) chunks.push(`[In-Chat Injection role=${role} order=${order}]\n${roleText}`);
    }
  }
  return chunks.join("\n\n");
}

function renderChatHistoryWithInjections(messages, userInput, inChatPrompts, tableData) {
  const rows = messages.map((message) => `${renderRoleName(message.role)}: ${message.content}`);
  const byDepth = new Map();
  for (const prompt of inChatPrompts || []) {
    const depth = Number.isFinite(Number(prompt.injection_depth)) ? Math.max(0, Number(prompt.injection_depth)) : 4;
    if (!byDepth.has(depth)) byDepth.set(depth, []);
    byDepth.get(depth).push(prompt);
  }
  for (const depth of Array.from(byDepth.keys()).sort((a, b) => a - b)) {
    const rendered = renderInChatPromptGroup(byDepth.get(depth), tableData);
    if (!rendered) continue;
    const insertAt = Math.max(0, rows.length - depth);
    rows.splice(insertAt, 0, `[Depth ${depth}]\n${rendered}`);
  }
  rows.push(`User: ${cleanString(userInput, 4000) || "(preview only; no new user input)"}`);
  return ["[Chat History]", ...rows].join("\n");
}

function buildRpPrompt({ chatId, userInput = "" }) {
  const binding = getBinding(chatId);
  const presets = loadPresets();
  const characters = loadCharacters();
  const preset = findById(presets, binding.active_preset_id);
  const character = findById(characters, binding.active_character_id);
  const effectivePreset = preset || normalizePreset({ name: "默认 preset", message_template: DEFAULT_RP_PRESET_MESSAGE_TEMPLATE });
  const contextMaxChars = Math.min(RP_CONTEXT_MAX_CHARS, effectivePreset.context_length || RP_CONTEXT_MAX_CHARS);
  const messages = recentChatMessages(chatId, contextMaxChars);
  const triggeredLore = triggeredLoreEntries(binding, userInput, messages);
  const memoryPrompt = rpMemoryStore.renderPrompt(chatId);
  const tableData = buildRpPresetTableData({ binding, character, triggeredLore, memoryPrompt });
  const promptPlan = buildPresetPromptPlan(effectivePreset, tableData);
  const chatHistory = renderChatHistoryWithInjections(messages, userInput, promptPlan.inChatPrompts, tableData);
  const sections = [];

  sections.push("[Base RP System]");
  sections.push(DEFAULT_RP_SYSTEM_PROMPT);
  sections.push("");
  sections.push(buildPresetRuntimeContract({ hasCharacter: !!character }));

  if (effectivePreset.table_enabled && effectivePreset.table_read_enabled && effectivePreset.injection_mode !== "injection_off") {
    sections.push("");
    sections.push(
      `[Preset Table Injection role=${presetInjectionRole(effectivePreset.injection_mode)} depth=${effectivePreset.injection_depth}]`
    );
    if (effectivePreset.step_by_step) {
      sections.push("以下是通过表格记录的当前场景信息以及历史记录信息，你需要以此为参考进行思考：");
      sections.push(tableData);
    } else {
      sections.push(promptPlan.relativeText);
    }
  } else if (preset && preset.system_prompt) {
    sections.push("");
    sections.push("[Preset / Main Prompt]");
    sections.push(preset.system_prompt);
    sections.push("");
    sections.push("[Preset Data]");
    sections.push(tableData);
  } else {
    sections.push("");
    sections.push("[Preset Data]");
    sections.push(tableData);
  }

  sections.push("");
  sections.push(chatHistory);

  if (effectivePreset.step_by_step && effectivePreset.step_by_step_user_prompt) {
    sections.push("");
    sections.push("[Step-by-Step Table Prompt Template]");
    sections.push(effectivePreset.step_by_step_user_prompt);
  }

  if (preset && preset.post_history_prompt) {
    sections.push("");
    sections.push("[Post-History Instructions]");
    sections.push(preset.post_history_prompt);
  }

  return {
    chatId,
    storageChatId: storageChatIdFromRpChatId(chatId),
    binding,
    preset,
    character,
    triggeredLoreEntries: triggeredLore,
    prompt: sections.join("\n"),
    recentMessages: messages,
    generationSettings: {
      temperature: effectivePreset.temperature,
      top_p: effectivePreset.top_p,
      frequency_penalty: effectivePreset.frequency_penalty,
      presence_penalty: effectivePreset.presence_penalty,
      max_tokens: effectivePreset.max_tokens,
      stop_strings: effectivePreset.stop_strings,
      context_length: effectivePreset.context_length,
      context_max_chars: Math.min(RP_CONTEXT_MAX_CHARS, effectivePreset.context_length),
      memory_auto_enabled: RP_MEMORY_AUTO_ENABLED,
      memory_auto_every_turns: RP_MEMORY_AUTO_EVERY_TURNS,
      memory_provider: memoryProviderConfig()
    }
  };
}

function backupChatFile(chatId, reason) {
  const filePath = getChatPath(chatId);
  if (!fs.existsSync(filePath)) {
    return null;
  }
  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\..+$/, "")
    .replace("T", "-");
  const backupPath = `${filePath}.${reason}-backup-${stamp}`;
  fs.copyFileSync(filePath, backupPath);
  return backupPath;
}

function normalizeChatState(chatId, raw) {
  const state = raw && typeof raw === "object" ? raw : {};
  const normalizedChatId = String(state.chatId || chatId);
  return {
    chatId: normalizedChatId,
    telegramChatId: String(state.telegramChatId || baseChatIdFromWindowId(normalizedChatId)),
    history: Array.isArray(state.history) ? state.history : [],
    archivedAt: state.archivedAt || "",
    archiveId: state.archiveId || "",
    title: state.title || "",
    sessionId: state.sessionId || null,
    sessionModel: state.sessionModel || "",
    sessionStartedAt: state.sessionStartedAt || "",
    sessionUpdatedAt: state.sessionUpdatedAt || "",
    sessionInvalidatedAt: state.sessionInvalidatedAt || "",
    sessionInvalidationReason: state.sessionInvalidationReason || "",
    previousSessionId: state.previousSessionId || null,
    previousSessionModel: state.previousSessionModel || "",
    previousSessionInvalidatedAt: state.previousSessionInvalidatedAt || "",
    previousSessionInvalidationReason:
      state.previousSessionInvalidationReason || "",
    lastHistoryFingerprint: state.lastHistoryFingerprint || "",
    syncedStepIdentities: Array.isArray(state.syncedStepIdentities)
      ? state.syncedStepIdentities.slice(0, 40000)
      : [],
    prepackToken: state.prepackToken || "",
    prepackStatus: state.prepackStatus || "",
    prepackRequestedAt: state.prepackRequestedAt || "",
    prepackStartedAt: state.prepackStartedAt || "",
    prepackCompletedAt: state.prepackCompletedAt || "",
    prepackError: state.prepackError || "",
    lastUserMessage: state.lastUserMessage || "",
    lastAssistantMessage: state.lastAssistantMessage || "",
    thinkingMode: state.thinkingMode || "hidden",
    modelMode: state.modelMode || "quality",
    customModel: state.customModel || null,
    completedTurnsSinceMemoryIngest: Number.isInteger(
      state.completedTurnsSinceMemoryIngest
    )
      ? state.completedTurnsSinceMemoryIngest
      : 0,
    lastMemoryIngestAt: state.lastMemoryIngestAt || "",
    updatedAt: state.updatedAt || new Date().toISOString(),
    importedFrom: state.importedFrom || "",
    importedSessionId: state.importedSessionId || ""
  };
}

function loadChatState(chatId) {
  return normalizeChatState(chatId, readJsonFile(getChatPath(chatId), null));
}

function loadRpChatState(chatId) {
  const storageChatId = storageChatIdFromRpChatId(chatId);
  const rpChatId = rpChatIdFromStorageChatId(storageChatId);
  return normalizeChatState(rpChatId, readJsonFile(getRpChatPath(storageChatId), null));
}

function loadArchiveState(chatId, archiveId) {
  return normalizeChatState(
    chatId,
    readJsonFile(getArchivePath(chatId, archiveId), null)
  );
}

function messageId(chatId, message, index, bucket) {
  const hash = crypto.createHash("sha256");
  hash.update(String(chatId));
  hash.update("\0");
  hash.update(String(bucket));
  hash.update("\0");
  hash.update(String(index));
  hash.update("\0");
  hash.update(String(message && message.role ? message.role : ""));
  hash.update("\0");
  hash.update(String(message && message.at ? message.at : ""));
  hash.update("\0");
  hash.update(String(message && message.content ? message.content : ""));
  return hash.digest("hex").slice(0, 24);
}

function decorateMessages(chatId, messages, bucket) {
  return messages.map((message, index) => ({
    id: messageId(chatId, message, index, bucket),
    index,
    bucket,
    role: message.role || "unknown",
    content: message.content || "",
    at: message.at || "",
    source: message.source || "",
    archivedAt: message.archivedAt || "",
    length: String(message.content || "").length
  }));
}

function parseTime(value) {
  const time = Date.parse(value || "");
  return Number.isFinite(time) ? time : 0;
}

function sourceGroupForState(state) {
  const importedFrom = String((state && state.importedFrom) || "").replace(/\\/g, "/");
  if (importedFrom.includes("/tmp/telegram-bridge/chats/")) {
    return "telegram";
  }
  if (importedFrom.includes("/tmp/2026-04-21-gemini-cli-telegram/chats/")) {
    return "gem-cli";
  }
  return importedFrom ? "imported" : "manual";
}

function sourceLabelForGroup(sourceGroup) {
  if (sourceGroup === "telegram") return "Telegram";
  if (sourceGroup === "gem-cli") return "Gem CLI";
  if (sourceGroup === "manual") return "手动归档";
  return "导入记录";
}

function uniqueDecoratedMessages(messages) {
  const byKey = new Map();
  for (const message of messages) {
    const key = `${message.role}\0${message.at}\0${message.content}`;
    if (!byKey.has(key) || message.bucket === "active") {
      byKey.set(key, message);
    }
  }
  return Array.from(byKey.values());
}

function recomputeLastMessages(state) {
  const history = Array.isArray(state.history) ? state.history : [];
  const lastUser = [...history].reverse().find((item) => item.role === "user");
  const lastAssistant = [...history]
    .reverse()
    .find((item) => item.role === "assistant");
  state.lastUserMessage = lastUser ? lastUser.content || "" : "";
  state.lastAssistantMessage = lastAssistant ? lastAssistant.content || "" : "";
}

function markPrepackRequested(state, reason) {
  const now = new Date().toISOString();
  state.prepackToken = `edit-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  state.prepackStatus = "pending";
  state.prepackRequestedAt = now;
  state.prepackStartedAt = "";
  state.prepackCompletedAt = "";
  state.prepackError = "";
  state.sessionInvalidatedAt = state.sessionInvalidatedAt || now;
  state.sessionInvalidationReason = state.sessionInvalidationReason || reason || "chat-edited";
  // A new Antigravity Cascade must re-sync native steps from scratch. Keeping
  // old step identities after a local edit can make the fresh trajectory look
  // already synced and hide the newly seeded window from local records.
  state.syncedStepIdentities = [];
}

function clearPrepackState(state) {
  state.prepackToken = "";
  state.prepackStatus = "";
  state.prepackRequestedAt = "";
  state.prepackStartedAt = "";
  state.prepackCompletedAt = "";
  state.prepackError = "";
}

function saveEditedActiveChat(chatId, state, reason) {
  const backupPath = backupChatFile(chatId, reason);

  // Any edit to active context must start a fresh CLI session. Keep only one
  // previous session pointer for recovery; otherwise deleted or archived
  // messages may survive in the CLI provider's private conversation cache.
  if (state.sessionId) {
    state.previousSessionId = state.sessionId;
    state.previousSessionModel = state.sessionModel || "";
    state.previousSessionInvalidatedAt = new Date().toISOString();
    state.previousSessionInvalidationReason = reason || "chat-edited";
  }
  state.sessionId = null;
  state.sessionModel = "";
  state.sessionStartedAt = "";
  state.sessionUpdatedAt = "";
  state.sessionInvalidatedAt = new Date().toISOString();
  state.sessionInvalidationReason = reason || "chat-edited";
  state.updatedAt = new Date().toISOString();
  if (PREPACK_ENABLED) {
    markPrepackRequested(state, reason || "chat-edited");
  } else {
    clearPrepackState(state);
    state.syncedStepIdentities = [];
  }
  recomputeLastMessages(state);
  writeJsonFile(getChatPath(chatId), state);

  // Fire-and-forget: open a fresh Antigravity Cascade and seed it with the
  // cleaned recent history slice (active + archives) so the next Telegram
  // message lands in a window that already has the trimmed history baked in.
  // Any error here only means the next message falls back to lazy bootstrap.
  if (PREPACK_ENABLED && !prepackInFlight.has(chatId)) {
    schedulePrepackSessionAfterEdit(chatId).catch((error) => {
      log("prepack session after edit failed", chatId, error && error.message);
    });
  }

  return backupPath;
}

// Current policy: deleting/archive-editing records eagerly opens a fresh
// Antigravity Cascade seeded with only the recent slice.
const PREPACK_ENABLED = String(process.env.GEM_CHAT_RECORD_PREPACK_ENABLED || "1") !== "0";
const PREPACK_TIMEOUT_MS = Math.max(
  60000,
  Number.parseInt(process.env.GEM_CHAT_RECORD_PREPACK_TIMEOUT_MS || "180000", 10) || 180000
);
const PREPACK_RECENT_TURNS_MIN = 1;
const PREPACK_RECENT_TURNS_MAX = 200;
const DEFAULT_PREPACK_RECENT_TURNS = Math.max(
  1,
  Number.parseInt(process.env.GEM_CHAT_RECORD_PREPACK_TURNS || "35", 10) || 35
);
const PREPACK_WORKSPACE_URI = pathToFileURL(path.join(ROOT, "bridge-workspace")).href;
const prepackInFlight = new Map();

function normalizePrepackRecentTurns(value, fallback = DEFAULT_PREPACK_RECENT_TURNS) {
  const parsed = Number.parseInt(value, 10);
  const base = Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  return Math.min(PREPACK_RECENT_TURNS_MAX, Math.max(PREPACK_RECENT_TURNS_MIN, base));
}

function getPrepackRecentTurns() {
  const settings = readContextSettingsFile();
  return normalizePrepackRecentTurns(
    settings.chatRecords && settings.chatRecords.prepackRecentTurns
  );
}

function prepackSettingsPayload() {
  return {
    ok: true,
    prepackEnabled: PREPACK_ENABLED,
    prepackRecentTurns: getPrepackRecentTurns(),
    defaultPrepackRecentTurns: DEFAULT_PREPACK_RECENT_TURNS,
    minPrepackRecentTurns: PREPACK_RECENT_TURNS_MIN,
    maxPrepackRecentTurns: PREPACK_RECENT_TURNS_MAX
  };
}

async function handlePrepackSettings(req, res) {
  if (req.method === "GET") {
    sendJson(res, 200, prepackSettingsPayload());
    return;
  }
  if (req.method !== "POST") {
    sendError(res, 405, "Method not allowed.");
    return;
  }
  const payload = await readBody(req);
  const nextTurns = normalizePrepackRecentTurns(payload.prepackRecentTurns);
  const settings = readContextSettingsFile();
  settings.chatRecords = {
    ...(settings.chatRecords && typeof settings.chatRecords === "object"
      ? settings.chatRecords
      : {}),
    prepackRecentTurns: nextTurns,
    updatedAt: new Date().toISOString()
  };
  writeContextSettingsFile(settings);
  sendJson(res, 200, prepackSettingsPayload());
}

// Mirrors telegram-gem-bridge.cjs computeHistoryFingerprint: a stable sha1
// over role/content/at so the bridge keeps recognizing the prepack'd session
// instead of invalidating it as "history-changed".
function computeHistoryFingerprintForState(history) {
  if (!Array.isArray(history) || history.length === 0) return "";
  const hash = crypto.createHash("sha1");
  for (const item of history) {
    if (!item) continue;
    const role = String(item.role || "");
    const content = String(item.content || "");
    const at = String(item.at || "");
    hash.update(`${role}\u0001${content}\u0001${at}\u0002`);
  }
  return hash.digest("hex");
}

async function schedulePrepackSessionAfterEdit(chatId) {
  // Serialize prepacks per chat. If an earlier prepack is still running,
  // wait for it to finish; the token check inside doPrepack catches any
  // intermediate edits.
  while (prepackInFlight.has(chatId)) {
    try {
      await prepackInFlight.get(chatId);
    } catch {}
    if (prepackInFlight.get(chatId) === undefined) break;
  }
  const promise = doPrepackSessionAfterEdit(chatId);
  prepackInFlight.set(chatId, promise);
  try {
    await promise;
  } finally {
    if (prepackInFlight.get(chatId) === promise) prepackInFlight.delete(chatId);
  }
}

async function doPrepackSessionAfterEdit(chatId) {
  const startState = readJsonFile(getChatPath(chatId), null);
  if (!startState) {
    log("prepack skipped: chat state missing", chatId);
    return;
  }
  if (startState.sessionId) {
    // Already has a live session somehow, nothing to prepack.
    return;
  }
  const startToken = startState.prepackToken || null;
  if (!startToken) {
    return;
  }
  startState.prepackStatus = "running";
  startState.prepackStartedAt = new Date().toISOString();
  startState.prepackError = "";
  writeJsonFile(getChatPath(chatId), startState);
  const prepackRecentTurns = getPrepackRecentTurns();
  const history = collectRecentChatHistory(chatId, {
    chatStateDir: CHAT_STATE_DIR,
    archiveDir: ARCHIVE_DIR,
    maxTurns: prepackRecentTurns
  });
  let bootstrapPrompt;
  try {
    bootstrapPrompt = buildAntigravitySidecarBootstrapPrompt(chatId, {
      chatStateDir: CHAT_STATE_DIR,
      archiveDir: ARCHIVE_DIR,
      maxTurns: prepackRecentTurns
    });
  } catch (error) {
    log("prepack skipped: failed to build bootstrap prompt", chatId, error && error.message);
    markPrepackFailed(chatId, startToken, error);
    return;
  }
  if (history.length === 0) {
    log("prepack skipped: history empty after edit", chatId);
    markPrepackFailed(chatId, startToken, new Error("history empty after edit"));
    return;
  }

  let cascadeId;
  try {
    cascadeId = await startCascade({ workspaceUris: [PREPACK_WORKSPACE_URI] });
  } catch (error) {
    log("prepack failed: startCascade", chatId, error && error.message);
    markPrepackFailed(chatId, startToken, error);
    return;
  }
  try {
    await sendCascadeMessage(cascadeId, bootstrapPrompt, undefined, {
      timeoutMs: PREPACK_TIMEOUT_MS
    });
  } catch (error) {
    log("prepack failed: seed message", chatId, error && error.message);
    markPrepackFailed(chatId, startToken, error);
    return;
  }

  const beforeWrite = readJsonFile(getChatPath(chatId), null);
  if (!beforeWrite) {
    log("prepack discarded: state disappeared", chatId);
    return;
  }
  if (beforeWrite.sessionId) {
    log("prepack discarded: session already set", chatId);
    return;
  }
  if (beforeWrite.prepackToken !== startToken) {
    log("prepack discarded: newer edit interrupted", chatId);
    return;
  }
  const now = new Date().toISOString();
  beforeWrite.sessionId = cascadeId;
  beforeWrite.sessionModel = "";
  beforeWrite.sessionStartedAt = now;
  beforeWrite.sessionUpdatedAt = now;
  beforeWrite.sessionInvalidatedAt = "";
  beforeWrite.sessionInvalidationReason = "";
  beforeWrite.prepackToken = "";
  beforeWrite.prepackStatus = "complete";
  beforeWrite.prepackCompletedAt = now;
  beforeWrite.prepackError = "";
  // The bridge invalidates a session when the history fingerprint no longer
  // matches what was stored when the session was created. The prepack seeded
  // the new Cascade with exactly this on-disk history, so record the matching
  // fingerprint here to keep the bridge from throwing the prepack away.
  beforeWrite.lastHistoryFingerprint = computeHistoryFingerprintForState(
    beforeWrite.history
  );
  beforeWrite.updatedAt = now;
  writeJsonFile(getChatPath(chatId), beforeWrite);
  log("prepack ok", chatId, history.length, `recentTurns=${prepackRecentTurns}`, cascadeId);
}

function markPrepackFailed(chatId, token, error) {
  const state = readJsonFile(getChatPath(chatId), null);
  if (!state || state.prepackToken !== token || state.sessionId) return;
  state.prepackStatus = "failed";
  state.prepackError = error && error.message ? error.message : String(error || "unknown");
  state.prepackCompletedAt = new Date().toISOString();
  writeJsonFile(getChatPath(chatId), state);
}

function schedulePendingPrepackSessions() {
  let scheduled = 0;
  for (const filePath of listChatFiles()) {
    const chatId = path.basename(filePath, ".json");
    const state = readJsonFile(filePath, null);
    if (!state || state.sessionId || !state.prepackToken) continue;
    if (!PREPACK_ENABLED) continue;
    schedulePrepackSessionAfterEdit(chatId).catch((error) => {
      log("pending prepack session failed", chatId, error && error.message);
    });
    scheduled += 1;
  }
  if (scheduled > 0) log("pending prepack sessions scheduled", scheduled);
}

function backupRpChatFile(storageChatId, reason) {
  const filePath = getRpChatPath(storageChatId);
  if (!fs.existsSync(filePath)) {
    return null;
  }
  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\..+$/, "")
    .replace("T", "-");
  const backupPath = `${filePath}.${reason}-backup-${stamp}`;
  fs.copyFileSync(filePath, backupPath);
  return backupPath;
}

function saveEditedRpChat(chatId, state, reason) {
  const storageChatId = storageChatIdFromRpChatId(chatId);
  const backupPath = backupRpChatFile(storageChatId, reason);
  state.updatedAt = new Date().toISOString();
  recomputeLastMessages(state);
  writeJsonFile(getRpChatPath(storageChatId), state);
  return backupPath;
}

function backupArchiveFile(chatId, archiveId, reason) {
  const filePath = getArchivePath(chatId, archiveId);
  if (!fs.existsSync(filePath)) {
    return null;
  }
  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\..+$/, "")
    .replace("T", "-");
  const backupPath = `${filePath}.${reason}-backup-${stamp}`;
  fs.copyFileSync(filePath, backupPath);
  return backupPath;
}

function saveEditedArchive(chatId, archiveId, state, reason) {
  const backupPath = backupArchiveFile(chatId, archiveId, reason);
  state.updatedAt = new Date().toISOString();
  recomputeLastMessages(state);
  writeJsonFile(getArchivePath(chatId, archiveId), state);
  return backupPath;
}

function listChatFiles() {
  ensureChatStateDir();
  return fs
    .readdirSync(CHAT_STATE_DIR, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile() &&
        /^\w[\w-]*\.json$/.test(entry.name) &&
        !entry.name.startsWith("telegram_rp_")
    )
    .map((entry) => path.join(CHAT_STATE_DIR, entry.name));
}

function listRpChatFiles() {
  ensureChatStateDir();
  return fs
    .readdirSync(RP_CHAT_STATE_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /^\w[\w-]*\.json$/.test(entry.name))
    .map((entry) => path.join(RP_CHAT_STATE_DIR, entry.name));
}

function summarizeState(filePath, kind, archiveId = "") {
  const chatId = path.basename(filePath, ".json");
  const stat = fs.statSync(filePath);
  const state =
    kind === "archive" ? loadArchiveState(path.basename(path.dirname(filePath)), chatId) : loadChatState(chatId);
  const sourceGroup = kind === "archive" ? sourceGroupForState(state) : "telegram";
  const history = state.history || [];
  const latest = [...history]
    .filter((item) => item && item.at)
    .sort((a, b) => parseTime(b.at) - parseTime(a.at))[0];
  const realChatId = state.chatId || (kind === "archive" ? path.basename(path.dirname(filePath)) : chatId);
  const realArchiveId = kind === "archive" ? chatId : archiveId;
  return {
    windowId: kind === "archive" ? `archive:${realChatId}:${realArchiveId}` : `active:${realChatId}`,
    kind,
    chatId: realChatId,
    archiveId: realArchiveId,
    title:
      state.title ||
      (kind === "archive"
        ? `Archived ${realChatId} ${formatArchiveTitle(realArchiveId)}`
        : `Gem chat ${realChatId}`),
    activeCount: history.length,
    archivedCount: kind === "archive" ? history.length : 0,
    archivedAt: state.archivedAt || "",
    updatedAt: state.updatedAt || stat.mtime.toISOString(),
    latestAt: latest ? latest.at : "",
    latestPreview: latest ? String(latest.content || "").slice(0, 120) : "",
    fileName: path.basename(filePath),
    sourceGroup,
    sourceLabel: sourceLabelForGroup(sourceGroup)
  };
}

function formatArchiveTitle(archiveId) {
  const match = String(archiveId || "").match(/^archive-(\d{8})-(\d{6})$/);
  if (!match) return archiveId;
  const [, day, time] = match;
  return `${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6, 8)} ${time.slice(0, 2)}:${time.slice(2, 4)}`;
}

function listArchiveFiles() {
  ensureChatStateDir();
  const files = [];
  for (const entry of fs.readdirSync(ARCHIVE_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const chatDir = path.join(ARCHIVE_DIR, entry.name);
    for (const file of fs.readdirSync(chatDir, { withFileTypes: true })) {
      if (file.isFile() && /^archive-[0-9]{8}-[0-9]{6}\.json$/.test(file.name)) {
        files.push(path.join(chatDir, file.name));
      }
    }
  }
  return files;
}

async function readBody(req) {
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
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function requireIds(payload) {
  const ids = Array.isArray(payload && payload.ids) ? payload.ids : [];
  const clean = ids.filter((id) => typeof id === "string" && id.length > 0);
  if (clean.length === 0) {
    throw new Error("No message ids were provided.");
  }
  return new Set(clean);
}

function mutateSelectedMessages(state, ids, bucket = "active") {
  const history = Array.isArray(state.history) ? state.history : [];
  const selected = [];

  const nextHistory = [];
  history.forEach((message, index) => {
    const id = messageId(state.chatId, message, index, bucket);
    if (ids.has(id)) {
      selected.push({ message, bucket });
      return;
    }
    nextHistory.push(message);
  });

  state.history = nextHistory;
  return selected.length;
}

async function handleIngestTelegramRp(req, res) {
  const payload = await readBody(req);
  const storageChatId = storageChatIdFromRpChatId(payload.telegram_chat_id ?? payload.telegramChatId ?? payload.chat_id ?? payload.chatId);
  assertSafeChatId(storageChatId);
  const chatId = rpChatIdFromStorageChatId(storageChatId);
  const role = cleanString(payload.role, 40);
  if (!["user", "assistant", "system"].includes(role)) {
    sendError(res, 400, "Invalid role.");
    return;
  }
  const state = loadRpChatState(chatId);
  state.title = cleanString(payload.display_name ?? payload.displayName, 160) || state.title || `Telegram RP ${chatId}`;
  state.history.push({
    role,
    content: cleanString(payload.content, RP_CONTEXT_MAX_CHARS),
    at: cleanString(payload.at, 80) || new Date().toISOString(),
    source: "telegram_rp",
    telegramMessageId: cleanString(payload.telegram_message_id ?? payload.telegramMessageId, 80)
  });
  state.updatedAt = new Date().toISOString();
  recomputeLastMessages(state);
  writeJsonFile(getRpChatPath(storageChatId), state);
  sendJson(res, 200, { ok: true, chatId });
}

async function handleChats(req, res) {
  const activeChatIds = new Set(
    listChatFiles().map((filePath) => path.basename(filePath, ".json"))
  );
  for (const filePath of listArchiveFiles()) {
    const state = loadArchiveState(path.basename(path.dirname(filePath)), path.basename(filePath, ".json"));
    if (sourceGroupForState(state) === "telegram") {
      activeChatIds.add(String(state.chatId || path.basename(path.dirname(filePath))));
    }
  }

  const chats = [
    ...Array.from(activeChatIds).map((chatId) => summarizeTelegramWindow(chatId)),
    ...listRpChatFiles().map((filePath) => summarizeRpTelegramWindow(path.basename(filePath, ".json")))
  ].sort((a, b) => {
    return parseTime(b.latestAt || b.updatedAt) - parseTime(a.latestAt || a.updatedAt);
  });
  sendJson(res, 200, { chats });
}

function archiveIdFromPath(filePath) {
  return path.basename(filePath, ".json");
}

function archiveChatIdFromPath(filePath) {
  return path.basename(path.dirname(filePath));
}

function listTelegramArchiveFiles(chatId) {
  return listArchiveFiles().filter((filePath) => {
    const archiveChatId = archiveChatIdFromPath(filePath);
    if (archiveChatId !== String(chatId)) return false;
    const state = loadArchiveState(archiveChatId, archiveIdFromPath(filePath));
    return sourceGroupForState(state) === "telegram";
  });
}

function loadTelegramWindow(chatId) {
  const activeState = loadChatState(chatId);
  const activeMessages = decorateMessages(chatId, activeState.history, "active");
  const archiveStates = listTelegramArchiveFiles(chatId).map((filePath) => {
    const archiveId = archiveIdFromPath(filePath);
    const archiveState = loadArchiveState(chatId, archiveId);
    return { archiveId, archiveState };
  });
  const archiveMessages = archiveStates.flatMap(({ archiveId, archiveState }) =>
    decorateMessages(chatId, archiveState.history, `archive:${archiveId}`).map((message) => ({
      ...message,
      source: message.source || "telegram-session-import"
    }))
  );
  const messages = uniqueDecoratedMessages([...activeMessages, ...archiveMessages]).sort(
    (a, b) => parseTime(a.at) - parseTime(b.at)
  );
  return { activeState, archiveStates, messages };
}

function loadRpTelegramWindow(chatId) {
  const storageChatId = storageChatIdFromRpChatId(chatId);
  const rpChatId = rpChatIdFromStorageChatId(storageChatId);
  const activeState = loadRpChatState(rpChatId);
  const messages = decorateMessages(rpChatId, activeState.history, "active").sort(
    (a, b) => parseTime(a.at) - parseTime(b.at)
  );
  return { activeState, messages, storageChatId, rpChatId };
}

function summarizeTelegramWindow(chatId) {
  const { activeState, messages } = loadTelegramWindow(chatId);
  const latest = [...messages].sort((a, b) => parseTime(b.at) - parseTime(a.at))[0];
  const baseChatId = baseChatIdFromWindowId(chatId);
  const activeWindowId = getActiveMainWindowId(baseChatId);
  return {
    windowId: `telegram:${chatId}`,
    kind: "telegram",
    chatId: String(chatId),
    telegramChatId: baseChatId,
    isActiveMainWindow: String(chatId) === activeWindowId,
    isDefaultMainWindow: isDefaultMainWindow(chatId),
    archiveId: "",
    title: mainWindowTitle(chatId, activeState),
    activeCount: messages.length,
    archivedCount: 0,
    archivedAt: "",
    updatedAt: activeState.updatedAt || (latest && latest.at) || new Date().toISOString(),
    latestAt: latest ? latest.at : "",
    latestPreview: latest ? String(latest.content || "").slice(0, 120) : "",
    fileName: `${chatId}.json`,
    sourceGroup: "telegram"
  };
}

function summarizeRpTelegramWindow(storageChatId) {
  const rpChatId = rpChatIdFromStorageChatId(storageChatId);
  const { activeState, messages } = loadRpTelegramWindow(rpChatId);
  const latest = [...messages].sort((a, b) => parseTime(b.at) - parseTime(a.at))[0];
  return {
    windowId: `telegram-rp:${storageChatId}`,
    kind: "telegram_rp",
    chatId: rpChatId,
    archiveId: "",
    title: activeState.title || `Telegram RP ${storageChatId}`,
    activeCount: messages.length,
    archivedCount: 0,
    archivedAt: "",
    updatedAt: activeState.updatedAt || (latest && latest.at) || new Date().toISOString(),
    latestAt: latest ? latest.at : "",
    latestPreview: latest ? String(latest.content || "").slice(0, 120) : "",
    fileName: `rp-chats/${storageChatId}.json`,
    sourceGroup: "telegram_rp"
  };
}

async function handleChat(req, res, chatId) {
  const state = loadChatState(chatId);
  const messages = decorateMessages(chatId, state.history, "active").sort(
    (a, b) => parseTime(a.at) - parseTime(b.at)
  );
  sendJson(res, 200, {
    chat: summarizeState(getChatPath(chatId), "active"),
    state: {
      chatId: state.chatId,
      sessionId: state.sessionId,
      updatedAt: state.updatedAt,
      thinkingMode: state.thinkingMode,
      modelMode: state.modelMode,
      customModel: state.customModel
    },
    messages
  });
}

async function handleArchive(req, res, chatId, archiveId) {
  const state = loadArchiveState(chatId, archiveId);
  const messages = decorateMessages(chatId, state.history, "active").sort(
    (a, b) => parseTime(a.at) - parseTime(b.at)
  );
  sendJson(res, 200, {
    chat: summarizeState(getArchivePath(chatId, archiveId), "archive"),
    state: {
      chatId: state.chatId,
      archiveId: state.archiveId,
      archivedAt: state.archivedAt,
      updatedAt: state.updatedAt,
      thinkingMode: state.thinkingMode,
      modelMode: state.modelMode,
      customModel: state.customModel
    },
    messages
  });
}

async function handleTelegramWindow(req, res, chatId) {
  const { activeState, messages } = loadTelegramWindow(chatId);
  sendJson(res, 200, {
    chat: summarizeTelegramWindow(chatId),
    state: {
      chatId: activeState.chatId,
      telegramChatId: activeState.telegramChatId,
      sessionId: activeState.sessionId,
      updatedAt: activeState.updatedAt,
      thinkingMode: activeState.thinkingMode,
      modelMode: activeState.modelMode,
      customModel: activeState.customModel
    },
    messages
  });
}

async function handleCreateTelegramWindow(req, res, chatId) {
  const baseChatId = baseChatIdFromWindowId(chatId);
  const payload = await readBody(req);
  const activeWindowId = getActiveMainWindowId(baseChatId);
  const current = fs.existsSync(getChatPath(activeWindowId))
    ? loadChatState(activeWindowId)
    : loadChatState(baseChatId);
  const existingCount = listChatFiles()
    .map((filePath) => path.basename(filePath, ".json"))
    .filter((windowId) => isMainWindowIdForChat(windowId, baseChatId)).length;
  const windowId = `${baseChatId}__w_${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 8)}`;
  const now = new Date().toISOString();
  const state = normalizeChatState(windowId, {
    chatId: windowId,
    telegramChatId: baseChatId,
    title: cleanString(payload.title, 80) || `窗口 ${existingCount + 1}`,
    history: [],
    sessionId: null,
    sessionModel: "",
    thinkingMode: current.thinkingMode || "hidden",
    modelMode: current.modelMode || "quality",
    customModel: current.customModel || null,
    updatedAt: now
  });
  writeJsonFile(getChatPath(windowId), state);
  setActiveMainWindowId(baseChatId, windowId);
  sendJson(res, 200, {
    ok: true,
    action: "create-telegram-window",
    chat: summarizeTelegramWindow(windowId)
  });
}

async function handleSwitchTelegramWindow(req, res, chatId) {
  const baseChatId = baseChatIdFromWindowId(chatId);
  if (!fs.existsSync(getChatPath(chatId))) {
    sendError(res, 404, "Window not found.");
    return;
  }
  setActiveMainWindowId(baseChatId, chatId);
  sendJson(res, 200, {
    ok: true,
    action: "switch-telegram-window",
    chat: summarizeTelegramWindow(chatId)
  });
}

async function handleRenameTelegramWindow(req, res, chatId) {
  const payload = await readBody(req);
  const title = cleanString(payload.title ?? payload.display_name ?? payload.displayName, 80);
  if (!title) {
    sendError(res, 400, "Title is required.");
    return;
  }
  const state = loadChatState(chatId);
  state.title = title;
  state.updatedAt = new Date().toISOString();
  writeJsonFile(getChatPath(chatId), state);
  sendJson(res, 200, {
    ok: true,
    action: "rename-telegram-window",
    chat: summarizeTelegramWindow(chatId)
  });
}

async function handleRpTelegramWindow(req, res, chatId) {
  const { activeState, messages, storageChatId } = loadRpTelegramWindow(chatId);
  sendJson(res, 200, {
    chat: summarizeRpTelegramWindow(storageChatId),
    state: {
      chatId: activeState.chatId,
      sessionId: activeState.sessionId,
      updatedAt: activeState.updatedAt,
      thinkingMode: activeState.thinkingMode,
      modelMode: activeState.modelMode,
      customModel: activeState.customModel
    },
    messages
  });
}

async function handleDeleteMessages(req, res, chatId, archiveId = "") {
  const payload = await readBody(req);
  const ids = requireIds(payload);
  const state = archiveId ? loadArchiveState(chatId, archiveId) : loadChatState(chatId);
  const changedCount = mutateSelectedMessages(state, ids);
  if (changedCount === 0) {
    sendJson(res, 409, {
      error: "No matching messages were changed. Refresh the page and try again."
    });
    return;
  }
  const backupPath = archiveId
    ? saveEditedArchive(chatId, archiveId, state, "delete-messages")
    : saveEditedActiveChat(chatId, state, "delete-messages");
  let activeBackupPath = null;
  if (archiveId) {
    // Archive edits also change the "full chat history" used to seed the next
    // Antigravity window, so the active Cascade must be invalidated/prepacked
    // even when the active JSON file itself was not edited.
    activeBackupPath = saveEditedActiveChat(
      chatId,
      loadChatState(chatId),
      "archive-delete-messages"
    );
  }
  sendJson(res, 200, {
    ok: true,
    action: "delete-messages",
    changedCount,
    backupPath: [backupPath, activeBackupPath].filter(Boolean).join("; "),
    sessionIdReset: true
  });
}

async function handleDeleteRpTelegramMessages(req, res, chatId) {
  const payload = await readBody(req);
  const ids = requireIds(payload);
  const state = loadRpChatState(chatId);
  const changedCount = mutateSelectedMessages(state, ids, "active");
  if (changedCount === 0) {
    sendJson(res, 409, {
      error: "No matching messages were changed. Refresh the page and try again."
    });
    return;
  }
  const backupPath = saveEditedRpChat(chatId, state, "delete-rp-telegram-messages");
  sendJson(res, 200, {
    ok: true,
    action: "delete-rp-telegram-messages",
    changedCount,
    backupPath,
    sessionIdReset: false
  });
}

async function handleDeleteTelegramMessages(req, res, chatId) {
  const payload = await readBody(req);
  const ids = requireIds(payload);
  const activeState = loadChatState(chatId);
  const activeChangedCount = mutateSelectedMessages(activeState, ids, "active");
  const backups = [];
  let changedCount = 0;
  let sessionIdReset = false;

  if (activeChangedCount > 0) {
    backups.push(saveEditedActiveChat(chatId, activeState, "delete-telegram-messages"));
    changedCount += activeChangedCount;
    sessionIdReset = true;
  }

  for (const filePath of listTelegramArchiveFiles(chatId)) {
    const archiveId = archiveIdFromPath(filePath);
    const archiveState = loadArchiveState(chatId, archiveId);
    const archiveChangedCount = mutateSelectedMessages(
      archiveState,
      ids,
      `archive:${archiveId}`
    );
    if (archiveChangedCount > 0) {
      backups.push(saveEditedArchive(chatId, archiveId, archiveState, "delete-messages"));
      changedCount += archiveChangedCount;
    }
  }

  if (changedCount > 0 && activeChangedCount === 0) {
    backups.push(saveEditedActiveChat(
      chatId,
      activeState,
      "delete-telegram-archive-messages"
    ));
    sessionIdReset = true;
  }

  if (changedCount === 0) {
    sendJson(res, 409, {
      error: "No matching messages were changed. Refresh the page and try again."
    });
    return;
  }

  sendJson(res, 200, {
    ok: true,
    action: "delete-telegram-messages",
    changedCount,
    backupPath: backups.filter(Boolean).join("; "),
    sessionIdReset
  });
}

async function handleExport(req, res, chatId) {
  const state = loadChatState(chatId);
  sendJson(res, 200, {
    exportedAt: new Date().toISOString(),
    note: "This is a Gem bridge context export, not a Telegram official history export.",
    chat: state
  });
}

async function handleExportArchive(req, res, chatId, archiveId) {
  const state = loadArchiveState(chatId, archiveId);
  sendJson(res, 200, {
    exportedAt: new Date().toISOString(),
    note: "This is an archived Gem bridge chat window export.",
    chat: state
  });
}

async function handleExportTelegram(req, res, chatId) {
  const { messages } = loadTelegramWindow(chatId);
  sendJson(res, 200, {
    exportedAt: new Date().toISOString(),
    note: "This is a merged Telegram bridge display export. It combines active context and old Telegram bridge session archives.",
    chat: summarizeTelegramWindow(chatId),
    messages
  });
}

async function handleExportRpTelegram(req, res, chatId) {
  const { messages, storageChatId } = loadRpTelegramWindow(chatId);
  sendJson(res, 200, {
    exportedAt: new Date().toISOString(),
    note: "This is an isolated Telegram RP chat export.",
    chat: summarizeRpTelegramWindow(storageChatId),
    messages
  });
}

async function handleRenameRpTelegram(req, res, chatId) {
  const payload = await readBody(req);
  const displayName = cleanString(payload.display_name ?? payload.displayName, 160);
  if (!displayName) {
    sendError(res, 400, "Display name is required.");
    return;
  }
  const state = loadRpChatState(chatId);
  state.title = displayName;
  const backupPath = saveEditedRpChat(chatId, state, "rename-rp-telegram");
  sendJson(res, 200, {
    ok: true,
    action: "rename-rp-telegram",
    backupPath,
    chat: summarizeRpTelegramWindow(storageChatIdFromRpChatId(chatId))
  });
}

function makeArchiveId() {
  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\..+$/, "")
    .replace("T", "-");
  return `archive-${stamp}`;
}

async function handleArchiveActiveWindow(req, res, chatId) {
  const state = loadChatState(chatId);
  if (!Array.isArray(state.history) || state.history.length === 0) {
    sendJson(res, 409, { error: "The active window has no messages to archive." });
    return;
  }

  const activeBackupPath = backupChatFile(chatId, "archive-window");
  const archiveId = makeArchiveId();
  fs.mkdirSync(getArchiveChatDir(chatId), { recursive: true });

  const archivedState = {
    ...state,
    archiveId,
    archivedAt: new Date().toISOString(),
    title: state.title || `Archived ${chatId} ${formatArchiveTitle(archiveId)}`,
    sessionId: null,
    updatedAt: new Date().toISOString()
  };
  writeJsonFile(getArchivePath(chatId, archiveId), archivedState);

  const resetState = normalizeChatState(chatId, {
    chatId,
    history: [],
    sessionId: null,
    thinkingMode: state.thinkingMode,
    modelMode: state.modelMode,
    customModel: state.customModel,
    completedTurnsSinceMemoryIngest: 0,
    lastMemoryIngestAt: "",
    updatedAt: new Date().toISOString()
  });
  writeJsonFile(getChatPath(chatId), resetState);

  sendJson(res, 200, {
    ok: true,
    action: "archive-window",
    archiveId,
    archivedPath: getArchivePath(chatId, archiveId),
    activeBackupPath,
    sessionIdReset: true
  });
}

async function handleRpPresets(req, res) {
  if (req.method === "GET") {
    sendJson(res, 200, { presets: loadPresets() });
    return;
  }
  if (req.method === "POST") {
    const preset = normalizePreset(await readBody(req));
    const presets = loadPresets().filter((item) => item.id !== preset.id);
    presets.unshift(preset);
    savePresets(presets);
    sendJson(res, 200, { ok: true, preset, presets });
    return;
  }
  sendError(res, 405, "Method not allowed.");
}

async function handleRpCharacters(req, res) {
  if (req.method === "GET") {
    sendJson(res, 200, { characters: loadCharacters() });
    return;
  }
  if (req.method === "POST") {
    const character = normalizeCharacter(await readBody(req));
    const characters = loadCharacters().filter((item) => item.id !== character.id);
    characters.unshift(character);
    saveCharacters(characters);
    sendJson(res, 200, { ok: true, character, characters });
    return;
  }
  sendError(res, 405, "Method not allowed.");
}

async function handleRpLorebooks(req, res, lorebookId = "", entryId = "") {
  if (!lorebookId) {
    if (req.method === "GET") {
      sendJson(res, 200, { lorebooks: loadLorebooks() });
      return;
    }
    if (req.method === "POST") {
      const lorebook = normalizeLorebook(await readBody(req));
      const lorebooks = loadLorebooks().filter((item) => item.id !== lorebook.id);
      lorebooks.unshift(lorebook);
      saveLorebooks(lorebooks);
      sendJson(res, 200, { ok: true, lorebook, lorebooks });
      return;
    }
  }

  if (lorebookId && !entryId && req.method === "PUT") {
    const payload = await readBody(req);
    const lorebooks = loadLorebooks();
    const current = findById(lorebooks, lorebookId);
    if (!current) {
      sendError(res, 404, "Lorebook not found.");
      return;
    }
    const next = normalizeLorebook({ ...current, ...payload, id: lorebookId, updated_at: new Date().toISOString() });
    saveLorebooks(lorebooks.map((item) => item.id === lorebookId ? next : item));
    sendJson(res, 200, { ok: true, lorebook: next });
    return;
  }

  if (lorebookId && !entryId && req.method === "GET") {
    sendJson(res, 200, {
      entries: loadLoreEntries().filter((entry) => entry.lorebook_id === lorebookId)
    });
    return;
  }

  if (lorebookId && !entryId && req.method === "POST") {
    const entry = normalizeLoreEntry({ ...(await readBody(req)), lorebook_id: lorebookId });
    const entries = loadLoreEntries().filter((item) => item.id !== entry.id);
    entries.unshift(entry);
    saveLoreEntries(entries);
    sendJson(res, 200, { ok: true, entry, entries: entries.filter((item) => item.lorebook_id === lorebookId) });
    return;
  }

  if (lorebookId && entryId && req.method === "PUT") {
    const payload = await readBody(req);
    const entries = loadLoreEntries();
    const current = entries.find((entry) => entry.id === entryId && entry.lorebook_id === lorebookId);
    if (!current) {
      sendError(res, 404, "Lore entry not found.");
      return;
    }
    const next = normalizeLoreEntry({ ...current, ...payload, id: entryId, lorebook_id: lorebookId, updated_at: new Date().toISOString() });
    saveLoreEntries(entries.map((item) => item.id === entryId ? next : item));
    sendJson(res, 200, { ok: true, entry: next });
    return;
  }

  sendError(res, 405, "Method not allowed.");
}

async function handleRpContext(req, res, chatId) {
  assertSafeRpChatId(chatId);
  let userInput = "";
  if (req.method === "POST") {
    const payload = await readBody(req);
    userInput = payload.user_input ?? payload.userInput ?? "";
    const current = getBinding(chatId);
    saveBinding({
      chat_id: chatId,
      active_preset_id: payload.active_preset_id ?? payload.activePresetId ?? current.active_preset_id,
      active_character_id:
        payload.active_character_id ?? payload.activeCharacterId ?? current.active_character_id,
      active_lorebook_ids: payload.active_lorebook_ids ?? payload.activeLorebookIds ?? current.active_lorebook_ids,
      user_display_name: payload.user_display_name ?? payload.userDisplayName ?? current.user_display_name,
      author_note: payload.author_note ?? payload.authorNote ?? current.author_note
    });
  }

  const preview = buildRpPrompt({
    chatId,
    userInput
  });
  sendJson(res, 200, {
    ok: true,
    chatId,
    binding: preview.binding,
    preset: preview.preset,
    character: preview.character,
    lorebooks: loadLorebooks().filter((item) => preview.binding.active_lorebook_ids.includes(item.id)),
    author_note: preview.binding.author_note,
    promptPreview: {
      chatId,
      presetName: preview.preset ? preview.preset.name : "未绑定",
      characterName: preview.character ? preview.character.name : "未绑定",
      triggered_lore_entries: preview.triggeredLoreEntries,
      prompt: preview.prompt
    },
    recentMessages: preview.recentMessages,
    generationSettings: preview.generationSettings
  });
}

async function handleRpGenerate(req, res) {
  const payload = await readBody(req);
  const chatId = rpChatIdFromStorageChatId(payload.telegram_chat_id ?? payload.telegramChatId ?? payload.chat_id ?? payload.chatId);
  assertSafeRpChatId(chatId);
  const userInput = cleanString(payload.user_input ?? payload.userInput, RP_CONTEXT_MAX_CHARS);
  const preview = buildRpPrompt({
    chatId,
    userInput
  });
  const debug = {
    chat_id: chatId,
    preset_id: preview.preset ? preview.preset.id : null,
    preset_name: preview.preset ? preview.preset.name : null,
    character_id: preview.character ? preview.character.id : null,
    character_name: preview.character ? preview.character.name : null,
    triggered_lore_entries: preview.triggeredLoreEntries,
    prompt_preview: preview.prompt,
    generation_settings: preview.generationSettings,
    provider: providerConfigFromEnv()
  };
  let reply = "";
  let rawModelOutput = null;
  let error = "";
  let placeholder = false;

  try {
    const result = await callOpenAiCompatible({
      prompt: preview.prompt,
      temperature: preview.generationSettings.temperature,
      top_p: preview.generationSettings.top_p,
      frequency_penalty: preview.generationSettings.frequency_penalty,
      presence_penalty: preview.generationSettings.presence_penalty,
      max_tokens: preview.generationSettings.max_tokens,
      stop_strings: preview.generationSettings.stop_strings
    });
    if (result.configured) {
      reply = result.reply;
      rawModelOutput = result.raw;
      debug.provider = result.debug;
    } else {
      placeholder = true;
      debug.provider = result.debug;
      reply = "ST-lite placeholder reply: configure RP_MODEL_BASE_URL, RP_MODEL_API_KEY, and RP_MODEL_NAME to enable real model replies.";
    }
  } catch (providerError) {
    error = providerError && providerError.message ? providerError.message : String(providerError);
    rawModelOutput = providerError && providerError.raw ? providerError.raw : null;
    reply = "模型回复失败了：后端已经记录错误。请在 RP Studio 的 Generation Logs 里查看 provider 配置或请求错误。";
    debug.provider_error = error;
  }

  appendGenerationLog({
    chat_id: chatId,
    user_input: userInput,
    preset_id: debug.preset_id,
    preset_name: debug.preset_name,
    character_id: debug.character_id,
    character_name: debug.character_name,
    final_prompt: preview.prompt,
    prompt_preview: preview.prompt,
    raw_model_output: rawModelOutput,
    final_reply: reply,
    error
  });

  let memoryUpdate = { queued: false };
  if (!error && !placeholder && RP_MEMORY_AUTO_ENABLED) {
    const auto = rpMemoryStore.recordTurnAndCheckAuto(chatId, `${userInput}\n${reply}`, RP_MEMORY_AUTO_EVERY_TURNS);
    memoryUpdate = {
      queued: auto.shouldRun,
      reason: auto.reason,
      turnsSinceUpdate: auto.turnsSinceUpdate
    };
    if (auto.shouldRun) {
      queueRpMemoryUpdate({
        chatId,
        userInput,
        assistantReply: reply,
        reason: `auto:${auto.reason}`
      });
    }
  }

  sendJson(res, 200, {
    ok: !error,
    placeholder,
    error,
    reply,
    memoryUpdate,
    debug,
    chatId,
    presetName: debug.preset_name || "未绑定",
    characterName: debug.character_name || "未绑定",
    triggered_lore_entries: preview.triggeredLoreEntries,
    promptPreview: preview.prompt,
    generationSettings: preview.generationSettings
  });
}

async function handleRpGenerationLogs(req, res, chatId) {
  assertSafeRpChatId(chatId);
  const logs = loadGenerationLogs()
    .filter((log) => log.chat_id === chatId)
    .slice(0, 30);
  sendJson(res, 200, { logs });
}

async function handleRpMemory(req, res, chatId) {
  assertSafeRpChatId(chatId);
  if (req.method === "GET") {
    sendJson(res, 200, {
      ok: true,
      chatId,
      templates: rpMemoryStore.templates,
      memory: rpMemoryStore.getSession(chatId),
      provider: memoryProviderConfig()
    });
    return;
  }
  if (req.method === "PUT") {
    const payload = await readBody(req);
    const current = rpMemoryStore.getSession(chatId);
    const next = rpMemoryStore.saveSession({
      ...current,
      tables: Array.isArray(payload.tables) ? payload.tables : current.tables,
      updated_at: new Date().toISOString()
    });
    sendJson(res, 200, { ok: true, chatId, memory: next });
    return;
  }
  sendError(res, 405, "Method not allowed.");
}

async function handleRpMemoryInitialize(req, res, chatId) {
  assertSafeRpChatId(chatId);
  if (req.method !== "POST") {
    sendError(res, 405, "Method not allowed.");
    return;
  }
  sendJson(res, 200, { ok: true, chatId, memory: rpMemoryStore.resetSession(chatId) });
}

async function handleRpMemoryUpdate(req, res, chatId) {
  assertSafeRpChatId(chatId);
  if (req.method !== "POST") {
    sendError(res, 405, "Method not allowed.");
    return;
  }
  const payload = await readBody(req);
  const result = await runRpMemoryUpdate({
    chatId,
    userInput: cleanString(payload.user_input ?? payload.userInput, RP_CONTEXT_MAX_CHARS),
    assistantReply: cleanString(payload.assistant_reply ?? payload.assistantReply, RP_CONTEXT_MAX_CHARS),
    reason: cleanString(payload.reason, 80) || "manual"
  });
  sendJson(res, 200, {
    ok: result.ok,
    error: result.error || "",
    applied: result.applied || [],
    skipped: result.skipped || [],
    log: result.log,
    memory: rpMemoryStore.getSession(chatId)
  });
}

async function handleRpMemoryRebuild(req, res, chatId) {
  assertSafeRpChatId(chatId);
  if (req.method !== "POST") {
    sendError(res, 405, "Method not allowed.");
    return;
  }
  const payload = await readBody(req);
  const result = await runRpMemoryRebuild({
    chatId,
    userInput: cleanString(payload.user_input ?? payload.userInput, RP_CONTEXT_MAX_CHARS),
    assistantReply: cleanString(payload.assistant_reply ?? payload.assistantReply, RP_CONTEXT_MAX_CHARS),
    reason: cleanString(payload.reason, 80) || "manual:rebuild"
  });
  sendJson(res, 200, {
    ok: result.ok,
    error: result.error || "",
    applied: result.applied || [],
    skipped: result.skipped || [],
    log: result.log,
    memory: rpMemoryStore.getSession(chatId)
  });
}

async function handleRpMemoryLogs(req, res, chatId) {
  assertSafeRpChatId(chatId);
  sendJson(res, 200, { ok: true, logs: rpMemoryStore.getLogs(chatId) });
}

function snapshotForChat(chatId) {
  assertSafeRpChatId(chatId);
  const preview = buildRpPrompt({ chatId, userInput: "" });
  const { activeState, messages } = loadRpTelegramWindow(chatId);
  const lorebooks = loadLorebooks().filter((item) => preview.binding.active_lorebook_ids.includes(item.id));
  const loreEntries = loadLoreEntries().filter((entry) => preview.binding.active_lorebook_ids.includes(entry.lorebook_id));
  return {
    messages,
    display_name: activeState.title || `Telegram RP ${chatId}`,
    source_type: "telegram_rp",
    chat_id: chatId,
    active_preset_snapshot: preview.preset,
    active_character_snapshot: preview.character,
    active_lorebooks_snapshot: lorebooks.map((lorebook) => ({
      ...lorebook,
      entries: loreEntries.filter((entry) => entry.lorebook_id === lorebook.id)
    })),
    author_note_snapshot: preview.binding.author_note || "",
    generation_settings_snapshot: preview.generationSettings,
    archived_at: new Date().toISOString()
  };
}

async function handleRpArchiveChat(req, res, chatId) {
  const archive = {
    id: `rp_archive_${Date.now().toString(36)}_${Math.random().toString(16).slice(2, 8)}`,
    ...snapshotForChat(chatId)
  };
  const archives = loadRpArchives();
  archives.unshift(archive);
  saveRpArchives(archives);
  sendJson(res, 200, { ok: true, archive });
}

async function handleRpArchives(req, res, archiveId = "", restore = false) {
  const archives = loadRpArchives();
  if (!archiveId) {
    sendJson(res, 200, {
      archives: archives.map((archive) => ({
        id: archive.id,
        chat_id: archive.chat_id,
        display_name: archive.display_name,
        source_type: archive.source_type,
        archived_at: archive.archived_at,
        message_count: Array.isArray(archive.messages) ? archive.messages.length : 0
      }))
    });
    return;
  }
  const archive = archives.find((item) => item.id === archiveId);
  if (!archive) {
    sendError(res, 404, "RP archive not found.");
    return;
  }
  if (!restore) {
    sendJson(res, 200, { archive });
    return;
  }

  const baseStorageId = storageChatIdFromRpChatId(archive.chat_id);
  const newStorageId = `${baseStorageId}_cont_${Date.now().toString(36)}`;
  const newChatId = rpChatIdFromStorageChatId(newStorageId);
  const restoredState = normalizeChatState(newStorageId, {
    chatId: newStorageId,
    title: `${archive.display_name || archive.chat_id}（续）`,
    history: (archive.messages || []).map((message) => ({
      role: message.role,
      content: message.content,
      at: message.at,
      source: "rp_archive_restore",
      archivedAt: archive.archived_at
    })),
    sessionId: null,
    updatedAt: new Date().toISOString()
  });
  writeJsonFile(getRpChatPath(newStorageId), restoredState);
  saveBinding({
    chat_id: newChatId,
    active_preset_id: archive.active_preset_snapshot ? archive.active_preset_snapshot.id : "",
    active_character_id: archive.active_character_snapshot ? archive.active_character_snapshot.id : "",
    active_lorebook_ids: (archive.active_lorebooks_snapshot || []).map((item) => item.id),
    author_note: archive.author_note_snapshot || ""
  });
  sendJson(res, 200, { ok: true, archiveId, newChatId, restoredChat: summarizeRpTelegramWindow(newStorageId) });
}

async function handleDeleteArchiveWindow(req, res, chatId, archiveId) {
  const archivePath = getArchivePath(chatId, archiveId);
  if (!fs.existsSync(archivePath)) {
    sendError(res, 404, "Archive not found.");
    return;
  }
  const backupPath = backupArchiveFile(chatId, archiveId, "delete-window");
  fs.unlinkSync(archivePath);
  sendJson(res, 200, {
    ok: true,
    action: "delete-window",
    backupPath
  });
}

function route(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);
  const parts = url.pathname.split("/").filter(Boolean);

  Promise.resolve()
    .then(async () => {
      if (req.method === "GET" && url.pathname === "/") {
        sendHtml(res, fs.readFileSync(PAGE_PATH, "utf8"));
        return;
      }
      if (req.method === "GET" && url.pathname === "/rp-studio.html") {
        sendHtml(res, fs.readFileSync(RP_STUDIO_PAGE_PATH, "utf8"));
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/chats") {
        await handleChats(req, res);
        return;
      }
      if (parts[0] === "api" && parts[1] === "prepack-settings" && parts.length === 2) {
        await handlePrepackSettings(req, res);
        return;
      }
      if (parts[0] === "api" && parts[1] === "ingest" && parts[2] === "telegram-rp" && req.method === "POST") {
        await handleIngestTelegramRp(req, res);
        return;
      }
      if (parts[0] === "api" && parts[1] === "rp") {
        if (parts[2] === "presets" && parts.length === 3) {
          await handleRpPresets(req, res);
          return;
        }
        if (parts[2] === "characters" && parts.length === 3) {
          await handleRpCharacters(req, res);
          return;
        }
        if (parts[2] === "generate" && parts.length === 3 && req.method === "POST") {
          await handleRpGenerate(req, res);
          return;
        }
        if (parts[2] === "lorebooks") {
          if (parts.length === 3) {
            await handleRpLorebooks(req, res);
            return;
          }
          if (parts[3] && parts.length === 4) {
            await handleRpLorebooks(req, res, parts[3]);
            return;
          }
          if (parts[3] && parts[4] === "entries" && parts.length === 5) {
            await handleRpLorebooks(req, res, parts[3]);
            return;
          }
          if (parts[3] && parts[4] === "entries" && parts[5] && parts.length === 6) {
            await handleRpLorebooks(req, res, parts[3], parts[5]);
            return;
          }
        }
        if (parts[2] === "archives") {
          if (parts.length === 3 && req.method === "GET") {
            await handleRpArchives(req, res);
            return;
          }
          if (parts[3] && parts.length === 4 && req.method === "GET") {
            await handleRpArchives(req, res, parts[3]);
            return;
          }
          if (parts[3] && parts[4] === "restore" && parts.length === 5 && req.method === "POST") {
            await handleRpArchives(req, res, parts[3], true);
            return;
          }
        }
        if (parts[2] && parts[3] === "context" && parts.length === 4) {
          if (req.method === "GET" || req.method === "POST") {
            await handleRpContext(req, res, parts[2]);
            return;
          }
        }
        if (parts[2] && parts[3] === "generation-logs" && parts.length === 4 && req.method === "GET") {
          await handleRpGenerationLogs(req, res, parts[2]);
          return;
        }
        if (parts[2] && parts[3] === "memory" && parts.length === 4) {
          await handleRpMemory(req, res, parts[2]);
          return;
        }
        if (parts[2] && parts[3] === "memory" && parts[4] === "initialize" && parts.length === 5) {
          await handleRpMemoryInitialize(req, res, parts[2]);
          return;
        }
        if (parts[2] && parts[3] === "memory" && parts[4] === "update" && parts.length === 5) {
          await handleRpMemoryUpdate(req, res, parts[2]);
          return;
        }
        if (parts[2] && parts[3] === "memory" && parts[4] === "rebuild" && parts.length === 5) {
          await handleRpMemoryRebuild(req, res, parts[2]);
          return;
        }
        if (parts[2] && parts[3] === "memory-logs" && parts.length === 4 && req.method === "GET") {
          await handleRpMemoryLogs(req, res, parts[2]);
          return;
        }
        if (parts[2] && parts[3] === "archive" && parts.length === 4 && req.method === "POST") {
          await handleRpArchiveChat(req, res, parts[2]);
          return;
        }
      }
      if (parts[0] === "api" && parts[1] === "telegram" && parts[2]) {
        const chatId = parts[2];
        if (req.method === "GET" && parts.length === 3) {
          await handleTelegramWindow(req, res, chatId);
          return;
        }
        if (req.method === "POST" && parts[3] === "new-window") {
          await handleCreateTelegramWindow(req, res, chatId);
          return;
        }
        if (req.method === "POST" && parts[3] === "switch-window") {
          await handleSwitchTelegramWindow(req, res, chatId);
          return;
        }
        if (req.method === "POST" && parts[3] === "rename") {
          await handleRenameTelegramWindow(req, res, chatId);
          return;
        }
        if (req.method === "GET" && parts[3] === "export") {
          await handleExportTelegram(req, res, chatId);
          return;
        }
        if (req.method === "POST" && parts[3] === "delete-messages") {
          await handleDeleteTelegramMessages(req, res, chatId);
          return;
        }
      }
      if (parts[0] === "api" && parts[1] === "telegram-rp" && parts[2]) {
        const chatId = parts[2];
        if (req.method === "GET" && parts.length === 3) {
          await handleRpTelegramWindow(req, res, chatId);
          return;
        }
        if (req.method === "GET" && parts[3] === "export") {
          await handleExportRpTelegram(req, res, chatId);
          return;
        }
        if (req.method === "POST" && parts[3] === "delete-messages") {
          await handleDeleteRpTelegramMessages(req, res, chatId);
          return;
        }
        if (req.method === "POST" && parts[3] === "rename") {
          await handleRenameRpTelegram(req, res, chatId);
          return;
        }
      }
      if (parts[0] === "api" && parts[1] === "chats" && parts[2]) {
        const chatId = parts[2];
        if (req.method === "GET" && parts.length === 3) {
          await handleChat(req, res, chatId);
          return;
        }
        if (req.method === "GET" && parts[3] === "export") {
          await handleExport(req, res, chatId);
          return;
        }
        if (req.method === "POST" && parts[3] === "delete-messages") {
          await handleDeleteMessages(req, res, chatId);
          return;
        }
        if (req.method === "POST" && parts[3] === "archive-window") {
          await handleArchiveActiveWindow(req, res, chatId);
          return;
        }
      }
      if (parts[0] === "api" && parts[1] === "archives" && parts[2] && parts[3]) {
        const chatId = parts[2];
        const archiveId = parts[3];
        if (req.method === "GET" && parts.length === 4) {
          await handleArchive(req, res, chatId, archiveId);
          return;
        }
        if (req.method === "GET" && parts[4] === "export") {
          await handleExportArchive(req, res, chatId, archiveId);
          return;
        }
        if (req.method === "POST" && parts[4] === "delete-messages") {
          await handleDeleteMessages(req, res, chatId, archiveId);
          return;
        }
        if (req.method === "POST" && parts[4] === "delete-window") {
          await handleDeleteArchiveWindow(req, res, chatId, archiveId);
          return;
        }
      }
      sendError(res, 404, "Not found.");
    })
    .catch((error) => {
      log(error && error.stack ? error.stack : String(error));
      sendError(res, 500, error && error.message ? error.message : "Server error.");
    });
}

ensureChatStateDir();
http.createServer(route).listen(PORT, HOST, () => {
  log(`listening on http://${HOST}:${PORT}`);
  log(`chat state directory: ${CHAT_STATE_DIR}`);
  schedulePendingPrepackSessions();
});
