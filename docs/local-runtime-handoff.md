# Local Runtime Handoff

Updated: 2026-07-09

This note records local Windows startup/runtime changes that are easy to miss when debugging the Telegram Qi bot on this machine.

## Current Startup Shape

- Windows Startup keeps `naginoumi-api-bridge.cmd`.
- `naginoumi-api-bridge.cmd` still owns the local `opencode` ingress/tunnels and the `4141` OpenAI bridge startup.
- `naginoumi-api-bridge.cmd` starts the records page service on `4144` from this repo only:
  - `C:\Users\yx\Documents\Codex\2026-04-21-gemini-cli-telegram\src\rp\gem-chat-record-manager.cjs`

## Removed Startup Items

These were intentionally removed and should not be restored unless the user explicitly asks:

- `Bridge Status Agents.cmd`
  - Previously started old hello-vercel status agents from `C:\Users\yx\Documents\New project\hello-vercel\tools\start-bridge-status-agents.cmd`.
  - It caused old `gem-status-agent.cjs` and `codex-status-agent.cjs` to keep polling paused/402 Vercel control endpoints.
- `Gem Control Agent.lnk`
  - Previously launched `start-gem-control-agent.cmd` as a background control poller.
  - The matching repo entries were also removed: `install-gem-control-agent-startup.cmd`, `start-gem-control-agent.cmd`, and `src/gem/gem-control-agent.cjs`.

## Important Boundary

Do not auto-start records/status/control code from:

- `C:\Users\yx\Documents\New project\hello-vercel\tools\...`

The active local records service should come from this repo, not from the old hello-vercel copy.

The records page itself is still expected to run. The local records service on
`4144` and its `/api/chats` data loading are still part of the active workflow.
The removed behavior was the old records-edit/prepack flow that tried to rebuild
or reseed a new Sidecar window after deleting/editing messages.

## Quick Checks

- Records page service: `127.0.0.1:4144`
- Telegram Gemini bridge: `127.0.0.1:4145`
- If old traffic returns, check for these process names first:
  - `gem-status-agent.cjs`
  - `codex-status-agent.cjs`
  - `start-bridge-status-agents.cmd`
