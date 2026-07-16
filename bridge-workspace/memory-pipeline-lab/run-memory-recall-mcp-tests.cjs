const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { createMemoryRecallService } = require('./memory-recall-service.cjs');
const {
  EMPTY_DYNAMIC_BLOCK,
  createMemoryContextWriter
} = require('./memory-context-writer.cjs');

async function testContextWriter() {
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aqi-memory-writer-'));
  const geminiPath = path.join(fixtureDir, 'GEMINI.md');
  const stablePrefix = '# Stable persona\n\nDo not change this text.\n';
  const stableSuffix = '\n\n# Stable footer\nKeep this too.\n';
  fs.writeFileSync(
    geminiPath,
    `${stablePrefix}<!-- MEMORY_CONTEXT_START -->\ninitial evidence\n<!-- MEMORY_CONTEXT_END -->${stableSuffix}`,
    'utf8'
  );

  const writer = createMemoryContextWriter({ geminiPath });
  const oldToken = writer.claim({ sessionId: 'telegram-test', turnId: 'turn-old' });
  const newToken = writer.claim({ sessionId: 'telegram-test', turnId: 'turn-new' });
  const oldResult = await writer.apply(
    oldToken,
    '<!-- MEMORY_CONTEXT_START -->\nold evidence\n<!-- MEMORY_CONTEXT_END -->'
  );
  const newResult = await writer.apply(
    newToken,
    '<!-- MEMORY_CONTEXT_START -->\nnew evidence\n<!-- MEMORY_CONTEXT_END -->'
  );
  const afterWrite = fs.readFileSync(geminiPath, 'utf8');
  const { result: clearResult } = await writer.beginTurn({
    sessionId: 'telegram-test',
    turnId: 'turn-clear'
  });
  const afterClear = fs.readFileSync(geminiPath, 'utf8');

  let invalidBlockRejected = false;
  const invalidToken = writer.claim({ sessionId: 'telegram-test', turnId: 'turn-invalid' });
  try {
    await writer.apply(invalidToken, '<!-- MEMORY_CONTEXT_START -->\nmissing end');
  } catch {
    invalidBlockRejected = true;
  }

  fs.rmSync(fixtureDir, { recursive: true, force: true });
  return {
    old_write_rejected_as_stale: oldResult.stale === true && oldResult.changed === false,
    newest_write_applied: newResult.stale === false && afterWrite.includes('new evidence') && !afterWrite.includes('old evidence'),
    stable_content_preserved: afterWrite.startsWith(stablePrefix)
      && afterWrite.endsWith(stableSuffix)
      && afterClear.startsWith(stablePrefix)
      && afterClear.endsWith(stableSuffix),
    clear_keeps_empty_region: clearResult.cleared === true && afterClear.includes(EMPTY_DYNAMIC_BLOCK) && !afterClear.includes('new evidence'),
    invalid_block_rejected: invalidBlockRejected
  };
}

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
  const ambiguousAfterWrite = await service.recall({
    query: '上次那件事后来怎么样了？',
    original_text: '上次那件事后来怎么样了？',
    turn_id: 'test-ambiguous-after-write'
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
    clarification_cleared_context: ambiguousAfterWrite.status === 'needs_clarification'
      && ambiguousAfterWrite.context_write?.cleared === true,
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
  const writer = await testContextWriter();
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
    stale_write_cannot_overwrite_new_turn: writer.old_write_rejected_as_stale,
    newest_dynamic_context_wins: writer.newest_write_applied,
    stable_gemini_content_is_preserved: writer.stable_content_preserved,
    empty_result_clears_old_context: writer.clear_keeps_empty_region,
    malformed_dynamic_block_is_rejected: writer.invalid_block_rejected,
    clarification_clears_previous_context: service.clarification_cleared_context,
    dynamic_region_consistent: service.latest_status === 'found'
      ? service.has_answer_context && service.wrote_dynamic_region && service.context_has_end_marker
      : !service.has_answer_context
  };
  const report = {
    generated_at: new Date().toISOString(),
    passed: Object.values(checks).every(Boolean),
    checks,
    protocol,
    service,
    writer
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
