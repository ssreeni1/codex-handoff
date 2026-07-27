#!/usr/bin/env node
/**
 * Small dependency-free MCP server. Providers are external executables so keys
 * and vendor SDKs stay outside the plugin and can be audited independently.
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { spawn } from "node:child_process";

const stateDir = resolve(process.env.HANDOFF_STATE_DIR || ".handoff-state");
const MAX_BRIEF_CHARS = 60_000;
const SECRET = /(api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|cookie|password|secret)\s*[:=]\s*[^\s,;]+/gi;

function reply(id, result) { process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`); }
function fail(id, message) { process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message } })}\n`); }
function text(value) { return { content: [{ type: "text", text: value }] }; }
function redact(value) { return value.replace(SECRET, (match, key) => `${key}: [REDACTED]`); }
function statePath(id) { return resolve(stateDir, `${id}.json`); }
function archivePath(id) { return resolve(stateDir, `${id}.tgz`); }

async function runLocal(command, args) {
  return await new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", code => code === 0 ? resolveRun() : reject(new Error(`${command} failed: ${stderr.slice(-1000)}`)));
  });
}

async function packageWorkspace(workspace, id) {
  const output = archivePath(id);
  await runLocal("tar", ["-czf", output, "--exclude=.git", "--exclude=node_modules", "--exclude=.env", "--exclude=.codex", "-C", workspace, "."]);
  const bytes = await readFile(output);
  if (bytes.length > 48 * 1024 * 1024) throw new Error("Workspace archive exceeds the 48 MiB handoff limit.");
  return bytes.toString("base64");
}

async function syncWorkspace(saved, id, key) {
  const remote = await runAdapter({ protocol_version: 1, action: "sync", handoff_id: id, remote_id: saved.remote.id }, key);
  if (!remote.workspace_archive_base64) throw new Error("Sandbox did not return a workspace archive.");
  const output = archivePath(`${id}.output`);
  await writeFile(output, Buffer.from(remote.workspace_archive_base64, "base64"), { mode: 0o600 });
  await runLocal("tar", ["-xzf", output, "-C", saved.workspace]);
  return remote;
}

async function providerKey() {
  return process.env.SAILBOX_HANDOFF_KEY || process.env.HANDOFF_SANDBOX_API_KEY || "";
}

async function credentialHandoff(args) {
  const mode = args.credential_mode || "none";
  if (mode === "none") {
    throw new Error("Credential forwarding requires explicit user confirmation. Ask whether to forward the local Codex login, then use auth_file or access_token with allow_credential_forwarding: true.");
  }
  if (args.allow_credential_forwarding !== true) {
    throw new Error("Set allow_credential_forwarding: true to send Codex authentication to a sandbox.");
  }
  if (mode === "access_token") {
    const token = process.env.CODEX_ACCESS_TOKEN;
    if (!token) throw new Error("CODEX_ACCESS_TOKEN is not set. This mode does not extract a token from local storage.");
    return { type: "codex_access_token", value: token };
  }
  if (mode === "auth_file") {
    const codexHome = process.env.CODEX_HOME || resolve(homedir(), ".codex");
    const path = resolve(codexHome, "auth.json");
    let contents;
    try { contents = await readFile(path, "utf8"); } catch {
      throw new Error(`No readable auth.json at ${path}. Your login may be stored in the OS keychain; use access_token mode or change Codex to file credential storage.`);
    }
    try { JSON.parse(contents); } catch { throw new Error(`Refusing to forward invalid JSON from ${path}.`); }
    return { type: "codex_auth_json", value: contents };
  }
  throw new Error("credential_mode must be one of: none, auth_file, access_token.");
}

async function runAdapter(payload, key) {
  const command = process.env.HANDOFF_PROVIDER_COMMAND;
  if (!command) throw new Error("No provider configured. Set HANDOFF_PROVIDER_COMMAND to an executable adapter path.");
  const [bin, ...args] = command.split(/\s+/);
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(bin, args, {
      env: { ...process.env, SANDBOX_API_KEY: key },
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", code => {
      if (code !== 0) return reject(new Error(`Provider adapter exited ${code}: ${stderr.trim()}`));
      try { resolvePromise(JSON.parse(stdout)); } catch { reject(new Error("Provider adapter must write one JSON object to stdout.")); }
    });
    child.stdin.end(JSON.stringify(payload));
  });
}

async function handoff(args) {
  if (!args.task?.trim()) throw new Error("task is required");
  const key = await providerKey();
  if (!key) {
    throw new Error("SAILBOX_HANDOFF_KEY is not set for Codex Handoff.");
  }
  const history = redact(String(args.conversation_history || ""));
  const brief = {
    protocol_version: 1,
    action: "launch",
    handoff_id: randomUUID(),
    task: redact(args.task).slice(0, MAX_BRIEF_CHARS),
    conversation_history: history.slice(0, MAX_BRIEF_CHARS),
    workspace: args.workspace || process.cwd(),
    requested_at: new Date().toISOString()
  };
  await mkdir(stateDir, { recursive: true });
  const workspace_archive_base64 = await packageWorkspace(brief.workspace, brief.handoff_id);
  const credential_handoff = await credentialHandoff(args);
  const remote = await runAdapter({ ...brief, credential_handoff, workspace_archive_base64 }, key);
  if (!remote.id) throw new Error("Provider adapter response must include id.");
  await writeFile(statePath(brief.handoff_id), JSON.stringify({ ...brief, remote, created_at: new Date().toISOString() }, null, 2), { mode: 0o600 });
  return text(`Sandbox started. Handoff ID: ${brief.handoff_id}\nRemote ID: ${remote.id}${remote.url ? `\nURL: ${remote.url}` : ""}${credential_handoff ? `\nCodex authentication forwarded via ${credential_handoff.type}; it was not saved locally.` : "\nNo Codex authentication was forwarded."}\nUse handoff_status with the handoff ID to collect the report.`);
}

async function status(args) {
  return await collectStatus(args.handoff_id);
}

async function collectStatus(handoffId) {
  if (!handoffId) throw new Error("handoff_id is required");
  const saved = JSON.parse(await readFile(statePath(handoffId), "utf8"));
  const key = await providerKey();
  if (!key) throw new Error("No Sail key is available to check this handoff.");
  const remote = await runAdapter({ protocol_version: 1, action: "status", handoff_id: handoffId, remote_id: saved.remote.id }, key);
  if (remote.status === "complete" && remote.report) {
    const synced = await syncWorkspace(saved, handoffId, key);
    const digest = createHash("sha256").update(remote.report).digest("hex").slice(0, 12);
    return text(`Sandbox workspace synchronized and Sailbox terminated.\n\nSandbox report (sha256:${digest}):\n\n${remote.report}`);
  }
  return text(`Sandbox status: ${remote.status || "unknown"}${remote.url ? `\nURL: ${remote.url}` : ""}${remote.detail ? `\n\n${remote.detail}` : ""}`);
}

async function waitForReport(args) {
  if (!args.handoff_id) throw new Error("handoff_id is required");
  const maxSeconds = Math.max(1, Math.min(Number(args.max_wait_seconds || 55), 55));
  const deadline = Date.now() + maxSeconds * 1000;
  let result;
  do {
    result = await collectStatus(args.handoff_id);
    if (!result.content[0].text.startsWith("Sandbox status: running")) return result;
    if (Date.now() >= deadline) return result;
    await new Promise(resolveSleep => setTimeout(resolveSleep, 5000));
  } while (Date.now() < deadline);
  return result;
}

const tools = [
  { name: "handoff", description: "Start a configured sandbox only after explicit approval to forward Codex credentials. It never starts an unauthenticated sandbox.", inputSchema: { type: "object", required: ["task", "credential_mode", "allow_credential_forwarding"], properties: { task: { type: "string" }, conversation_history: { type: "string", description: "A concise current-task history supplied by the caller." }, workspace: { type: "string" }, credential_mode: { type: "string", enum: ["auth_file", "access_token"] }, allow_credential_forwarding: { type: "boolean", const: true, description: "Explicit user confirmation to forward the selected Codex credential to this trusted Sailbox." } } } },
  { name: "handoff_status", description: "Poll a sandbox handoff and return its final report when complete.", inputSchema: { type: "object", required: ["handoff_id"], properties: { handoff_id: { type: "string" } } } }
  ,{ name: "handoff_wait", description: "Wait up to 55 seconds for a handoff report. Call repeatedly until it returns the final report, then relay its results and next-step plan to the initiating chat.", inputSchema: { type: "object", required: ["handoff_id"], properties: { handoff_id: { type: "string" }, max_wait_seconds: { type: "number", minimum: 1, maximum: 55 } } } }
];
process.stdin.setEncoding("utf8");
let buffer = "";
process.stdin.on("data", data => { buffer += data; let n; while ((n = buffer.indexOf("\n")) >= 0) { const line = buffer.slice(0, n); buffer = buffer.slice(n + 1); if (line.trim()) handle(line); } });
async function handle(line) { let req; try { req = JSON.parse(line); } catch { return; } try {
  if (req.method === "initialize") return reply(req.id, { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "codex-handoff", version: "0.1.0" } });
  if (req.method === "tools/list") return reply(req.id, { tools });
  if (req.method === "tools/call") return reply(req.id, req.params.name === "handoff" ? await handoff(req.params.arguments || {}) : req.params.name === "handoff_status" ? await status(req.params.arguments || {}) : req.params.name === "handoff_wait" ? await waitForReport(req.params.arguments || {}) : (() => { throw new Error("Unknown tool"); })());
  if (req.id !== undefined) reply(req.id, {});
} catch (error) { if (req.id !== undefined) fail(req.id, error.message); } }
