#!/usr/bin/env node
/**
 * Sailbox adapter for the Codex Handoff provider protocol.
 * stdout is reserved for one protocol response; diagnostics go to stderr.
 */
import { App, Client, Sailbox } from "@sailresearch/sdk";

const APP_NAME = process.env.HANDOFF_SAIL_APP || "codex-handoff";
const BOX_SIZE = process.env.HANDOFF_SAIL_SIZE || "s";
const WORKSPACE = "/workspace/codex-handoff";
const BRIEF_PATH = `${WORKSPACE}/brief.md`;
const REPORT_PATH = `${WORKSPACE}/report.md`;
const RESULT_PATH = `${WORKSPACE}/result.json`;
const RUNNER_PATH = `${WORKSPACE}/run-handoff.sh`;
const LOG_PATH = `${WORKSPACE}/handoff.log`;
const INPUT_ARCHIVE = "/tmp/codex-handoff-input.tgz";
const OUTPUT_ARCHIVE = "/tmp/codex-handoff-output.tgz";

async function readRequest() {
  let body = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) body += chunk;
  if (!body.trim()) throw new Error("Expected a JSON provider request on stdin.");
  return JSON.parse(body);
}

function taskBrief(request) {
  return `# Codex sandbox handoff\n\n## Task\n${request.task}\n\n## Conversation context\n${request.conversation_history || "No extra context was supplied."}\n\n## Local workspace\n${request.workspace || "Not supplied"}\n\n## Instructions\nContinue the task autonomously in this Sailbox. Work in ${WORKSPACE}. Record a concise final report in ${REPORT_PATH}, including changes, verification, remaining limitations, and a recommended next-step plan for the initiating chat. Do not include credentials in the report.\n`;
}

async function prepareCredential(box, credential) {
  if (!credential) return { env: {}, login: "" };
  if (credential.type === "codex_auth_json") {
    await box.fs.write("/root/.codex/auth.json", credential.value, { mode: 0o600 });
    return { env: {}, login: "" };
  }
  if (credential.type === "codex_access_token") {
    return {
      env: { CODEX_ACCESS_TOKEN: credential.value },
      login: "mkdir -p /root/.codex; printf '%s' \"$CODEX_ACCESS_TOKEN\" | codex login --with-access-token",
    };
  }
  throw new Error(`Unsupported credential handoff type: ${credential.type}`);
}

async function launch(request) {
  const apiKey = process.env.SAIL_API_KEY || process.env.SANDBOX_API_KEY;
  if (!apiKey) throw new Error("Set SAILBOX_HANDOFF_KEY (or SAIL_API_KEY) before running Codex; the adapter receives it as SANDBOX_API_KEY.");
  // The SDK snapshots environment credentials when it builds its default
  // client, so always use an explicit client for protocol-injected secrets.
  const client = Client.fromConfig({ apiKey });
  const app = await App.find(APP_NAME, { mintIfMissing: true, client });
  const box = await Sailbox.create({
    client,
    app,
    name: `codex-handoff-${request.handoff_id.slice(0, 8)}`,
    size: BOX_SIZE,
    private: true,
  });

  try {
    if (!request.workspace_archive_base64) throw new Error("Missing local workspace archive.");
    await box.fs.write(INPUT_ARCHIVE, Buffer.from(request.workspace_archive_base64, "base64"), { mode: 0o600 });
    const unpack = await box.exec(`mkdir -p ${WORKSPACE} && tar -xzf ${INPUT_ARCHIVE} -C ${WORKSPACE}`);
    const unpackResult = await unpack.wait();
    if (unpackResult.exitCode !== 0) throw new Error(`Could not unpack workspace: ${unpackResult.stderr || unpackResult.stdout}`);
    await box.fs.write(BRIEF_PATH, taskBrief(request), { mode: 0o600 });
    const credential = await prepareCredential(box, request.credential_handoff);
    // Bootstrap runs inside the detached job. Fresh Debian boxes need longer
    // than an MCP request; returning now lets the parent poll status instead
    // of timing out before a handoff ID is available.
    const runner = [
      "set -u; status=failed; code=1",
      `mkdir -p ${WORKSPACE}`,
      "apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq ca-certificates curl nodejs npm && npm install -g @openai/codex",
      credential.login,
      `if codex exec --dangerously-bypass-approvals-and-sandbox -C ${WORKSPACE} -o ${REPORT_PATH} - < ${BRIEF_PATH}; then status=complete; code=0; else status=failed; code=$?; fi`,
      `printf '{\"status\":\"%s\",\"exit_code\":%s}\n' \"$status\" \"$code\" > ${RESULT_PATH}`,
      "exit 0",
    ].filter(Boolean).join("; ");
    await box.fs.write(RUNNER_PATH, `#!/usr/bin/env bash\n${runner}\n`, { mode: 0o700 });
    // Sail's detached exec is best-effort for this workload. A normal shell
    // exec that starts `nohup` returns immediately but leaves the bootstrap
    // process attached to the Sailbox lifetime, with durable diagnostics.
    const launcher = await box.exec(`nohup bash ${RUNNER_PATH} > ${LOG_PATH} 2>&1 < /dev/null &`, { env: credential.env });
    const launchResult = await launcher.wait();
    if (launchResult.exitCode !== 0) throw new Error(`Could not start the Sailbox handoff runner: ${launchResult.stderr || launchResult.stdout}`);
    return { id: box.sailboxId, url: `https://app.sailresearch.com/sailboxes/${box.sailboxId}` };
  } catch (error) {
    await box.terminate().catch(() => {});
    throw error;
  }
}

async function status(request) {
  const apiKey = process.env.SAIL_API_KEY || process.env.SANDBOX_API_KEY;
  if (!apiKey) throw new Error("Set SAILBOX_HANDOFF_KEY (or SAIL_API_KEY) before checking a Sailbox handoff.");
  const box = await Sailbox.get(request.remote_id, { client: Client.fromConfig({ apiKey }) });
  if (await box.fs.exists(RESULT_PATH)) {
    const result = JSON.parse((await box.fs.read(RESULT_PATH)).toString());
    const report = (await box.fs.exists(REPORT_PATH)) ? (await box.fs.read(REPORT_PATH)).toString() : "Codex completed without writing a report.";
    return { status: "complete", report: `Sailbox ${box.sailboxId} ${result.status} (exit ${result.exit_code}).\n\n${report}` };
  }
  if (["failed", "terminated"].includes(box.status)) {
    return { status: "failed", report: `Sailbox ${box.sailboxId} is ${box.status} before Codex wrote a final report.` };
  }
  const log = (await box.fs.exists(LOG_PATH)) ? (await box.fs.read(LOG_PATH)).toString().slice(-1200) : "Bootstrap is queued.";
  return { status: "running", url: `https://app.sailresearch.com/sailboxes/${box.sailboxId}`, detail: log };
}

async function sync(request) {
  const apiKey = process.env.SAIL_API_KEY || process.env.SANDBOX_API_KEY;
  if (!apiKey) throw new Error("Missing Sail key for workspace synchronization.");
  const box = await Sailbox.get(request.remote_id, { client: Client.fromConfig({ apiKey }) });
  try {
    const pack = await box.exec(`tar -czf ${OUTPUT_ARCHIVE} --exclude=brief.md --exclude=run-handoff.sh --exclude=handoff.log --exclude=result.json -C ${WORKSPACE} .`);
    const result = await pack.wait();
    if (result.exitCode !== 0) throw new Error(`Could not package sandbox workspace: ${result.stderr || result.stdout}`);
    const bytes = await box.fs.read(OUTPUT_ARCHIVE);
    if (bytes.length > 48 * 1024 * 1024) throw new Error("Sandbox workspace archive exceeds the 48 MiB sync limit.");
    return { workspace_archive_base64: bytes.toString("base64") };
  } finally {
    await box.terminate().catch(() => {});
  }
}

try {
  const request = await readRequest();
  const response = request.action === "launch" ? await launch(request) : request.action === "status" ? await status(request) : request.action === "sync" ? await sync(request) : (() => { throw new Error(`Unsupported action: ${request.action}`); })();
  process.stdout.write(JSON.stringify(response));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
