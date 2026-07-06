const assert = require("assert");
const {
  buildEventMemoryPrompt,
  createPendingBatches,
  normalizeUserEvidenceIndexes,
  normalizeTelegramMessages
} = require("./memory-ingest.cjs");
const {
  formatElapsedTime,
  tokenize
} = require("./memory-context.cjs");
const {
  cosineSimilarity,
  recordVectorText
} = require("./memory-vector.cjs");
const {
  buildChatChunks,
  buildChatRetrievalQuery
} = require("./chat-vector-memory.cjs");

function makeTurn(index, at) {
  return [
    { role: "user", content: `用户消息 ${index}`, at },
    { role: "assistant", content: `助手回复 ${index}`, at }
  ];
}

function testNaturalEventBatching() {
  const messages = [
    ...makeTurn(1, "2026-06-14T00:00:00.000Z"),
    ...makeTurn(2, "2026-06-14T00:01:00.000Z")
  ];
  const result = createPendingBatches({
    sourceChannel: "telegram",
    sourceRef: "test",
    updatedAt: "2026-06-14T00:01:00.000Z",
    messages,
    processedMessageCount: 0
  });

  assert.strictEqual(result.batches.length, 1);
  assert.strictEqual(result.batches[0].turnCount, 2);
  assert.strictEqual(result.batches[0].messages.length, 4);
}

function testUserEvidenceFiltering() {
  const batch = {
    messages: [
      { role: "user", content: "我喜欢雨天" },
      { role: "assistant", content: "我会记住" },
      { role: "user", content: "但是不喜欢淋雨" }
    ]
  };

  assert.deepStrictEqual(
    normalizeUserEvidenceIndexes([1, 2, 3, 99], batch),
    [1, 3]
  );
}

function testPromptGuards() {
  const prompt = buildEventMemoryPrompt(
    {
      sourceChannel: "telegram",
      sourceRef: "test",
      startIndex: 0,
      endIndex: 1,
      messages: makeTurn(1, "2026-06-14T00:00:00.000Z"),
      turnCount: 1,
      charCount: 20
    },
    [
      {
        id: "memory-1",
        title: "旧事件",
        content: "用户正在准备考试。",
        metadata: { status: "active" }
      }
    ]
  );

  assert.match(prompt, /action":"create\|update\|skip/);
  assert.match(prompt, /memoryId=memory-1/);
  assert.match(prompt, /Do not describe the assistant's feelings/);
}

function testTextUtilities() {
  const normalized = normalizeTelegramMessages({
    updatedAt: "2026-06-14T00:00:00.000Z",
    history: [
      { role: "user", content: "  喜欢雨天  " },
      { role: "assistant", content: "知道了" }
    ]
  });
  assert.strictEqual(normalized[0].content, "喜欢雨天");
  assert.ok(tokenize("我喜欢雨天，也喜欢下雨声").has("雨天"));
  assert.strictEqual(formatElapsedTime(3 * 60 * 60 * 1000), "约 3 小时");
}

function testVectorUtilities() {
  assert.strictEqual(cosineSimilarity([1, 0], [1, 0]), 1);
  assert.strictEqual(cosineSimilarity([1, 0], [0, 1]), 0);
  assert.match(
    recordVectorText({
      title: "雨天偏好",
      content: "用户喜欢雨声。",
      metadata: { keywords: ["雨天"] }
    }),
    /雨天偏好[\s\S]*用户喜欢雨声[\s\S]*雨天/
  );
}

function testChatChunkingKeepsTurnsTogether() {
  const chunks = buildChatChunks([
    {
      chatId: "test",
      sourceId: "active:test",
      sourceKind: "active",
      sourceRef: "test.json",
      messages: [
        { role: "user", content: "第一轮问题", at: "2026-06-14T00:00:00.000Z" },
        { role: "assistant", content: "第一轮回答", at: "2026-06-14T00:00:10.000Z" },
        { role: "user", content: "第二轮问题", at: "2026-06-14T00:01:00.000Z" },
        { role: "assistant", content: "第二轮回答", at: "2026-06-14T00:01:10.000Z" }
      ]
    }
  ]);

  assert.strictEqual(chunks.length, 1);
  assert.strictEqual(chunks[0].messageCount, 4);
  assert.strictEqual(chunks[0].turnCount, 2);
  assert.match(chunks[0].text, /User: 第一轮问题/);
  assert.match(chunks[0].text, /Assistant: 第二轮回答/);
}

function testChatChunkEmbeddingKeepsUserFocus() {
  const longAssistantReply = "assistant emotional prose ".repeat(80);
  const chunks = buildChatChunks([
    {
      chatId: "test",
      sourceId: "active:test-focus",
      sourceKind: "active",
      sourceRef: "test.json",
      messages: [
        {
          role: "user",
          content: "I am anxious about going to work today.",
          at: "2026-06-14T00:00:00.000Z"
        },
        {
          role: "assistant",
          content: longAssistantReply,
          at: "2026-06-14T00:00:10.000Z"
        }
      ]
    }
  ]);

  assert.strictEqual(chunks.length, 1);
  assert.match(chunks[0].retrievalText, /I am anxious about going to work/);
  assert.doesNotMatch(chunks[0].retrievalText, /assistant emotional prose/);
  assert.ok(chunks[0].text.length > chunks[0].retrievalText.length);
  assert.ok(chunks[0].retrievalText.length < 500);
}

function testChatRetrievalQueryKeepsUserFocus() {
  const history = [
    { role: "user", content: "我们之前处理过 Telegram 409。"},
    { role: "assistant", content: "一大段充满情绪和安慰的回复。".repeat(80) },
    { role: "user", content: "那个后来怎么解决的？" }
  ];
  const query = buildChatRetrievalQuery("那个后来怎么解决的？", history);
  assert.match(query, /我们之前处理过 Telegram 409/);
  assert.match(query, /那个后来怎么解决的/);
  assert.doesNotMatch(query, /一大段充满情绪/);
}

function testChatRetrievalQueryDropsStaleContext() {
  const history = [
    {
      role: "user",
      content: "An unrelated topic from hours ago.",
      at: "2026-06-14T00:00:00.000Z"
    },
    {
      role: "user",
      content: "So what now?",
      at: "2026-06-14T03:00:00.000Z"
    }
  ];
  const query = buildChatRetrievalQuery("So what now?", history);
  assert.doesNotMatch(query, /unrelated topic/);
  assert.match(query, /So what now/);
}

async function main() {
  testNaturalEventBatching();
  testUserEvidenceFiltering();
  testPromptGuards();
  testTextUtilities();
  testVectorUtilities();
  testChatChunkingKeepsTurnsTogether();
  testChatChunkEmbeddingKeepsUserFocus();
  testChatRetrievalQueryKeepsUserFocus();
  testChatRetrievalQueryDropsStaleContext();
  process.stdout.write("memory system tests passed\n");
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exit(1);
});
