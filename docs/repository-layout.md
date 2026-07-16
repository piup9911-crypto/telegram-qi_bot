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
```

本机运行数据位于仓库根目录，但被 `.gitignore` 排除：

```text
bridge-home/
bridge-state/
bridge-workspace/
codex-bridge-state/
codex-bridge-workspace/
st-bridge-home/
st-bridge-state/
st-bridge-workspace/
memory-docs/
rp-config/
```

`bridge-workspace/` 自身包含一个本机 Git 仓库，用于管理 Gem 工作区规则；不要把它当作主仓库源码目录。记忆实验代码目前位于 `bridge-workspace/memory-pipeline-lab/`，正式运行时只依赖其中的数据库、统一召回服务、MCP 和必要索引。
