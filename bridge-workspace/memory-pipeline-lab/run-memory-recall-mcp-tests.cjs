const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { createMemoryRecallService } = require('./memory-recall-service.cjs');

async function testService() {
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aqi-memory-recall-'));
  const geminiPath = path.join(fixtureDir, 'GEMINI.md');
  fs.writeFileSync(geminiPath, '# Persona\n', 'utf8');
  const service = createMemoryRecallService({ geminiPath, writeContext: true });
  const prepared = await service.prepare();
  const ambiguous = await service.recall({
    query: '上次那件事，你现在不会还在想吧？',
    original_text: '上次那件事，你现在不会还在想吧？'
  });
  const latest = await service.recall({
    query: '用户最近一次表示饿了是什么时候',
    original_text: '我最近一次说饿了是什么时候？',
    operation: 'latest_occurrence',
    subject: 'user',
    turn_id: 'test-latest-hungry'
  });
  const quote = await service.recall({
    query: '用户最近一次表示饿了时的原话',
    original_text: '我最近一次说饿了的原话是什么？',
    operation: 'quote',
    subject: 'user',
    turn_id: 'test-latest-hungry'
  });
  const written = fs.readFileSync(geminiPath, 'utf8');
  await service.close();
  fs.rmSync(fixtureDir, { recursive: true, force: true });
  return {
    ambiguous_status: ambiguous.status,
    prepared,
    latest_status: latest.status,
    latest_operation: latest.operation,
    latest_retrieval_mode: latest.retrieval_mode,
    has_answer_context: Boolean(latest.answer_context),
    quote_status: quote.status,
    quote_operation: quote.operation,
    quote_retrieval_mode: quote.retrieval_mode,
    quote_raw_count: quote.raw.length,
    wrote_dynamic_region: written.includes('<!-- MEMORY_CONTEXT_START -->'),
    context_has_end_marker: written.includes('<!-- MEMORY_CONTEXT_END -->')
  };
}

function testMcpProtocol() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, 'memory-recall-mcp.cjs')], {
      cwd: path.join(__dirname, '..'),
      env: { ...process.env, AQI_MEMORY_WRITE_CONTEXT: '0' },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`MCP protocol test timed out: ${stderr}`));
    }, 10000);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      const lines = stdout.split(/\r?\n/).filter(Boolean);
      const responses = lines.map((line) => JSON.parse(line));
      if (responses.some((item) => item.id === 3)) {
        clearTimeout(timer);
        child.kill();
        const initialize = responses.find((item) => item.id === 1);
        const list = responses.find((item) => item.id === 2);
        const call = responses.find((item) => item.id === 3);
        resolve({
          initialized: initialize?.result?.serverInfo?.name === 'aqi-memory-recall',
          tool_count: list?.result?.tools?.length || 0,
          tool_name: list?.result?.tools?.[0]?.name || null,
          vague_call_status: call?.result?.structuredContent?.status || null
        });
      }
    });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })}\n`);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })}\n`);
    child.stdin.write(`${JSON.stringify({
      jsonrpc: '2.0', id: 3, method: 'tools/call',
      params: {
        name: 'memory_recall',
        arguments: {
          query: '上次那件事，你现在不会还在想吧？',
          original_text: '上次那件事，你现在不会还在想吧？'
        }
      }
    })}\n`);
  });
}

async function main() {
  const protocol = await testMcpProtocol();
  const service = await testService();
  const workspaceMcp = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '.agents', 'mcp_config.json'), 'utf8'));
  const checks = {
    protocol_initialized: protocol.initialized,
    memory_recall_exposed: protocol.tool_count === 1 && protocol.tool_name === 'memory_recall',
    mcp_call_returns_structured_result: protocol.vague_call_status === 'needs_clarification',
    vague_reference_rejected: service.ambiguous_status === 'needs_clarification',
    local_indexes_prepare_without_embedding_model: service.prepared.ready && service.prepared.embedding_model_loaded === false,
    explicit_operation_honored: service.latest_operation === 'latest_occurrence',
    strong_keyword_uses_lexical_fast_path: service.latest_retrieval_mode === 'lexical_fast',
    recall_completed: ['found', 'no_match'].includes(service.latest_status),
    raw_fallback_operation_honored: service.quote_operation === 'quote',
    raw_fallback_completed: ['found', 'no_match'].includes(service.quote_status),
    ambiguous_raw_query_can_fall_back_to_vector: service.quote_retrieval_mode === 'hybrid_vector',
    ollama_keep_alive_is_ten_minutes: workspaceMcp.mcpServers?.['aqi-memory']?.env?.AQI_OLLAMA_KEEP_ALIVE === '10m',
    dynamic_region_consistent: service.latest_status === 'found'
      ? service.has_answer_context && service.wrote_dynamic_region && service.context_has_end_marker
      : !service.has_answer_context
  };
  const report = {
    generated_at: new Date().toISOString(),
    passed: Object.values(checks).every(Boolean),
    checks,
    protocol,
    service
  };
  const outputPath = path.join(__dirname, 'memory-recall-mcp-test-results.json');
  fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify(report, null, 2));
  if (!report.passed) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
