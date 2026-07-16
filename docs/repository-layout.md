# Repository Layout

最后核对：2026-07-16

```text
src/
  adapters/   Antigravity、sidecar、云端适配
  gem/        Telegram Gem Bot 与 Gemini OpenAI bridge
  codex/      Telegram Codex Bot 与 Codex OpenAI bridge
  memory/     SQLite 运行时和旧 LMC 回滚适配
  rp/         聊天记录与 RP runtime
scripts/      备份、导入、探测和索引维护
tests/        回归测试
ui/           本地服务页面
docs/         当前仍有效的设计与维护说明
bridge-workspace/
  memory-pipeline-lab/  SQLite 记忆源码、迁移、规则与测试
  .agents/skills/       Gem 可使用的只读召回 skill
```

本机运行数据位于仓库根目录或 `bridge-workspace/`，但被 `.gitignore` 排除：

```text
bridge-home/
bridge-state/
bridge-workspace/GEMINI.md
bridge-workspace/.agents/mcp_config.json
bridge-workspace/memory-pipeline-lab/*.sqlite
bridge-workspace/memory-pipeline-lab/*.html
codex-bridge-state/
codex-bridge-workspace/
st-bridge-home/
st-bridge-state/
st-bridge-workspace/
memory-docs/
rp-config/
```

`bridge-workspace/` 已并入主仓库管理，不再包含独立 `.git`。主仓库只跟踪可移植的记忆源码、文档、迁移和测试；人格文件、MCP 本机绝对路径、正式数据库、聊天衍生报告及其他运行文件继续只保存在本机。
