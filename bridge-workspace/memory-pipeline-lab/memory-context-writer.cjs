const fs = require('fs');
const path = require('path');

const START_MARKER = '<!-- MEMORY_CONTEXT_START -->';
const END_MARKER = '<!-- MEMORY_CONTEXT_END -->';
const EMPTY_DYNAMIC_BLOCK = `${START_MARKER}\n${END_MARKER}`;

function countOccurrences(text, needle) {
  let count = 0;
  let cursor = 0;
  while (true) {
    const index = text.indexOf(needle, cursor);
    if (index === -1) return count;
    count += 1;
    cursor = index + needle.length;
  }
}

function normalizeDynamicBlock(dynamicBlock) {
  const block = String(dynamicBlock || '').trim();
  if (!block) return EMPTY_DYNAMIC_BLOCK;

  const startCount = countOccurrences(block, START_MARKER);
  const endCount = countOccurrences(block, END_MARKER);
  if (startCount !== 1 || endCount !== 1) {
    throw new Error('dynamic memory block must contain exactly one start marker and one end marker');
  }
  if (block.indexOf(START_MARKER) > block.indexOf(END_MARKER)) {
    throw new Error('dynamic memory block end marker appears before start marker');
  }
  return block;
}

function replaceDynamicRegionPreservingDocument(documentText, dynamicBlock) {
  const document = String(documentText || '');
  const startCount = countOccurrences(document, START_MARKER);
  const endCount = countOccurrences(document, END_MARKER);
  if (startCount === 0 && endCount === 0) {
    if (!document) return `${dynamicBlock}\n`;
    const separator = document.endsWith('\n') ? '\n' : '\n\n';
    return `${document}${separator}${dynamicBlock}\n`;
  }
  if (startCount !== 1 || endCount !== 1) {
    throw new Error('GEMINI.md must contain either no dynamic markers or exactly one marker pair');
  }

  const start = document.indexOf(START_MARKER);
  const end = document.indexOf(END_MARKER);
  if (end < start) throw new Error('GEMINI.md dynamic region end marker appears before start marker');
  const after = end + END_MARKER.length;
  return `${document.slice(0, start)}${dynamicBlock}${document.slice(after)}`;
}

function atomicWriteDynamicContext(geminiPath, dynamicBlock) {
  const normalizedBlock = normalizeDynamicBlock(dynamicBlock);
  const current = fs.existsSync(geminiPath) ? fs.readFileSync(geminiPath, 'utf8') : '';
  const next = replaceDynamicRegionPreservingDocument(current, normalizedBlock);
  if (next === current) {
    return {
      changed: false,
      cleared: normalizedBlock === EMPTY_DYNAMIC_BLOCK,
      path: geminiPath,
      chars: normalizedBlock.length
    };
  }

  fs.mkdirSync(path.dirname(geminiPath), { recursive: true });
  const tempPath = `${geminiPath}.memory-context-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`;
  fs.writeFileSync(tempPath, next, 'utf8');
  try {
    fs.renameSync(tempPath, geminiPath);
  } catch (error) {
    try { fs.unlinkSync(tempPath); } catch {}
    throw error;
  }
  return {
    changed: true,
    cleared: normalizedBlock === EMPTY_DYNAMIC_BLOCK,
    path: geminiPath,
    chars: normalizedBlock.length
  };
}

function createMemoryContextWriter(options = {}) {
  const geminiPath = options.geminiPath;
  if (!geminiPath) throw new Error('geminiPath is required');

  const latestRevisionBySession = new Map();
  let revisionCounter = 0;
  let writeQueue = Promise.resolve();

  function claim(input = {}) {
    const sessionId = String(input.sessionId || 'telegram-main').trim() || 'telegram-main';
    const turnId = String(input.turnId || '').trim();
    if (!turnId) throw new Error('turnId is required');
    if (sessionId.length > 160) throw new Error('sessionId must be 160 characters or fewer');
    if (turnId.length > 200) throw new Error('turnId must be 200 characters or fewer');

    const token = {
      sessionId,
      turnId,
      revision: ++revisionCounter
    };
    latestRevisionBySession.set(sessionId, token);
    return token;
  }

  function isCurrent(token) {
    const latest = latestRevisionBySession.get(token.sessionId);
    return Boolean(latest && latest.revision === token.revision && latest.turnId === token.turnId);
  }

  function enqueue(task) {
    const run = writeQueue.then(task, task);
    writeQueue = run.catch(() => {});
    return run;
  }

  async function apply(token, dynamicBlock) {
    return enqueue(() => {
      if (!isCurrent(token)) {
        return {
          changed: false,
          stale: true,
          cleared: false,
          path: geminiPath,
          chars: 0,
          session_id: token.sessionId,
          turn_id: token.turnId,
          revision: token.revision
        };
      }
      return {
        ...atomicWriteDynamicContext(geminiPath, dynamicBlock),
        stale: false,
        session_id: token.sessionId,
        turn_id: token.turnId,
        revision: token.revision
      };
    });
  }

  async function beginTurn(input = {}) {
    const token = claim(input);
    const result = await apply(token, '');
    return { token, result };
  }

  return {
    claim,
    apply,
    beginTurn,
    clear(token) {
      return apply(token, '');
    },
    isCurrent,
    async idle() {
      await writeQueue;
    }
  };
}

module.exports = {
  EMPTY_DYNAMIC_BLOCK,
  END_MARKER,
  START_MARKER,
  atomicWriteDynamicContext,
  createMemoryContextWriter,
  normalizeDynamicBlock,
  replaceDynamicRegionPreservingDocument
};
