# Telegram-only 记忆系统说明

最后更新：2026-05-08

## 当前边界

云端记忆和独立记忆现在只服务 Telegram bridge。

Gemini CLI 本体已经和这套记忆系统解耦：

- 桌面 `gemini-start.cmd` 不再运行 `memory-ingest.cjs`
- 桌面 `gemini-start.cmd` 不再运行 `shared-memory-sync.cjs`
- `memory-ingest.cjs --source cli` 不再支持
- 不再向 `~/gemini-test/INDEPENDENT_MEMORY.md` 写入自动记忆
- 不再生成 CLI 启动注入用的 `cli-bootstrap-prompt.txt`
- 旧的 `start-gemini-cli-with-memory.*` 和 `start-shared-memory-gemini.cmd` 已删除

这样做的目标很简单：Telegram 聊天记忆归 Telegram，普通 Gemini CLI 启动保持纯净，不再为记忆系统付出启动耗时，也不再混入 Telegram 的聊天上下文。

## 仍然保留的能力

Telegram 侧仍然会继续使用独立记忆系统：

- Telegram 聊天记录保存在 `bridge-state/chats/`
- `memory-ingest.cjs --source telegram --chat-id <id>` 从 Telegram 聊天记录生成小摘要
- 小摘要达到阈值后会合并为大摘要
- `shared-memory-sync.cjs` 会把可读记忆编译成 `INDEPENDENT_MEMORY.md`
- 编译后的 `INDEPENDENT_MEMORY.md` 只写入 `bridge-workspace/`
- Telegram bridge 在构造 Gemini prompt 时读取 `bridge-workspace/INDEPENDENT_MEMORY.md`

## 主要文件

### `telegram-gem-bridge.cjs`

Telegram 主桥接程序。它负责接收 Telegram 消息、调用隔离配置下的 Gemini CLI、维护聊天状态，并在需要时触发 Telegram 记忆刷新。

它调用 `syncSharedMemory()` 时只传入 `bridge-workspace/` 作为目标目录。

### `memory-ingest.cjs`

Telegram 记忆摄取脚本。它只读取 `bridge-state/chats/` 下的 Telegram 聊天记录。

如果传入 `--source cli`，脚本会直接报错，避免旧启动器或旧命令悄悄把 Gemini CLI 聊天重新接进云端记忆。

### `shared-memory-sync.cjs`

Telegram 可读记忆编译脚本。它会合并本地独立记忆和可读云端记忆，然后写出：

- `memory-docs/generated/independent-memory.md`
- `bridge-workspace/INDEPENDENT_MEMORY.md`
- `bridge-state/shared-memory-cache.json`

它不会再写入 `~/gemini-test/`，也不会再生成 CLI bootstrap prompt。

### `independent-memory-manager.cjs`

本地记忆管理网页服务。每次编辑、复制、删除记忆后，它仍然会调用 `syncSharedMemory()`，但同步目标默认只包含 Telegram 工作区。

## 触发规则

Telegram bridge 当前的自动摄取节奏：

- 完成 10 轮用户/助手对话
- 再等待 2 分钟空闲窗口
- 触发 `memory-ingest.cjs --source telegram --chat-id <id>`

这套节奏只作用于 Telegram。普通 Gemini CLI 启动、普通 CLI 对话、`~/gemini-test` 工作区都不参与。

## 维护规则

- 不要恢复 `memory-ingest.cjs --source cli`
- 不要把 `bridge-workspace/INDEPENDENT_MEMORY.md` 同步到 `~/gemini-test/`
- 不要重新添加“带记忆启动 Gemini CLI”的启动器
- 不要让桌面 `gemini-start.cmd` 调用记忆脚本
- `GEMINI.md` 仍然是手动维护的人格层，自动摘要不能改写它
- 如果以后要给普通 Gemini CLI 做记忆，应该另建独立系统，不要复用 Telegram 云端记忆

## 验证清单

修改记忆系统后至少运行：

```cmd
node --check memory-ingest.cjs
node --check shared-memory-sync.cjs
node --check telegram-gem-bridge.cjs
node memory-ingest.cjs --source cli
node memory-ingest.cjs --source telegram
node shared-memory-sync.cjs
```

预期结果：

- 前三个语法检查通过
- `--source cli` 明确报错，说明 CLI 摄取已断开
- `--source telegram` 可以正常完成，即使没有新聊天也应返回 `ok: true`
- `shared-memory-sync.cjs` 只把 `INDEPENDENT_MEMORY.md` 写到 Telegram 工作区
