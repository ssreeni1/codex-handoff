import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

const root = new URL("..", import.meta.url).pathname;

function startServer(env) {
  const child = spawn("node", [join(root, "server/index.mjs")], { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] });
  let buffer = "";
  const replies = [];
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", chunk => { buffer += chunk; let index; while ((index = buffer.indexOf("\n")) >= 0) { replies.push(JSON.parse(buffer.slice(0, index))); buffer = buffer.slice(index + 1); } });
  return {
    child,
    async call(id, name, args) {
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } })}\n`);
      while (!replies.some(reply => reply.id === id)) await new Promise(resolve => setTimeout(resolve, 10));
      const index = replies.findIndex(reply => reply.id === id);
      return replies.splice(index, 1)[0];
    }
  };
}

test("handoff syncs only provider-manifest files and retains no task history", async t => {
  const base = await mkdtemp(join(tmpdir(), "codex-handoff-test-"));
  const workspace = join(base, "workspace");
  const codexHome = join(base, "codex-home");
  const state = join(base, "state");
  await mkdir(workspace); await mkdir(codexHome);
  await writeFile(join(workspace, "source.txt"), "local source\n");
  await writeFile(join(workspace, ".env"), "must-not-leave-local\n");
  await writeFile(join(codexHome, "auth.json"), "{}\n");
  const server = startServer({ SAILBOX_HANDOFF_KEY: "test-key", CODEX_HOME: codexHome, HANDOFF_STATE_DIR: state, HANDOFF_PROVIDER_COMMAND: `node ${join(root, "scripts/mock-provider.mjs")}` });
  t.after(() => server.child.kill());
  const doctor = await server.call(1, "handoff_doctor", {});
  assert.match(doctor.result.content[0].text, /available via SAILBOX_HANDOFF_KEY/);
  assert.doesNotMatch(doctor.result.content[0].text, /test-key/);
  const launch = await server.call(2, "handoff", { task: "test task", conversation_history: "secret-token: no-store", workspace, model: "gpt-5.4", credential_mode: "auth_file", allow_credential_forwarding: true });
  assert.equal(launch.error, undefined);
  assert.match(launch.result.content[0].text, /Model: gpt-5.4/);
  const handoffId = launch.result.content[0].text.match(/Handoff ID: ([\w-]+)/)[1];
  const completion = await server.call(3, "handoff_status", { handoff_id: handoffId });
  assert.match(completion.result.content[0].text, /synchronized \(1 files\)/);
  assert.match(completion.result.content[0].text, /Mock provider completed successfully/);
  assert.equal(await readFile(join(workspace, "mock-result.txt"), "utf8"), "Mock sync completed.\n");
  assert.equal(await readFile(join(workspace, ".env"), "utf8"), "must-not-leave-local\n");
  const stateText = await readFile(join(state, `${handoffId}.json`), "utf8");
  assert.doesNotMatch(stateText, /secret-token|test task/);
  assert.doesNotMatch(stateText, /Mock provider completed successfully/);
  assert.match(stateText, /report_delivered_at/);
});

test("handoff rejects an unsafe model name", async t => {
  const base = await mkdtemp(join(tmpdir(), "codex-handoff-test-"));
  const workspace = join(base, "workspace");
  const codexHome = join(base, "codex-home");
  await mkdir(workspace); await mkdir(codexHome);
  await writeFile(join(codexHome, "auth.json"), "{}\n");
  const server = startServer({ SAILBOX_HANDOFF_KEY: "test-key", CODEX_HOME: codexHome, HANDOFF_STATE_DIR: join(base, "state"), HANDOFF_PROVIDER_COMMAND: `node ${join(root, "scripts/mock-provider.mjs")}` });
  t.after(() => server.child.kill());
  const launch = await server.call(1, "handoff", { task: "test task", workspace, model: "gpt-5.4;bad", credential_mode: "auth_file", allow_credential_forwarding: true });
  assert.match(launch.error.message, /model must contain only/);
});

test("doctor identifies a missing Sail key without exposing environment values", async t => {
  const base = await mkdtemp(join(tmpdir(), "codex-handoff-test-"));
  const server = startServer({ CODEX_HOME: join(base, "no-auth"), HANDOFF_STATE_DIR: join(base, "state"), HANDOFF_PROVIDER_COMMAND: "node missing-provider.mjs" });
  t.after(() => server.child.kill());
  const doctor = await server.call(1, "handoff_doctor", {});
  assert.match(doctor.result.content[0].text, /Sail key: missing/);
  assert.match(doctor.result.content[0].text, /launchctl setenv SAILBOX_HANDOFF_KEY/);
});

test("handoff rejects a sandbox path that escapes its workspace", async t => {
  const base = await mkdtemp(join(tmpdir(), "codex-handoff-test-"));
  const workspace = join(base, "workspace");
  const codexHome = join(base, "codex-home");
  const state = join(base, "state");
  await mkdir(workspace); await mkdir(codexHome);
  await writeFile(join(codexHome, "auth.json"), "{}\n");
  const server = startServer({ SAILBOX_HANDOFF_KEY: "test-key", CODEX_HOME: codexHome, HANDOFF_STATE_DIR: state, HANDOFF_PROVIDER_COMMAND: `node ${join(root, "scripts/mock-provider.mjs")}`, MOCK_UNSAFE_PATH: "1" });
  t.after(() => server.child.kill());
  const launch = await server.call(1, "handoff", { task: "test task", workspace, credential_mode: "auth_file", allow_credential_forwarding: true });
  const handoffId = launch.result.content[0].text.match(/Handoff ID: ([\w-]+)/)[1];
  const completion = await server.call(2, "handoff_status", { handoff_id: handoffId });
  assert.match(completion.error.message, /Refusing unsafe sandbox path/);
});
