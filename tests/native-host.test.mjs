import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const host = fileURLToPath(new URL('../bridge/native-host.mjs', import.meta.url));
const fixture = fileURLToPath(new URL('./fixtures/fake-codex.mjs', import.meta.url));
const origin = `chrome-extension://${'a'.repeat(32)}/`;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const frame = value => {
  const payload = Buffer.from(JSON.stringify(value));
  const header = Buffer.alloc(4); header.writeUInt32LE(payload.length);
  return Buffer.concat([header, payload]);
};
const request = { type: 'analyze', requestId: 'offline-request', mode: 'together', content: { title: '纯离线样例' } };

async function withHost(mode, run, caller = origin) {
  const directory = await mkdtemp(join(tmpdir(), 'voss-native-test-'));
  const log = join(directory, 'fixture.jsonl');
  const child = spawn(process.execPath, [host, '--allowed-origin', origin, caller], {
    env: { ...process.env, VOSS_CODEX_BIN: fixture, VOSS_FAKE_MODE: mode, VOSS_FAKE_LOG: log }, stdio: ['pipe', 'pipe', 'pipe']
  });
  let buffer = Buffer.alloc(0), exited = false;
  const replies = [];
  child.stdin.on('error', () => {});
  child.stderr.on('data', () => {});
  child.stdout.on('data', chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4 && buffer.length >= 4 + buffer.readUInt32LE(0)) {
      const size = buffer.readUInt32LE(0);
      replies.push(JSON.parse(buffer.subarray(4, size + 4).toString()));
      buffer = buffer.subarray(size + 4);
    }
  });
  const closed = new Promise(resolve => child.on('close', code => { exited = true; resolve(code); }));
  const watchdog = setTimeout(() => child.kill('SIGKILL'), 5000);
  const events = async () => {
    try { return (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  };
  const until = async predicate => {
    for (let i = 0; i < 200; i++) { if (await predicate()) return; await delay(15); }
    throw new Error('Offline host did not reach expected state');
  };
  try { await run({ child, replies, closed, events, until }); }
  finally {
    child.stdin.end();
    if (!exited) child.kill('SIGTERM');
    await closed; clearTimeout(watchdog);
    for (const event of await events()) if (event.event === 'spawn') {
      assert.throws(() => process.kill(event.pid, 0), { code: 'ESRCH' }, 'model child exited');
      await assert.rejects(access(event.cwd), { code: 'ENOENT' }, 'temporary analysis directory removed');
    }
    await rm(directory, { recursive: true, force: true });
  }
}

test('native host accepts fragmented frames and returns only the bounded model result', () => withHost('success', async ({ child, replies, until }) => {
  const bytes = frame(request);
  child.stdin.write(bytes.subarray(0, 2)); await delay(20);
  child.stdin.write(bytes.subarray(2, 11)); await delay(20);
  child.stdin.write(bytes.subarray(11));
  await until(() => replies.length === 1);
  assert.deepEqual(replies[0], { requestId: request.requestId, ok: true, text: '离线测试回答。', model: 'offline-fixture' });
}));

test('native quota error is safe and retains its identity', () => withHost('quota', async ({ child, replies, until }) => {
  child.stdin.write(frame(request)); await until(() => replies.length === 1);
  assert.equal(replies[0].code, 'QUOTA_EXCEEDED');
  assert.equal(JSON.stringify(replies).includes('secret'), false);
}));

test('native chat framing preserves explicit background and previous replies', () => withHost('chat-context', async ({ child, replies, until }) => {
  child.stdin.write(frame({ type: 'chat', requestId: request.requestId, conversation: { message: '再短一点', memory: 'Voss 背景', history: [{ role: 'user', text: '写一句' }, { role: 'assistant', text: '上一句回答' }] } }));
  await until(() => replies.length === 1);
  assert.deepEqual(replies[0], { requestId: request.requestId, ok: true, text: '已收到背景和上一句回答。', model: 'offline-fixture' });
}));

test('native chat passes the chosen model and depth to Codex', () => withHost('success', async ({ child, replies, until, events }) => {
  child.stdin.write(frame({ type: 'chat', requestId: request.requestId, conversation: { message: '你好' }, options: { model: 'gpt-test', effort: 'high' } }));
  await until(() => replies.length === 1);
  assert.equal(replies[0].ok, true);
  const log = await events();
  assert.equal(log.find(item => item.method === 'thread/start').model, 'gpt-test');
  assert.equal(log.find(item => item.method === 'turn/start').effort, 'high');
}));

test('native chat forwards note images to Codex as image inputs', () => withHost('success', async ({ child, replies, until, events }) => {
  const jpeg = 'data:image/jpeg;base64,' + 'A'.repeat(300_000);
  child.stdin.write(frame({ type: 'chat', requestId: request.requestId, conversation: { message: '看图', page: { title: '图' } }, images: [jpeg, jpeg, jpeg] }));
  await until(() => replies.length === 1);
  assert.equal(replies[0].ok, true);
  assert.equal((await events()).find(item => item.method === 'turn/start').inputs.length, 4);
}));

test('native chat returns memory updates only when learning was asked for', () => withHost('memory', async ({ child, replies, until }) => {
  child.stdin.write(frame({ type: 'chat', requestId: request.requestId, learn: true, conversation: { message: '我在学写文案', remembered: [{ id: 'm-abc123', text: '用户喜欢猫', date: '2026-09-20' }] } }));
  await until(() => replies.length === 1);
  assert.deepEqual(replies[0], { requestId: request.requestId, ok: true, text: '好的，记住了。', model: 'offline-fixture', remember: ['用户在学写小红书文案', '用户希望回答简短'], forget: ['m-abc123'] });
}));

test('native chat rejects unsafe model options before starting Codex', () => withHost('success', async ({ child, replies, until, events }) => {
  child.stdin.write(frame({ type: 'chat', requestId: request.requestId, conversation: { message: '你好' }, options: { model: 'x; rm -rf ~' } }));
  await until(() => replies.length === 1);
  assert.equal(replies[0].code, 'INVALID_SETTINGS');
  assert.deepEqual(await events(), []);
}));

test('native model list returns names and depths without starting a thread', () => withHost('success', async ({ child, replies, until, events }) => {
  child.stdin.write(frame({ type: 'models', requestId: request.requestId }));
  await until(() => replies.length === 1);
  assert.deepEqual(replies[0].models.map(item => item.id), ['gpt-test', 'gpt-lite']);
  assert.equal((await events()).some(item => item.method === 'thread/start' || item.method === 'turn/start'), false);
}));

for (const action of ['cancel', 'disconnect']) {
  test(`native ${action} during generation stops the model child`, () => withHost('generating-hang', async ({ child, replies, closed, events, until }) => {
    child.stdin.write(frame(request));
    await until(async () => (await events()).some(event => event.method === 'turn/start'));
    if (action === 'cancel') {
      child.stdin.write(frame({ type: 'cancel', requestId: request.requestId }));
      await until(() => replies.length === 1); assert.equal(replies[0].code, 'CANCELLED');
    } else {
      child.stdin.end(); assert.equal(await closed, 0); assert.equal(replies.length, 0);
    }
  }));
}

test('wrong extension origin exits before starting a model', () => withHost('success', async ({ closed, events }) => {
  assert.equal(await closed, 1); assert.deepEqual(await events(), []);
}, `chrome-extension://${'b'.repeat(32)}/`));

test('oversized native frame is rejected before starting a model', () => withHost('success', async ({ child, closed, events }) => {
  const bytes = Buffer.alloc(4); bytes.writeUInt32LE(6 * 1024 * 1024 + 1); child.stdin.write(bytes);
  assert.equal(await closed, 0); assert.deepEqual(await events(), []);
}));
