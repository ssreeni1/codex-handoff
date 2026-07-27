---
name: handoff
description: Hand off the active Codex task to a configured external sandbox and return its report. Use when the user says /handoff or asks to continue the current task in a new sandbox.
---

# Codex Handoff

Use the `handoff` MCP tool when the user asks for `/handoff` or for a sandbox continuation.

1. Make a compact but complete task brief from the active conversation: objective, relevant decisions, constraints, current workspace, files changed, commands/tests run, and the next action. Do not include secrets.
2. Before creating any Sailbox, ask the user: "May I forward your local Codex login to a private Sailbox so it can continue this task?" Do not call `handoff` until they explicitly approve.
3. After approval, call `handoff` with `credential_mode: "auth_file"` and `allow_credential_forwarding: true` (or the approved access-token mode).
4. Return control to the main chat immediately after launch. Tell the user that the sandbox is working in the background and offer: "Say 'check in on the sandbox' whenever you want an update."
5. Only when the user asks to check in, call `handoff_wait` (or `handoff_status`). Once complete, this synchronizes the sandbox workspace into the initiating local workspace before terminating the Sailbox, then relay the sandbox's results and recommended next-step plan.

`auth_file` relays `$CODEX_HOME/auth.json` only when it is file-backed; it cannot read OS-keychain credentials. `access_token` relays an explicitly provided `CODEX_ACCESS_TOKEN`. The credential is sent only to the configured adapter and is never saved in plugin state or included in the report. On final report collection, the Sailbox is automatically terminated. Do not use either mode for an untrusted sandbox/provider.
