const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');
const { applyMigrations } = require('./memory-v1-migrate.cjs');
const { enqueueMemoryBatch } = require('./memory-producer-queue.cjs');
const { claimNextJob, buildProducerRequest, processClaimedJob, markTransientFailure } = require('./memory-producer-worker.cjs');
const { commitProducerOutput } = require('./memory-producer-writer.cjs');

const labDir = __dirname;
const sourceDb = path.join(labDir,'memory-schema-v2-complete.sqlite');
const targetDb = path.join(labDir,'memory-producer-offline.sqlite');
const resultPath = path.join(labDir,'memory-producer-offline-results.json');
const reportPath = path.join(labDir,'memory-producer-offline-report.html');
const now = '2026-07-15T12:00:00.000Z';

function hash(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function assert(condition, name, detail = '') {
  if (!condition) throw new Error(`ASSERTION FAILED: ${name}${detail ? ` - ${detail}` : ''}`);
  checks.push({ name, passed: true, detail });
}
function addConversation(db,id,title) {
  db.prepare(`INSERT INTO conversations(id,source_kind,title,started_at,ended_at,message_count,source_file,boundary_reason,imported_at,timezone_name) VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(id,'test_fixture',title,now,now,0,'synthetic://memory-producer','offline_fixture',now,'Asia/Shanghai');
}
function addMessage(db,conversationId,index,speaker,text,timestamp) {
  const id = `${conversationId}:${index}`;
  db.prepare(`INSERT INTO raw_messages(id,conversation_id,message_index,source_message_index,speaker,text,timestamp,local_date,text_hash,imported_at,memory_review_status) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id,conversationId,index,index,speaker,text,timestamp,timestamp.slice(0,10),hash(text),now,'unreviewed');
  db.prepare('UPDATE conversations SET message_count=message_count+1,ended_at=? WHERE id=?').run(timestamp,conversationId);
  return id;
}
function counts(db) {
  return {
    summaries: Number(db.prepare("SELECT count(*) n FROM event_summaries WHERE conversation_id LIKE 'producer_fixture_%'").get().n),
    cards: Number(db.prepare("SELECT count(*) n FROM memory_cards WHERE memory_key LIKE 'fixture_user.%'").get().n),
    timelines: Number(db.prepare("SELECT count(*) n FROM fact_timelines WHERE fact_key LIKE 'fixture_user.%'").get().n),
    facts: Number(db.prepare("SELECT count(*) n FROM fact_events e JOIN fact_timelines t ON t.id=e.timeline_id WHERE t.fact_key LIKE 'fixture_user.%'").get().n),
    occurrences: Number(db.prepare("SELECT count(*) n FROM event_occurrences WHERE event_key LIKE 'fixture.%'").get().n)
  };
}
function htmlEscape(value) { return String(value).replace(/[&<>]/g,(c)=>({ '&':'&amp;','<':'&lt;','>':'&gt;' }[c])); }

const checks = [];
for (const suffix of ['', '-shm', '-wal']) {
  const file = targetDb + suffix;
  if (fs.existsSync(file)) fs.rmSync(file,{ force: true });
}
fs.copyFileSync(sourceDb,targetDb);
const migration = applyMigrations(targetDb);
const db = new DatabaseSync(targetDb);
db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;');

try {
  addConversation(db,'producer_fixture_valid','虚构成功样本');
  const validIds = [
    addMessage(db,'producer_fixture_valid',1,'user','以后回复请先给结论，再给简短解释。','2026-07-15T08:00:00.000Z'),
    addMessage(db,'producer_fixture_valid',2,'assistant','好的，我会先给结论。','2026-07-15T08:00:03.000Z'),
    addMessage(db,'producer_fixture_valid',3,'user','我现在改成坐地铁通勤了。','2026-07-15T08:01:00.000Z'),
    addMessage(db,'producer_fixture_valid',4,'user','我们刚才完成了测试通知。','2026-07-15T08:02:00.000Z'),
    addMessage(db,'producer_fixture_valid',5,'user','嗯嗯。','2026-07-15T08:03:00.000Z'),
    addMessage(db,'producer_fixture_valid',6,'assistant','好。','2026-07-15T08:03:01.000Z')
  ];
  const queued = enqueueMemoryBatch(db,{ conversationId:'producer_fixture_valid',triggerKind:'manual_test',provider:'fixture',model:'fixture-v1',now });
  assert(queued.created,'成功样本入队');
  assert(queued.messages.map((row)=>row.id).join('|')===validIds.join('|'),'自动批次按原顺序选取未处理消息');
  const claimed = claimNextJob(db,{ owner:'offline-lab',now });
  assert(claimed?.id===queued.job.id,'原子领取正确任务');
  const request = buildProducerRequest(claimed,queued.messages);
  assert(request.transcript.length===6 && request.system.includes('untrusted'),'生成隔离模型请求');

  const validOutput = {
    version:'memory_producer_output_v1',batch_id:claimed.id,segments:[
      { segment_key:'reply_style',source_message_ids:validIds.slice(0,2),topic_key:'reply-style',topic:'回复方式偏好',summary_mode:'detailed',gist:'用户明确希望回复先给结论，再给简短解释；助手表示会遵循。',retrieval_terms:['回复偏好','先给结论','简短解释'],user_goals:[],user_confirmed:[{text:'用户要求先给结论，再给简短解释。',source_message_ids:[validIds[0]]}],assistant_proposals:[{text:'助手表示会先给结论。',source_message_ids:[validIds[1]]}],open_questions:[],disposition:'card',cards:[{candidate_key:'interaction.reply_structure',memory_type:'stable',title:'回复结构偏好',content:'回复时先给结论，再给简短解释。',domain:'interaction',topic:'回复方式',subject_key:'fixture_user',sensitivity:'ordinary',recall_scope:'always',evidence:[{source_message_id:validIds[0],evidence_quote:'以后回复请先给结论，再给简短解释。'}]}],timelines:[],occurrences:[] },
      { segment_key:'commute',source_message_ids:[validIds[2]],topic_key:'commute-mode',topic:'通勤方式变化',summary_mode:'index',gist:'用户表示现在改为乘地铁通勤。',retrieval_terms:['通勤','地铁'],user_goals:[],user_confirmed:[{text:'用户现在乘地铁通勤。',source_message_ids:[validIds[2]]}],assistant_proposals:[],open_questions:[],disposition:'timeline',cards:[],timelines:[{fact_key:'fixture_user.commute_mode',topic:'通勤方式',subject_key:'fixture_user',predicate_key:'commute_mode',domain:'daily_life',sensitivity:'ordinary',recall_scope:'relevant_only',events:[{content:'用户当前改为乘地铁通勤。',value_text:'地铁',source_message_ids:[validIds[2]],evidence_quotes:{[validIds[2]]:'我现在改成坐地铁通勤了。'},currentness:'last_known_state',valid_at:null,valid_at_precision:'unknown',evidence_status:'user_explicit'}]}],occurrences:[] },
      { segment_key:'notification_test',source_message_ids:[validIds[3]],topic_key:'notification-test',topic:'测试通知完成',summary_mode:'index',gist:'用户确认刚才已经完成测试通知。',retrieval_terms:['测试通知','完成'],user_goals:[],user_confirmed:[{text:'测试通知已经完成。',source_message_ids:[validIds[3]]}],assistant_proposals:[],open_questions:[],disposition:'event_only',cards:[],timelines:[],occurrences:[{event_key:'fixture.notification_test',occurrence_key:'fixture.notification_test:2026-07-15',event_label:'测试通知',event_text:'用户确认测试通知已经完成。',aliases:['通知测试'],subject_key:'shared',event_status:'completed',source_message_ids:[validIds[3]],evidence_quotes:{[validIds[3]]:'我们刚才完成了测试通知。'},evidence_status:'user_explicit',confidence:0.99,sensitivity:'ordinary',recall_scope:'relevant_only',occurred_at:null,time_precision:'exact'}] },
      { segment_key:'low_value',source_message_ids:validIds.slice(4,6),topic_key:'ack',topic:'简短确认',summary_mode:'none',gist:'',retrieval_terms:[],user_goals:[],user_confirmed:[],assistant_proposals:[],open_questions:[],disposition:'event_only',cards:[],timelines:[],occurrences:[] }
    ]
  };
  const processed = processClaimedJob(db,claimed,validOutput,{ now,dbPath:targetDb });
  assert(processed.succeeded,'合格输出写入成功');
  const afterFirst = counts(db);
  assert(afterFirst.summaries===3,'按内容切成三个摘要段',JSON.stringify(afterFirst));
  assert(afterFirst.cards===1 && afterFirst.timelines===1 && afterFirst.facts===1 && afterFirst.occurrences===1,'四类持久内容数量正确',JSON.stringify(afterFirst));
  assert(db.prepare('SELECT status FROM memory_processing_jobs WHERE id=?').get(claimed.id).status==='succeeded','任务账本记录成功');
  assert(db.prepare('SELECT count(*) n FROM raw_messages WHERE id IN (?,?) AND memory_review_status=\'raw_only\'').get(validIds[4],validIds[5]).n===2,'低价值内容只留原文');
  const auditRow = db.prepare('SELECT output_json,validation_json,write_result_json,committed_at FROM memory_processing_jobs WHERE id=?').get(claimed.id);
  assert(JSON.parse(auditRow.validation_json).passed && JSON.parse(auditRow.write_result_json).cards.inserted===1 && auditRow.committed_at,'任务审计字段完整');
  assert(Number(db.prepare("SELECT count(*) n FROM memory_search_documents WHERE target_id='card:fixture_user.interaction.reply_structure'").get().n)===1,'词索引自动刷新');

  const secondWrite = commitProducerOutput(db,claimed,validOutput,queued.messages,{ now:'2026-07-15T12:01:00.000Z',dbPath:targetDb });
  const afterSecond = counts(db);
  assert(JSON.stringify(afterFirst)===JSON.stringify(afterSecond),'重复执行不制造重复记忆',JSON.stringify(afterSecond));
  assert(secondWrite.summaries.reused===3 && secondWrite.cards.reused===1 && secondWrite.fact_events.reused===1 && secondWrite.occurrences.reused===1,'幂等写入路径实际命中');

  const updateId = addMessage(db,'producer_fixture_valid',7,'user','我现在不坐地铁了，改为走路通勤。','2026-07-15T08:10:00.000Z');
  const updateQueued = enqueueMemoryBatch(db,{ conversationId:'producer_fixture_valid',messageIds:[updateId],triggerKind:'manual_test',provider:'fixture',now:'2026-07-15T12:01:30.000Z' });
  const updateClaim = claimNextJob(db,{ owner:'offline-lab',now:'2026-07-15T12:01:30.000Z' });
  const updateOutput = {version:'memory_producer_output_v1',batch_id:updateClaim.id,segments:[{segment_key:'commute_update',source_message_ids:[updateId],topic_key:'commute-mode-update',topic:'通勤方式再次变化',summary_mode:'index',gist:'用户明确表示不再坐地铁，当前改为步行通勤。',retrieval_terms:['通勤','走路','地铁'],user_goals:[],user_confirmed:[{text:'用户当前改为步行通勤。',source_message_ids:[updateId]}],assistant_proposals:[],open_questions:[],disposition:'timeline',cards:[],timelines:[{fact_key:'fixture_user.commute_mode',topic:'通勤方式',subject_key:'fixture_user',predicate_key:'commute_mode',domain:'daily_life',sensitivity:'ordinary',recall_scope:'relevant_only',events:[{content:'用户当前改为步行通勤。',value_text:'步行',source_message_ids:[updateId],evidence_quotes:{[updateId]:'我现在不坐地铁了，改为走路通勤。'},currentness:'last_known_state',valid_at:null,valid_at_precision:'unknown',evidence_status:'user_explicit'}]}],occurrences:[]} ]};
  const updated = processClaimedJob(db,updateClaim,updateOutput,{now:'2026-07-15T12:01:31.000Z',dbPath:targetDb});
  assert(updated.succeeded && updated.write_result.fact_events.superseded===1,'新事实把当前指针移到新值');
  const factRows = db.prepare("SELECT e.value_text,e.is_current,e.invalid_at FROM fact_events e JOIN fact_timelines t ON t.id=e.timeline_id WHERE t.fact_key='fixture_user.commute_mode' ORDER BY e.observed_at").all();
  assert(factRows.length===2 && factRows[0].value_text==='地铁' && factRows[0].is_current===0 && factRows[0].invalid_at && factRows[1].value_text==='步行' && factRows[1].is_current===1,'旧事实保留为时间线，新事实成为当前值');

  addConversation(db,'producer_fixture_invalid','虚构错误证据样本');
  const invalidIds = [
    addMessage(db,'producer_fixture_invalid',1,'user','今天我们讨论一下喝茶。','2026-07-15T09:00:00.000Z'),
    addMessage(db,'producer_fixture_invalid',2,'assistant','你以后一定最喜欢红茶。','2026-07-15T09:00:03.000Z')
  ];
  const invalidQueued = enqueueMemoryBatch(db,{ conversationId:'producer_fixture_invalid',triggerKind:'manual_test',provider:'fixture',now:'2026-07-15T12:02:00.000Z' });
  const invalidClaim = claimNextJob(db,{ owner:'offline-lab',now:'2026-07-15T12:02:00.000Z' });
  const invalidOutput = { version:'memory_producer_output_v1',batch_id:invalidClaim.id,segments:[{segment_key:'bad',source_message_ids:invalidIds,topic_key:'tea',topic:'喝茶',summary_mode:'index',gist:'讨论喝茶。',retrieval_terms:['茶'],user_goals:[],user_confirmed:[],assistant_proposals:[{text:'助手猜测用户喜欢红茶。',source_message_ids:[invalidIds[1]]}],open_questions:[],disposition:'card',cards:[{candidate_key:'preference.tea',memory_type:'stable',title:'茶偏好',content:'用户最喜欢红茶。',domain:'preference',topic:'饮品',subject_key:'fixture_user',sensitivity:'ordinary',recall_scope:'relevant_only',evidence:[{source_message_id:invalidIds[1],evidence_quote:'你以后一定最喜欢红茶。'}]}],timelines:[],occurrences:[]} ] };
  const invalidProcessed = processClaimedJob(db,invalidClaim,invalidOutput,{ now:'2026-07-15T12:02:01.000Z',dbPath:targetDb });
  assert(!invalidProcessed.succeeded && invalidProcessed.stage==='validation','助手猜测被证据规则拦截');
  assert(db.prepare('SELECT status FROM memory_processing_jobs WHERE id=?').get(invalidClaim.id).status==='failed','错误输出进入失败态且不写入');
  assert(Number(db.prepare("SELECT count(*) n FROM memory_cards WHERE memory_key='fixture_user.preference.tea'").get().n)===0,'幻觉 Card 未进入数据库');

  addConversation(db,'producer_fixture_retry','虚构重试样本');
  const retryIds = [addMessage(db,'producer_fixture_retry',1,'user','请记住这是重试测试。','2026-07-15T10:00:00.000Z')];
  const retryQueued = enqueueMemoryBatch(db,{ conversationId:'producer_fixture_retry',triggerKind:'manual_test',provider:'fixture',now:'2026-07-15T12:03:00.000Z' });
  const retryClaim = claimNextJob(db,{ owner:'offline-lab',now:'2026-07-15T12:03:00.000Z' });
  const retry = markTransientFailure(db,retryClaim.id,'provider_timeout','synthetic timeout',{ now:'2026-07-15T12:03:01.000Z',delayMs:60000 });
  assert(retry.status==='retry_wait' && retry.next_attempt_at==='2026-07-15T12:04:01.000Z','临时错误自动等待重试');
  const extraId = addMessage(db,'producer_fixture_retry',2,'user','这是另一批输入。','2026-07-15T10:01:00.000Z');
  const blocked = enqueueMemoryBatch(db,{ conversationId:'producer_fixture_retry',messageIds:[extraId],triggerKind:'manual_test',provider:'fixture',now:'2026-07-15T12:03:02.000Z' });
  assert(!blocked.created && blocked.reason==='active_job_exists','同会话同类任务不并发');

  const finalCounts = counts(db);
  const result = {
    generated_at:new Date().toISOString(), database:targetDb, source_database_unchanged:sourceDb,
    migration, passed:true, checks, valid_job:{ id:claimed.id, validation:processed.validation, write_result:processed.write_result },
    invalid_job:{ id:invalidClaim.id, validation:invalidProcessed.validation }, retry_job:{ id:retryClaim.id, retry },
    idempotent_second_write:secondWrite, final_fixture_counts:finalCounts
  };
  fs.writeFileSync(resultPath,JSON.stringify(result,null,2),'utf8');
  fs.writeFileSync(reportPath,`<!doctype html><meta charset="utf-8"><title>自动记忆生产器离线验收</title><style>body{font:16px/1.65 system-ui;max-width:980px;margin:40px auto;padding:0 24px;color:#222}h1{margin-bottom:8px}.ok{color:#087a3e}table{border-collapse:collapse;width:100%}td,th{border:1px solid #ddd;padding:8px;text-align:left}code{background:#f4f4f4;padding:2px 5px}</style><h1>自动记忆生产器离线验收</h1><p class="ok"><b>全部通过：${checks.length}/${checks.length}</b></p><p>使用虚构对话；没有调用外部模型，也没有修改主数据库。</p><table><tr><th>检查</th><th>结果</th><th>说明</th></tr>${checks.map(c=>`<tr><td>${htmlEscape(c.name)}</td><td class="ok">通过</td><td>${htmlEscape(c.detail)}</td></tr>`).join('')}</table><h2>最终生成</h2><pre>${htmlEscape(JSON.stringify(finalCounts,null,2))}</pre><h2>保护行为</h2><ul><li>助手猜测冒充用户偏好：拦截，不写 Card</li><li>重复执行：复用原记录，不重复生成</li><li>模拟超时：进入 retry_wait，同类任务不并发</li></ul>`,'utf8');
  process.stdout.write(`${JSON.stringify({ passed:true,checks:checks.length,resultPath,reportPath,targetDb,finalCounts },null,2)}\n`);
} finally {
  db.close();
}
