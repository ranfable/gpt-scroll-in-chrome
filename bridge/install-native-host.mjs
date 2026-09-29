#!/usr/bin/env node
import { mkdir, writeFile, chmod, copyFile, readFile } from "node:fs/promises";
import { accessSync, constants } from "node:fs";
import { dirname, join, isAbsolute, delimiter } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const extensionId = process.argv[2];
if (!/^[a-p]{32}$/.test(extensionId || "")) throw new Error("请传入 chrome://extensions 中的 32 位 Voss 扩展 ID。");
if (process.platform !== "darwin") throw new Error("当前安装器仅支持 macOS Google Chrome。");
const base = dirname(fileURLToPath(import.meta.url));
const origin = `chrome-extension://${extensionId}/`;
const launcher = join(base, "launch-native-host");
const quote = value => `'${value.replace(/'/g, "'\\''")}'`;
const executable = path => { try { accessSync(path, constants.X_OK); return true; } catch { return false; } };

// Chrome starts the host with a minimal PATH, so a Codex CLI found in the
// user's shell now is recorded in the launcher by its absolute path.
function findCodex() {
  const flag = process.argv.indexOf("--codex");
  if (flag > 0) {
    const given = process.argv[flag + 1] || "";
    if (!isAbsolute(given) || !executable(given)) throw new Error("--codex 需要一个可执行的完整路径，例如 /usr/local/bin/codex。");
    return given;
  }
  if (process.env.VOSS_CODEX_BIN && executable(process.env.VOSS_CODEX_BIN)) return process.env.VOSS_CODEX_BIN;
  // The ChatGPT desktop app's bundled Codex is found by the client itself.
  if (executable("/Applications/ChatGPT.app/Contents/Resources/codex")) return "";
  for (const dir of (process.env.PATH || "").split(delimiter)) {
    if (dir && isAbsolute(dir) && executable(join(dir, "codex"))) return join(dir, "codex");
  }
  return null;
}
const codex = findCodex();
if (codex === null) console.error("注意：没有找到 Codex。请安装 ChatGPT 桌面版，或用 --codex /完整路径/codex 指定后重新运行。");

const env = codex ? `export VOSS_CODEX_BIN=${quote(codex)}\n` : "";
await writeFile(launcher, `#!/bin/sh\n${env}exec ${quote(process.execPath)} ${quote(join(base, "native-host.mjs"))} --allowed-origin ${quote(origin)} "$@"\n`, { mode: 0o700 });
await chmod(launcher, 0o700);
const manifest = { name: "com.voss.scroll", description: "Voss Scroll local text analysis", path: launcher, type: "stdio", allowed_origins: [origin] };
const prepared = join(base, "com.voss.scroll.json");
await writeFile(prepared, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
const target = join(homedir(), "Library/Application Support/Google/Chrome/NativeMessagingHosts/com.voss.scroll.json");
if (process.argv.includes("--install")) {
  try {
    const previous = await readFile(target, "utf8");
    if (previous !== await readFile(prepared, "utf8")) await writeFile(`${target}.backup-${Date.now()}`, previous, { mode: 0o600 });
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  await mkdir(dirname(target), { recursive: true });
  await copyFile(prepared, target);
  await chmod(target, 0o600);
}
console.log(JSON.stringify({
  installed: process.argv.includes("--install"), prepared, target, allowedOrigin: origin,
  codex: codex === "" ? "ChatGPT 桌面版自带" : codex ?? "未找到"
}, null, 2));
