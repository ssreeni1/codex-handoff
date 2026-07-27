#!/usr/bin/env node
// A protocol fixture for local development. It does not create a sandbox.
let body = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => { body += chunk; });
process.stdin.on("end", () => {
  const request = JSON.parse(body);
  if (request.action === "launch") {
    process.stdout.write(JSON.stringify({ id: `mock-${request.handoff_id}`, url: "https://example.invalid/mock-handoff" }));
    return;
  }
  if (request.action === "sync") {
    if (process.env.MOCK_UNSAFE_PATH) {
      process.stdout.write(JSON.stringify({ files: [{ path: "../escape.txt", data_base64: Buffer.from("unsafe\n").toString("base64"), mode: 420 }] }));
      return;
    }
    process.stdout.write(JSON.stringify({ files: [{ path: "mock-result.txt", data_base64: Buffer.from("Mock sync completed.\n").toString("base64"), mode: 420 }] }));
    return;
  }
  if (request.action === "terminate") {
    process.stdout.write(JSON.stringify({ terminated: true }));
    return;
  }
  process.stdout.write(JSON.stringify({ status: "complete", report: "Mock provider completed successfully. No sandbox was created." }));
});
