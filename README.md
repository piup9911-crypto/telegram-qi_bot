# Telegram–Gemini Bridge

本仓库是阿祈 Telegram Bot 的本机桥接项目，也保留 Codex Bot、OpenAI 兼容接口和 RP 记录工具。

最后核对：2026-07-16

## 当前正式入口

| 功能 | 启动入口 | 核心源码 |
|---|---|---|
| Telegram–Gemini 主 Bot | `start-telegram-gem-bridge.cmd` | `src/gem/telegram-gem-bridge.cjs` |
| Telegram–Codex Bot | `start-telegram-codex-bridge.cmd` | `src/codex/telegram-codex-bridge.cjs` |
| Gemini OpenAI 兼容接口 | `start-gemini-cli-openai-bridge.cmd` | `src/gem/gemini-cli-openai-bridge.cjs` |
| Codex OpenAI 兼容接口 | `start-codex-openai-bridge.cmd` | `src/codex/codex-openai-bridge.cjs` |
| 聊天记录与 RP 服务 | `start-gem-chat-record-manager.cmd` | `src/rp/gem-chat-record-manager.cjs` |

旧 status/control agent、localhost.run、Cloudflare Quick Tunnel 启动脚本已经退役。公网入口使用机器上配置的 Cloudflare Named Tunnel，不再由仓库内旧脚本维护。

## 当前记忆系统

> **记忆系统完整方案：**  
> [打开结构思维导图、数据表、召回流程、当前劣势和后续验证安排](./bridge-workspace/memory-pipeline-lab/README.md)

Telegram 主 Bot 已切换到 SQLite 记忆链路：

1. 原始 Telegram 聊天先正常写入 `bridge-state/`。
2. 桥接把新增消息增量写入正式 SQLite。
3. FTS5/Jieba 提供词语和原文检索。
4. 语义问题必要时使用向量召回。
5. Gem 通过只读 `memory_recall` 工具按需查询。
6. 后台 Summary / Card / Fact 模型目前关闭，不产生额外模型调用。

旧 LMC 已退出正常召回和写入链路，但 `memory-docs/lmc/` 与旧模块暂时保留，用于回滚和参考。

详细说明：

- [记忆系统概览](./MEMORY_SYSTEM_OVERVIEW.md)
- [当前真实运行方式](./bridge-workspace/memory-pipeline-lab/MEMORY_RUNTIME_V1.md)
- [历史需求草稿](./plan.md)（只用于追溯目标）

## 目录边界

### 正式源码

- `src/gem/`：Gem 主 Bot、OpenAI 兼容接口、主动消息和 Telegram MCP。
- `src/codex/`：Codex Bot、SDK session 和 OpenAI 兼容接口。
- `src/memory/`：SQLite 运行时，以及暂时保留的旧 LMC/向量适配。
- `src/adapters/`：Antigravity、sidecar 和云端适配器。
- `src/rp/`：聊天记录服务和 RP runtime。
- `bridge-workspace/memory-pipeline-lab/`：SQLite 记忆源码、召回器、迁移、规则与回归测试。
- `scripts/`：备份、导入、探测和索引维护脚本。
- `tests/`：本地回归测试。
- `ui/`：本地服务使用的页面。

### 本机数据

以下目录或内容不应提交：

- `bridge-state/`、`bridge-home/`
- `bridge-workspace/GEMINI.md`、`.agents/mcp_config.json`
- `bridge-workspace` 中的 SQLite、HTML/JSON 实验结果、媒体和临时文件
- `codex-bridge-state/`、`codex-bridge-workspace/`
- `st-bridge-state/`、`st-bridge-home/`、`st-bridge-workspace/`
- `memory-docs/`
- `rp-config/`

它们包含聊天、运行状态、OAuth、数据库或本机配置，不是普通源码。

## 验证

```powershell
npm run check
node .\tests\memory-system.test.cjs
node .\bridge-workspace\memory-pipeline-lab\validate-memory-schema-v2.cjs
node .\bridge-workspace\memory-pipeline-lab\run-memory-recall-mcp-tests.cjs
```

## 维护原则

- 不改写稳定的 `bridge-workspace/GEMINI.md` 正文。
- 不把旧 LMC 重新接回默认召回热路径。
- 不把原始聊天、数据库、OAuth 或真实 env 提交到 Git。
- 不恢复已退役的 status/control agent。
- 修改启动入口后，要检查真实进程、端口和日志，不只做语法检查。
- 旧 LMC 删除必须等新 SQLite 链路完成真实消息观察期。
