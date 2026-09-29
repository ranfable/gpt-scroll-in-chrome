#!/usr/bin/env node
import { analyzeText, chatText, listModels, prepareModelOptions, VossError } from "./codex-client.mjs";

// Chrome appends the calling extension origin after the launcher's arguments.
const allowed = process.argv[2] === "--allowed-origin" ? process.argv[3] : "";
const caller = process.argv[4];
if (!/^chrome-extension:\/\/[a-p]{32}\/$/.test(allowed) || caller !== allowed) process.exit(1);

let buffer = Buffer.alloc(0);
let controller = null;
let disconnected = false;
let used = false;
// Requests may carry up to six downscaled note images; replies stay small.
const MAX_IN_BYTES = 6 * 1024 * 1024;
const MAX_OUT_BYTES = 131072;
const idle = setTimeout(() => process.stdin.destroy(), 10_000);

function send(value) {
  if (disconnected) return;
  const payload = Buffer.from(JSON.stringify(value), "utf8");
  if (payload.length > MAX_OUT_BYTES) return;
  const header = Buffer.alloc(4);
  header.writeUInt32LE(payload.length);
  process.stdout.write(Buffer.concat([header, payload]));
}

async function receive(message) {
  clearTimeout(idle);
  const requestId = message?.requestId;
  if (typeof requestId !== "string" || !/^[a-zA-Z0-9-]{1,80}$/.test(requestId)) { process.stdin.destroy(); return; }
  if (message.type === "ping") { send({ requestId, ok: true, version: "0.8.1" }); return; }
  if (message.type === "cancel") { controller?.abort(); return; }
  if (!["analyze", "chat", "models"].includes(message.type) || used) { send({ requestId, ok: false, code: "INVALID_REQUEST", message: "无法处理这次请求。" }); return; }
  used = true;
  controller = new AbortController();
  try {
    if (message.type === "models") {
      send({ requestId, ok: true, models: await listModels({ signal: controller.signal }) });
      return;
    }
    const result = message.type === "chat"
      ? await chatText(message.conversation, { ...prepareModelOptions(message.options ?? {}), images: message.images ?? [], learn: message.learn === true, signal: controller.signal })
      : await analyzeText(message.content, { mode: message.mode, signal: controller.signal });
    send({ requestId, ok: true, text: result.text, model: result.model, ...(Array.isArray(result.remember) ? { remember: result.remember, forget: result.forget } : {}) });
  } catch (error) {
    send({ requestId, ok: false, code: error instanceof VossError ? error.code : "HOST_ERROR", message: error instanceof VossError ? error.message : "本机连接出现问题，请重试。" });
  } finally {
    controller = null;
    if (disconnected) process.exitCode = 0;
  }
}

function disconnect() {
  if (disconnected) return;
  disconnected = true;
  clearTimeout(idle);
  controller?.abort();
  process.stdin.destroy();
}
process.stdin.on("data", chunk => {
  if (buffer.length + chunk.length > MAX_IN_BYTES + 4) { disconnect(); return; }
  buffer = Buffer.concat([buffer, chunk]);
  while (buffer.length >= 4) {
    const size = buffer.readUInt32LE(0);
    if (!size || size > MAX_IN_BYTES) { disconnect(); return; }
    if (buffer.length < 4 + size) return;
    const raw = buffer.subarray(4, 4 + size);
    buffer = buffer.subarray(4 + size);
    let message;
    try { message = JSON.parse(raw.toString("utf8")); } catch { disconnect(); return; }
    void receive(message);
  }
});
process.stdin.on("end", disconnect);
process.stdin.on("close", disconnect);
process.stdin.on("error", disconnect);
process.stdout.on("error", disconnect);
process.once("SIGTERM", disconnect);
process.once("SIGINT", disconnect);
