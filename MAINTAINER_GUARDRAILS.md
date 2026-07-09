# Maintainer Guardrails

This file is a quick handoff note for Codex, Gemini CLI, Claude Code, or any
future helper editing this bridge. It focuses on rules that are easy to break
accidentally.

## 当前记忆边界（2026-05-08）

- 云端记忆和独立记忆现在只服务 Telegram bridge。
- 普通 Gemini CLI 不再作为这套记忆系统的输入源或输出目标。
- 桌面 `gemini-start.cmd` 必须保持纯启动，不要重新调用
  `memory-ingest.cjs` 或 `shared-memory-sync.cjs`。
- `memory-ingest.cjs --source cli` 已停用；如果旧命令触发它，应该明确报错。
- `shared-memory-sync.cjs` 默认只写入 `bridge-workspace/INDEPENDENT_MEMORY.md`。
- 不要重新添加 `start-gemini-cli-with-memory.*` 或
  `start-shared-memory-gemini.cmd` 这类带记忆的 Gemini CLI 启动器。
- 如果以后普通 Gemini CLI 也需要记忆，另建独立系统，不要复用 Telegram
  云端记忆。

## Telegram Thinking UI

- Hidden thinking and the final reply must stay in one Telegram message bubble.
- The active hidden-thinking path is `buildHiddenThinkingSingleBubblePlan()` in
  `telegram-gem-bridge.cjs`.
- That path uses Telegram `entities`, especially `expandable_blockquote`, instead
  of raw HTML. This is intentional.
- Do not switch hidden thinking back to raw HTML `<blockquote expandable>` unless
  you test Telegram hidden-thinking replies end to end.
- The old HTML helpers are retained only for fallback/reference. They previously
  caused clients to show only `Thinking` / `Thought` or hide the final reply.

## Memory System Invariants

- `GEMINI.md` is manual-only. Automatic summaries must not rewrite it.
- Automatic memories live under `memory-docs/` as editable Markdown files with a
  `MEMORY_META` JSON block.
- The old cloud `pending/approved` model is retired as a source of truth. It may
  be imported once, but new memory ingest should not write more old entries.
- Model-readable memory is compiled into `INDEPENDENT_MEMORY.md`.
- Private memory and trash are not model-readable.
- Copies into `long_term` or `private` must create independent records. Editing
  the copy must never update the source.
- Editing a small summary only changes that small summary. If it is later merged
  into a large summary, the merge must use the edited current text.
- Editing a large summary only changes that large summary.

## Summary Lifecycle

- Small summaries are generated from 10 complete user-assistant turns (20 messages).
- The Telegram bridge does not ingest after every idle pause. It waits for 10
  completed user/assistant turns, then a 2-minute idle window.
- Large-summary consolidation starts when there are 16 active small summaries.
- The oldest 15 small summaries become one large summary. The newest small
  summary remains active for the next cycle.
- Do not move small summaries to trash unless the large summary has actually
  been created, or the same generation signature is already known.
- Trash retention is 180 days from `trashedAt`.

## Local Tools

- The old independent memory editor page has been removed. Keep the LMC files
  and memory compilation scripts for reference/runtime work, but do not treat a
  local memory page as the source of truth.
- Old cloud import:
  `node legacy-cloud-memory-migration.cjs --force` if you need to rerun the
  one-time import from old `approvedEntries` / `pendingEntries`.
- Old cloud `memory.html` still uses the previous pending/approved model. Do not
  treat it as the source of truth for the new file-based memory workflow.

## Before Finishing Changes

Run syntax checks for touched scripts:

```bash
node --check telegram-gem-bridge.cjs
node --check memory-ingest.cjs
node --check independent-memory-store.cjs
node --check shared-memory-sync.cjs
node --check legacy-cloud-memory-migration.cjs
```

If a change touches Telegram thinking delivery, also manually test:

- hidden thinking
- visible thinking
- streaming reply finalization
- normal replies with no thinking block
