#!/usr/bin/env node
import { analyzeText } from "./codex-client.mjs";

const startedAt = Date.now();
const controller = new AbortController();
process.once("SIGINT", () => controller.abort());
process.once("SIGTERM", () => controller.abort());
try {
  const result = await analyzeText({
    title: "一杯咖啡的慢早晨",
    author: "Voss 测试样例",
    description: "早起十分钟，磨豆、烧水，把手机放远一点。今天从一杯亲手冲的咖啡开始。",
  }, { signal: controller.signal, onStatus: status => process.stderr.write(`[Voss] ${status}\n`) });
  console.log(JSON.stringify({ ok: true, durationMs: Date.now() - startedAt, ...result }, null, 2));
} catch (error) {
  console.log(JSON.stringify({ ok: false, durationMs: Date.now() - startedAt, code: error.code || "UNKNOWN", message: error.message, method: error.method }, null, 2));
  process.exitCode = 1;
}
