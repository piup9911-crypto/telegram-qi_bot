# Repository Layout

This repository is the standalone Telegram Qi bot bridge. Runtime state and
local secrets stay at the repository root, while source files are grouped by
feature.

## Root

- `README.md`, `plan.md`, and maintenance notes stay at the root for quick
  reading.
- `start-*.cmd` launch the local services and point into `src/`.
- `bridge.env.example` documents environment variables. Real `bridge.env` and
  runtime state are local-only.

## Source

- `src/gem/`: Telegram Gem bot, Gemini/OpenAI bridge, Gem status/control agents,
  proactive messages, and Telegram MCP helper.
- `src/memory/`: local memory stores, LMC-compatible code, prompt memory
  context, vector recall, memory manager service, and memory sync.
- `src/adapters/`: Antigravity CLI/sidecar adapters and cloud-memory client.
- `src/codex/`: Codex Telegram bot and Codex OpenAI/status/control helpers.
- `src/rp/`: RP chat-record manager and RP runtime.

## Support

- `ui/`: HTML tools served by local services.
- `scripts/`: one-shot maintenance and rebuild commands.
- `tests/`: local test/probe files.
- `docs/`: design notes and project maps.

## Runtime

- `bridge-state/`, `bridge-workspace/`, and `bridge-home/` are the Gem bot
  runtime state.
- `codex-bridge-state/` and `codex-bridge-workspace/` belong to the Codex bot.
- `memory-docs/` contains local memory records and generated memory files.
