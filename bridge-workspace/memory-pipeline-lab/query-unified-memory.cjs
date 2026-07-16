const { createUnifiedMemoryRetriever } = require('./memory-retriever-unified.cjs');

async function main() {
  const query = process.argv.slice(2).join(' ').trim();
  if (!query) throw new Error('请在命令后输入查询内容。');
  const retriever = await createUnifiedMemoryRetriever();
  const result = await retriever.recall(query);
  retriever.close();
  console.log(JSON.stringify({
    query: result.query,
    triggered: result.triggered,
    operation: result.operation,
    temporal: result.temporal,
    event_query: result.event_query || null,
    event_count: result.event_count,
    selection_reason: result.selection_reason,
    durable: result.durable.map((item) => ({
      id: item.id, type: item.type, score: item.score,
      title: item.payload?.title || item.payload?.topic || item.payload?.event_label,
      event_status: item.payload?.event_status || null,
      local_date: item.payload?.local_date || null
    })),
    raw: result.raw.map((item) => ({ id: item.id, date: item.local_date, text: item.text })),
    elapsed_ms: result.elapsed_ms,
    dynamic_block: result.dynamic_block
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
