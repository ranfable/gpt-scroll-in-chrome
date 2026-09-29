import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeText, chatText, listModels, prepareContent, prepareModelOptions, CHAT_INSTRUCTIONS } from '../bridge/codex-client.mjs';
import { buildChatPrompt } from '../bridge/chat-prompt.mjs';

const fixture = fileURLToPath(new URL('./fixtures/fake-codex.mjs', import.meta.url));
const sample = { title: '固定测试', description: '只有测试文字。' };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const exists = path => access(path).then(() => true, () => false);

async function withFake(mode, run) {
  const directory = await mkdtemp(join(tmpdir(), 'voss-bridge-test-'));
  const logPath = join(directory, 'fixture.jsonl');
  const values = { VOSS_CODEX_BIN: fixture, VOSS_FAKE_MODE: mode, VOSS_FAKE_LOG: logPath };
  const old = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  await chmod(fixture, 0o755);
  Object.assign(process.env, values);
  const events = async () => {
    try { return (await readFile(logPath, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  };
  const waitForInitialize = async () => {
    for (let i = 0; i < 150; i++) {
      if ((await events()).some(item => item.method === 'initialize')) return;
      await delay(20);
    }
    throw new Error('Offline fixture did not initialize');
  };
  const assertCleaned = async () => {
    const spawn = (await events()).find(item => item.event === 'spawn');
    assert.ok(spawn, 'fake server must have started');
    assert.equal(await exists(spawn.cwd), false, 'analysis temporary directory removed');
    assert.throws(() => process.kill(spawn.pid, 0), { code: 'ESRCH' }, 'fake child exited');
  };
  try { await run({ events, waitForInitialize, assertCleaned }); }
  finally {
    for (const [key, value] of Object.entries(old)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(directory, { recursive: true, force: true });
  }
}

test('bridge offline regression suite', { concurrency: false }, async t => {
  await t.test('prepareContent allows only bounded text fields', () => {
    assert.deepEqual(prepareContent({ title: ' 标题 ', author: ' 作者 ', description: ' 正文 ', url: 'https://example.test/?token=omit', cookies: 'omit' }),
      { title: '标题', author: '作者', description: '正文' });
    assert.throws(() => prepareContent({ author: '作者' }), { code: 'EMPTY_CONTENT' });
    assert.throws(() => prepareContent({ title: ' '.repeat(100) }), { code: 'EMPTY_CONTENT' });
    assert.throws(() => prepareContent({ title: 42 }), { code: 'INVALID_INPUT' });
    assert.throws(() => prepareContent(null), { code: 'INVALID_INPUT' });
    assert.throws(() => prepareContent({ description: '字'.repeat(20001) }), { code: 'CONTENT_TOO_LONG' });
  });
  await t.test('completion before turn/start acknowledgement resolves once and cleans up', () => withFake('success', async ({ assertCleaned }) => {
    const result = await analyzeText(sample, { timeoutMs: 5000 });
    assert.equal(result.text, '离线测试回答。');
    assert.equal(result.status, 'completed');
    assert.equal(result.model, 'offline-fixture');
    assert.deepEqual(result.observedItems, ['agentMessage']);
    await assertCleaned();
  }));
  await t.test('pre-cancelled request starts no child', () => withFake('hang', async ({ events }) => {
    const controller = new AbortController(); controller.abort();
    await assert.rejects(analyzeText(sample, { signal: controller.signal }), { code: 'CANCELLED' });
    assert.deepEqual(await events(), []);
  }));
  await t.test('chat sends memory and follow-up through the restricted client without requiring a page', () => withFake('chat-context', async ({ assertCleaned }) => {
    const result = await chatText({ message: '再短一点', memory: 'Voss 背景', history: [{ role: 'user', text: '写一句' }, { role: 'assistant', text: '上一句回答' }] });
    assert.equal(result.text, '已收到背景和上一句回答。');
    await assertCleaned();
  }));
  await t.test('chosen model and depth reach thread/start and turn/start; default keeps Codex model and low depth', () => withFake('success', async ({ events, assertCleaned }) => {
    await chatText({ message: '你好' }, { model: 'gpt-test', effort: 'high' });
    let log = await events();
    assert.equal(log.find(item => item.method === 'thread/start').model, 'gpt-test');
    assert.equal(log.find(item => item.method === 'turn/start').effort, 'high');
    await assertCleaned();
    await chatText({ message: '你好' });
    log = (await events()).filter(item => item.event === 'request');
    assert.equal(log.filter(item => item.method === 'thread/start').at(-1).model, undefined);
    assert.equal(log.filter(item => item.method === 'turn/start').at(-1).effort, 'low');
  }));
  await t.test('invalid model options are rejected before a child starts', () => withFake('success', async ({ events }) => {
    for (const options of [{ model: 'bad id; rm -rf' }, { model: 42 }, { effort: 'extreme' }, { effort: '__proto__' }]) {
      await assert.rejects(chatText({ message: '你好' }, options), { code: 'INVALID_SETTINGS' });
    }
    assert.throws(() => prepareModelOptions(null), { code: 'INVALID_SETTINGS' });
    assert.equal((await events()).length, 0);
  }));
  await t.test('note images reach turn/start as image inputs after the text, and the prompt knows the count', () => withFake('success', async ({ events, assertCleaned }) => {
    const jpeg = 'data:image/jpeg;base64,' + 'A'.repeat(200);
    await chatText({ message: '图里有什么', page: { title: '有图', description: '' } }, { images: [jpeg, jpeg] });
    const turn = (await events()).find(item => item.method === 'turn/start');
    assert.deepEqual(turn.inputs, ['text', 'image:auto:data:image/jpeg;base64', 'image:auto:data:image/jpeg;base64']);
    assert.equal(turn.imageCount, 2);
    await assertCleaned();
  }));
  await t.test('images that are not small data URLs are rejected before a child starts', () => withFake('success', async ({ events }) => {
    for (const images of [['https://example.test/cat.jpg'], ['file:///etc/passwd'], ['data:image/svg+xml;base64,AAAA'], Array(7).fill('data:image/png;base64,AAAA'), ['data:image/jpeg;base64,' + 'A'.repeat(700_001)], 'data:image/png;base64,AAAA']) {
      await assert.rejects(chatText({ message: '你好' }, { images }), { code: 'INVALID_IMAGES' });
    }
    assert.throws(() => buildChatPrompt({ message: 'hi', imageCount: 7 }), { code: 'INVALID_CHAT' });
    assert.equal((await events()).length, 0);
  }));
  await t.test('learning asks for a structured reply and keeps only safe, known memory updates', () => withFake('memory', async ({ events, assertCleaned }) => {
    const remembered = [{ id: 'm-abc123', text: '用户喜欢猫', date: '2026-09-20' }];
    const result = await chatText({ message: '忘掉猫那条，我在学写文案', remembered }, { learn: true });
    assert.equal(result.text, '好的，记住了。');
    assert.deepEqual(result.remember, ['用户在学写小红书文案', '用户希望回答简短']);
    assert.deepEqual(result.forget, ['m-abc123']);
    assert.equal((await events()).find(item => item.method === 'turn/start').schema, true);
    await assertCleaned();
  }));
  await t.test('without learning there is no schema and no memory fields', () => withFake('memory', async ({ events }) => {
    const result = await chatText({ message: '你好' });
    assert.equal(result.text, '离线测试回答。'); assert.equal('remember' in result, false);
    assert.equal((await events()).find(item => item.method === 'turn/start').schema, false);
  }));
  await t.test('a non-JSON structured reply is shown as a plain reply with nothing remembered', () => withFake('memory-bad-json', async () => {
    const result = await chatText({ message: '你好' }, { learn: true });
    assert.equal(result.text, '这不是 JSON，但仍是回复'); assert.deepEqual(result.remember, []); assert.deepEqual(result.forget, []);
  }));
  await t.test('if the model rejects the schema, the same question is answered once more without it', () => withFake('schema-rejected', async ({ events, assertCleaned }) => {
    const result = await chatText({ message: '你好' }, { learn: true });
    assert.equal(result.text, '离线测试回答。'); assert.equal(result.learnFailed, true); assert.deepEqual(result.remember, []);
    const turns = (await events()).filter(item => item.method === 'turn/start');
    assert.deepEqual(turns.map(item => item.schema), [true, false]);
    await assertCleaned();
  }));
  await t.test('quota errors are not retried without the schema', () => withFake('quota', async ({ events }) => {
    await assert.rejects(chatText({ message: '你好' }, { learn: true }), { code: 'QUOTA_EXCEEDED' });
    assert.equal((await events()).filter(item => item.method === 'turn/start').length, 1);
  }));
  await t.test('chat uses the Voss persona with the safety rules; the one-off analysis does not', () => withFake('success', async ({ events }) => {
    await chatText({ message: '你好' });
    await analyzeText(sample);
    const starts = (await events()).filter(item => item.method === 'thread/start');
    assert.deepEqual(starts.map(item => [item.persona, item.safety]), [[true, true], [false, true]]);
    assert.match(CHAT_INSTRUCTIONS, /Never invent shared past events/);
    assert.match(CHAT_INSTRUCTIONS, /不得调用任何工具/);
    assert.ok(CHAT_INSTRUCTIONS.indexOf('Never invent shared past events') < CHAT_INSTRUCTIONS.indexOf('以下规则始终有效'), 'safety rules come last');
  }));
  await t.test('model list keeps only safe names and known depths, without starting a thread', () => withFake('success', async ({ events, assertCleaned }) => {
    const models = await listModels();
    assert.deepEqual(models, [
      { id: 'gpt-test', name: 'GPT Test', efforts: ['low', 'high'], isDefault: true },
      { id: 'gpt-lite', name: 'GPT Lite', efforts: ['low'], isDefault: false }
    ]);
    const methods = (await events()).filter(item => item.event === 'request').map(item => item.method);
    assert.equal(methods.includes('thread/start') || methods.includes('turn/start'), false);
    await assertCleaned();
  }));
  await t.test('cancellation while connecting keeps CANCELLED and cleans up', () => withFake('hang', async ({ waitForInitialize, assertCleaned }) => {
    const controller = new AbortController();
    const result = assert.rejects(analyzeText(sample, { signal: controller.signal, timeoutMs: 5000 }), { code: 'CANCELLED' });
    try { await waitForInitialize(); } finally { controller.abort(); }
    await result;
    await assertCleaned();
  }));
  await t.test('connection timeout keeps TIMEOUT and cleans up', () => withFake('hang', async ({ assertCleaned }) => {
    await assert.rejects(analyzeText(sample, { timeoutMs: 1000 }), { code: 'TIMEOUT' });
    await assertCleaned();
  }));
  for (const [mode, code] of Object.entries({ 'logged-out': 'LOGIN_REQUIRED', quota: 'QUOTA_EXCEEDED', busy: 'SERVICE_BUSY', unauthorized: 'LOGIN_REQUIRED', network: 'NETWORK_ERROR', 'http-auth': 'LOGIN_REQUIRED', 'http-busy': 'SERVICE_BUSY', unknown: 'MODEL_FAILED', disconnect: 'DISCONNECTED', malformed: 'BAD_PROTOCOL', 'bad-item': 'BAD_PROTOCOL', tool: 'UNEXPECTED_TOOL' })) {
    await t.test(`${mode} preserves a safe error and removes child and temporary files`, () => withFake(mode, async ({ assertCleaned }) => {
      await assert.rejects(analyzeText(sample, { timeoutMs: 3000 }), error => {
        assert.equal(error.code, code);
        assert.equal(error.message.includes('secret'), false);
        return true;
      });
      await assertCleaned();
    }));
  }
  for (const mode of ['generating-hang', 'stubborn']) {
    await t.test(`cancel during ${mode} stops the process`, () => withFake(mode, async ({ assertCleaned }) => {
      const controller = new AbortController();
      await assert.rejects(analyzeText(sample, { signal: controller.signal, timeoutMs: 5000,
        onStatus: status => { if (status === 'generating') setTimeout(() => controller.abort(), 50); }
      }), { code: 'CANCELLED' });
      await assertCleaned();
    }));
  }
  await t.test('generation timeout cleans up', () => withFake('generating-hang', async ({ assertCleaned }) => {
    await assert.rejects(analyzeText(sample, { timeoutMs: 1000 }), { code: 'TIMEOUT' });
    await assertCleaned();
  }));
});
