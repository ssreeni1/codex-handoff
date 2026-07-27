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

## Use

Ask Codex to `/handoff`. It must ask for explicit permission before it forwards your Codex login. The original chat remains available while the Sailbox works. Say “check in on the sandbox” to retrieve progress; when complete, its workspace is merged into the initiating local workspace and the Sailbox is terminated.

## Security and data

- No Sail or Codex credential is written to repository files or plugin state.
- The local workspace upload excludes `.git`, `node_modules`, `.env`, and `.codex`.
- Sandbox control files, logs, and the handoff brief are not copied back.
- Workspace archives are capped at 48 MiB in each direction.
- The plugin creates private Sailboxes only.

`auth_file` uses `$CODEX_HOME/auth.json` and only works for file-backed Codex authentication. `access_token` uses `CODEX_ACCESS_TOKEN`. Do not approve forwarding to a provider/account you do not trust.

## Development

```sh
npm ci
node --check server/index.mjs
node --check scripts/sailbox-provider.mjs
```

The server is dependency-free; only the Sail adapter uses `@sailresearch/sdk`. `scripts/mock-provider.mjs` is a protocol-only test fixture and never creates a sandbox.
