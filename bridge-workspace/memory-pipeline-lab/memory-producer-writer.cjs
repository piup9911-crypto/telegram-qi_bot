const crypto = require('crypto');
const { rebuildWordSearchIndex } = require('./rebuild-word-search-index.cjs');

function sha(value) { return crypto.createHash('sha256').update(String(value)).digest('hex'); }
function json(value) { return JSON.stringify(value ?? null); }
function arr(value) { return Array.isArray(value) ? value : []; }
function obj(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
function unique(values) { return [...new Set(values.filter(Boolean))]; }
function parse(value, fallback) { try { return JSON.parse(value || ''); } catch { return fallback; } }

function sourceMap(messages) { return new Map(messages.map((message) => [message.id, message])); }

function mergeFactEvidence(db, existing, event, now) {
  const ids = unique([...parse(existing.source_message_ids_json, []), ...arr(event.source_message_ids)]);
  const quotes = { ...parse(existing.evidence_quotes_json, {}), ...obj(event.evidence_quotes) };
  db.prepare(`
    UPDATE fact_events SET source_message_ids_json=?,evidence_quotes_json=?,recorded_at=? WHERE id=?
  `).run(json(ids), json(quotes), now, existing.id);
  return existing.id;
}

function commitProducerOutput(db, job, output, messages, options = {}) {
  const now = options.now || new Date().toISOString();
  const policyVersion = job.policy_version || 'memory-policy-v1';
  const byId = sourceMap(messages);
  const result = {
    summaries: { inserted: 0, reused: 0 }, cards: { inserted: 0, reused: 0, conflicts: [] },
    card_sources: { inserted: 0, reused: 0 }, timelines: { inserted: 0, reused: 0 },
    fact_events: { inserted: 0, merged: 0, superseded: 0, reused: 0 },
    occurrences: { inserted: 0, reused: 0 }, reviewed_messages: 0, search_index: null
  };
  const summaryBySegment = new Map();
  const evidenceMessageIds = new Set();
  const statusByMessage = new Map();

  db.exec('BEGIN IMMEDIATE');
  try {
    for (const segment of arr(output.segments)) {
      const segmentIds = arr(segment.source_message_ids);
      if (segment.summary_mode === 'none') {
        for (const id of segmentIds) statusByMessage.set(id, 'raw_only');
        continue;
      }
      const segmentRows = segmentIds.map((id) => byId.get(id));
      const identity = sha(json({ conversation: job.conversation_id, ids: segmentIds, topic: segment.topic_key }));
      const summaryId = `producer_summary:${identity.slice(0, 24)}`;
      const contentHash = sha(json({ producer: job.processor_version, conversation: job.conversation_id, segment }));
      const existed = db.prepare('SELECT id FROM event_summaries WHERE id=? OR content_hash=?').get(summaryId, contentHash);
      if (existed) {
        summaryBySegment.set(segment.segment_key, existed.id);
        result.summaries.reused += 1;
      } else {
        db.prepare(`
          INSERT INTO event_summaries(
            id,conversation_id,start_message_index,end_message_index,topic_key,topic,summary_mode,gist,
            source_spans_json,observation_ids_json,user_goals_json,user_confirmed_json,
            assistant_proposals_json,open_questions_json,retrieval_terms_json,source_generation,
            content_hash,created_at,card_decision,card_reason,memory_action,memory_processed_at,memory_policy_version
          ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        `).run(
          summaryId, job.conversation_id, Math.min(...segmentRows.map((row) => row.message_index)),
          Math.max(...segmentRows.map((row) => row.message_index)), segment.topic_key || 'misc', segment.topic,
          segment.summary_mode, segment.gist,
          json([{ start_id: segmentIds[0], end_id: segmentIds[segmentIds.length - 1] }]), json(segmentIds),
          json(arr(segment.user_goals)), json(arr(segment.user_confirmed)), json(arr(segment.assistant_proposals)),
          json(arr(segment.open_questions)), json(arr(segment.retrieval_terms)), job.processor_version || 'memory-producer-v1',
          contentHash, now, arr(segment.cards).length ? 'created' : 'none',
          arr(segment.cards).length ? 'validated user-evidenced card candidates' : 'reviewed; no card candidate',
          segment.disposition, now, policyVersion
        );
        summaryBySegment.set(segment.segment_key, summaryId);
        result.summaries.inserted += 1;
      }
      for (const id of segmentIds) statusByMessage.set(id, 'summary');

      for (const card of arr(segment.cards)) {
        const subjectPrefix = `${card.subject_key}.`;
        const memoryKey = card.candidate_key.startsWith(subjectPrefix)
          ? card.candidate_key
          : `${subjectPrefix}${card.candidate_key}`;
        let saved = db.prepare('SELECT * FROM memory_cards WHERE memory_key=?').get(memoryKey);
        if (!saved) {
          const cardId = `producer_card:${sha(memoryKey).slice(0, 24)}`;
          db.prepare(`
            INSERT INTO memory_cards(
              id,memory_type,title,content,domain,topic,status,source_identity,derived_from_summary_id,
              timeline_id,created_at,updated_at,write_reason,memory_key,sensitivity,recall_scope,subject_key
            ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
          `).run(cardId,card.memory_type,card.title,card.content,card.domain || 'unknown',card.topic || segment.topic,
            'active','user_evidence',summaryBySegment.get(segment.segment_key),null,now,now,
            'automatic producer: exact user evidence passed validation',memoryKey,card.sensitivity,card.recall_scope,card.subject_key);
          saved = db.prepare('SELECT * FROM memory_cards WHERE id=?').get(cardId);
          result.cards.inserted += 1;
        } else if (saved.content.trim() === String(card.content).trim()) {
          result.cards.reused += 1;
        } else {
          result.cards.conflicts.push({ memory_key: memoryKey, existing: saved.content, proposed: card.content });
          continue;
        }
        for (const evidence of arr(card.evidence)) {
          const sourceId = evidence.source_message_id;
          const sourceKey = sha(`${saved.id}\n${sourceId}\nsupports`);
          const inserted = db.prepare(`
            INSERT OR IGNORE INTO memory_sources(id,memory_card_id,raw_message_id,relation,evidence_quote,added_at)
            VALUES (?,?,?,?,?,?)
          `).run(`producer_source:${sourceKey.slice(0, 24)}`,saved.id,sourceId,'supports',evidence.evidence_quote,now);
          result.card_sources[inserted.changes ? 'inserted' : 'reused'] += 1;
          evidenceMessageIds.add(sourceId);
        }
      }

      for (const timeline of arr(segment.timelines)) {
        let savedTimeline = db.prepare('SELECT * FROM fact_timelines WHERE fact_key=?').get(timeline.fact_key);
        if (!savedTimeline) {
          const timelineId = `producer_timeline:${sha(timeline.fact_key).slice(0, 24)}`;
          db.prepare(`
            INSERT INTO fact_timelines(
              id,fact_key,topic,current_event_id,created_at,updated_at,sensitivity,recall_scope,subject_key,predicate_key,domain
            ) VALUES (?,?,?,?,?,?,?,?,?,?,?)
          `).run(timelineId,timeline.fact_key,timeline.topic,null,now,now,timeline.sensitivity,timeline.recall_scope,
            timeline.subject_key,timeline.predicate_key,timeline.domain || 'unknown');
          savedTimeline = db.prepare('SELECT * FROM fact_timelines WHERE id=?').get(timelineId);
          result.timelines.inserted += 1;
        } else result.timelines.reused += 1;

        for (const event of arr(timeline.events)) {
          const sourceIds = arr(event.source_message_ids);
          sourceIds.forEach((id) => evidenceMessageIds.add(id));
          const claimKey = sha(json({ fact_key: timeline.fact_key, value: event.value_text, sources: [...sourceIds].sort(), currentness: event.currentness }));
          const repeated = db.prepare('SELECT * FROM fact_events WHERE source_claim_key=?').get(claimKey);
          if (repeated) { result.fact_events.reused += 1; continue; }
          const current = db.prepare('SELECT * FROM fact_events WHERE timeline_id=? AND is_current=1').get(savedTimeline.id);
          if (event.currentness === 'last_known_state' && current && String(current.value_text).trim() === String(event.value_text).trim()) {
            mergeFactEvidence(db,current,event,now);
            result.fact_events.merged += 1;
            continue;
          }
          if (event.currentness === 'last_known_state' && current) {
            db.prepare('UPDATE fact_events SET is_current=0,invalid_at=? WHERE id=?').run(event.valid_at || now,current.id);
            result.fact_events.superseded += 1;
          }
          const primary = byId.get(sourceIds[0]);
          const observedAt = primary?.timestamp || now;
          const eventId = `producer_fact:${claimKey.slice(0, 24)}`;
          const isCurrent = event.currentness === 'last_known_state' ? 1 : 0;
          const eventKind = event.currentness === 'last_known_state' ? 'state_change' : 'historical_event';
          db.prepare(`
            INSERT INTO fact_events(
              id,timeline_id,source_message_id,valid_at,valid_at_precision,observed_at,content,evidence_status,
              is_current,value_text,event_kind,source_claim_key,invalid_at,recorded_at,source_message_ids_json,
              temporal_basis,evidence_quotes_json,correction_of_event_id
            ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
          `).run(eventId,savedTimeline.id,sourceIds[0],event.valid_at || null,event.valid_at_precision,observedAt,
            event.content,event.evidence_status,isCurrent,event.value_text,eventKind,claimKey,null,now,json(sourceIds),
            event.valid_at ? 'explicit_text' : 'source_timestamp',json(obj(event.evidence_quotes)),null);
          db.prepare('UPDATE fact_timelines SET current_event_id=CASE WHEN ?=1 THEN ? ELSE current_event_id END,updated_at=? WHERE id=?')
            .run(isCurrent,eventId,now,savedTimeline.id);
          result.fact_events.inserted += 1;
        }
      }

      for (const occurrence of arr(segment.occurrences)) {
        const sourceIds = arr(occurrence.source_message_ids);
        sourceIds.forEach((id) => evidenceMessageIds.add(id));
        const firstSource = byId.get(sourceIds[0]);
        const occurredAt = occurrence.occurred_at || firstSource?.timestamp || now;
        const occurrenceId = `producer_event:${sha(json({ key: occurrence.occurrence_key, status: occurrence.event_status, occurredAt })).slice(0, 24)}`;
        const inserted = db.prepare(`
          INSERT OR IGNORE INTO event_occurrences(
            id,event_key,occurrence_key,event_label,event_text,aliases_json,subject_key,event_status,
            occurred_at,ended_at,local_date,time_precision,summary_id,source_message_ids_json,
            evidence_quotes_json,evidence_status,confidence,sensitivity,recall_scope,policy_version,created_at
          ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        `).run(occurrenceId,occurrence.event_key,occurrence.occurrence_key,occurrence.event_label,occurrence.event_text,
          json(arr(occurrence.aliases)),occurrence.subject_key,occurrence.event_status,occurredAt,occurrence.ended_at || null,
          firstSource?.local_date || occurredAt.slice(0,10),occurrence.time_precision || (occurrence.occurred_at ? 'exact' : 'exact'),
          summaryBySegment.get(segment.segment_key),json(sourceIds),json(obj(occurrence.evidence_quotes)),occurrence.evidence_status,
          Number(occurrence.confidence),occurrence.sensitivity,occurrence.recall_scope,policyVersion,now);
        result.occurrences[inserted.changes ? 'inserted' : 'reused'] += 1;
      }
    }

    for (const [id, baseStatus] of statusByMessage) {
      const status = evidenceMessageIds.has(id) ? 'evidence' : baseStatus;
      db.prepare(`
        UPDATE raw_messages SET memory_review_status=?,memory_review_reason=?,memory_reviewed_at=?,memory_policy_version=?
        WHERE id=?
      `).run(status,status === 'raw_only' ? 'no durable memory candidate' : 'automatic producer validation passed',now,policyVersion,id);
      result.reviewed_messages += 1;
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }

  if (options.rebuildSearchIndex !== false) {
    try { result.search_index = rebuildWordSearchIndex(db, { dbPath: options.dbPath }); }
    catch (error) { result.search_index = { refreshed: false, error: error.message }; }
  }
  return result;
}

module.exports = { commitProducerOutput };
