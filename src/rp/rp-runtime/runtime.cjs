const {
  getActiveRuntimeConfig,
  getRuntimeDebugConfig
} = require("./config-store.cjs");
const { buildPrompt } = require("./prompt-builder.cjs");

function buildRuntimeResult({ chatId, chatState, userInput }) {
  const runtimeConfig = getActiveRuntimeConfig(chatState);
  const prompt = buildPrompt({
    chatId,
    chatState,
    runtimeConfig,
    userInput
  });
  const debugConfig = getRuntimeDebugConfig(runtimeConfig);

  return {
    reply: "RP Runtime connected.",
    debug: {
      chat_id: chatId,
      character_id: debugConfig.character_id,
      preset_id: debugConfig.preset_id,
      persona_id: debugConfig.persona_id,
      triggered_lore_entries: debugConfig.triggered_lore_entries,
      used_memories: debugConfig.used_memories,
      applied_regex_rules: debugConfig.applied_regex_rules,
      prompt_preview: prompt.prompt
    }
  };
}

function buildPromptPreview({ chatId, chatState, userInput = "" }) {
  return buildRuntimeResult({ chatId, chatState, userInput }).debug;
}

module.exports = {
  buildRuntimeResult,
  buildPromptPreview
};
