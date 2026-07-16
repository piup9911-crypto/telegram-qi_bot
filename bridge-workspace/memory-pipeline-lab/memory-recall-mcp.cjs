const { createMemoryRecallService } = require('./memory-recall-service.cjs');

const service = createMemoryRecallService();
let buffer = '';

// Load only the local SQLite/catalog caches when Antigravity starts this MCP.
// This does not call Ollama or load bge-m3; it merely moves the small local
// index cost away from the first user-triggered recall.
setTimeout(() => {
  void service.prepare().then((result) => {
    process.stderr.write(`[aqi-memory] local indexes ready in ${result.elapsed_ms} ms\n`);
  }).catch((error) => {
    process.stderr.write(`[aqi-memory] local index prepare failed: ${error?.message || error}\n`);
  });
}, 0);

function send(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function success(id, result) {
  if (id === undefined || id === null) return;
  send({ jsonrpc: '2.0', id, result });
}

function failure(id, code, message) {
  if (id === undefined || id === null) return;
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

const tools = [
  {
    name: 'memory_recall',
    description: [
      'Read-only search of Aqi Telegram memory. Call this only when the user asks about personal/shared past information that is not already clear in recent context.',
      'Rewrite the request as a self-contained query. If the original says “那个/那件事”, provide topic_anchor only when recent context resolves it; otherwise do not search and ask the user.',
      'Use operation=auto first. Use quote only as a second call when exact wording or stronger raw evidence is needed. Never call more than twice for one user turn.'
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'A self-contained Chinese retrieval query containing the subject, topic and requested answer shape.'
        },
        original_text: {
          type: 'string',
          description: 'The user original wording. Used to reject unresolved vague references.'
        },
        topic_anchor: {
          type: 'string',
          description: 'Concrete topic resolved from recent context, such as “Server酱”. Leave empty if it cannot be resolved.'
        },
        operation: {
          type: 'string',
          enum: ['auto', 'overview', 'process', 'exact', 'quote', 'inventory', 'timeline_aggregate', 'first_occurrence', 'latest_occurrence', 'occurrence_count', 'occurrence_exists', 'commitment', 'history_detail', 'earliest_record', 'mixed'],
          default: 'auto'
        },
        subject: {
          type: 'string',
          enum: ['user', 'assistant_aqi'],
          default: 'user'
        },
        turn_id: {
          type: 'string',
          description: 'Reuse one identifier if making a second recall call for the same user turn.'
        },
        max_chars: {
          type: 'integer',
          minimum: 1200,
          maximum: 9000,
          default: 6000
        }
      },
      required: ['query', 'original_text']
    }
  }
];

async function handle(request) {
  const { id, method } = request || {};
  if (!method || method.startsWith('notifications/')) return;
  try {
    if (method === 'initialize') {
      success(id, {
        protocolVersion: '2024-11-05',
        serverInfo: { name: 'aqi-memory-recall', version: '1.0.0' },
        capabilities: { tools: {} }
      });
      return;
    }
    if (method === 'ping') {
      success(id, {});
      return;
    }
    if (method === 'tools/list') {
      success(id, { tools });
      return;
    }
    if (method === 'tools/call') {
      if (request.params?.name !== 'memory_recall') {
        throw new Error(`Unknown tool: ${request.params?.name || ''}`);
      }
      const result = await service.recall(request.params?.arguments || {});
      success(id, {
        content: [{ type: 'text', text: JSON.stringify(result) }],
        structuredContent: result,
        isError: false
      });
      return;
    }
    if (['resources/list', 'resources/templates/list', 'prompts/list'].includes(method)) {
      const key = method === 'resources/list' ? 'resources'
        : method === 'resources/templates/list' ? 'resourceTemplates' : 'prompts';
      success(id, { [key]: [] });
      return;
    }
    failure(id, -32601, `Method not found: ${method}`);
  } catch (error) {
    failure(id, -32000, error?.message || String(error));
  }
}

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  const lines = buffer.split(/\r?\n/);
  buffer = lines.pop() || '';
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      void handle(JSON.parse(trimmed));
    } catch (error) {
      failure(null, -32700, error?.message || 'Parse error');
    }
  }
});

async function shutdown() {
  try { await service.close(); } catch {}
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
