#!/usr/bin/env node
// Read-only protocol check. Never starts a thread/turn or prints credentials.
import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { createInterface } from "node:readline";

const bundledCodex = "/Applications/ChatGPT.app/Contents/Resources/codex";
let codexBinary = process.env.VOSS_CODEX_BIN;
if (!codexBinary) {
  try {
    accessSync(bundledCodex, constants.X_OK);
    codexBinary = bundledCodex;
  } catch {
    codexBinary = "codex";
  }
}

const child = spawn(codexBinary, ["app-server", "--listen", "stdio://"], {
  stdio: ["pipe", "pipe", "pipe"],
});
const lines = createInterface({ input: child.stdout });
const pending = new Map();
let nextId = 0;
let diagnosticBytes = 0;
let permissionWarning = false;
let finished = false;
let exited = false;
let forceStop;

child.stderr.on("data", chunk => {
  diagnosticBytes += chunk.length;
  // Record the condition without printing raw logs, paths, or account data.
  permissionWarning ||= /operation not permitted|permission denied/i.test(chunk.toString());
});

function rejectPending(message) {
  for (const { reject } of pending.values()) reject(new Error(message));
  pending.clear();
}

child.on("error", () => rejectPending("Could not start Codex app-server."));
child.stdin.on("error", () => rejectPending("Codex app-server input closed."));
const closed = new Promise(resolve => child.on("close", () => {
  exited = true;
  clearTimeout(forceStop);
  if (!finished) rejectPending("Codex app-server exited before completing the check.");
  resolve();
}));

function send(message) {
  child.stdin.write(`${JSON.stringify(message)}\n`);
}

function request(method, params) {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    send({ id, method, params });
  });
}

lines.on("line", line => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message.method && message.id !== undefined) {
    // A diagnostics client cannot grant permissions or execute tools.
    send({ id: message.id, error: { code: -32601, message: "Unsupported by connection check" } });
    return;
  }
  const waiter = pending.get(message.id);
  if (!waiter) return;
  pending.delete(message.id);
  if (message.error) waiter.reject(new Error(`Codex protocol error (${message.error.code ?? "unknown"}).`));
  else waiter.resolve(message.result);
});

const deadline = setTimeout(() => {
  rejectPending("Connection check timed out after 20 seconds.");
  child.kill("SIGTERM");
}, 20_000);

const report = {
  checkedAt: new Date().toISOString(),
  nodeVersion: process.version,
  codexBinary,
  handshake: false,
  modelRequestSent: false,
};

try {
  await request("initialize", {
    clientInfo: { name: "voss_scroll_diagnostics", title: "Voss Scroll Connection Check", version: "0.1.0" },
  });
  send({ method: "initialized", params: {} });
  report.handshake = true;
  const account = await request("account/read", { refreshToken: false });
  report.account = {
    type: account.account?.type ?? null,
    planType: account.account?.planType ?? null,
    requiresOpenaiAuth: account.requiresOpenaiAuth,
  };
  report.readyForModelTest = report.account.type === "chatgpt";
  if (!report.readyForModelTest) process.exitCode = 2;
} catch (error) {
  report.error = error.message;
  process.exitCode = 1;
} finally {
  finished = true;
  clearTimeout(deadline);
  child.stdin.end();
  child.kill("SIGTERM");
  if (!exited) forceStop = setTimeout(() => child.kill("SIGKILL"), 1_000);
  await closed;
  lines.close();
  report.diagnostics = { stderrBytes: diagnosticBytes, permissionWarning };
  console.log(JSON.stringify(report, null, 2));
}
