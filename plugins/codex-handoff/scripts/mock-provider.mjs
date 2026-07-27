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
  process.stdout.write(JSON.stringify({ status: "complete", report: "Mock provider completed successfully. No sandbox was created." }));
});
