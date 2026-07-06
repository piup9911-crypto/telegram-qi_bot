// Shared bootstrap helpers for opening a fresh Antigravity Sidecar Cascade
// and pre-seeding it with a bounded recent slice of local chat history.
//
// Used by both telegram-gem-bridge.cjs (lazy bootstrap on next user message)
// and gem-chat-record-manager.cjs (eager prepack right after a delete/archive
// so the next message lands in a Cascade that already has the trimmed
// history baked in).

const fs = require("fs");
const path = require("path");

function readJsonFile(filePath, fallback = null) {
  if (!fs.existsSync(filePath)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function listChatArchivePaths(chatId, archiveDir) {
  const dir = path.join(archiveDir, String(chatId));
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => path.join(dir, entry.name))
      .sort();
  } catch {
    return [];
  }
}

function limitHistoryToRecentTurns(history, maxTurns) {
  const limit = Number.parseInt(maxTurns, 10);
  if (!Number.isFinite(limit) || limit <= 0) return history;

  const selected = [];
  let userTurns = 0;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const message = history[index];
    selected.unshift(message);
    if (message && message.role === "user") {
      userTurns += 1;
      if (userTurns >= limit) break;
    }
  }
  return selected;
}

function collectRecentChatHistory(chatId, { chatStateDir, archiveDir, maxTurns = 35 } = {}) {
  const activeState = readJsonFile(path.join(chatStateDir, `${chatId}.json`), {
    history: []
  });
  const activeHistory = Array.isArray(activeState.history)
    ? activeState.history
    : [];
  const archiveHistories = listChatArchivePaths(chatId, archiveDir).map((p) => {
    const s = readJsonFile(p, { history: [] });
    return Array.isArray(s.history) ? s.history : [];
  });
  const merged = [...archiveHistories.flat(), ...activeHistory];
  const seen = new Set();
  const deduped = [];
  for (const m of merged) {
    if (!m || !m.content || !m.content.trim()) continue;
    const key = `${m.at || ""}|${m.role}|${m.content.slice(0, 200)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(m);
  }
  deduped.sort((a, b) => {
    const ta = Date.parse(a.at || "") || 0;
    const tb = Date.parse(b.at || "") || 0;
    return ta - tb;
  });
  return limitHistoryToRecentTurns(deduped, maxTurns);
}

function formatHistoryLines(history) {
  return history.map((m) => {
    const prefix = m.role === "assistant" ? "Assistant" : "User";
    const ts = m.at
      ? m.at.replace("T", " ").replace(/\.\d{3}Z$/, " UTC")
      : "";
    return ts ? `${prefix} [${ts}]: ${m.content}` : `${prefix}: ${m.content}`;
  });
}

function buildRecentSeedPrompt(history) {
  const lines = formatHistoryLines(history);
  return [
    "[System] The following is a bounded recent slice of the real prior dialogue between you and the user.",
    "It is ordered by time and is provided only as background for continuity.",
    "Do not treat this imported slice as the current user request. Do not summarize or analyze the slice unless the user asks.",
    "Continue the later conversation naturally from this recent context.",
    "Reply with exactly: 收到",
    "",
    "=== Recent dialogue slice begins ===",
    lines.join("\n"),
    "=== Recent dialogue slice ends ==="
  ].join("\n");
}

function buildAntigravitySidecarBootstrapPrompt(chatId, options = {}) {
  const chatStateDir = options.chatStateDir;
  const archiveDir = options.archiveDir;
  if (!chatStateDir || !archiveDir) {
    throw new Error("buildAntigravitySidecarBootstrapPrompt requires chatStateDir and archiveDir");
  }
  const bridgeContract = [
    "[系统] 你正在通过 Telegram 与用户持续对话。",
    "默认用中文回复中文消息。普通聊天直接回答，不要自行启动代码调查。",
    "只有当用户明确要求读取、编辑、调试本机内容或操控电脑时，才使用 Antigravity 工具。",
    "这是一个长期常驻会话。后续每轮只会收到新的用户消息，请延续本会话中已经导入的历史。"
  ].join("\n");
  const history = chatId
    ? collectRecentChatHistory(chatId, {
        chatStateDir,
        archiveDir,
        maxTurns: options.maxTurns
      })
    : [];
  if (history.length === 0) {
    return [
      bridgeContract,
      "请记住以上约定并只回复\"收到\"两个字。"
    ].join("\n\n");
  }
  return [bridgeContract, buildRecentSeedPrompt(history)].join("\n\n");
}

module.exports = {
  collectRecentChatHistory,
  limitHistoryToRecentTurns,
  buildAntigravitySidecarBootstrapPrompt,
  formatHistoryLines,
  buildRecentSeedPrompt
};
