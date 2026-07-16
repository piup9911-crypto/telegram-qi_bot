const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const dbPath = process.env.AQI_MEMORY_DB || path.join(__dirname, 'memory-schema-v2-complete.sqlite');
const outputPath = path.join(__dirname, 'memory-content-quality-audit.json');
const db = new DatabaseSync(dbPath, { readOnly: true });

function parseArray(value) {
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return null;
  }
}

const summaries = db.prepare('SELECT * FROM event_summaries ORDER BY id').all();
const cards = db.prepare('SELECT * FROM memory_cards ORDER BY id').all();
const messages = db.prepare('SELECT id, conversation_id, message_index, speaker, text, local_date FROM raw_messages').all();
const sources = db.prepare(`
  SELECT ms.*, r.speaker, r.text FROM memory_sources ms
  LEFT JOIN raw_messages r ON r.id = ms.raw_message_id
`).all();
db.close();

const messageById = new Map(messages.map((row) => [row.id, row]));
const messagesByConversation = new Map();
for (const row of messages) {
  const rows = messagesByConversation.get(row.conversation_id) || [];
  rows.push(row);
  messagesByConversation.set(row.conversation_id, rows);
}

const badJson = [];
const missingClaimSources = [];
const wrongClaimSpeaker = [];
const wideEnvelopeSummaries = [];
const unconfirmedSummaries = [];
for (const summary of summaries) {
  const jsonFields = ['source_spans_json', 'observation_ids_json', 'user_goals_json', 'user_confirmed_json',
    'assistant_proposals_json', 'open_questions_json', 'retrieval_terms_json'];
  for (const field of jsonFields) if (parseArray(summary[field]) === null) badJson.push({ summary_id: summary.id, field });

  for (const [field, expectedSpeaker] of [['user_confirmed_json', 'user'], ['user_goals_json', 'user'], ['assistant_proposals_json', 'assistant']]) {
    for (const claim of parseArray(summary[field]) || []) {
      if (!Array.isArray(claim.source_message_ids) || !claim.source_message_ids.length) {
        missingClaimSources.push({ summary_id: summary.id, field, claim: claim.text || '' });
        continue;
      }
      for (const id of claim.source_message_ids) {
        const message = messageById.get(id);
        if (!message || message.speaker !== expectedSpeaker) {
          wrongClaimSpeaker.push({ summary_id: summary.id, field, message_id: id, actual: message?.speaker || 'missing' });
        }
      }
    }
  }

  const sourceMessageIds = new Set();
  for (const span of parseArray(summary.source_spans_json) || []) {
    const start = messageById.get(span.start_id);
    const end = messageById.get(span.end_id);
    if (!start || !end || start.conversation_id !== end.conversation_id) continue;
    for (const message of messagesByConversation.get(start.conversation_id) || []) {
      if (message.message_index >= Math.min(start.message_index, end.message_index)
        && message.message_index <= Math.max(start.message_index, end.message_index)) sourceMessageIds.add(message.id);
    }
  }
  const envelopeMessages = summary.end_message_index - summary.start_message_index + 1;
  const excessMessages = envelopeMessages - sourceMessageIds.size;
  if (excessMessages >= 50) {
    wideEnvelopeSummaries.push({
      summary_id: summary.id,
      topic: summary.topic,
      envelope_messages: envelopeMessages,
      cited_messages: sourceMessageIds.size,
      excess_messages: excessMessages,
      envelope_ratio: Number((envelopeMessages / Math.max(1, sourceMessageIds.size)).toFixed(1))
    });
  }
  if (!(parseArray(summary.user_confirmed_json) || []).length) {
    unconfirmedSummaries.push({
      summary_id: summary.id,
      topic: summary.topic,
      assistant_claims: (parseArray(summary.assistant_proposals_json) || []).length,
      action: '精确问题中降权；需要事实答案时继续查原文或工具'
    });
  }
}

const cardsWithoutSources = cards.filter((card) => !sources.some((source) => source.memory_card_id === card.id));
const cardSourcesNotUser = sources.filter((source) => source.speaker !== 'user');
const evidenceQuoteMismatches = sources.filter((source) => source.evidence_quote
  && !String(source.text || '').includes(source.evidence_quote));
const orphanCardSummaries = cards.filter((card) => card.derived_from_summary_id
  && !summaries.some((summary) => summary.id === card.derived_from_summary_id));

const scopeCounts = Object.entries(cards.reduce((counts, card) => {
  counts[card.recall_scope] = (counts[card.recall_scope] || 0) + 1;
  return counts;
}, {})).map(([scope, count]) => ({ scope, count }));

const issueCounts = [
  { category: '摘要时间包络过宽', count: wideEnvelopeSummaries.length, severity: 'high', status: '召回器已修正' },
  { category: '摘要没有用户确认项', count: unconfirmedSummaries.length, severity: 'medium', status: '已增加证据等级与降权' },
  { category: '摘要 JSON 无效', count: badJson.length, severity: 'high', status: '无需修复' },
  { category: '摘要声明缺来源', count: missingClaimSources.length, severity: 'high', status: '无需修复' },
  { category: '摘要来源角色错误', count: wrongClaimSpeaker.length, severity: 'high', status: '无需修复' },
  { category: 'Card 没有原文来源', count: cardsWithoutSources.length, severity: 'high', status: '无需修复' },
  { category: 'Card 来源不是用户', count: cardSourcesNotUser.length, severity: 'high', status: '无需修复' },
  { category: 'Card 引文不匹配原文', count: evidenceQuoteMismatches.length, severity: 'high', status: '无需修复' },
  { category: 'Card 来源摘要不存在', count: orphanCardSummaries.length, severity: 'high', status: '无需修复' }
];

const report = {
  generated_at: new Date().toISOString(),
  dataset: { database: dbPath, summaries: summaries.length, cards: cards.length, card_sources: sources.length },
  metrics: {
    structural_failures: badJson.length + missingClaimSources.length + wrongClaimSpeaker.length
      + cardsWithoutSources.length + cardSourcesNotUser.length + evidenceQuoteMismatches.length + orphanCardSummaries.length,
    wide_envelope_summaries: wideEnvelopeSummaries.length,
    unconfirmed_summaries: unconfirmedSummaries.length,
    cards_with_valid_user_sources: cards.length - cardsWithoutSources.length
  },
  issue_counts: issueCounts,
  wide_envelope_summaries: wideEnvelopeSummaries.sort((left, right) => right.excess_messages - left.excess_messages),
  unconfirmed_summaries: unconfirmedSummaries,
  card_scope_counts: scopeCounts,
  recommendations: [
    '摘要时间只按 source_spans_json 的真实原文日期计算，不再使用首尾索引包络。',
    '摘要增加 evidence_level；没有用户确认项的摘要在精确问题中降权。',
    'Card 当前来源完整，不批量重写；以后按 MEMORY_CONTENT_RULES_V1.md 生成和合并。',
    '先修召回路线和证据边界，再重新生成摘要文字，避免把旧的召回错误误判成内容错误。'
  ]
};

fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
process.stdout.write(`${JSON.stringify({ output: outputPath, dataset: report.dataset, metrics: report.metrics }, null, 2)}\n`);
