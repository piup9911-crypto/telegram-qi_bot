# Telegram Bridge Code Review Fixes — 2026-04-24

> **Reviewer**: Pyrite (烬)
> **Project**: telegram-gem-bridge (Gemini CLI ↔ Telegram 桥接)
> **Date**: 2026-04-24
> **Scope**: Full codebase review — 7 modules, 5 bugs fixed

---

## Summary

All fixes are marked with `[BUG-TN FIX]` comments inline for easy `grep` lookup:

```bash
grep -rn "\[BUG-T" --include="*.cjs" --include="*.js"
```

---

## Fix Details

### 🔴 Bug T1 — `/status` command crashes with ReferenceError (HIGH)

**File**: `telegram-gem-bridge.cjs` (line 1978)

**Problem**: The `/status` handler referenced `SHARED_MEMORY_URL`, a variable that
doesn't exist anywhere in the file. The correct variable is `SHARED_MEMORY_PAGE_URL`
(defined at line 96). This caused a `ReferenceError` crash every time a user sent
`/status` in Telegram.

**Fix**: Changed to `SHARED_MEMORY_PAGE_URL`.

**Search tag**: `[BUG-T1 FIX]`

---

### 🟡 Bug T2 — `callGemini` indentation misalignment (MEDIUM)

**File**: `telegram-gem-bridge.cjs` (lines 1179-1183)

**Problem**: The `log()` and `reject()` lines inside the `if (code !== 0)` block
had 2 fewer spaces of indentation than the surrounding code. In JavaScript this
doesn't change behavior, but it implies the lines are outside the if-block, creating
a maintenance trap for future edits.

**Fix**: Aligned indentation to 8 spaces, matching the surrounding block.

**Search tag**: `[BUG-T2 FIX]`

---

### 🟡 Bug T6 — `memory-ingest.cjs` uses real HOME instead of bridge HOME (MEDIUM)

**File**: `memory-ingest.cjs` (lines 371-373)

**Problem**: The main bridge isolates Gemini CLI by setting `USERPROFILE`/`HOME` to
`bridge-home/`, but the memory ingest subprocess used `REAL_HOME`, sharing the user's
real `~/.gemini` config. This could cause OAuth credential conflicts or divergent
settings when both processes run concurrently.

**Fix**: Changed to use `bridge-home/` and also set `GEMINI_CLI_TRUSTED_FOLDERS_PATH`
to match the main bridge's isolation.

**Search tag**: `[BUG-T6 FIX]`

---

### 🟢 Bug T3 — Dead guard conditions in `emitPreview` (LOW)

**File**: `telegram-gem-bridge.cjs` (lines 1266-1270)

**Problem**: Two guard conditions (`!previewText && !force` and
`previewText === lastPreviewText && !force`) were already fully covered by the
`if (!force) { ... }` block above them. These lines could never execute.

**Fix**: Removed the dead code.

**Search tag**: `[BUG-T3 FIX]`

---

### 🟢 Bug T4 — English queue/error messages in Chinese UI (LOW)

**File**: `telegram-gem-bridge.cjs` (lines 2070, 2221, 2229)

**Problem**: Three user-facing messages were in English while the rest of the bot
UI is Chinese. Specifically:
- "The previous message is still processing. I queued this one." → "上一条消息还在处理中，这条已经排上队了。"
- "Bridge error:" → "桥接出错了："

**Fix**: Unified to Chinese.

**Search tag**: `[BUG-T4 FIX]`

---

## Files Modified

| File | Changes |
|------|---------|
| `telegram-gem-bridge.cjs` | T1 (undefined var), T2 (indent), T3 (dead code), T4 (Chinese text) |
| `memory-ingest.cjs` | T6 (HOME isolation) |

## Architecture Quick Reference

```
User (Telegram) ──► telegram-gem-bridge.cjs ──► Gemini CLI subprocess
                         │                          ↓
                         │                    bridge-home/.gemini (isolated config)
                         │                          ↓
                         │                    bridge-workspace/ (isolated project dir)
                         │
                         ├── shared-memory-sync.cjs (compile independent memory + one-time legacy import)
                         ├── legacy-cloud-memory-migration.cjs (retire old pending/approved cloud data)
                         ├── memory-ingest.cjs (background: 10 complete turns / 20 messages → small summary)
                         ├── independent-memory-store.cjs (editable Markdown records with JSON metadata)
                         └── cloud-memory-client.cjs (legacy Vercel API client for migration)
```

### Memory Lifecycle
```
Chat messages (15 per batch)
    → small_summary (memory-ingest.cjs + Gemini)
    → [accumulate 16 small summaries]
    → large_summary (consolidation)
    → INDEPENDENT_MEMORY.md (compiled into the readable Telegram / CLI memory layer)
```

Note: independent memory records live as Markdown files under `memory-docs/`
with JSON metadata in HTML comments. They are not a single JSON database.
Private records and trash records are intentionally excluded from the
model-readable compiled memory output.
