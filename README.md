# Telegram Gemini Bridge

最后更新：2026-06-18

这个目录保存本机 Telegram bridge、Gemini CLI bridge、OpenAI 兼容 bridge，以及 Telegram-only 独立记忆系统。

## 当前记忆边界

云端记忆和独立记忆现在只服务 Telegram bridge。

普通 Gemini CLI 已经和这套记忆系统解耦：

- 桌面 `C:\Users\yx\Desktop\gemini-start.cmd` 不再运行记忆脚本
- `memory-ingest.cjs` 不再支持 `--source cli`
- `shared-memory-sync.cjs` 不再写入 `C:\Users\yx\gemini-test`
- 旧的 `start-gemini-cli-with-memory.*` 已删除
- 旧的 `start-shared-memory-gemini.cmd` 已删除

普通 Gemini CLI 的启动路径现在应该尽量短：设置代理，进入 `gemini-test`，启动 `gemini`。

## 常用启动

### 启动 Telegram bridge

```cmd
start-telegram-gem-bridge.cmd
```

或：

```cmd
node src\gem\telegram-gem-bridge.cjs
```

### 启动本地记忆管理器

```cmd
start-independent-memory-manager.cmd
```

然后打开：

```text
http://127.0.0.1:4142/
```

### 启动普通 Gemini CLI

使用桌面：

```text
C:\Users\yx\Desktop\gemini-start.cmd
```

这个启动器不再加载 Telegram 云端记忆。

## 记忆系统

Telegram 记忆的当前流程：

1. Telegram 聊天写入 `bridge-state/chats/`
2. Telegram bridge 在完成 10 轮对话并空闲 2 分钟后触发摄取
3. `memory-ingest.cjs --source telegram --chat-id <id>` 生成小摘要
4. 小摘要积累到阈值后合并为大摘要
5. `shared-memory-sync.cjs` 编译可读记忆
6. 编译结果写入 `bridge-workspace/INDEPENDENT_MEMORY.md`
7. Telegram bridge 构造 prompt 时读取这份记忆

`GEMINI.md` 仍然是手动维护的人格层，自动摘要不能改写它。

### LMC 分层记忆

2026-06-18 起，Telegram bridge 额外接入 LMC 风格的分层记忆。它不是替代原来的 `INDEPENDENT_MEMORY.md`，而是给“长期事实、临时状态、过去事件、可搜索证据”增加一条更细的存储和召回链路。

当前分层：

| 层级 | 用途 | 默认参与普通回复 |
| --- | --- | --- |
| `stable` | 长期偏好、边界、关系设定、身份事实、长期指令 | 是 |
| `temporary` | 今天/最近/当前项目状态、短期计划、临时心情或可过期事实 | 是，但到期后自动视为过期 |
| `event` | 已经发生的共同经历、阶段性事件、过去上下文 | 只在相关时召回 |
| `search_only` | 弱相关、不确定、暂不该影响人格或当前判断的搜索证据 | 否，只有用户问“之前/还记得/搜索”等历史问题时才放出 |

核心流程：

1. `telegram-gem-bridge.cjs` 继续把 Telegram 对话写入本地聊天状态。
2. 空闲摄取时，bridge 会先运行 `lmc-memory-ingest.cjs`，再运行旧的 Markdown 摘要整理，避免 LMC 状态页被旧摘要耗时阻塞。
3. `lmc-memory-ingest.cjs` 调用 Gemini 做 hippocampus pass，把原始片段整理成 `lifeEvent`、`searchEvidence` 和严格的 `curatedMemories`；如果 Gemini CLI 返回转义 JSON，整理器会先还原再解析。
4. `lmc-memory-store.cjs` 负责落盘、状态演化、过期判断、同一 `factKey` 的新旧事实替换，以及召回排序。
5. `memory-context.cjs` 在构造 prompt 时合并普通记忆、向量召回和 LMC 召回，并提醒模型把 `expired`、`superseded`、`historical`、`search_only` 当作过去证据，不要当成当前偏好。
6. `lmc-status.cjs` 用来快速查看 LMC 当前统计，不输出记忆正文。

重要规则：

- 临时记忆必须带 `validUntil` 或 `expiresAt`，否则不会写入，避免旧状态长期污染回复。
- 同一个 `factKey` 的新事实会把旧事实标记为 `superseded`，旧事实仍可作为历史证据保留。
- `search_only` 片段默认不进入普通回复，只在用户明显追问过去记录或搜索时参与召回。
- 状态页只同步数量、时间戳和管道状态，不上传 LMC 记忆正文。

## 主 Bot prompt 和上下文窗口

Telegram 主 bot 的 prompt 由 `telegram-gem-bridge.cjs` 组装，并通过 Gemini CLI 的 `--prompt` stdin 输入给模型。Gemini CLI 的工作目录是 `bridge-workspace/`，隔离 home 是 `bridge-home/`。

主 bot 每轮可以看到的信息主要有：

- `bridge-workspace/GEMINI.md`：Telegram 版本的人格 / prompt 设置。
- `bridge-workspace/INDEPENDENT_MEMORY.md`：独立长期记忆。每轮构造 prompt 时会读取并注入。
- 当前真实时间上下文：默认时区是 `Asia/Shanghai`，用于时间感、提醒和语气判断。
- 最近 Telegram 本地聊天历史：来自 active 聊天 `bridge-state/chats/<chat_id>.json`，并默认合并同一 chat id 下的 Telegram 归档 `bridge-state/chat-archives/<chat_id>/*.json`。
- 当前用户消息：总是放在 prompt 最后，作为这一轮要回答的消息。
- 主 bot 不使用 Gemini CLI `--resume`：每轮都开新的 CLI 调用，只吃桥接本轮显式裁切出的 prompt，避免 Gemini CLI 内部旧会话压缩影响 Telegram 上下文。

最近聊天历史的显式注入窗口由两个环境变量控制：

| 变量 | 默认值 | 含义 |
| --- | ---: | --- |
| `BRIDGE_PROMPT_HISTORY_MESSAGES` | `10000` | 内部保险上限，日常不作为主要调节项 |
| `BRIDGE_PROMPT_HISTORY_CHARS` | `1000000` | 最近消息文本总字符上限 |
| `BRIDGE_PROMPT_INCLUDE_ARCHIVES` | `true` | 是否把同一 Telegram chat id 的归档历史纳入 prompt 候选窗口 |

实现细节：

- `buildPromptHistory()` 会把 active history 和归档 history 合并、去重，并按消息时间排序。
- `formatRecentChatContext()` 会从合并后的最新历史往前取，直到达到内部消息保险上限或最大历史字符数。
- `buildInitialPrompt()` 会把最近历史放入 `Recent local Telegram chat history for continuity:`；主 bot 每轮都使用这个完整 prompt，不依赖 CLI resume。
- 最近历史里的最后一条通常是当前用户消息，所以注入到历史区时会排除最后一条，再在末尾单独写入 `User message:`。
- 因此实际可理解为：当前用户消息 + 最近过往消息，主要受最大历史字符数限制。
- 本地历史文件保留量、网页 chat-records 展示量和每轮 prompt 注入量不是一回事；网页可以显示 active + archive 的更多记录，但每轮仍只按上面的窗口注入。

当前主聊天在 2026-05-17 检查时：

- active 文件 `bridge-state/chats/7541487750.json` 保存了 155 条消息：77 条用户消息、78 条助手消息，正文约 34249 字符。
- Telegram 归档 `bridge-state/chat-archives/7541487750/archive-20260509-084736.json` 保存了 569 条消息。
- 合并后共有 724 条候选消息；当前 Gem 主 bot 最大历史字符数是 1000000，会优先按字符上限裁剪。

可通过 `bridge-state/context-settings.json` 或桥接状态总舱的 Gem 状态页调节：

```json
{
  "telegramGem": {
    "maxHistoryChars": 1000000
  }
}
```

当前模型选择：

- `modelMode: quality` 且没有 `customModel` 时，默认使用 `gemini-3.1-pro-preview`。
- `modelMode: fast` 时，默认使用 `BRIDGE_GEMINI_MODEL_FAST`，当前 `bridge.env` 里是 `gemini-2.5-flash`。

## 主要文件

| 文件 | 用途 |
| --- | --- |
| `src/gem/telegram-gem-bridge.cjs` | Telegram 主桥接程序 |
| `src/memory/memory-ingest.cjs` | Telegram 聊天摘要摄取 |
| `src/memory/lmc-memory-ingest.cjs` | LMC hippocampus 后台整理，把事件片段提炼为生活事件、搜索证据和严格记忆 |
| `src/memory/lmc-memory-store.cjs` | LMC 文件型存储、过期判断、事实替换、召回和巡检 |
| `src/memory/lmc-status.cjs` | 输出 LMC 统计状态，不输出记忆正文 |
| `src/memory/memory-context.cjs` | 汇总长期记忆、向量召回、聊天召回和 LMC 召回，生成 prompt 记忆上下文 |
| `src/memory/memory-vector.cjs` | 本地向量索引和检索支持 |
| `src/memory/chat-vector-memory-v2.cjs` | 并行的聊天向量索引 V2，生成时间线、来源树和样本预览，暂不替换当前 bot 召回 |
| `scripts/rebuild-chat-vectors-v2.cjs` | 一次性重建 V2 索引；会复用旧向量，只有新增/变化片段才重新嵌入 |
| `src/memory/shared-memory-sync.cjs` | Telegram 可读记忆编译 |
| `src/memory/core-memory-store.cjs` | 文件型独立记忆存储 |
| `src/memory/memory-manager.cjs` | 本地记忆管理 Web 服务 |
| `src/adapters/cloud-memory-client.cjs` | 云端记忆 API 客户端 |
| `src/gem/gemini-cli-openai-bridge.cjs` | OpenAI 兼容接口桥接 |
| `src/gem/telegram-mcp-fixed.cjs` | Telegram MCP 服务端 |

状态页同步文件在网站仓库 `C:\Users\yx\Documents\New project\hello-vercel`：

| 文件 | 用途 |
| --- | --- |
| `tools/gemini-cli-telegram/gem-status-agent.cjs` | 本机状态代理，读取 bridge、向量和 LMC 统计后上报 |
| `api/gem-status.mjs` | Vercel API，过滤并规范化状态字段 |
| `memory-monitor.html` | 记忆监测页，展示当前事实、临时记忆、历史记忆、搜索证据和过期/替换数量 |

## 维护规则

- 不要把 `memory-ingest.cjs` 加回普通 Gemini CLI 启动链
- 不要恢复 `memory-ingest.cjs --source cli`
- 不要把 `INDEPENDENT_MEMORY.md` 同步到 `C:\Users\yx\gemini-test`
- 不要重新添加带记忆的 Gemini CLI 启动器
- 如果以后普通 Gemini CLI 也需要记忆，另建独立系统，不复用 Telegram 云端记忆

更多细节见 `MEMORY_SYSTEM_OVERVIEW.md` 和 `MAINTAINER_GUARDRAILS.md`。

## 验证命令

```cmd
npm run check
node --check src/memory/memory-ingest.cjs
node --check src/memory/lmc-memory-store.cjs
node --check src/memory/lmc-memory-ingest.cjs
node --check src/memory/memory-context.cjs
node --check src/memory/chat-vector-memory-v2.cjs
node --check scripts/rebuild-chat-vectors-v2.cjs
node --check src/memory/shared-memory-sync.cjs
node --check src/memory/memory-manager.cjs
node src/memory/lmc-status.cjs
node src/memory/memory-ingest.cjs --source cli
node src/memory/memory-ingest.cjs --source telegram
node scripts/rebuild-chat-vectors-v2.cjs
node src/memory/shared-memory-sync.cjs
```

预期：

- 语法检查通过
- `--source cli` 明确报错
- `--source telegram` 正常完成
- `rebuild-chat-vectors-v2.cjs` 写入 `bridge-state/chat-vector-index-v2.json`，并返回索引数量、复用数量和时间桶数量
- `lmc-status.cjs` 正常返回 LMC 统计字段，例如 `currentFactCount`、`temporaryMemoryCount`、`searchOnlyChunkCount`
- `shared-memory-sync.cjs` 只写入 Telegram 工作区
