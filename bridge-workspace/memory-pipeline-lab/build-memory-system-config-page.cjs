const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const config = require('./memory-system-config.json');

const labDir = __dirname;
const outputPath = path.join(labDir,'memory-system-config.html');
const dbPath = path.join(labDir,'memory-schema-v2-complete.sqlite');
const recallResultPath = path.join(labDir,'unified-memory-recall-evaluation.json');
const producerResultPath = path.join(labDir,'memory-producer-offline-results.json');
const routingResultPath = path.join(labDir,'recall-intent-routing-evaluation.json');

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g,(character)=>({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  })[character]);
}
function readJson(file,fallback={}) { try { return JSON.parse(fs.readFileSync(file,'utf8')); } catch { return fallback; } }
function getCounts() {
  const db = new DatabaseSync(dbPath,{ readOnly:true });
  const count = (table) => Number(db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n);
  const result = {
    schema_version:Number(db.prepare('PRAGMA user_version').get().user_version),
    raw_messages:count('raw_messages'), event_summaries:count('event_summaries'),
    memory_cards:count('memory_cards'), fact_timelines:count('fact_timelines'),
    fact_events:count('fact_events'), event_occurrences:count('event_occurrences'),
    word_documents:count('memory_search_documents')
  };
  db.close();
  return result;
}
function statusLabel(value) { return value ? ['已开启','on'] : ['未开启','off']; }
function operationLimits(key,value) {
  const omit = new Set(['label','primary_layer','min_base','min_semantic','max_drop','max_drop_from_top','ambiguity_gap']);
  return Object.entries(value).filter(([name])=>!omit.has(name)).map(([name,amount])=>{
    const labels = {
      date_summary_limit:'单日摘要',period_summary_limit:'月份摘要',candidate_limit:'初选候选',summary_limit:'最终摘要',
      source_raw_limit:'来源原文',durable_limit:'结构记忆',evidence_raw_limit:'证据原文',raw_limit:'原文',card_limit:'Card',
      per_day_limit:'每天原文',day_limit:'最多天数',event_limit:'事件',goal_limit:'目标',per_summary_limit:'每段目标',
      durable_min_base:'结构最低总分',durable_min_semantic:'结构最低语义',raw_min_base:'原文最低总分',raw_min_semantic:'原文最低语义'
    };
    return `${labels[name] || name}：${amount}`;
  }).join('；');
}

const counts = getCounts();
const recallResult = readJson(recallResultPath);
const producerResult = readJson(producerResultPath);
const routingResult = readJson(routingResultPath);
const recallMetrics = recallResult.metrics || {};
const runtimeLabels = {
  recall_connected_to_sidecar:'桥接每轮预先召回',
  memory_recall_mcp_configured:'MCP 召回工具已配置',
  memory_recall_mcp_protocol_verified:'MCP 协议已验证',
  memory_recall_live_model_verified:'真实 Gem 调用已验证',
  memory_recall_lexical_fast_path_enabled:'词语快速召回',
  memory_recall_vector_fallback_enabled:'向量召回兜底',
  bridge_sqlite_raw_ingest_enabled:'正式 SQLite 原文写入',
  producer_queue_connected_to_bridge:'后台任务入队',
  producer_connected_to_sidecar:'后台 worker 调度',
  external_producer_model_enabled:'后台整理模型',
  dynamic_gemini_md_write_enabled:'桥接主动写动态区',
  memory_tool_dynamic_write_configured:'召回工具覆盖动态区',
  legacy_lmc_recall_enabled:'旧 LMC 召回',
  legacy_lmc_write_enabled:'旧 LMC 写入',
  legacy_shared_memory_sync_enabled:'旧共享 Markdown 同步',
  local_bge_m3_enabled:'本机 bge-m3 向量',
  jieba_word_index_enabled:'Jieba 中文词索引'
};
const operations = Object.entries(config.recall.operations);
const weights = config.recall.ranking_weights;

const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>阿祈记忆系统配置总览</title>
<style>
:root{--ink:#1f2633;--muted:#667085;--line:#dce3ec;--paper:#fbfcfe;--card:#fff;--blue:#4f6bed;--teal:#149a8a;--amber:#b26a00;--red:#b42318;--green:#087a52}
*{box-sizing:border-box}body{margin:0;background:linear-gradient(145deg,#eef3ff 0,#f8fafc 42%,#effaf7 100%);color:var(--ink);font:15px/1.65 system-ui,"Microsoft YaHei",sans-serif}
main{max-width:1180px;margin:0 auto;padding:38px 22px 70px}.hero{background:rgba(255,255,255,.9);border:1px solid rgba(255,255,255,.8);box-shadow:0 18px 50px rgba(45,61,98,.10);border-radius:24px;padding:28px 30px;margin-bottom:20px}.eyebrow{font-size:12px;letter-spacing:.12em;color:var(--blue);font-weight:800}.hero h1{font-size:clamp(28px,5vw,46px);line-height:1.15;margin:8px 0 12px}.hero p{color:var(--muted);max-width:820px;margin:0}.notice{margin-top:18px;border-left:4px solid var(--amber);background:#fff8e8;padding:11px 14px;border-radius:8px;color:#744600}.grid{display:grid;grid-template-columns:repeat(12,1fr);gap:18px}.panel{grid-column:span 12;background:var(--card);border:1px solid var(--line);border-radius:18px;padding:22px;box-shadow:0 8px 28px rgba(45,61,98,.06)}.half{grid-column:span 6}.third{grid-column:span 4}h2{font-size:20px;margin:0 0 15px}h3{font-size:15px;margin:0 0 8px}.sub{color:var(--muted);font-size:13px}.status-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.status{display:flex;justify-content:space-between;align-items:center;border:1px solid var(--line);padding:10px 12px;border-radius:12px}.pill{font-size:12px;font-weight:800;padding:3px 9px;border-radius:999px}.pill.on{background:#e8f8f2;color:var(--green)}.pill.off{background:#fff1ef;color:var(--red)}.flow{display:grid;grid-template-columns:repeat(6,1fr);gap:8px;align-items:stretch}.step{background:var(--paper);border:1px solid var(--line);border-radius:12px;padding:12px 10px;text-align:center;font-weight:650}.step small{display:block;color:var(--muted);font-weight:400}.arrow{display:none}.metric{font-size:30px;font-weight:800;line-height:1.1}.metric-label{color:var(--muted);font-size:13px}.metric-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:14px}.metric-box{padding:15px;background:var(--paper);border:1px solid var(--line);border-radius:13px}table{width:100%;border-collapse:separate;border-spacing:0;font-size:14px}th{text-align:left;color:#475467;background:#f5f7fb;border-top:1px solid var(--line)}th,td{padding:11px 12px;border-right:1px solid var(--line);border-bottom:1px solid var(--line);vertical-align:top}th:first-child,td:first-child{border-left:1px solid var(--line)}tr:first-child th:first-child{border-top-left-radius:10px}tr:first-child th:last-child{border-top-right-radius:10px}tbody tr:hover{background:#fbfcff}.mono{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12px}.bar-row{display:grid;grid-template-columns:105px 1fr 45px;gap:10px;align-items:center;margin:10px 0}.bar{height:11px;background:#edf0f5;border-radius:99px;overflow:hidden}.bar i{display:block;height:100%;background:linear-gradient(90deg,var(--blue),var(--teal));border-radius:99px}.key-list{display:grid;grid-template-columns:1fr 1fr;gap:9px}.key{background:var(--paper);border:1px solid var(--line);border-radius:11px;padding:10px 12px}.key b{display:block}.links a{color:var(--blue);text-decoration:none;margin-right:16px}.links a:hover{text-decoration:underline}details{margin-top:12px}summary{cursor:pointer;color:var(--blue);font-weight:700}pre{overflow:auto;background:#111827;color:#d1e1ff;padding:16px;border-radius:12px;font-size:12px;max-height:480px}
@media(max-width:820px){.half,.third{grid-column:span 12}.flow{grid-template-columns:repeat(2,1fr)}.status-grid,.key-list{grid-template-columns:1fr}.metric-grid{grid-template-columns:1fr 1fr}.panel{overflow:auto}}
</style></head><body><main>
<section class="hero"><div class="eyebrow">MEMORY SYSTEM · READ-ONLY CONTROL VIEW</div><h1>阿祈记忆系统配置总览</h1><p>这里展示的是代码当前真正读取的统一配置，不是另一份手写说明。修改 <span class="mono">memory-system-config.json</span> 后，生产批次和召回器会使用同一组数值。</p><div class="notice"><b>当前是已接线、未完全实聊验证：</b>正式 SQLite 原文写入和任务入队已启用；MCP 协议已验证，但真实 Gem 自主调用仍待验证；后台 worker 与外部整理模型保持关闭。</div></section>

<div class="grid">
<section class="panel"><h2>一轮记忆召回怎么走</h2><div class="flow">
${[['1','看当前上下文'],['2','召回门控'],['3','识别问题类型'],['4','三路并行检索'],['5','证据与隐私过滤'],['6','生成动态参考区']].map(([n,t])=>`<div class="step"><small>STEP ${n}</small>${t}</div>`).join('')}
</div></section>

<section class="panel half"><h2>运行开关</h2><div class="status-grid">${Object.entries(config.runtime_status).map(([key,value])=>{const [label,state]=statusLabel(value);return `<div class="status"><span>${esc(runtimeLabels[key]||key)}</span><span class="pill ${state}">${label}</span></div>`}).join('')}</div></section>
<section class="panel half"><h2>目前的数据量</h2><div class="metric-grid">
${[['原始消息',counts.raw_messages],['摘要',counts.event_summaries],['Card',counts.memory_cards],['事实线',counts.fact_timelines],['事实事件',counts.fact_events],['事件目录',counts.event_occurrences]].map(([label,value])=>`<div class="metric-box"><div class="metric">${value}</div><div class="metric-label">${label}</div></div>`).join('')}
</div><p class="sub">文字检索文档 ${counts.word_documents} 条；主实验库 schema v${counts.schema_version}。</p></section>

<section class="panel third"><h2>后台整理批次</h2><div class="key-list">
<div class="key"><b>${config.producer.batch_max_messages} 条</b><span class="sub">单批最多消息</span></div><div class="key"><b>${config.producer.batch_max_chars} 字</b><span class="sub">单批最多字符</span></div>
<div class="key"><b>${config.producer.max_attempts} 次</b><span class="sub">最多尝试</span></div><div class="key"><b>${config.producer.lease_ms/60000} 分钟</b><span class="sub">任务租约</span></div></div><p class="sub">分段依据：聊天内容和对话目的。固定时间窗：关闭。</p></section>
<section class="panel third"><h2>动态参考区</h2><div class="metric">${config.recall.dynamic_block_default_max_chars}</div><div class="metric-label">默认最大字符</div><p>一轮最多拆成 <b>${config.recall.max_compound_questions}</b> 个历史子问题；默认排除最近 <b>${config.recall.exclude_recent_context_minutes}</b> 分钟原文，避免把当前上下文再次召回。</p></section>
<section class="panel third"><h2>最近验证</h2><div class="metric">${recallMetrics.passed||0}/${recallMetrics.total||0}</div><div class="metric-label">统一召回回归</div><p>意图路由 <b>${routingResult.passed||0}/${routingResult.total||0}</b>；自动生产器 <b>${producerResult.checks?.length||0}</b> 项离线检查通过。</p></section>

<section class="panel half"><h2>综合相关度配比</h2>${Object.entries(weights).map(([key,value])=>`<div class="bar-row"><span>${esc({semantic:'向量语义',rrf:'多路排名',lexical:'普通词面',evidence_coverage:'查询词证据'}[key]||key)}</span><div class="bar"><i style="width:${value*100}%"></i></div><b>${Math.round(value*100)}%</b></div>`).join('')}<p class="sub">相关度只是初排，之后还要经过人物、时间、隐私范围、事件状态和原文证据过滤。</p></section>
<section class="panel half"><h2>事件与隐私门槛</h2><div class="key-list">
<div class="key"><b>${config.recall.event_gate.confidence_min}</b><span class="sub">事件最低证据置信度</span></div><div class="key"><b>${config.recall.event_gate.semantic_min}</b><span class="sub">事件最低语义相关</span></div>
<div class="key"><b>${config.recall.explicit_only_gate.semantic_min}</b><span class="sub">敏感内容语义门槛</span></div><div class="key"><b>${config.recall.explicit_only_gate.lexical_min}</b><span class="sub">敏感内容词面门槛</span></div></div><p class="sub">敏感内容还必须明确问到对应人物，达到分数也不代表可以自动召回。</p></section>

<section class="panel"><h2>召回门控现在怎样判断</h2><table><thead><tr><th>结果</th><th>典型情况</th><th>接下来做什么</th></tr></thead><tbody>
<tr><td><span class="pill off">不召回</span><div class="mono sub">suppress</div></td><td>当前窗口已经够用；“嗯嗯、好、抱抱”等低信息输入；没有过去或个人记忆意图</td><td>清空旧动态区，直接使用当前上下文</td></tr>
<tr><td><span class="pill on">召回</span><div class="mono sub">retrieve</div></td><td>过去日期、个人事实、偏好边界、历史过程、原话、约定、首次、最近、次数或是否发生</td><td>识别问题类型，再选择摘要、Card、事实线、事件或原文</td></tr>
<tr><td><span class="pill" style="background:#eef2ff;color:#3448a4">使用工具</span><div class="mono sub">tool_only</div></td><td>当前代码、系统、文件、网页、公开资料等问题，而且不是询问历史处理过程</td><td>查实时工具或本地文件，不拿个人记忆代替当前事实</td></tr>
</tbody></table><h3 style="margin-top:18px">意图冲突优先级</h3><div class="flow" style="grid-template-columns:repeat(5,1fr)">${config.recall.intent_priority.map((key,index)=>`<div class="step"><small>${index+1}</small>${esc({forced_recall:'调用方强制',recent_context_sufficient:'当前上下文足够',low_signal:'低信息',contextual_followup:'依赖本轮追问',current_deadline:'当前期限',historical_intent:'历史记忆意图',external_current_lookup:'外部当前资料',current_technical_task:'当前技术任务',no_answer_requested:'没有要求回答',no_memory_intent:'无记忆意图'}[key]||key)}</div>`).join('')}</div><p class="sub"><b>历史记忆意图排在技术主题之前：</b>“最近一次说有 bug”会召回历史；“这个 bug 怎么修”才走当前工具。代码保留了强制召回入口，但“模型回答到一半自己决定查记忆”还没有接进 sidecar。</p></section>

<section class="panel"><h2>各类问题当前实际数量</h2><table><thead><tr><th>问题类型</th><th>优先层</th><th>实际数量和范围</th><th>主要门槛</th></tr></thead><tbody>
${operations.map(([key,value])=>`<tr><td><b>${esc(value.label)}</b><div class="sub mono">${esc(key)}</div></td><td>${esc(value.primary_layer)}</td><td>${esc(operationLimits(key,value))}</td><td>${value.min_base!==undefined?`总分 ≥ ${value.min_base}`:''}${value.min_semantic!==undefined?`${value.min_base!==undefined?'；':''}语义 ≥ ${value.min_semantic}`:''}</td></tr>`).join('')}
</tbody></table></section>

<section class="panel"><h2>自动写入保护</h2><div class="key-list">
${['模型只能给候选，不能直接写 SQLite','Card 与用户事实必须引用用户原话','引用必须是原消息中的逐字片段','敏感内容只能 explicit_only','重复批次和重复事实不会复制','旧事实保留，新事实移动当前指针','临时超时自动退避重试','同会话同类任务禁止并发'].map(text=>`<div class="key">✓ ${esc(text)}</div>`).join('')}
</div></section>

<section class="panel links"><h2>文件和报告</h2><p><a href="memory-producer-offline-report.html">自动生产器验收报告</a><a href="unified-memory-recall-evaluation.html">统一召回回归报告</a><a href="MEMORY_PRODUCER_V1.md">自动写入规则</a><a href="UNIFIED_RECALL_SPEC.md">召回规则</a></p><details><summary>查看完整机器配置 JSON</summary><pre>${esc(JSON.stringify(config,null,2))}</pre></details></section>
</div></main></body></html>`;

fs.writeFileSync(outputPath,html,'utf8');
process.stdout.write(`${JSON.stringify({output:outputPath,config_version:config.version,operations:operations.length,counts,recall_metrics:recallMetrics,routing_metrics:{passed:routingResult.passed||0,total:routingResult.total||0},producer_checks:producerResult.checks?.length||0},null,2)}\n`);
