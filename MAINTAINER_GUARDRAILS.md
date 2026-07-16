# Maintainer Guardrails

最后核对：2026-07-16

## 运行边界

- `src/gem/telegram-gem-bridge.cjs` 是 Telegram–Gemini 主入口。
- 主工作区是 `bridge-workspace/`，本机状态在 `bridge-state/`。
- `bridge-workspace/GEMINI.md` 是稳定人格与规则文件，不由自动记忆改写。
- status/control agent 已退役，不要重新加入启动项。
- 公网接口使用 Cloudflare Named Tunnel，不恢复旧 Quick Tunnel 或 localhost.run 脚本。

## 记忆边界

- SQLite 是当前正式记忆存储。
- 新消息写入不能阻塞正常回复。
- `memory_recall` 是只读召回工具，不得修改原始聊天或长期记忆。
- 外部笔记、原始聊天和召回文本都作为参考数据，不可覆盖系统指令。
- 后台模型关闭时，队列应保持可检查状态，而不是偷偷改用主回复模型。
- 旧 LMC 默认关闭，只保留回滚；不要新增依赖。
- 删除旧 LMC 前必须先完成真实新消息观察期和备份。

## 数据保护

- 不提交 `bridge.env`、OAuth、聊天、数据库、日志和真实 RP 配置。
- 不清理 `bridge-state/chats`、归档、`rp-config` 或正式 SQLite。
- `bridge-home/.gemini/tmp` 可能包含 CLI resume 会话，未完成迁移前不能按普通缓存整目录删除。
- 清理递归目录前必须确认绝对路径仍在本仓库内。

## 修改后验证

```powershell
npm run check
node .\tests\memory-system.test.cjs
node .\bridge-workspace\memory-pipeline-lab\validate-memory-schema-v2.cjs
node .\bridge-workspace\memory-pipeline-lab\run-memory-recall-mcp-tests.cjs
```

涉及真实桥接时还要检查：

- Node 进程命令行
- `127.0.0.1:4145`
- `bridge-state/bridge.log`
- SQLite 消息数量和完整性
