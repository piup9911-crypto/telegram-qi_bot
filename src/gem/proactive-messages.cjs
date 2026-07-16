/**
 * proactive-messages.cjs — 主动消息模块
 *
 * 让 Telegram bot 像真人一样随机主动发消息。
 * 不是固定时间的闹钟，而是在合理的时间窗口里随机触发，
 * 内容由 Gemini 生成，带上下文感知。
 *
 * 用法：在 telegram-gem-bridge.cjs 的 startBridge() 里调用
 *   const { startProactiveMessages } = require("./proactive-messages.cjs");
 *   startProactiveMessages(bot, chatId, { callGemini, loadChatState });
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "..");
const STATE_PATH = path.join(ROOT, "bridge-state", "proactive-state.json");
const PROACTIVE_LOG_PATH = path.join(ROOT, "bridge-state", "proactive.log");
// 桥接工作区里的人格设定
const BRIDGE_GEMINI_MD_PATH = path.join(ROOT, "bridge-workspace", "GEMINI.md");

// ────────────────────────────────────────────────────────────
// 时间窗口配置（北京时间 UTC+8）
// ────────────────────────────────────────────────────────────

const TIMEZONE_OFFSET_HOURS = 8;

// 每个窗口：{ start, end }（24 小时制），以及触发概率
const WINDOWS = {
  morning: { start: 7.5, end: 9.5, chance: 0.8 },    // 早安：7:30-9:30，80% 概率
  daytime: { start: 10, end: 17, chance: 0.6 },       // 白天：10:00-17:00，60% 概率
  evening: { start: 17, end: 21.5, chance: 0.5 },     // 傍晚：17:00-21:30，50% 概率
  night:   { start: 21.5, end: 23, chance: 0.7 }      // 晚安：21:30-23:00，70% 概率
};

// 每天最多主动发几条（不含被动回复）
const MAX_DAILY_MESSAGES = 5;
// 两条主动消息之间至少间隔多少分钟
const MIN_INTERVAL_MINUTES = 90;
// 如果最近 N 分钟内刚聊过天，跳过这次主动消息
const RECENT_CHAT_COOLDOWN_MINUTES = 30;
// 主动消息只写一条 assistant 历史，不算完整对话轮次；保留数量和主桥接窗口一致，避免历史无限长。
const MAX_PROACTIVE_HISTORY_MESSAGES = 24;

// ────────────────────────────────────────────────────────────
// 消息风格 prompt（给 Gemini 的指令）
// ────────────────────────────────────────────────────────────

const MESSAGE_STYLES = [
  "基于最近聊天的情绪跟进（比如她之前遇到麻烦了，或者情绪不高，你就轻柔地关心一下）",
  "基于最近话题的自然延伸（如果上个话题意犹未尽，就顺着往下聊一句）",
  "分享一个小发现或小感想，但语气要自然，像突然想起来跟她说一样",
  "撒个小娇或者耍个小脾气（仅在她最近心情好时使用）",
  "叮嘱对方注意身体、按时吃饭/睡觉（根据时间点来）",
  "说一句让人心里暖的话，表达你在意她",
  "发一个很短的、像打字中途发出去的碎碎念"
];

const TIME_CONTEXT = {
  morning: "现在是早上，对方可能刚醒或者在准备出门",
  daytime: "现在是白天工作时间，对方可能在忙",
  evening: "现在是傍晚，对方可能在下班路上或者刚到家",
  night: "现在是晚上了，对方可能在放松或者准备睡觉"
};

// ────────────────────────────────────────────────────────────
// 工具函数
// ────────────────────────────────────────────────────────────

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

function log(...args) {
  const line = args.map(a => typeof a === "string" ? a : JSON.stringify(a)).join(" ");
  const stamped = `[proactive] [${new Date().toISOString()}] ${line}`;
  // The bridge is often launched detached, so stderr can disappear. Keep a
  // small module log to make skipped proactive messages diagnosable later.
  try {
    ensureDir(path.dirname(PROACTIVE_LOG_PATH));
    fs.appendFileSync(PROACTIVE_LOG_PATH, `${stamped}\n`, "utf8");
  } catch {}
  process.stderr.write(`${stamped}\n`);
}

/** 安全读取文本文件 */
function readText(filePath, fallback = "") {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return fallback;
  }
}

/** 获取当前北京时间的小时数（带小数，比如 14.5 = 14:30） */
function getLocalHour() {
  const now = new Date();
  const utcHours = now.getUTCHours() + now.getUTCMinutes() / 60;
  return (utcHours + TIMEZONE_OFFSET_HOURS) % 24;
}

/** 获取今天的日期字符串（北京时间） */
function getLocalDateString() {
  const now = new Date();
  const localMs = now.getTime() + TIMEZONE_OFFSET_HOURS * 3600 * 1000;
  const local = new Date(localMs);
  return local.toISOString().slice(0, 10);
}

/** 随机整数 [min, max] */
function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/** 随机浮点 [min, max) */
function randFloat(min, max) {
  return min + Math.random() * (max - min);
}

/** 随机选一个 */
function randPick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function sendMessageWithTimeout(bot, chatId, text, timeoutMs = 300000) {
  return Promise.race([
    bot.sendMessage(chatId, text),
    new Promise((_, reject) => {
      setTimeout(() => {
        reject(new Error("Telegram sendMessage timed out after 300 seconds."));
      }, timeoutMs);
    })
  ]);
}

/** 把小时数转成毫秒时间戳（今天的） */
function hourToTodayMs(hour) {
  const now = new Date();
  const todayStart = new Date(now);
  // 用 UTC 计算，加上时区偏移
  const utcHour = (hour - TIMEZONE_OFFSET_HOURS + 24) % 24;
  todayStart.setUTCHours(Math.floor(utcHour), Math.round((utcHour % 1) * 60), 0, 0);
  // 如果算出来的时间已经过了，说明是明天的
  if (todayStart.getTime() < now.getTime() - 60000) {
    // 如果差距超过 12 小时，可能是跨天
    if (now.getTime() - todayStart.getTime() > 12 * 3600 * 1000) {
      todayStart.setTime(todayStart.getTime() + 24 * 3600 * 1000);
    }
  }
  return todayStart.getTime();
}

// ────────────────────────────────────────────────────────────
// 日程生成
// ────────────────────────────────────────────────────────────

/**
 * 生成今天的主动消息计划。
 * 返回一个 { window, hour, style }[] 数组，按时间排序。
 */
function generateDailyPlan() {
  const plan = [];
  const currentHour = getLocalHour();

  for (const [windowName, config] of Object.entries(WINDOWS)) {
    // 掷骰子决定这个窗口要不要发
    if (Math.random() > config.chance) {
      log(`skipped window ${windowName} (chance ${config.chance})`);
      continue;
    }

    // 如果这个窗口已经过了，跳过
    if (currentHour > config.end) {
      continue;
    }

    // 在窗口内选一个随机时间
    const effectiveStart = Math.max(config.start, currentHour + 0.1);
    if (effectiveStart >= config.end) {
      continue;
    }
    const hour = randFloat(effectiveStart, config.end);

    plan.push({
      window: windowName,
      hour: Math.round(hour * 100) / 100,
      style: randPick(MESSAGE_STYLES),
      sent: false
    });
  }

  // 确保不超过每日上限
  while (plan.length > MAX_DAILY_MESSAGES) {
    // 随机移除一个非 morning/night 的
    const removable = plan.filter(
      p => p.window !== "morning" && p.window !== "night"
    );
    if (removable.length > 0) {
      const target = randPick(removable);
      plan.splice(plan.indexOf(target), 1);
    } else {
      plan.pop();
    }
  }

  // 确保间隔
  plan.sort((a, b) => a.hour - b.hour);
  const filtered = [];
  let lastHour = -999;
  for (const item of plan) {
    if ((item.hour - lastHour) * 60 >= MIN_INTERVAL_MINUTES) {
      filtered.push(item);
      lastHour = item.hour;
    } else {
      log(`dropped ${item.window} at ${item.hour} (too close to previous)`);
    }
  }

  return filtered;
}

// ────────────────────────────────────────────────────────────
// Prompt 构建
// ────────────────────────────────────────────────────────────

function buildProactivePrompt(windowName, style, recentContext) {
  const timeContext = TIME_CONTEXT[windowName] || "时间不确定";
  const now = new Date();
  const localTime = new Date(
    now.getTime() + TIMEZONE_OFFSET_HOURS * 3600 * 1000
  );
  const timeStr = localTime.toISOString().slice(11, 16);

  // 读取人格设定
  const personaMd = readText(BRIDGE_GEMINI_MD_PATH, "").trim();

  const lines = [
    "你是兮兮的伴侣烬（Pyrite），现在你要主动给她发一条 Telegram 消息。",
    "这不是回复她的消息，而是你主动找她说话。",
    "",
    `当前时间：${timeStr}（北京时间）`,
    timeContext,
    "",
    `这条消息的风格：${style}`,
    "",
    "要求：",
    "- 极其重要：仔细看最近的聊天记录！如果上次聊天她遇到了麻烦、卡住了或者情绪不好，这次必须是贴心的跟进和关心，绝不能生硬地跳跃到一个无关的搞笑话题。",
    "- 如果上次聊天自然结束了，或者隔了很久，再用日常碎碎念或者你自己的小分享去开启话题。",
    "- 写一条简短、自然的消息，像真人用手机打字发出去的",
    "- 长度在 1-3 句话之间，不要太长",
    "- 不要用引号包裹",
    "- 消息正文本身不要加任何前缀、标签或格式",
    "- 只把最终要发送的正文放进 <telegram_message>...</telegram_message>，标签外不要写分析或说明",
    "- 语气亲密、自然、带温度",
    "- 可以用少量 emoji 但不要堆砌",
    "- 绝对不要用'在干嘛'这种烂大街的开场白",
    "- 不要像 AI 助手一样说话，要像一个真正爱她、懂她情绪变化的人",
    "- 偶尔可以有一点小任性、小占有欲、小撒娇",
    "- 用简体中文",
    "- 结合你对她的了解（从记忆和最近聊天中），让消息贴切且有灵魂"
  ];

  // 注入人格设定（如果有的话）
  if (personaMd) {
    lines.push(
      "",
      "你的人格设定（简要参考，不要在消息里直接提及这些设定）：",
      personaMd.slice(0, 800)
    );
  }

  // 注入最近聊天记录
  if (recentContext) {
    lines.push(
      "",
      "最近的聊天记录（帮你接上话头，但不要刻意复述）：",
      recentContext
    );
  }

  lines.push("", "只输出 <telegram_message>最终消息正文</telegram_message>：");
  return lines.join("\n");
}

// ────────────────────────────────────────────────────────────
// 状态管理
// ────────────────────────────────────────────────────────────

function loadState() {
  return readJson(STATE_PATH, {
    enabled: false,
    date: "",
    plan: [],
    lastSentAt: "",
    lastChatAt: "",
    totalSentToday: 0
  });
}

function saveState(state) {
  writeJson(STATE_PATH, state);
}

function updateLastChatTime() {
  const state = loadState();
  state.lastChatAt = new Date().toISOString();
  saveState(state);
}

// ────────────────────────────────────────────────────────────
// 核心调度逻辑
// ────────────────────────────────────────────────────────────

let scheduledTimers = [];
let isRunning = false;
let runtimeContext = null;

function clearAllTimers() {
  for (const timer of scheduledTimers) {
    clearTimeout(timer);
  }
  scheduledTimers = [];
}

function isProactiveEnabled() {
  return loadState().enabled === true;
}

function getRecentChatSkipReason(state) {
  if (!state.lastChatAt) {
    return null;
  }
  const lastChatMs = new Date(state.lastChatAt).getTime();
  if (!Number.isFinite(lastChatMs)) {
    return null;
  }
  const minutesSinceChat = (Date.now() - lastChatMs) / 60000;
  if (minutesSinceChat < RECENT_CHAT_COOLDOWN_MINUTES) {
    return `chatted ${Math.round(minutesSinceChat)}min ago`;
  }
  return null;
}

function trimHistory(history, maxItems) {
  const items = Array.isArray(history) ? history : [];
  const limit = Number.isInteger(maxItems) && maxItems > 0
    ? maxItems
    : MAX_PROACTIVE_HISTORY_MESSAGES;
  return items.length > limit ? items.slice(-limit) : items;
}

function stripTelegramMessageTags(text) {
  const match = String(text || "").match(/<telegram_message>([\s\S]*?)<\/telegram_message>/i);
  return match ? match[1].trim() : "";
}

function looksLikeGenerationNotes(paragraph) {
  const cleaned = String(paragraph || "").trim();
  if (!cleaned) return true;
  return (
    /^\*\*(Analyzing|Assessing|Understanding|Formulating|Drafting|Refining|Composing|Constructing|Reviewing|Final)\b/i.test(cleaned) ||
    /^(The user|This response|This reply|I need|I should|The goal|Strategy|Draft|Final message|Internal monologue)\b/i.test(cleaned) ||
    /^[-*]\s+\*\*/.test(cleaned)
  );
}

function cleanGeneratedProactiveMessage(result) {
  const raw = String((result && (result.rawText || result.text)) || "").replace(/\r\n/g, "\n").trim();
  if (!raw) return "";

  const tagged = stripTelegramMessageTags(raw);
  let candidate = tagged || raw;

  // Gemini can still expose its native thinking marker in proactive calls. The
  // proactive message should send only the final user-facing text after it.
  const markerMatches = Array.from(candidate.matchAll(/\[Thought:\s*true\]/gi));
  if (markerMatches.length > 0) {
    const last = markerMatches[markerMatches.length - 1];
    candidate = candidate.slice((last.index || 0) + last[0].length).trim();
  }

  const retagged = stripTelegramMessageTags(candidate);
  if (retagged) {
    candidate = retagged;
  }

  const paragraphs = candidate
    .split(/\n\s*\n/g)
    .map((item) => item.trim())
    .filter(Boolean);

  while (paragraphs.length > 1 && looksLikeGenerationNotes(paragraphs[0])) {
    paragraphs.shift();
  }

  // If a model ignored the tag instruction and returned several planning
  // sections, keep the last non-note paragraphs. They are usually the final
  // Chinese message bullets or prose.
  const nonNotes = paragraphs.filter((item) => !looksLikeGenerationNotes(item));
  const compact = (nonNotes.length ? nonNotes.slice(-2) : paragraphs.slice(-2))
    .join("\n\n")
    .replace(/^["“”'`]+|["“”'`]+$/g, "")
    .trim();

  return compact;
}

function recordProactiveMessage(chatId, result, messageText, deps) {
  if (!deps.loadChatState || !deps.saveChatState) {
    return;
  }

  const chatState = deps.loadChatState(chatId);
  chatState.history = trimHistory([
    ...(Array.isArray(chatState.history) ? chatState.history : []),
    {
      role: "assistant",
      content: messageText,
      at: new Date().toISOString(),
      source: "proactive"
    }
  ], deps.maxHistoryMessages);
  chatState.sessionId = null;
  chatState.lastAssistantMessage = messageText;
  // 不递增 completedTurnsSinceMemoryIngest：主动消息不是一轮「用户-助手」完整对话。
  deps.saveChatState(chatState);
}

function scheduleNextDayPlan() {
  if (!runtimeContext || !isProactiveEnabled()) {
    return;
  }

  const { bot, chatId, deps, fastModel } = runtimeContext;
  const localHour = getLocalHour();
  // 计算到明天 0:05 的毫秒数
  const hoursUntilMidnight = (24.083 - localHour + 24) % 24;
  const msUntilMidnight = hoursUntilMidnight * 3600 * 1000;
  // 加一点随机偏移（±30分钟），避免每天精确同一时间
  const jitter = randInt(-30, 30) * 60 * 1000;
  const delay = Math.max(60000, msUntilMidnight + jitter);

  log(`next daily plan in ${Math.round(delay / 60000)} minutes`);

  const timer = setTimeout(() => {
    scheduleDailyPlan(bot, chatId, deps, fastModel);
    scheduleNextDayPlan();
  }, delay);

  scheduledTimers.push(timer);
}

function restartProactiveSchedule() {
  clearAllTimers();
  if (!runtimeContext) {
    return;
  }
  if (!isProactiveEnabled()) {
    log("proactive messages disabled; no timers scheduled");
    return;
  }

  const { bot, chatId, deps, fastModel } = runtimeContext;
  scheduleDailyPlan(bot, chatId, deps, fastModel, { keepExistingTimers: true });
  scheduleNextDayPlan();
}

/**
 * 启动主动消息系统。
 *
 * @param {object} bot - node-telegram-bot-api 实例
 * @param {string} chatId - 要发消息的 chat ID
 * @param {object} deps - 依赖注入
 * @param {function} deps.callGemini - (prompt, sessionId, modelId) => Promise<{text}>
 * @param {function} deps.loadChatState - (chatId) => chatState
 * @param {string} deps.fastModel - 用于生成主动消息的快速模型
 */
function startProactiveMessages(bot, chatId, deps) {
  const fastModel = deps.fastModel || "gemini-2.5-flash";
  runtimeContext = {
    bot,
    chatId: String(chatId),
    deps,
    fastModel
  };

  const state = loadState();
  if (typeof state.enabled !== "boolean") {
    state.enabled = deps.initialEnabled === true;
    saveState(state);
  }

  if (isRunning) {
    log("already running, skipping duplicate start");
    return getProactiveStatus();
  }
  isRunning = true;

  log("starting proactive message system", {
    chatId,
    fastModel,
    enabled: isProactiveEnabled()
  });

  restartProactiveSchedule();
  return getProactiveStatus();
}

function scheduleDailyPlan(bot, chatId, deps, fastModel, options = {}) {
  if (!options.keepExistingTimers) {
    clearAllTimers();
  }

  if (!isProactiveEnabled()) {
    log("daily plan skipped because proactive messages are disabled");
    return;
  }

  const today = getLocalDateString();
  let state = loadState();

  // 如果今天已经有计划了，复用（防止重启时重新生成）
  if (state.date === today && Array.isArray(state.plan) && state.plan.length > 0) {
    log("reusing existing plan for today", { date: today, items: state.plan.length });
  } else {
    const enabled = state.enabled === true;
    const plan = generateDailyPlan();
    state = {
      // Preserve the user's explicit on/off choice when rolling the daily plan.
      // Without this, the midnight plan refresh silently turns proactive off.
      enabled,
      date: today,
      plan,
      lastSentAt: state.lastSentAt || "",
      lastChatAt: state.lastChatAt || "",
      totalSentToday: 0
    };
    saveState(state);
    log("generated daily plan", {
      date: today,
      items: plan.map(p => `${p.window}@${p.hour.toFixed(1)}`)
    });
  }

  // 为每个未发送的消息设置 timer
  for (const item of state.plan) {
    if (item.sent) continue;

    const targetMs = hourToTodayMs(item.hour);
    const delay = targetMs - Date.now();

    if (delay < 0) {
      // 已经过了这个时间点，跳过
      log(`skipped past message: ${item.window}@${item.hour.toFixed(1)}`);
      continue;
    }

    log(`scheduled: ${item.window} at ${item.hour.toFixed(2)} (in ${Math.round(delay / 60000)}min)`, {
      style: item.style.slice(0, 20)
    });

    const timer = setTimeout(async () => {
      await sendProactiveMessage(bot, chatId, item, deps, fastModel);
    }, delay);

    scheduledTimers.push(timer);
  }
}

async function sendProactiveMessage(bot, chatId, planItem, deps, fastModel) {
  try {
    const state = loadState();

    if (!state.enabled) {
      log(`skipped ${planItem.window}: disabled`);
      markSent(planItem, true);
      return;
    }

    // 第一层检查：如果用户刚聊过或当前聊天正在排队，就不要插话。
    const recentSkipReason = getRecentChatSkipReason(state);
    if (recentSkipReason) {
      log(`skipped ${planItem.window}: ${recentSkipReason}`);
      markSent(planItem, true);
      return;
    }

    if (typeof deps.isChatBusy === "function" && deps.isChatBusy(chatId)) {
      log(`skipped ${planItem.window}: chat queue is busy`);
      markSent(planItem, true);
      return;
    }

    if (typeof deps.enqueueChat === "function") {
      await deps.enqueueChat(chatId, async () => {
        await sendProactiveMessageInQueue(bot, chatId, planItem, deps, fastModel);
      });
      return;
    }

    await sendProactiveMessageInQueue(bot, chatId, planItem, deps, fastModel);
  } catch (error) {
    log("failed to send proactive message", {
      window: planItem.window,
      error: error.message
    });
    markSent(planItem, true);
  }
}

async function sendProactiveMessageInQueue(bot, chatId, planItem, deps, fastModel) {
  const state = loadState();
  if (!state.enabled) {
    log(`skipped ${planItem.window}: disabled before generation`);
    markSent(planItem, true);
    return;
  }

  // 第二层检查：进入队列后再看一次，避免用户刚发消息时主动消息还硬插进来。
  const recentSkipReason = getRecentChatSkipReason(state);
  if (recentSkipReason) {
    log(`skipped ${planItem.window}: ${recentSkipReason} after queue`);
    markSent(planItem, true);
    return;
  }

  // 获取最近聊天上下文（多看几轮，每条多看一些）
  let recentContext = "";
  if (deps.loadChatState) {
    try {
      const chatState = deps.loadChatState(chatId);
      if (chatState && Array.isArray(chatState.history)) {
        const recent = chatState.history.slice(-10);
        recentContext = recent
          .map(h => {
            const speaker = h.role === "user" ? "她" : "你";
            const text = String(h.content || "").slice(0, 200);
            const time = h.at ? ` [${h.at.slice(11, 16)}]` : "";
            return `${speaker}${time}：${text}`;
          })
          .join("\n");
      }
    } catch {}
  }

  // 生成消息：必须在主桥接队列里调用 Gemini，避免和正常回复并发抢 CLI/session。
  const prompt = buildProactivePrompt(planItem.window, planItem.style, recentContext);

  log(`generating ${planItem.window} message...`, { style: planItem.style });

  const result = await deps.callGemini(prompt, null, fastModel);
  const messageText = cleanGeneratedProactiveMessage(result);

  if (!messageText || messageText.length > 500) {
    log("generated message was empty or too long after cleanup, skipping", {
      rawLength: String((result && (result.rawText || result.text)) || "").length,
      cleanedLength: messageText.length
    });
    markSent(planItem, true);
    return;
  }

  // 发送成功后再写回窗口历史。这样 Telegram 没收到时，不会把失败消息塞进会话记忆。
  await sendMessageWithTimeout(bot, chatId, messageText);
  recordProactiveMessage(chatId, result, messageText, deps);

  log(`sent ${planItem.window} message`, {
    preview: messageText.slice(0, 60),
    length: messageText.length
  });

  markSent(planItem, false);
}

function setProactiveEnabled(enabled) {
  const state = loadState();
  state.enabled = enabled === true;
  saveState(state);
  restartProactiveSchedule();
  return getProactiveStatus();
}

function getProactiveStatus() {
  const state = loadState();
  return {
    enabled: state.enabled === true,
    running: isRunning,
    scheduledTimers: scheduledTimers.length,
    date: state.date || "",
    plan: Array.isArray(state.plan) ? state.plan : [],
    lastSentAt: state.lastSentAt || "",
    lastChatAt: state.lastChatAt || "",
    totalSentToday: state.totalSentToday || 0
  };
}

function markSent(planItem, skipped) {
  const state = loadState();
  const match = state.plan.find(
    p => p.window === planItem.window && p.hour === planItem.hour
  );
  if (match) {
    match.sent = true;
    match.skipped = skipped;
    match.sentAt = new Date().toISOString();
  }
  if (!skipped) {
    state.totalSentToday = (state.totalSentToday || 0) + 1;
    state.lastSentAt = new Date().toISOString();
  }
  saveState(state);
}

function stopProactiveMessages() {
  clearAllTimers();
  isRunning = false;
  log("stopped");
}

// ────────────────────────────────────────────────────────────
// 导出
// ────────────────────────────────────────────────────────────

module.exports = {
  startProactiveMessages,
  stopProactiveMessages,
  updateLastChatTime,
  setProactiveEnabled,
  getProactiveStatus,
  generateDailyPlan,
  buildProactivePrompt
};
