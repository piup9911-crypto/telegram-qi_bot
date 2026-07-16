const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
  createUnifiedMemoryRetriever,
  replaceDynamicRegion
} = require('./memory-retriever-unified.cjs');

const DEFAULT_DB_PATH = path.join(__dirname, 'memory-schema-v2-complete.sqlite');
const DEFAULT_GEMINI_MD_PATH = path.join(__dirname, '..', 'GEMINI.md');
const ALLOWED_OPERATIONS = new Set([
  'auto', 'earliest_record', 'first_occurrence', 'latest_occurrence',
  'occurrence_count', 'occurrence_exists', 'commitment', 'quote', 'process',
  'timeline_aggregate', 'overview', 'inventory', 'history_detail', 'exact', 'mixed'
]);
const ALLOWED_SUBJECTS = new Set(['user', 'assistant_aqi']);
const VAGUE_REFERENCE_RE = /(?:上次|之前|以前)?(?:那个|那件事|这个|这件事)|^(?:后来|然后|后面)(?:呢|怎么样|如何)?[？?]?$/u;

function envFlag(name, fallback = false) {
  const value = process.env[name];
  if (value === undefined || value === null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function clip(text, limit) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  return value.length <= limit ? value : `${value.slice(0, Math.max(0, limit - 1))}…`;
}

function validateRequest(input = {}) {
  const query = String(input.query || '').trim();
  if (!query) throw new Error('query is required');
  if (query.length > 800) throw new Error('query must be 800 characters or fewer');

  const operation = String(input.operation || 'auto').trim();
  if (!ALLOWED_OPERATIONS.has(operation)) {
    throw new Error(`unsupported operation: ${operation}`);
  }

  const subject = String(input.subject || 'user').trim();
  if (!ALLOWED_SUBJECTS.has(subject)) {
    throw new Error(`unsupported subject: ${subject}`);
  }

  const topicAnchor = String(input.topic_anchor || '').trim();
  if (topicAnchor.length > 160) throw new Error('topic_anchor must be 160 characters or fewer');
  const originalText = String(input.original_text || query).trim();
  if (originalText.length > 1200) throw new Error('original_text must be 1200 characters or fewer');

  return {
    query,
    operation,
    subject,
    topicAnchor,
    originalText,
    turnId: String(input.turn_id || crypto.randomUUID()).trim(),
    maxChars: Math.max(1200, Math.min(9000, Number(input.max_chars) || 6000))
  };
}

function requiresClarification(request) {
  if (!VAGUE_REFERENCE_RE.test(request.originalText)) return false;
  return !request.topicAnchor;
}

function buildStandaloneQuery(request) {
  if (!request.topicAnchor) return request.query;
  if (request.query.includes(request.topicAnchor)) return request.query;
  return `${request.topicAnchor}；${request.query}`;
}

function summarizeDurable(item) {
  const payload = item.payload || {};
  return {
    id: item.id,
    type: item.type,
    score: item.score,
    title: payload.title || payload.topic || payload.event_label || payload.fact_key || null,
    date: payload.local_date || payload.first_date || payload.valid_at || null,
    evidence_level: payload.evidence_level || null
  };
}

function summarizeRaw(item) {
  return {
    id: item.id,
    date: item.local_date || String(item.timestamp || '').slice(0, 10) || null,
    timestamp: item.timestamp || null,
    speaker: item.speaker || 'user',
    text: clip(item.text, 700),
    evidence_role: item.evidence_role || null
  };
}

function writeDynamicContext(geminiPath, dynamicBlock) {
  const current = fs.existsSync(geminiPath) ? fs.readFileSync(geminiPath, 'utf8') : '';
  const next = replaceDynamicRegion(current, dynamicBlock);
  if (next === current) return { changed: false, path: geminiPath, chars: dynamicBlock.length };
  fs.mkdirSync(path.dirname(geminiPath), { recursive: true });
  const tempPath = `${geminiPath}.memory-recall-${process.pid}-${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, next, 'utf8');
  try {
    fs.renameSync(tempPath, geminiPath);
  } catch (error) {
    try { fs.unlinkSync(tempPath); } catch {}
    throw error;
  }
  return { changed: true, path: geminiPath, chars: dynamicBlock.length };
}

function storageFingerprint(dbPath) {
  return [dbPath, `${dbPath}-wal`]
    .map((filePath) => {
      try {
        const stat = fs.statSync(filePath);
        return `${path.basename(filePath)}:${stat.size}:${stat.mtimeMs}`;
      } catch {
        return `${path.basename(filePath)}:missing`;
      }
    })
    .join('|');
}

function createMemoryRecallService(options = {}) {
  const dbPath = options.dbPath || process.env.AQI_MEMORY_DB_PATH || DEFAULT_DB_PATH;
  const geminiPath = options.geminiPath || process.env.AQI_MEMORY_GEMINI_MD_PATH || DEFAULT_GEMINI_MD_PATH;
  const writeContext = options.writeContext ?? envFlag('AQI_MEMORY_WRITE_CONTEXT', false);
  let retrieverPromise = null;
  let retrieverFingerprint = null;

  async function getRetriever(refreshIfChanged = false) {
    const currentFingerprint = storageFingerprint(dbPath);
    if (retrieverPromise && refreshIfChanged && currentFingerprint !== retrieverFingerprint) {
      const previous = await retrieverPromise;
      previous.close();
      retrieverPromise = null;
    }
    if (!retrieverPromise) {
      retrieverPromise = createUnifiedMemoryRetriever({
        dbPath,
        tracePath: options.tracePath || process.env.AQI_MEMORY_TRACE_PATH || null
      });
      retrieverFingerprint = currentFingerprint;
    }
    return retrieverPromise;
  }

  return {
    async prepare() {
      const startedAt = performance.now();
      const retriever = await getRetriever(true);
      return {
        ready: true,
        elapsed_ms: Number((performance.now() - startedAt).toFixed(1)),
        stats: retriever.stats(),
        embedding_model_loaded: false
      };
    },
    async recall(input = {}) {
      const request = validateRequest(input);
      if (requiresClarification(request)) {
        return {
          status: 'needs_clarification',
          reason: 'vague_reference_without_topic_anchor',
          message: '当前问题包含“那个/那件事”等指代，但没有能唯一定位的主题。请先结合最近上下文确定 topic_anchor；仍不确定就直接向用户追问，不要宽泛搜索历史。',
          query: request.query,
          operation: request.operation,
          context_write: { enabled: writeContext, changed: false }
        };
      }

      const standaloneQuery = buildStandaloneQuery(request);
      const retriever = await getRetriever(true);
      const result = await retriever.recall(standaloneQuery, {
        force: true,
        operation: request.operation,
        subject: request.subject,
        turnId: request.turnId,
        maxChars: request.maxChars,
        timeZone: 'Asia/Shanghai'
      });
      const found = Boolean(result.durable.length || result.raw.length);
      let contextWrite = { enabled: writeContext, changed: false, chars: 0 };
      if (writeContext) {
        contextWrite = {
          enabled: true,
          ...writeDynamicContext(geminiPath, found ? result.dynamic_block : '')
        };
      }

      return {
        status: found ? 'found' : 'no_match',
        reason: result.selection_reason,
        query: request.query,
        standalone_query: standaloneQuery,
        operation: result.operation,
        retrieval_mode: result.retrieval_mode || null,
        fast_path_reason: result.fast_path_reason || null,
        subject: result.subject,
        temporal: result.temporal || null,
        event_count: Number.isInteger(result.event_count) ? result.event_count : null,
        durable: result.durable.map(summarizeDurable),
        raw: result.raw.map(summarizeRaw),
        answer_context: result.dynamic_block || '',
        context_write: contextWrite,
        elapsed_ms: result.elapsed_ms,
        instruction: found
          ? '只依据 answer_context 中的历史证据回答；区分用户原话与旧助手说法，不足之处明确说不确定。'
          : '没有候选通过证据门。不要据此断言事情没有发生；可以缩小问题、换用 quote 模式再查一次，或向用户追问。'
      };
    },
    async close() {
      if (!retrieverPromise) return;
      const retriever = await retrieverPromise;
      retriever.close();
      retrieverPromise = null;
      retrieverFingerprint = null;
    },
    config() {
      return {
        dbPath, geminiPath, writeContext, readOnlyDatabase: true,
        ollamaKeepAlive: process.env.AQI_OLLAMA_KEEP_ALIVE || null
      };
    }
  };
}

module.exports = {
  ALLOWED_OPERATIONS,
  createMemoryRecallService,
  requiresClarification,
  validateRequest,
  writeDynamicContext
};
