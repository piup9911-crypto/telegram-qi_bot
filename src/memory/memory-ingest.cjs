// Legacy entry point retained for process/test compatibility. LMC now owns all
// memory ingestion; this module only keeps the pure Telegram batching helpers.
require("./core-memory-store.cjs");

const MIN_EVENT_TURNS = Math.max(1, Number.parseInt(process.env.MEMORY_MIN_EVENT_TURNS || "2", 10) || 2);
const MIN_EVENT_CHARS = Math.max(100, Number.parseInt(process.env.MEMORY_MIN_EVENT_CHARS || "500", 10) || 500);
const MAX_EVENT_TURNS = Math.max(MIN_EVENT_TURNS, Number.parseInt(process.env.MEMORY_MAX_EVENT_TURNS || "30", 10) || 30);
const MAX_EVENT_CHARS = Math.max(MIN_EVENT_CHARS, Number.parseInt(process.env.MEMORY_MAX_EVENT_CHARS || "14000", 10) || 14000);
const EVENT_GAP_MS = Math.max(10 * 60 * 1000, Number.parseInt(process.env.MEMORY_EVENT_GAP_MS || "2700000", 10) || 2700000);

function normalizeTelegramMessages(chatJson) {
  const history = Array.isArray(chatJson && chatJson.history) ? chatJson.history : [];
  return history
    .map((message) => ({
      role: message && message.role === "assistant" ? "assistant" : "user",
      content: String(message && (message.content || message.text) || "").trim(),
      at: String(message && (message.at || message.createdAt) || chatJson.updatedAt || "")
    }))
    .filter((message) => message.content);
}

function batchCharCount(turns) {
  return turns.reduce(
    (total, turn) => total + turn.messages.reduce((sum, message) => sum + message.content.length, 0),
    0
  );
}

function createPendingBatches(source) {
  const batches = [];
  let scanIndex = Math.max(0, Number(source.processedMessageCount) || 0);
  while (
    scanIndex < source.messages.length &&
    !(source.messages[scanIndex].role === "user" && source.messages[scanIndex + 1] && source.messages[scanIndex + 1].role === "assistant")
  ) scanIndex += 1;
  const alignedProcessedMessageCount = scanIndex;
  const completeTurns = [];
  while (scanIndex < source.messages.length) {
    if (source.messages[scanIndex].role === "user" && source.messages[scanIndex + 1] && source.messages[scanIndex + 1].role === "assistant") {
      completeTurns.push({
        startIndex: scanIndex,
        endIndex: scanIndex + 1,
        messages: [source.messages[scanIndex], source.messages[scanIndex + 1]]
      });
      scanIndex += 2;
    } else scanIndex += 1;
  }

  function pushBatch(turns, closedByGap) {
    if (!turns.length) return;
    const charCount = batchCharCount(turns);
    if (!closedByGap && turns.length < MIN_EVENT_TURNS && charCount < MIN_EVENT_CHARS) return;
    const messages = turns.flatMap((turn) => turn.messages);
    batches.push({
      sourceChannel: source.sourceChannel,
      sourceRef: source.sourceRef,
      updatedAt: source.updatedAt,
      startIndex: turns[0].startIndex,
      endIndex: turns[turns.length - 1].endIndex,
      messages,
      turnCount: turns.length,
      charCount,
      firstMessageAt: messages[0] ? messages[0].at : "",
      lastMessageAt: messages.length ? messages[messages.length - 1].at : ""
    });
  }

  let current = [];
  for (const turn of completeTurns) {
    const previous = current[current.length - 1];
    const previousAt = previous ? Date.parse(previous.messages[1].at) : 0;
    const currentAt = Date.parse(turn.messages[0].at);
    const closedByGap = current.length > 0 && Number.isFinite(previousAt) && Number.isFinite(currentAt) && currentAt - previousAt >= EVENT_GAP_MS;
    const tooLarge = current.length >= MAX_EVENT_TURNS || batchCharCount([...current, turn]) > MAX_EVENT_CHARS;
    if (closedByGap || tooLarge) {
      pushBatch(current, closedByGap);
      current = [];
    }
    current.push(turn);
  }
  pushBatch(current, false);
  return { batches, alignedProcessedMessageCount };
}

function normalizeUserEvidenceIndexes(value, batch) {
  if (!Array.isArray(value) || !batch || !Array.isArray(batch.messages)) return [];
  return [...new Set(value.map((item) => Number.parseInt(item, 10)))]
    .filter((index) => Number.isInteger(index) && index >= 1 && index <= batch.messages.length && batch.messages[index - 1].role === "user")
    .slice(0, 12);
}

function buildBatchTranscript(batch) {
  return batch.messages.map((message, index) => `${index + 1}. ${message.role === "user" ? "User" : "Assistant"}: ${message.content}`).join("\n\n");
}

function buildEventMemoryPrompt(batch, recentMemories = []) {
  const candidates = recentMemories.length
    ? recentMemories.map((record) => `memoryId=${record.id} | title=${record.title || ""} | content=${record.content || ""}`).join("\n")
    : "(none)";
  return [
    "Analyze this completed slice of a personal Telegram conversation for the LMC ingest pipeline.",
    'Return JSON only: {"action":"create|update|skip","memoryId":"","summary":"","evidenceMessageIndexes":[1]}',
    "Only user-authored statements may establish memory.",
    "Do not describe the assistant's feelings, gestures, promises, requests, advice, or roleplay performance as memory content.",
    "For update, use an exact candidate memoryId. If evidence is insufficient, use skip.",
    "Recent candidates:",
    candidates,
    "Conversation slice:",
    buildBatchTranscript(batch)
  ].join("\n");
}

async function main() {
  process.stdout.write(`${JSON.stringify({
    ok: true,
    skipped: true,
    reason: "Legacy small/large summary ingest is retired; LMC owns memory ingestion."
  }, null, 2)}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error && error.stack ? error.stack : String(error)}\n`);
    process.exit(1);
  });
}

module.exports = {
  buildEventMemoryPrompt,
  createPendingBatches,
  normalizeTelegramMessages,
  normalizeUserEvidenceIndexes
};
