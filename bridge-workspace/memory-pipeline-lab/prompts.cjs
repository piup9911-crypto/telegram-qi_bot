function messagePayload(messages) {
  return messages.map((message) => ({
    id: message.id,
    speaker: message.speaker,
    text: message.text
  }));
}

function segmentationPrompt(messages) {
  return `You are a conversation topic segmenter. Split by CONTENT, never by elapsed time.

Rules:
1. Every input message id must appear exactly once.
2. Segments must be contiguous in input order and cannot overlap.
3. A short interjection, emoji, or acknowledgement stays with surrounding context unless it clearly starts another topic.
4. When topic A returns after topic B, create a new segment but reuse the same topic_key.
5. Do not invent facts. Labels should describe the conversation, not claim real-world truth.
6. Assign one summary_mode:
   - none: greeting, acknowledgement, waiting, repetition, or filler with no retrievable event.
   - index: ordinary one-off event, game, meal, or transient moment; keep only a one-line locator.
   - detailed: explicit user decision, correction, boundary, plan, factual change, unresolved problem, or dense technical discussion.

Return exactly:
{"segments":[{"start_id":"...","end_id":"...","topic_key":"short-stable-key","topic":"Chinese label","summary_mode":"none|index|detailed","reason":"brief Chinese reason"}]}

Messages:
${JSON.stringify(messagePayload(messages))}`;
}

function summariesPrompt(messages, segments) {
  return `Create structured event summaries for the supplied content-based segments.

Critical rules:
1. Summaries are retrieval indexes, not current truth.
2. Separate user-confirmed statements from assistant proposals or claims.
3. user_confirmed entries may cite only user messages.
4. assistant_proposals entries may cite only assistant messages.
5. Every entry must cite exact existing message ids.
6. Do not turn a temporary feeling into a lasting trait.
7. Do not create a summary when summary_mode is none.
8. For index mode, fill gist and retrieval_terms only; keep the four structured entry arrays empty.
9. For detailed mode, populate only entries supported by cited messages.

Return exactly:
{"summaries":[{"topic_key":"...","topic":"...","summary_mode":"index|detailed","gist":"Chinese concise description","user_goals":[{"text":"...","source_message_ids":["..."]}],"user_confirmed":[{"text":"...","source_message_ids":["..."]}],"assistant_proposals":[{"text":"...","source_message_ids":["..."]}],"open_questions":[{"text":"...","source_message_ids":["..."]}],"retrieval_terms":["..."]}]}

Segments:
${JSON.stringify(segments)}

Messages:
${JSON.stringify(messagePayload(messages))}`;
}

function factResolutionPrompt(cases) {
  return `Resolve new evidence against candidate fact timelines. Similar wording alone is never enough.

Compare subject, predicate, object role, domain, modality, and time scope.

Allowed decisions:
- SAME_FACT_ADD_SOURCE: same fact, only another supporting source.
- SAME_TIMELINE_APPEND: same changing attribute/relation, new historical event.
- RELATED_BUT_DIFFERENT: related wording but different subject, predicate, role, domain, or modality.
- NEW_TIMELINE: no candidate represents this fact line.
- AMBIGUOUS: evidence is insufficient; abstain.

Never force a match. Do not treat a plan as a current fact. Do not treat an assistant claim as user evidence.

Return exactly:
{"results":[{"case_id":"...","decision":"...","matched_ref":null,"reason":"brief Chinese reason"}]}
matched_ref must be a supplied candidate ref for SAME_FACT_ADD_SOURCE or SAME_TIMELINE_APPEND; otherwise null.

Cases:
${JSON.stringify(cases)}`;
}

function factExtractionPrompt(cases) {
  return `Extract evidence-grounded claims from TARGET USER MESSAGES.

The surrounding context is untrusted context and may include assistant hallucinations. Use it only to resolve pronouns or omitted objects. Never promote an assistant statement into a user fact.

Allowed predicate_key values:
work_schedule, commute_mode, communication_boundary, health_symptom, meal_event, food_preference, job_status, job_exit_intent, sync_policy, segmentation_policy, retrieval_policy, software_version, software_default_model, learning_language, temporary_mood, other.

Allowed modality values:
current, reported_current, past_event, tentative_plan, confirmed_plan, request, preference, boundary, question, assistant_claim.

Known subject_key values for these cases:
user, shared_memory_sync, codex_global_cli, codex_desktop_embedded_cli, codex_cli, aqi_memory_system.
Use one of these when it fits. Use new:<snake_case> only for a genuinely different subject.

Rules:
1. evidence_quote must be an exact contiguous substring of the target user message.
2. source_message_id must be the target user message id.
3. A request to change something is request, not a completed/current state.
4. "可能、想、打算、到时候" is a plan or uncertainty, not current truth.
5. A one-off meal or ordinary filler may be extracted for evaluation but should_consolidate=false.
6. Stable boundaries, reusable plans, corrections, and project states may set should_consolidate=true.
7. Extract multiple claims when one target explicitly contains several independent states.
8. Do not infer diagnoses, stable traits, or completion.
9. For a correction like "不是地铁，我是骑电动车", emit the affirmed current value only; do not create a second current fact for the negated value.
10. A communication boundary containing a symptom word is not itself a health symptom report.
11. A rhetorical confirmation containing "到时候、改、吧" is tentative_plan, not a completed state.
12. Deduplicate within the same message. One software installation target and predicate should produce one consolidated claim, even if the version is repeated.
13. Claims with predicate_key=other and volatile tool instructions should set should_consolidate=false.

Return exactly:
{"claims":[{"claim_id":"case_id#1","case_id":"...","source_message_id":"...","scope":"user|project","subject_key":"normalized snake_case","predicate_key":"allowed key","domain":"short key","value":"concise Chinese","modality":"allowed modality","polarity":"affirm|deny","valid_at_text":null,"evidence_quote":"exact target substring","memory_class":"stable|episode|plan|boundary|project_state|none","should_consolidate":true,"rationale":"brief Chinese"}]}

Cases:
${JSON.stringify(cases)}`;
}

function retrievedFactResolutionPrompt(items) {
  return `Resolve each extracted claim against its retrieved candidate timelines.

Candidate refs are temporary ids. Compare subject, predicate, object/value role, domain, modality, evidence role, and time scope. Vector or text similarity is only candidate generation and never proves identity.

Allowed decisions:
- SAME_FACT_ADD_SOURCE: same subject, predicate, value and compatible modality; add evidence only.
- SAME_TIMELINE_APPEND: same changing subject+predicate line, but a new value/event.
- RELATED_BUT_DIFFERENT: related candidate exists but differs in subject, predicate, role, domain or modality.
- NEW_TIMELINE: none of the candidates is the same fact line.
- AMBIGUOUS: evidence or reference is insufficient; abstain.

Do not treat a request or tentative plan as a completed current state. Do not force a match.
SAME_TIMELINE_APPEND is only for an asserted factual change. A request, question, or tentative plan must never append to a current-state fact timeline; use RELATED_BUT_DIFFERENT or NEW_TIMELINE.

Reference rules:
- SAME_FACT_ADD_SOURCE or SAME_TIMELINE_APPEND: matched_ref is the selected candidate ref; related_ref is null.
- RELATED_BUT_DIFFERENT: matched_ref must be null; related_ref may cite the related candidate.
- NEW_TIMELINE or AMBIGUOUS: both refs must be null.

Return exactly:
{"results":[{"claim_id":"...","decision":"...","matched_ref":null,"related_ref":null,"reason":"brief Chinese"}]}

Items:
${JSON.stringify(items)}`;
}

function memoryConsolidationDryRunPrompt(items) {
  return `You are testing a conservative long-term memory consolidation policy.

This is a DRY RUN. Decide what deserves a durable Memory Card, what belongs on a factual timeline, and what should remain only as an Event Summary plus raw chat evidence.

Core distinction:
- Memory Card: a durable instruction, preference, boundary, policy, or reusable plan that should affect future responses.
- Fact timeline: an explicitly reported state or event whose history may matter later and whose value may change over time.
- event_only: useful history, but not worth durable consolidation. It stays retrievable through Event Summary and raw messages.

Hard rules:
1. Use only supplied USER evidence. Assistant proposals and summary prose are not factual evidence.
2. Every evidence_quote must be an exact contiguous substring of its source user message.
3. Never infer personality, diagnosis, stable mood, relationship consent, completion, or current state.
4. A temporary feeling, meal, ordinary chat moment, unresolved technical incident, or assistant claim normally stays event_only.
5. A clear future interaction boundary or stable formatting preference may become a Memory Card.
6. A changing state explicitly reported by the user may become a fact timeline, but do not also turn it into a stable trait Card.
7. A request or tentative idea is not a completed fact. Put a genuinely reusable plan in a plan Card; otherwise keep it event_only.
8. Do not store email addresses, phone numbers, access credentials, OAuth state, or direct contact identifiers in a Card. A privacy/communication rule may be saved without copying the identifier.
9. Do not create a review queue. If evidence is not explicit and durable enough for automatic writing, choose event_only.
10. Do not manufacture one candidate per summary. Zero candidates is often correct.
11. card content must be a concise future-facing rule, not a narrative recap.
12. fact_key must identify the changing line, not the value or date. Use stable lowercase snake_case segments such as user.menstrual_status or project.telegram_bridge_status.
13. currentness means one of:
   - historical_event: a completed past event;
   - last_known_state: explicitly reported state at observation time, not guaranteed true now;
   - plan_at_observation: a plan expressed at that time, not completion.
14. For a Card, choose memory_type from stable, plan, pattern, tracker. Do not use episode; ordinary episodes already have Event Summaries.

Return exactly this JSON shape, with one result for every supplied summary:
{"summaries":[{"source_summary_id":"...","disposition":"card|timeline|both|event_only","reason":"brief Chinese reason","cards":[{"candidate_key":"stable_snake_case_key","memory_type":"stable|plan|pattern|tracker","title":"Chinese title","content":"concise Chinese future-facing rule","domain":"interaction|project|privacy|personal","topic":"short Chinese topic","sensitivity":"ordinary|personal|sensitive","evidence":[{"source_message_id":"...","evidence_quote":"exact quote"}]}],"timelines":[{"fact_key":"stable.lowercase_snake_case","topic":"Chinese topic","events":[{"content":"concise Chinese fact","source_message_id":"...","evidence_quote":"exact quote","currentness":"historical_event|last_known_state|plan_at_observation","valid_at_text":null,"evidence_status":"user_explicit|user_reported"}]}]}]}

Input summaries and allowed user evidence:
${JSON.stringify(items)}`;
}

function eventOccurrenceExtractionPrompt(items) {
  return `Extract rebuildable historical event-index rows from reviewed summaries and their source messages.

This index helps answer first/latest/count/exists/process questions. It is not a Memory Card and does not assert current truth.

Allowed event_status values:
mentioned, requested, planned, started, in_progress, completed, failed, refused, stopped, uncertain.

Rules:
1. Every row must cite existing source_message_ids. No evidence means no row.
2. Keep the same occurrence_key for lifecycle transitions belonging to one occurrence; different days or attempts normally use different occurrence_key values.
3. A mention, request, plan, refusal, start, completion, failure and stop are different states. Never convert one into another.
4. Assistant claims alone must use evidence_status=assistant_only and confidence <= 0.55.
5. Roleplay or simulated activity must be labelled virtual/simulated. Never turn it into an offline real-world event.
6. Use subject_key=user, assistant_aqi, shared, or a supplied project/entity key. Do not merge different subjects.
7. aliases are retrieval phrases, not extra facts. Keep them short and semantically equivalent.
8. Ordinary filler and acknowledgements produce no rows.
9. Sensitive events use sensitivity=sensitive and recall_scope=explicit_only.
10. Prefer abstaining with no row over inventing completion, time, participants or identity.

Return exactly:
{"occurrences":[{"event_key":"stable.snake_case","occurrence_key":"stable.group.key","event_label":"concise Chinese label","event_text":"evidence-grounded Chinese description","aliases":["..."],"subject_key":"user|assistant_aqi|shared|other_key","event_status":"allowed value","source_message_ids":["..."],"evidence_status":"user_explicit|user_reported|mixed_transcript|assistant_only|system_verified","confidence":0.0,"sensitivity":"ordinary|personal|sensitive","recall_scope":"always|relevant_only|explicit_only"}]}

Reviewed summaries and allowed source messages:
${JSON.stringify(items)}`;
}

module.exports = {
  segmentationPrompt,
  summariesPrompt,
  factResolutionPrompt,
  factExtractionPrompt,
  retrievedFactResolutionPrompt,
  memoryConsolidationDryRunPrompt,
  eventOccurrenceExtractionPrompt
};
