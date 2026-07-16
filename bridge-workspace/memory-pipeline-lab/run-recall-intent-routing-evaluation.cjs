const fs = require('fs');
const path = require('path');
const { analyzeRecallIntent } = require('./memory-retriever-unified.cjs');

const cases = [
  { id:'history_with_bug', query:'我最近一次说有bug要处理的时间是？', decision:'retrieve', intent:'historical_recall', operation:'latest_occurrence' },
  { id:'history_with_process', query:'我们之前修桥接是什么时候，最后成功了吗？', decision:'retrieve', intent:'historical_recall', operation:'process' },
  { id:'history_with_deploy', query:'上次部署后来顺利了吗？', decision:'retrieve', intent:'historical_recall', operation:'process' },
  { id:'history_external_terms', query:'我们上次查 Gemini 最新消息时说了什么？', decision:'retrieve', intent:'historical_recall' },
  { id:'history_code_quote', query:'找找我之前说代码有问题的原话', decision:'retrieve', intent:'historical_recall', operation:'quote' },
  { id:'history_action_question', query:'能继续处理我们上次没有修完的bug吗？', decision:'retrieve', intent:'historical_context_for_action' },
  { id:'history_action_context', query:'继续处理我们上次没有修完的bug', decision:'tool_only', intent:'current_technical_task' },
  { id:'current_bug', query:'这个bug怎么处理？', decision:'tool_only', intent:'current_technical_task' },
  { id:'current_restart', query:'帮我重启现在的桥接服务', decision:'tool_only', intent:'current_technical_task' },
  { id:'current_file', query:'现在这个配置文件是什么？', decision:'tool_only', intent:'current_technical_task' },
  { id:'external_latest', query:'查一下 Gemini 的最新消息', decision:'tool_only', intent:'external_current_lookup' },
  { id:'external_release', query:'Gemini 3.5 什么时候发布？', decision:'tool_only', intent:'external_current_lookup' },
  { id:'personal_schedule', query:'我通常几点上班？', decision:'retrieve', intent:'historical_recall', operation:'exact' },
  { id:'personal_preference', query:'我以前说过不喜欢什么？', decision:'retrieve', intent:'historical_recall', operation:'inventory' },
  { id:'monthly_overview', query:'上个月我们主要做了什么？', decision:'retrieve', intent:'historical_recall', operation:'overview' },
  { id:'first_event', query:'我们第一次测试通知是哪天？', decision:'retrieve', intent:'historical_recall', operation:'first_occurrence' },
  { id:'event_count', query:'我们总共完成过几次通知测试？', decision:'retrieve', intent:'historical_recall', operation:'occurrence_count' },
  { id:'commitment', query:'我们之前约定一起做什么？', decision:'retrieve', intent:'historical_recall', operation:'commitment' },
  { id:'scoped_subject', query:'妈妈的邮箱是什么？', options:{subject:'mother'}, decision:'retrieve', intent:'historical_recall' },
  { id:'low_signal', query:'嗯嗯', decision:'suppress', intent:'low_signal' },
  { id:'context_followup', query:'那是哪天？', decision:'suppress', intent:'contextual_followup' },
  { id:'plain_statement', query:'我们以前聊过这个', decision:'suppress', intent:'no_answer_requested' },
  { id:'current_context_wins', query:'我们上次修bug是什么时候？', options:{currentContextSufficient:true}, decision:'suppress', intent:'use_recent_context' },
  { id:'force_wins', query:'普通问题', options:{force:true,currentContextSufficient:true}, decision:'retrieve', intent:'forced_recall' }
];

const results = cases.map((test) => {
  const actual = analyzeRecallIntent(test.query,test.options || {});
  const checks = {
    decision:actual.decision === test.decision,
    intent:actual.intent === test.intent,
    operation:test.operation ? actual.operation === test.operation : true
  };
  return { ...test, actual:{decision:actual.decision,intent:actual.intent,operation:actual.operation,reason:actual.reason,next_action:actual.next_action}, checks, passed:Object.values(checks).every(Boolean) };
});
const output = {
  generated_at:new Date().toISOString(), total:results.length,
  passed:results.filter((row)=>row.passed).length, failed:results.filter((row)=>!row.passed).length,
  results
};
const outputPath = path.join(__dirname,'recall-intent-routing-evaluation.json');
fs.writeFileSync(outputPath,JSON.stringify(output,null,2),'utf8');
process.stdout.write(`${JSON.stringify({output:outputPath,total:output.total,passed:output.passed,failed:output.failed,failures:results.filter((row)=>!row.passed)},null,2)}\n`);
if (output.failed) process.exitCode=1;
