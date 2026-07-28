#!/usr/bin/env node
/**
 * Small dependency-free MCP server. Providers are external executables so keys
 * and vendor SDKs stay outside the plugin and can be audited independently.
 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, unlink, stat } from "node:fs/promises";
import { resolve, relative, sep } from "node:path";
import { homedir } from "node:os";
import { spawn } from "node:child_process";

const stateDir = resolve(process.env.HANDOFF_STATE_DIR || ".handoff-state");
const MAX_BRIEF_CHARS = 60_000;
const MAX_SYNC_BYTES = 48 * 1024 * 1024;
const EXCLUDED_PATH_SEGMENTS = new Set([".git", ".codex", ".env", "node_modules", ".aws", ".ssh", ".gcloud", ".kube"]);
const AUTO_POLL_MS = Math.max(5_000, Number(process.env.HANDOFF_AUTO_POLL_MS || 10_000));
const WATCHER_URI = "ui://codex-handoff/watcher.html";
const cleanupTimers = new Map();
const SECRET = /(api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|cookie|password|secret)\s*[:=]\s*[^\s,;]+/gi;

function reply(id, result) { process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`); }
function fail(id, message) { process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message } })}\n`); }
function text(value, structuredContent) { return { content: [{ type: "text", text: value }], ...(structuredContent ? { structuredContent } : {}) }; }
function notify(value) { process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/message", params: { level: "info", data: value } })}\n`); }
function redact(value) { return value.replace(SECRET, (match, key) => `${key}: [REDACTED]`); }
function statePath(id) { return resolve(stateDir, `${id}.json`); }
function archivePath(id) { return resolve(stateDir, `${id}.tgz`); }

function stopAutoCleanup(handoffId) {
  const timer = cleanupTimers.get(handoffId);
  if (timer) clearInterval(timer);
  cleanupTimers.delete(handoffId);
}

function startAutoCleanup(handoffId) {
  let polling = false;
  const poll = async () => {
    if (polling) return;
    polling = true;
    try {
      const result = await collectStatus(handoffId);
      if (!result.content[0].text.startsWith("Sandbox status: running")) {
        stopAutoCleanup(handoffId);
        notify(`Codex Handoff finished. Files were synchronized and the Sailbox was terminated. Call handoff_status with ${handoffId} to read the sandbox report and plan.`);
      }
    } catch {
      // A transient provider error is retried on the next interval. The user
      // can still inspect the handoff with handoff_status.
    } finally { polling = false; }
  };
  const timer = setInterval(poll, AUTO_POLL_MS);
  timer.unref();
  cleanupTimers.set(handoffId, timer);
  void poll();
}

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
  const directory = await stat(workspace).catch(() => null);
  if (!directory?.isDirectory()) throw new Error("workspace must be a readable directory.");
  try {
    await runLocal("tar", ["-czf", output, "--exclude=.git", "--exclude=.codex", "--exclude=.env", "--exclude=.env.*", "--exclude=node_modules", "--exclude=.npmrc", "--exclude=.pypirc", "--exclude=.aws", "--exclude=.ssh", "--exclude=.gcloud", "--exclude=.kube", "--exclude=*.pem", "--exclude=*.key", "--exclude=id_rsa", "-C", workspace, "."]);
    const bytes = await readFile(output);
    if (bytes.length > MAX_SYNC_BYTES) throw new Error("Workspace archive exceeds the 48 MiB handoff limit.");
    return bytes.toString("base64");
  } finally {
    await unlink(output).catch(() => {});
  }
}

async function syncWorkspace(saved, id, key) {
  const remote = await runAdapter({ protocol_version: 1, action: "sync", handoff_id: id, remote_id: saved.remote.id }, key);
  if (!Array.isArray(remote.files)) throw new Error("Sandbox did not return a file manifest.");
  let bytes = 0;
  const files = remote.files.map(file => {
    if (!file || typeof file.path !== "string" || typeof file.data_base64 !== "string") throw new Error("Sandbox returned an invalid file manifest.");
    const normalized = file.path.replaceAll("\\\\", "/");
    const segments = normalized.split("/");
    if (!normalized || normalized.startsWith("/") || segments.some(segment => !segment || segment === "." || segment === ".." || EXCLUDED_PATH_SEGMENTS.has(segment) || segment === ".npmrc" || segment === ".pypirc" || segment === "id_rsa" || /\.(pem|key)$/i.test(segment))) {
      throw new Error(`Refusing unsafe sandbox path: ${file.path}`);
    }
    const target = resolve(saved.workspace, normalized);
    if (relative(saved.workspace, target).startsWith(`..${sep}`) || relative(saved.workspace, target) === "..") throw new Error(`Refusing path outside workspace: ${file.path}`);
    const data = Buffer.from(file.data_base64, "base64");
    bytes += data.length;
    if (bytes > MAX_SYNC_BYTES) throw new Error("Sandbox file sync exceeds the 48 MiB limit.");
    return { target, data, mode: Number.isInteger(file.mode) ? file.mode & 0o777 : 0o644 };
  });
  for (const file of files) {
    await mkdir(resolve(file.target, ".."), { recursive: true, mode: 0o700 });
    await writeFile(file.target, file.data, { mode: file.mode || 0o644 });
  }
  return { files: files.length, bytes };
}

async function providerKey() {
  return process.env.SAILBOX_HANDOFF_KEY || process.env.HANDOFF_SANDBOX_API_KEY || "";
}

async function doctor() {
  const codexHome = process.env.CODEX_HOME || resolve(homedir(), ".codex");
  const authFileAvailable = await readFile(resolve(codexHome, "auth.json"), "utf8").then(() => true).catch(() => false);
  const keySource = process.env.SAILBOX_HANDOFF_KEY ? "SAILBOX_HANDOFF_KEY" : process.env.HANDOFF_SANDBOX_API_KEY ? "HANDOFF_SANDBOX_API_KEY" : "missing";
  const lines = [
    "Codex Handoff diagnostics (credential values are never displayed):",
    `- Sail key: ${keySource === "missing" ? "missing" : `available via ${keySource}`}`,
    `- Provider adapter: ${process.env.HANDOFF_PROVIDER_COMMAND ? "configured" : "missing"}`,
    `- File-backed Codex auth: ${authFileAvailable ? "available" : "not found"}`,
    `- Access-token auth: ${process.env.CODEX_ACCESS_TOKEN ? "available" : "not set"}`
  ];
  if (keySource === "missing") {
    lines.push(process.platform === "darwin"
      ? "- Fix for Codex Desktop on macOS: run `launchctl setenv SAILBOX_HANDOFF_KEY 'your-key'`, fully quit Codex, then reopen it."
      : "- Fix: configure SAILBOX_HANDOFF_KEY in the environment of the Codex process, then restart Codex.");
  }
  return text(lines.join("\n"));
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

function requestedModel(args) {
  if (!args.model) return undefined;
  if (typeof args.model !== "string" || !/^[A-Za-z0-9._:/-]+$/.test(args.model)) throw new Error("model must contain only letters, numbers, '.', '_', ':', '/', or '-'.");
  return args.model;
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
    throw new Error("Codex Handoff cannot see SAILBOX_HANDOFF_KEY. For Codex Desktop, set it in the app's environment (on macOS: `launchctl setenv SAILBOX_HANDOFF_KEY 'your-key'`), fully quit Codex, then reopen it. Call handoff_doctor for safe diagnostics.");
  }
  const history = redact(String(args.conversation_history || ""));
  const model = requestedModel(args);
  const brief = {
    protocol_version: 1,
    action: "launch",
    handoff_id: randomUUID(),
    task: redact(args.task).slice(0, MAX_BRIEF_CHARS),
    conversation_history: history.slice(0, MAX_BRIEF_CHARS),
    workspace: args.workspace || process.cwd(),
    requested_at: new Date().toISOString(),
    model
  };
  await mkdir(stateDir, { recursive: true });
  let workspace_archive_base64 = await packageWorkspace(brief.workspace, brief.handoff_id);
  const credential_handoff = await credentialHandoff(args);
  let remote;
  try { remote = await runAdapter({ ...brief, credential_handoff, workspace_archive_base64 }, key); }
  finally { workspace_archive_base64 = undefined; }
  if (!remote.id) throw new Error("Provider adapter response must include id.");
  await writeFile(statePath(brief.handoff_id), JSON.stringify({ handoff_id: brief.handoff_id, workspace: brief.workspace, remote, created_at: new Date().toISOString() }, null, 2), { mode: 0o600 });
  startAutoCleanup(brief.handoff_id);
  return text(`Sandbox started. Handoff ID: ${brief.handoff_id}\nRemote ID: ${remote.id}${remote.url ? `\nURL: ${remote.url}` : ""}\nModel: ${model || "Codex default"}${credential_handoff ? `\nCodex authentication forwarded via ${credential_handoff.type}; it was not saved locally.` : "\nNo Codex authentication was forwarded."}\nThis task will receive the sandbox report automatically when it completes.`, {
    handoff_id: brief.handoff_id,
    remote_id: remote.id,
    status: "running"
  });
}

async function status(args) {
  return await collectStatus(args.handoff_id, true);
}

function completionText(saved) {
  return text(`Sandbox workspace synchronized (${saved.synced_files} files) and Sailbox terminated.\n\nSandbox report and plan:\n\n${saved.final_report}`);
}

async function collectStatus(handoffId, deliverReport = false) {
  if (!handoffId) throw new Error("handoff_id is required");
  const saved = JSON.parse(await readFile(statePath(handoffId), "utf8"));
  if (saved.completed_at || saved.failed_at) {
    if (saved.final_report && deliverReport) {
      const result = saved.completed_at ? completionText(saved) : text(`Sandbox failed and was terminated.\n\n${saved.final_report}`);
      await writeFile(statePath(handoffId), JSON.stringify({ ...saved, final_report: undefined, report_delivered_at: new Date().toISOString() }, null, 2), { mode: 0o600 });
      return result;
    }
    return text(`Sandbox handoff already ${saved.completed_at ? "completed and synchronized" : "failed and terminated"}.`);
  }
  const key = await providerKey();
  if (!key) throw new Error("No Sail key is available to check this handoff.");
  const remote = await runAdapter({ protocol_version: 1, action: "status", handoff_id: handoffId, remote_id: saved.remote.id }, key);
  if (remote.status === "complete" && remote.report) {
    const synced = await syncWorkspace(saved, handoffId, key);
    await runAdapter({ protocol_version: 1, action: "terminate", handoff_id: handoffId, remote_id: saved.remote.id }, key);
    const completed = { handoff_id: handoffId, workspace: saved.workspace, remote: saved.remote, created_at: saved.created_at, completed_at: new Date().toISOString(), synced_files: synced.files, final_report: remote.report };
    await writeFile(statePath(handoffId), JSON.stringify(completed, null, 2), { mode: 0o600 });
    stopAutoCleanup(handoffId);
    const result = text(`Sandbox workspace synchronized (${synced.files} files) and Sailbox terminated.\n\nSandbox report and plan:\n\n${remote.report}`);
    if (deliverReport) await writeFile(statePath(handoffId), JSON.stringify({ ...completed, final_report: undefined, report_delivered_at: new Date().toISOString() }, null, 2), { mode: 0o600 });
    return result;
  }
  if (remote.status === "failed") {
    await runAdapter({ protocol_version: 1, action: "terminate", handoff_id: handoffId, remote_id: saved.remote.id }, key).catch(() => {});
    const failed = { handoff_id: handoffId, workspace: saved.workspace, remote: saved.remote, created_at: saved.created_at, failed_at: new Date().toISOString(), final_report: remote.report || "No sandbox report was available." };
    await writeFile(statePath(handoffId), JSON.stringify(failed, null, 2), { mode: 0o600 });
    stopAutoCleanup(handoffId);
    const result = text(`Sandbox failed and was terminated.\n\n${failed.final_report}`);
    if (deliverReport) await writeFile(statePath(handoffId), JSON.stringify({ ...failed, final_report: undefined, report_delivered_at: new Date().toISOString() }, null, 2), { mode: 0o600 });
    return result;
  }
  return text(`Sandbox status: ${remote.status || "unknown"}${remote.url ? `\nURL: ${remote.url}` : ""}${remote.detail ? `\n\n${remote.detail}` : ""}`);
}

async function waitForReport(args) {
  if (!args.handoff_id) throw new Error("handoff_id is required");
  const maxSeconds = Math.max(1, Math.min(Number(args.max_wait_seconds || 55), 55));
  const deadline = Date.now() + maxSeconds * 1000;
  let result;
  do {
    result = await collectStatus(args.handoff_id, true);
    if (!result.content[0].text.startsWith("Sandbox status: running")) return result;
    if (Date.now() >= deadline) return result;
    await new Promise(resolveSleep => setTimeout(resolveSleep, 5000));
  } while (Date.now() < deadline);
  return result;
}

const tools = [
  { name: "handoff_doctor", description: "Safely diagnose Sail-key, provider, and Codex-auth availability without displaying credential values.", inputSchema: { type: "object", properties: {} } },
  { name: "handoff", description: "Start a configured sandbox only after explicit approval to forward Codex credentials. It never starts an unauthenticated sandbox.", inputSchema: { type: "object", required: ["task", "credential_mode", "allow_credential_forwarding"], properties: { task: { type: "string" }, conversation_history: { type: "string", description: "A concise current-task history supplied by the caller." }, workspace: { type: "string" }, model: { type: "string", description: "Optional Codex model for the sandbox, for example gpt-5.4." }, credential_mode: { type: "string", enum: ["auth_file", "access_token"] }, allow_credential_forwarding: { type: "boolean", const: true, description: "Explicit user confirmation to forward the selected Codex credential to this trusted Sailbox." } } }, _meta: { ui: { resourceUri: WATCHER_URI }, "openai/outputTemplate": WATCHER_URI } },
  { name: "handoff_status", description: "Poll a sandbox handoff and return its final report when complete.", inputSchema: { type: "object", required: ["handoff_id"], properties: { handoff_id: { type: "string" } } } }
  ,{ name: "handoff_wait", description: "Wait up to 55 seconds for a handoff report. Call repeatedly until it returns the final report, then relay its results and next-step plan to the initiating chat.", inputSchema: { type: "object", required: ["handoff_id"], properties: { handoff_id: { type: "string" }, max_wait_seconds: { type: "number", minimum: 1, maximum: 55 } } } }
];
process.stdin.setEncoding("utf8");
let buffer = "";
process.stdin.on("data", data => { buffer += data; let n; while ((n = buffer.indexOf("\n")) >= 0) { const line = buffer.slice(0, n); buffer = buffer.slice(n + 1); if (line.trim()) handle(line); } });
async function handle(line) { let req; try { req = JSON.parse(line); } catch { return; } try {
  if (req.method === "initialize") return reply(req.id, { protocolVersion: "2024-11-05", capabilities: { tools: {}, resources: {} }, serverInfo: { name: "codex-handoff", version: "0.1.0" } });
  if (req.method === "resources/list") return reply(req.id, { resources: [{ uri: WATCHER_URI, name: "Codex Handoff watcher", mimeType: "text/html;profile=mcp-app", description: "Shows a running handoff and posts its result back to the initiating task." }] });
  if (req.method === "resources/read") {
    if (req.params?.uri !== WATCHER_URI) throw new Error("Unknown resource");
    return reply(req.id, { contents: [{ uri: WATCHER_URI, mimeType: "text/html;profile=mcp-app", text: await readFile(new URL("../assets/handoff-watcher.html", import.meta.url), "utf8"), _meta: { ui: { prefersBorder: true } } }] });
  }
  if (req.method === "tools/list") return reply(req.id, { tools });
  if (req.method === "tools/call") return reply(req.id, req.params.name === "handoff_doctor" ? await doctor() : req.params.name === "handoff" ? await handoff(req.params.arguments || {}) : req.params.name === "handoff_status" ? await status(req.params.arguments || {}) : req.params.name === "handoff_wait" ? await waitForReport(req.params.arguments || {}) : (() => { throw new Error("Unknown tool"); })());
  if (req.id !== undefined) reply(req.id, {});
} catch (error) { if (req.id !== undefined) fail(req.id, error.message); } }
