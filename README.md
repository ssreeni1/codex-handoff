# Codex Handoff

Run a Codex task in a private [Sailbox](https://www.sailresearch.com/sailboxes) and bring the completed work back to the chat and workspace that started it.

Codex Handoff is a small, open-source Codex plugin for work that is useful to delegate but should not hold up the initiating chat. It is Sailbox-first today, with a deliberately narrow provider interface for adding other sandbox backends later.

## What it does

1. You ask Codex to `/handoff` a task.
2. Codex asks for explicit permission before it forwards your Codex login to a private sandbox.
3. The plugin creates a Sailbox, uploads a filtered copy of the workspace, and starts Codex there.
4. Your original chat stays available while the plugin monitors the handoff in the background.
5. When the remote task finishes, its report and next plan are returned to the initiating chat; changed files are synced to the local workspace before the Sailbox is terminated.

## Install

Requirements:

- Codex CLI or Desktop
- Node.js 22 or newer
- A Sail API key

```sh
git clone https://github.com/ssreeni1/codex-handoff.git
cd codex-handoff/plugins/codex-handoff
npm ci
cd ../..
codex plugin marketplace add "$(pwd)"
codex plugin add codex-handoff@personal
```

Give the Codex process your Sail key through its environment. Do not commit it or put it in plugin configuration:

```sh
export SAILBOX_HANDOFF_KEY='your-sail-api-key'
```

Restart Codex and open a new task after installing. For Codex Desktop, configure this environment variable through your OS or secret manager so the app process inherits it.

### Codex Desktop on macOS

A terminal `export` does not reach an already-running Desktop app. Set the key
for the GUI login session, then fully quit and reopen Codex:

```sh
launchctl setenv SAILBOX_HANDOFF_KEY='your-sail-api-key'
```

Use `launchctl unsetenv SAILBOX_HANDOFF_KEY` to remove it. In a Codex task, ask
for `handoff_doctor` to confirm the plugin can see the key without displaying it.

## Use

Ask Codex to `/handoff`. It will prepare a concise handoff brief, then request your approval before a sandbox is created or any authentication is forwarded.

The sandbox treats that brief as a goal: it creates an implementation plan, executes the plan, verifies its work, and returns the plan with its results. To choose the sandbox model, say for example: “`/handoff` this using `gpt-5.4`.” If no model is named, Codex uses its configured default.

If setup fails, ask Codex to run `handoff_doctor`. It reports key, provider, and
authentication availability without revealing credential values.

After approval, your local task is free to continue. The in-chat handoff card checks the sandbox in the background. On completion, it synchronizes workspace changes locally, stops the Sailbox, and posts the sandbox report and plan back into the task automatically. You can still ask for a status check at any time.

## Security model

- Sailboxes are created as private.
- Codex authentication is never forwarded without explicit approval for that handoff.
- Sail credentials and Codex credentials are not written to the repository or plugin state.
- Uploads exclude `.git`, `node_modules`, `.env`, and `.codex`.
- Uploads and returned file manifests are limited to 48 MiB.
- Sandbox output is returned as a regular-file manifest, not an archive. Paths that escape the workspace or target credential/configuration locations are rejected.
- Control files, logs, and the handoff brief are excluded from the files copied back.

Only approve authentication forwarding to a Sail account and sandbox provider you trust. File-backed login uses `$CODEX_HOME/auth.json`; token-based login uses `CODEX_ACCESS_TOKEN`. The local handoff record deliberately stores only the remote ID, workspace path, and lifecycle metadata—not the task, conversation history, or credentials.

## Development

The plugin source lives in [`plugins/codex-handoff`](plugins/codex-handoff). Its [plugin README](plugins/codex-handoff/README.md) contains the focused development commands and implementation notes.

```sh
cd plugins/codex-handoff
npm ci
node --check server/index.mjs
node --check scripts/sailbox-provider.mjs
```

## License

[MIT](LICENSE)
