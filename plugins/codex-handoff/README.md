# Codex Handoff

Run a Codex task in a private [Sailbox](https://www.sailresearch.com/sailboxes) without losing the initiating chat. The plugin asks before forwarding Codex authentication, packages the workspace into the Sailbox, and synchronizes completed work back before termination.

## Install

Requirements: Codex CLI/Desktop, Node 22+, and a Sail API key.

```sh
git clone <this-repository-url> codex-handoff
cd codex-handoff/plugins/codex-handoff
npm ci
cd ../..
codex plugin marketplace add "$(pwd)"
codex plugin add codex-handoff@personal
```

Give Codex the Sail key as an environment variable. Never commit it.

```sh
export SAILBOX_HANDOFF_KEY='...'
```

Restart Codex and start a new task after installation. Use your operating system or secret manager to provide this environment variable to the Codex process.

On macOS with Codex Desktop, a terminal `export` is insufficient for an already-running app. Run `launchctl setenv SAILBOX_HANDOFF_KEY='your-sail-api-key'`, fully quit Codex, then reopen it. Ask Codex to run `handoff_doctor` to safely confirm configuration; it never displays credential values.

## Use

Ask Codex to `/handoff`. It must ask for explicit permission before it forwards your Codex login. The brief becomes the sandbox's goal: it creates a plan, executes it to completion, verifies the result, and returns the plan in its final report. To select a model, ask for `/handoff` using that model (for example `gpt-5.4`); otherwise Codex uses its configured default. The original chat remains available while the Sailbox works. While the Codex task stays open, the plugin polls in the background and terminates completed or failed Sailboxes. Completion produces a best-effort MCP notification; say “check in on the sandbox” to retrieve the retained final report and plan. The report is removed from plugin state after it is delivered.

If a handoff cannot start, use `handoff_doctor` before retrying. It reports whether the Codex process can see a Sail key, provider adapter, and usable authentication without exposing their values.

## Security and data

- No Sail or Codex credential is written to repository files or plugin state.
- The local workspace upload excludes `.git`, `node_modules`, `.env`, and `.codex`.
- Sandbox control files, logs, and the handoff brief are not copied back.
- Uploads and returned file manifests are capped at 48 MiB.
- Sandbox output is a validated regular-file manifest, never an archive extracted into the local workspace.
- The plugin creates private Sailboxes only.

`auth_file` uses `$CODEX_HOME/auth.json` and only works for file-backed Codex authentication. `access_token` uses `CODEX_ACCESS_TOKEN`. Do not approve forwarding to a provider/account you do not trust.

## Development

```sh
npm ci
node --check server/index.mjs
node --check scripts/sailbox-provider.mjs
npm test
```

The server is dependency-free; only the Sail adapter uses `@sailresearch/sdk`. `scripts/mock-provider.mjs` is a protocol-only test fixture and never creates a sandbox.

To run the opt-in live test against a disposable workspace, provide `SAILBOX_HANDOFF_KEY` and run:

```sh
node test/e2e-sailbox.mjs /absolute/path/to/workspace [model]
```

This test forwards file-backed Codex authentication and lets the sandbox write to the supplied workspace. Use a disposable copy, not a project with uncommitted work.
