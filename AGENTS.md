# Codex Handoff contributor guide

Codex Handoff is a Codex plugin that delegates work to a private Sailbox. Treat
credential handling and local-workspace synchronization as security-sensitive.

## Quick start

```sh
cd plugins/codex-handoff
npm ci
npm test
node --check server/index.mjs
node --check scripts/sailbox-provider.mjs
```

The plugin reads the Sail credential only from `SAILBOX_HANDOFF_KEY` (with the
generic `HANDOFF_SANDBOX_API_KEY` compatibility fallback). Never add a key,
token, auth file, or real conversation transcript to the repository or tests.

## Design constraints

- Never launch a sandbox or forward Codex credentials without explicit user approval.
- Do not weaken the upload exclusions or manifest-path validation. Sandbox output
  must remain regular files under the selected workspace; never extract a
  sandbox-provided archive locally.
- Keep handoff state free of task text, conversation history, and credentials.
- Completed and failed handoffs must terminate their Sailbox. Preserve the
  background cleanup behavior when changing lifecycle code.
- Keep the provider boundary small: `launch`, `status`, `sync`, and `terminate`
  exchange one JSON object over standard input/output.

## Tests and releases

`npm test` uses the mock provider and must pass for every change. The optional
`test/e2e-sailbox.mjs` forwards file-backed Codex authentication and writes to
the workspace supplied to it; run it only with explicit user approval and a
disposable workspace.

Before release, run the plugin manifest validator and scan staged changes for
credential values. Do not commit generated `.state` data, `node_modules`, or
unrelated workspace files.
