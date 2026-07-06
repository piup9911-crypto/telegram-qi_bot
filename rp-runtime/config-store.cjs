function getActiveRuntimeConfig(chatState) {
  const rpConfig =
    chatState && chatState.rp_config && typeof chatState.rp_config === "object"
      ? chatState.rp_config
      : {};

  return {
    character_id: rpConfig.character_id || null,
    preset_id: rpConfig.preset_id || null,
    persona_id: rpConfig.persona_id || null,
    lorebook_ids: Array.isArray(rpConfig.lorebook_ids) ? rpConfig.lorebook_ids : [],
    author_note_id: rpConfig.author_note_id || null,
    regex_rule_ids: Array.isArray(rpConfig.regex_rule_ids) ? rpConfig.regex_rule_ids : [],
    scene_state_id: rpConfig.scene_state_id || null,
    memory_summary_id: rpConfig.memory_summary_id || null
  };
}

function getRuntimeDebugConfig(runtimeConfig) {
  return {
    character_id: runtimeConfig.character_id,
    preset_id: runtimeConfig.preset_id,
    persona_id: runtimeConfig.persona_id,
    triggered_lore_entries: [],
    used_memories: [],
    applied_regex_rules: []
  };
}

module.exports = {
  getActiveRuntimeConfig,
  getRuntimeDebugConfig
};
