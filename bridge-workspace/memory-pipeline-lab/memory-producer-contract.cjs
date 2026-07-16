const OUTPUT_VERSION = 'memory_producer_output_v1';
const SUMMARY_MODES = new Set(['none', 'index', 'detailed']);
const DISPOSITIONS = new Set(['card', 'timeline', 'both', 'event_only']);
const CARD_TYPES = new Set(['stable', 'episode', 'plan', 'pattern', 'tracker']);
const SENSITIVITIES = new Set(['ordinary', 'personal', 'sensitive']);
const RECALL_SCOPES = new Set(['always', 'relevant_only', 'explicit_only']);
const CURRENTNESS = new Set(['historical_event', 'last_known_state', 'plan_at_observation']);
const PRECISIONS = new Set(['exact', 'day', 'month', 'approximate', 'unknown']);
const FACT_EVIDENCE = new Set(['user_explicit', 'user_reported']);
const EVENT_STATUSES = new Set(['mentioned','requested','planned','started','in_progress','completed','failed','refused','stopped','uncertain']);
const EVENT_EVIDENCE = new Set(['user_explicit','user_reported','mixed_transcript','assistant_only','system_verified']);

function arr(value) { return Array.isArray(value) ? value : []; }
function obj(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
function present(value) { return typeof value === 'string' && value.trim().length > 0; }

function producerOutputContract() {
  return {
    version: OUTPUT_VERSION,
    batch_id: 'job id',
    segments: [{
      segment_key: 'stable key inside batch',
      source_message_ids: ['ordered, contiguous input ids'],
      topic_key: 'short machine key', topic: 'short human title',
      summary_mode: 'none | index | detailed', gist: 'grounded summary',
      retrieval_terms: ['terms'], user_goals: [{ text: '...', source_message_ids: ['...'] }],
      user_confirmed: [{ text: '...', source_message_ids: ['...'] }],
      assistant_proposals: [{ text: '...', source_message_ids: ['...'] }],
      open_questions: [{ text: '...', source_message_ids: ['...'] }],
      disposition: 'card | timeline | both | event_only',
      cards: [{ candidate_key: '...', memory_type: 'stable', title: '...', content: '...', domain: '...', topic: '...', subject_key: 'user', sensitivity: 'ordinary', recall_scope: 'relevant_only', evidence: [{ source_message_id: '...', evidence_quote: 'exact substring' }] }],
      timelines: [{ fact_key: 'subject.predicate', topic: '...', subject_key: 'user', predicate_key: '...', domain: '...', sensitivity: 'ordinary', recall_scope: 'relevant_only', events: [{ content: '...', value_text: '...', source_message_ids: ['...'], evidence_quotes: { message_id: 'exact substring' }, currentness: 'last_known_state', valid_at: null, valid_at_precision: 'unknown', evidence_status: 'user_explicit' }] }],
      occurrences: [{ event_key: '...', occurrence_key: '...', event_label: '...', event_text: '...', aliases: [], subject_key: 'user', event_status: 'completed', source_message_ids: ['...'], evidence_quotes: { message_id: 'exact substring' }, evidence_status: 'user_explicit', confidence: 0.9, sensitivity: 'ordinary', recall_scope: 'relevant_only', occurred_at: null }]
    }]
  };
}

function validateProducerOutput(output, messages, options = {}) {
  const errors = [];
  const warnings = [];
  const byId = new Map(messages.map((message) => [message.id, message]));
  const inputIds = messages.map((message) => message.id);
  const position = new Map(inputIds.map((id, index) => [id, index]));
  const segments = arr(output?.segments);
  const covered = [];
  const error = (code, path, detail) => errors.push({ code, path, detail });
  const warning = (code, path, detail) => warnings.push({ code, path, detail });

  if (output?.version !== OUTPUT_VERSION) error('bad_version', 'version', `Expected ${OUTPUT_VERSION}.`);
  if (options.jobId && output?.batch_id !== options.jobId) error('bad_batch_id', 'batch_id', 'Output does not belong to this job.');
  if (!segments.length) error('missing_segments', 'segments', 'At least one segment is required.');

  function validateRefs(items, path, allowedSpeakers) {
    for (const [index, item] of arr(items).entries()) {
      if (!present(item?.text)) error('missing_text', `${path}[${index}].text`, 'Text is required.');
      for (const id of arr(item?.source_message_ids)) {
        const source = byId.get(id);
        if (!source) error('unknown_source', `${path}[${index}]`, id);
        else if (allowedSpeakers && !allowedSpeakers.has(source.speaker)) error('wrong_speaker', `${path}[${index}]`, `${id} is ${source.speaker}.`);
      }
    }
  }

  function validateQuote(sourceId, quote, path, allowedSpeakers = null) {
    const source = byId.get(sourceId);
    if (!source) return error('unknown_source', path, sourceId);
    if (allowedSpeakers && !allowedSpeakers.has(source.speaker)) return error('wrong_speaker', path, `${sourceId} is ${source.speaker}.`);
    if (!present(quote) || !source.text.includes(quote)) error('quote_not_exact', path, `Quote is not an exact substring of ${sourceId}.`);
  }

  for (const [segmentIndex, segment] of segments.entries()) {
    const path = `segments[${segmentIndex}]`;
    const ids = arr(segment?.source_message_ids);
    if (!ids.length) error('empty_segment', `${path}.source_message_ids`, 'Segment cannot be empty.');
    for (const id of ids) {
      if (!byId.has(id)) error('unknown_source', `${path}.source_message_ids`, id);
      covered.push(id);
    }
    const positions = ids.map((id) => position.get(id)).filter(Number.isInteger);
    for (let i = 1; i < positions.length; i += 1) {
      if (positions[i] !== positions[i - 1] + 1) error('non_contiguous_segment', `${path}.source_message_ids`, 'Segment ids must be contiguous and ordered.');
    }
    if (!SUMMARY_MODES.has(segment?.summary_mode)) error('bad_summary_mode', `${path}.summary_mode`, segment?.summary_mode);
    if (segment?.summary_mode !== 'none' && (!present(segment?.topic) || !present(segment?.gist))) error('incomplete_summary', path, 'Indexed summaries require topic and gist.');
    if (segment?.summary_mode === 'none' && (arr(segment?.cards).length || arr(segment?.timelines).length || arr(segment?.occurrences).length)) error('raw_only_has_memory', path, 'A raw-only segment cannot write durable memory.');
    if (!DISPOSITIONS.has(segment?.disposition)) error('bad_disposition', `${path}.disposition`, segment?.disposition);

    validateRefs(segment?.user_goals, `${path}.user_goals`, new Set(['user']));
    validateRefs(segment?.user_confirmed, `${path}.user_confirmed`, new Set(['user']));
    validateRefs(segment?.assistant_proposals, `${path}.assistant_proposals`, new Set(['assistant']));
    validateRefs(segment?.open_questions, `${path}.open_questions`, null);

    for (const [cardIndex, card] of arr(segment?.cards).entries()) {
      const cardPath = `${path}.cards[${cardIndex}]`;
      if (!present(card?.candidate_key) || !present(card?.title) || !present(card?.content)) error('incomplete_card', cardPath, 'Card key, title and content are required.');
      if (!CARD_TYPES.has(card?.memory_type)) error('bad_card_type', `${cardPath}.memory_type`, card?.memory_type);
      if (!SENSITIVITIES.has(card?.sensitivity)) error('bad_sensitivity', `${cardPath}.sensitivity`, card?.sensitivity);
      if (!RECALL_SCOPES.has(card?.recall_scope)) error('bad_recall_scope', `${cardPath}.recall_scope`, card?.recall_scope);
      if (card?.sensitivity === 'sensitive' && card?.recall_scope !== 'explicit_only') error('sensitive_scope_too_broad', cardPath, 'Sensitive Cards must be explicit-only.');
      if (!arr(card?.evidence).length) error('missing_evidence', `${cardPath}.evidence`, 'Cards need user evidence.');
      for (const [evidenceIndex, evidence] of arr(card?.evidence).entries()) {
        if (!ids.includes(evidence?.source_message_id)) error('source_outside_segment', `${cardPath}.evidence[${evidenceIndex}]`, evidence?.source_message_id);
        validateQuote(evidence?.source_message_id, evidence?.evidence_quote, `${cardPath}.evidence[${evidenceIndex}]`, new Set(['user']));
      }
      if (/(?:api[_ -]?key|token|password|密码|密钥)\s*[:=]\s*\S+/i.test(card?.content || '')) error('secret_in_card', `${cardPath}.content`, 'Possible secret must stay in raw evidence only.');
    }

    for (const [timelineIndex, timeline] of arr(segment?.timelines).entries()) {
      const timelinePath = `${path}.timelines[${timelineIndex}]`;
      if (!/^[^.\s]+\.[^.\s]+$/.test(timeline?.fact_key || '')) error('bad_fact_key', `${timelinePath}.fact_key`, timeline?.fact_key);
      if (!present(timeline?.subject_key) || !present(timeline?.predicate_key)) error('incomplete_timeline', timelinePath, 'Subject and predicate are required.');
      if (present(timeline?.subject_key) && !String(timeline?.fact_key || '').startsWith(`${timeline.subject_key}.`)) error('fact_subject_mismatch', timelinePath, 'fact_key must start with subject_key.');
      if (!SENSITIVITIES.has(timeline?.sensitivity) || !RECALL_SCOPES.has(timeline?.recall_scope)) error('bad_timeline_policy', timelinePath, 'Invalid sensitivity or recall scope.');
      if (timeline?.sensitivity === 'sensitive' && timeline?.recall_scope !== 'explicit_only') error('sensitive_scope_too_broad', timelinePath, 'Sensitive facts must be explicit-only.');
      for (const [eventIndex, event] of arr(timeline?.events).entries()) {
        const eventPath = `${timelinePath}.events[${eventIndex}]`;
        if (!present(event?.content) || !present(event?.value_text)) error('incomplete_fact_event', eventPath, 'Fact content and value are required.');
        if (!CURRENTNESS.has(event?.currentness)) error('bad_currentness', `${eventPath}.currentness`, event?.currentness);
        if (!PRECISIONS.has(event?.valid_at_precision)) error('bad_precision', `${eventPath}.valid_at_precision`, event?.valid_at_precision);
        if (!FACT_EVIDENCE.has(event?.evidence_status)) error('bad_fact_evidence', `${eventPath}.evidence_status`, event?.evidence_status);
        for (const sourceId of arr(event?.source_message_ids)) {
          if (!ids.includes(sourceId)) error('source_outside_segment', `${eventPath}.source_message_ids`, sourceId);
          validateQuote(sourceId, obj(event?.evidence_quotes)[sourceId], `${eventPath}.evidence_quotes.${sourceId}`, new Set(['user']));
        }
        if (!arr(event?.source_message_ids).length) error('missing_evidence', eventPath, 'Fact events need user evidence.');
      }
    }

    for (const [occurrenceIndex, occurrence] of arr(segment?.occurrences).entries()) {
      const occurrencePath = `${path}.occurrences[${occurrenceIndex}]`;
      if (!present(occurrence?.event_key) || !present(occurrence?.occurrence_key) || !present(occurrence?.event_text)) error('incomplete_occurrence', occurrencePath, 'Event key, occurrence key and text are required.');
      if (!EVENT_STATUSES.has(occurrence?.event_status)) error('bad_event_status', `${occurrencePath}.event_status`, occurrence?.event_status);
      if (!EVENT_EVIDENCE.has(occurrence?.evidence_status)) error('bad_event_evidence', `${occurrencePath}.evidence_status`, occurrence?.evidence_status);
      if (!SENSITIVITIES.has(occurrence?.sensitivity) || !RECALL_SCOPES.has(occurrence?.recall_scope)) error('bad_occurrence_policy', occurrencePath, 'Invalid sensitivity or recall scope.');
      const confidence = Number(occurrence?.confidence);
      if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) error('bad_confidence', `${occurrencePath}.confidence`, occurrence?.confidence);
      if (occurrence?.evidence_status === 'assistant_only' && confidence > 0.55) error('assistant_confidence_too_high', occurrencePath, 'Assistant-only evidence is capped at 0.55.');
      if (occurrence?.evidence_status === 'assistant_only' && occurrence?.event_status === 'completed') error('assistant_cannot_prove_completion', occurrencePath, 'Assistant text cannot prove completion.');
      if (occurrence?.sensitivity === 'sensitive' && occurrence?.recall_scope !== 'explicit_only') error('sensitive_scope_too_broad', occurrencePath, 'Sensitive occurrences must be explicit-only.');
      for (const sourceId of arr(occurrence?.source_message_ids)) {
        if (!ids.includes(sourceId)) error('source_outside_segment', `${occurrencePath}.source_message_ids`, sourceId);
        validateQuote(sourceId, obj(occurrence?.evidence_quotes)[sourceId], `${occurrencePath}.evidence_quotes.${sourceId}`);
      }
      if (!arr(occurrence?.source_message_ids).length) error('missing_evidence', occurrencePath, 'Occurrences need transcript evidence.');
    }
  }

  const expected = inputIds.join('\n');
  const actual = covered.join('\n');
  if (actual !== expected) error('coverage_mismatch', 'segments', 'Every input message must appear once, in original order.');
  const duplicates = covered.filter((id, index) => covered.indexOf(id) !== index);
  if (duplicates.length) error('duplicate_source', 'segments', [...new Set(duplicates)].join(','));
  if (!errors.length && segments.every((segment) => segment.summary_mode === 'none')) warning('raw_only_batch', 'segments', 'No durable memory was produced; input remains searchable as raw transcript.');

  return {
    passed: errors.length === 0, errors, warnings,
    stats: {
      input_messages: inputIds.length, segments: segments.length,
      summaries: segments.filter((segment) => segment.summary_mode !== 'none').length,
      cards: segments.reduce((n, segment) => n + arr(segment.cards).length, 0),
      timelines: segments.reduce((n, segment) => n + arr(segment.timelines).length, 0),
      occurrences: segments.reduce((n, segment) => n + arr(segment.occurrences).length, 0)
    }
  };
}

module.exports = { OUTPUT_VERSION, producerOutputContract, validateProducerOutput };
