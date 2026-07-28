import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";

const watcher = await readFile(new URL("../assets/handoff-watcher.html", import.meta.url), "utf8");
const script = watcher.match(/<script>([\s\S]*?)<\/script>/)?.[1];

test("watcher posts a valid completion message to its host", async () => {
  const posted = [];
  const elements = new Map([["status", { textContent: "" }], ["detail", { textContent: "" }]]);
  let onMessage;
  const parent = { postMessage: message => posted.push(message) };
  const context = vm.createContext({
    document: { getElementById: id => elements.get(id) }, parent,
    addEventListener: (name, handler) => { if (name === "message") onMessage = handler; },
    setTimeout: () => 0, Map, Promise
  });
  vm.runInContext(script, context);
  onMessage({ source: parent, data: { jsonrpc: "2.0", method: "ui/notifications/tool-result", params: { structuredContent: { handoff_id: "handoff-1" } } } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(posted[0].method, "tools/call");
  assert.equal(posted[0].params.name, "handoff_status");
  assert.equal(posted[0].params.arguments.handoff_id, "handoff-1");
  onMessage({ source: parent, data: { jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "Sandbox workspace synchronized (1 files) and Sailbox terminated." }] } } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(posted[1].method, "ui/message");
  assert.equal(posted[1].params.role, "user");
  assert.equal(posted[1].params.content[0].type, "text");
  assert.match(posted[1].params.content[0].text, /Codex Handoff completed/);
});
