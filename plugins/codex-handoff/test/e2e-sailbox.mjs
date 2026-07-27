// Run manually with SAILBOX_HANDOFF_KEY set. This intentionally forwards the
// file-backed Codex login, so it is not part of the default test suite.
import { spawn } from "node:child_process";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const workspace = process.argv[2];
if (!workspace) throw new Error("Usage: node test/e2e-sailbox.mjs /absolute/workspace/path");
if (!process.env.SAILBOX_HANDOFF_KEY) throw new Error("SAILBOX_HANDOFF_KEY is required.");
const state = await mkdtemp(join(tmpdir(), "codex-handoff-e2e-"));
await mkdir(state, { recursive: true });
const root = new URL("..", import.meta.url).pathname;
const child = spawn("node", [join(root, "server/index.mjs")], { env: { ...process.env, HANDOFF_STATE_DIR: state, HANDOFF_PROVIDER_COMMAND: `node ${join(root, "scripts/sailbox-provider.mjs")}` }, stdio: ["pipe", "pipe", "inherit"] });
let buffer = "";
const pending = new Map();
child.stdout.setEncoding("utf8");
child.stdout.on("data", chunk => { buffer += chunk; let end; while ((end = buffer.indexOf("\n")) >= 0) { const message = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1); pending.get(message.id)?.(message); } });
let id = 0;
function call(name, args) {
  const requestId = ++id;
  return new Promise(resolve => { pending.set(requestId, value => { pending.delete(requestId); resolve(value); }); child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: requestId, method: "tools/call", params: { name, arguments: args } })}\n`); });
}
try {
  const launch = await call("handoff", {
    task: "End-to-end handoff test. Work only in this Conway's Game of Life project. Run its existing test suite, inspect the implementation, and create HANDOFF_E2E.md with the test result, one concise observation, and a recommended next step. Do not modify existing source files.",
    conversation_history: "This is an authorized end-to-end validation of Codex Handoff. Do not include secrets in generated files.",
    workspace,
    credential_mode: "auth_file",
    allow_credential_forwarding: true
  });
  if (launch.error) throw new Error(launch.error.message);
  const handoffId = launch.result.content[0].text.match(/Handoff ID: ([\w-]+)/)?.[1];
  if (!handoffId) throw new Error("Handoff launch returned no handoff ID.");
  console.log(`Started Sailbox handoff ${handoffId}.`);
  for (;;) {
    await new Promise(resolve => setTimeout(resolve, 15_000));
    const update = await call("handoff_status", { handoff_id: handoffId });
    if (update.error) throw new Error(update.error.message);
    const text = update.result.content[0].text;
    console.log(text.slice(0, 1600));
    if (!text.startsWith("Sandbox status: running")) break;
  }
} finally {
  child.kill();
}
