const DEFAULT_RECENT_MESSAGE_LIMIT = 8;

function normalizeMessage(message) {
  return {
    role: String((message && message.role) || "unknown"),
    content: String((message && message.content) || ""),
    at: String((message && message.at) || "")
  };
}

function getRecentTelegramRpMessages(chatState, limit = DEFAULT_RECENT_MESSAGE_LIMIT) {
  const history = Array.isArray(chatState && chatState.history) ? chatState.history : [];
  return history
    .filter((message) => message && message.source_type === "telegram_rp")
    .slice(-limit)
    .map(normalizeMessage);
}

function buildPrompt({ chatId, chatState, runtimeConfig, userInput }) {
  const recentMessages = getRecentTelegramRpMessages(chatState);
  const lines = [
    "[BASE SYSTEM PLACEHOLDER]",
    "You are the RP Runtime prompt compiler. Real model routing is not connected yet.",
    "",
    `[CHAT ID] ${chatId}`,
    `[CHARACTER ID] ${runtimeConfig.character_id || "null"}`,
    `[PRESET ID] ${runtimeConfig.preset_id || "null"}`,
    `[PERSONA ID] ${runtimeConfig.persona_id || "null"}`,
    "",
    "[RECENT TELEGRAM_RP MESSAGES]"
  ];

  if (recentMessages.length === 0) {
    lines.push("(none)");
  } else {
    for (const message of recentMessages) {
      lines.push(`${message.role}${message.at ? ` @ ${message.at}` : ""}: ${message.content}`);
    }
  }

  lines.push("", "[CURRENT USER INPUT]", String(userInput || ""));

  return {
    prompt: lines.join("\n"),
    recentMessages
  };
}

module.exports = {
  buildPrompt,
  getRecentTelegramRpMessages
};
