# Gem Bridge Chat Record Manager

## Purpose

This manager handles local Gem bridge chat records. It is not the official
Telegram chat history and it is separate from the independent memory system.

The manager exists for two jobs:

- Save and inspect the chat records that Gem bridge can feed back into Gemini.
- Permanently delete selected local context records when a bad reply, leaked
  thinking text, or corrupted message should stop affecting the model.
- Archive a whole chat window, similar to the ChatGPT left sidebar archive
  behavior.
- Keep the panel focused on Telegram bridge display records only.
- Preview the mobile layout on desktop when a phone cannot reach the LAN page.

## Scope

Managed file:

```text
bridge-state\chats\<chatId>.json
```

Archived windows:

```text
bridge-state\chat-archives\<chatId>\archive-YYYYMMDD-HHMMSS.json
```

Imported Telegram bridge sessions are merged into the Telegram display window.
Gemini CLI-only session folders are intentionally ignored.

Out of scope for this version:

- Telegram app message deletion.
- `INDEPENDENT_MEMORY.md` edits.
- Automatic upload or automatic down-sync.
- Public tunnel access by default.
- Codex bridge chat records.

## Local Panel

Start the panel with:

```powershell
.\start-gem-chat-record-manager.cmd
```

Open:

```text
http://127.0.0.1:4144
```

If you want another device on the same trusted Wi-Fi to open it, start the
server with:

```text
GEM_CHAT_RECORD_MANAGER_HOST=0.0.0.0
```

Then open the computer LAN address, for example:

```text
http://192.168.101.8:4144
```

The current Vercel site also exposes a no-login live path:

```text
https://naginoumi.com/chat-records-live/
```

That path is a reverse proxy to the local panel through the current public
tunnel. The computer, local agent, and tunnel must stay running. This path has
no authentication, so do not share it with anyone who should not see or edit the
records.

The panel provides:

- A ChatGPT-style left chat list.
- A Telegram current display window that merges current Telegram bridge records
  with old Telegram bridge sessions.
- Full message display for the selected chat.
- Date dividers between messages.
- A Xiaomi-gallery-style floating date rail that appears while scrolling.
- A desktop phone preview mode for checking the mobile layout.
- Permanent deletion for selected messages.
- Archive current window.
- Delete archived window.
- JSON export for manual backup or later cloud upload.

## Deletion Rules

Deletion is permanent for the selected managed window. Deleted messages are
removed from that window after a backup is written.

When deleting from the merged Telegram display window, the manager deletes from
the underlying active chat file and/or Telegram session archive file that owns
the selected message. Active-chat edits reset `sessionId`; archive-only edits do
not affect the active Gemini CLI session.

## Window Archive Rules

Archive is window-level, not message-level. When the current window is archived:

1. The active chat JSON is backed up.
2. The current `history` is copied into a timestamped archive file.
3. The active chat JSON is reset to an empty new window.
4. The old window appears under the archived group in the left sidebar.

Archived windows are no longer read by Gem bridge as the active model context.
They remain visible in the manager and can be exported or permanently deleted.

Every write creates a timestamped backup next to the original chat JSON before
modifying the file.

## Why SessionId Is Reset

Gem bridge uses Gemini CLI `--resume <sessionId>` for continuing a conversation.
If a message is deleted or archived only in the local JSON, the old Gemini CLI
session may still contain that message in its private cache.

For that reason, active-window delete and window-archive operations set:

```json
"sessionId": null
```

The next Gem reply starts a fresh Gemini CLI session while retaining the cleaned
local active history and independent memory files.

## Relationship To Memory

This system is separate from the independent memory system. It does not read or
write these files:

```text
bridge-workspace\INDEPENDENT_MEMORY.md
C:\Users\yx\gemini-test\INDEPENDENT_MEMORY.md
memory-docs\generated\independent-memory.md
```

Deleting a chat record only changes what the bridge can use as local chat
context. It does not erase long-term memory.

## Thought Block Cleanup

The local cleanup script removes leaked assistant thinking text from the records
used by this panel and by Gem bridge context. It does not call Telegram delete
APIs, so Telegram app messages are not removed.

Preview first:

```powershell
.\clean-telegram-thought-blocks-preview.cmd
```

Apply cleanup:

```powershell
.\clean-telegram-thought-blocks-apply.cmd
```

The script backs up changed JSON files under:

```text
bridge-state\thought-cleanup-backups\
```

It only edits assistant records. It removes obvious `[Thought: true]` prefixes,
pure assistant thinking messages, long English reasoning blocks, and broken
artifact blocks that do not look like normal dialogue. When active local chat
records are changed, `sessionId` is reset so the next Gem bridge reply starts
from the cleaned local context instead of resuming an old cached session.

New assistant replies are also cleaned before they are saved into local JSON.
That record cleanup does not change the Telegram message that was sent.

## Domain Live Path

The public domain does not store chat records. It only forwards requests:

```text
naginoumi.com/chat-records-live/ -> public tunnel -> 127.0.0.1:4144
```

Vercel rewrites are configured in:

```text
vercel.json
```

If the temporary tunnel URL changes, update the `/chat-records-live` rewrite
destination in `vercel.json` and redeploy the site.

## Future Cloud Version

A later cloud version can add:

- Manual upload from local JSON to cloud storage.
- Manual apply from cloud storage back to local JSON.
- A public URL protected by a write token.
- A diff preview before applying cloud edits locally.
