import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createChatStore, recentHistory, rememberedForPrompt } from '../extension/chat-store.mjs';

const source = readFileSync(new URL('../extension/background.js', import.meta.url), 'utf8').replace(/^import .*;\n/, '');
const first = '11111111-1111-4111-8111-111111111111';
const second = '22222222-2222-4222-8222-222222222222';
const event = () => {
  const listeners = new Set();
  return { addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn),
    emit: (...args) => [...listeners].map(fn => fn(...args)) };
};
function setup() {
  const ports = [], timers = new Map();
  let nextTimer = 0, saved = {};
  const chrome = {
    storage: { local: { async setAccessLevel() {}, async get() { return structuredClone(saved); }, async set(value) { saved = { ...saved, ...structuredClone(value) }; } } },
    runtime: { getURL: path => 'chrome-extension://extension-id/' + path, id: 'extension-id', onMessage: event(), onSuspend: event(), lastError: undefined,
      connectNative(name) {
        assert.equal(name, 'com.voss.scroll');
        const port = { onMessage: event(), onDisconnect: event(), sent: [], disconnected: 0,
          postMessage(message) { this.sent.push(JSON.parse(JSON.stringify(message))); },
          disconnect() { this.disconnected++; this.onDisconnect.emit(); } };
        ports.push(port); return port;
      } },
    tabs: { onRemoved: event(), onUpdated: event() }
  };
  vm.runInNewContext(source, { chrome, URL, crypto: globalThis.crypto, createChatStore, recentHistory, rememberedForPrompt, fetch: async () => ({ ok: true, json: async () => ({ text: '测试 Voss 背景' }) }), setTimeout: (fn, delay) => {
    assert.equal(delay, 95_000); timers.set(++nextTimer, fn); return nextTimer;
  }, clearTimeout: id => timers.delete(id) });
  const sender = { id: chrome.runtime.id, frameId: 0, tab: { id: 1 }, url: 'https://www.xiaohongshu.com/explore/example' };
  function send(message = {}, who = sender) {
    const responses = [];
    const returns = chrome.runtime.onMessage.emit(message, who, result => responses.push(JSON.parse(JSON.stringify(result))));
    return { responses, returns };
  }
  const analyze = (id = first, content = { title: '标题', author: '作者', description: '正文' }, who) =>
    send({ type: 'VOSS_ANALYZE', requestId: id, content }, who);
  return { chrome, ports, timers, sender, send, analyze };
}

test('valid main-frame request forwards only bounded text and accepts its matching result once', () => {
  const h = setup();
  const request = h.analyze(first, { title: ' 标题 ', author: ' 作者 ', description: ' 正文 ', url: 'private', cookie: 'private' });
  assert.deepEqual(request.returns, [true]);
  assert.deepEqual(h.ports[0].sent, [{ type: 'analyze', requestId: first, content: { title: '标题', author: '作者', description: '正文' }, mode: 'together' }]);
  h.ports[0].onMessage.emit({ requestId: second, ok: true, text: '过期', model: 'fixture' });
  assert.equal(request.responses.length, 0);
  h.ports[0].onMessage.emit({ requestId: first, ok: true, text: ' 答案 ', model: 'fixture' });
  h.ports[0].onMessage.emit({ requestId: first, ok: true, text: '重复', model: 'fixture' });
  assert.deepEqual(request.responses, [{ ok: true, text: '答案', model: 'fixture' }]);
  assert.equal(h.ports[0].disconnected, 1); assert.equal(h.timers.size, 0);
});

test('rejects foreign extensions, subframes, HTTP and lookalike domains before native launch', () => {
  const h = setup();
  for (const change of [{ id: 'other' }, { frameId: 1 }, { frameId: undefined }, { tab: undefined },
    { url: 'http://www.douyin.com/' }, { url: 'https://douyin.com.evil.test/' }, { url: 'https://notdouyin.com/' }]) {
    assert.equal(h.analyze(first, { title: 'test' }, { ...h.sender, ...change }).responses[0].code, 'FORBIDDEN');
  }
  assert.equal(h.ports.length, 0);
  for (const url of ['https://douyin.com/', 'https://www.douyin.com/', 'https://xiaohongshu.com/']) {
    h.analyze(first, { title: 'test' }, { ...h.sender, url });
  }
  assert.equal(h.ports.length, 3);
});

test('forwards all four modes but rejects unrecognized or non-string modes before starting a host', () => {
  for (const mode of ['together', 'roast', 'learn', 'viral']) {
    const h = setup();
    h.send({ type: 'VOSS_ANALYZE', requestId: first, content: { title: 'test' }, mode });
    assert.equal(h.ports[0].sent[0].mode, mode);
  }
  for (const mode of ['constructor', '__proto__', 'invented', '', null, {}, 42]) {
    const h = setup();
    const result = h.send({ type: 'VOSS_ANALYZE', requestId: first, content: { title: 'test' }, mode });
    assert.equal(result.responses[0].code, 'INVALID_MODE');
    assert.equal(h.ports.length, 0);
  }
});

test('rejects malformed IDs, types, empty and oversized content', () => {
  const h = setup();
  assert.equal(h.analyze('bad-id').responses[0].code, 'INVALID_INPUT');
  for (const content of [null, [], { title: 42 }, { title: 't', author: null }]) {
    assert.equal(h.analyze(first, content).responses[0].code, 'INVALID_INPUT');
  }
  assert.equal(h.analyze(first, { author: 'a' }).responses[0].code, 'EMPTY_CONTENT');
  for (const content of [{ title: 'x'.repeat(20_001) }, { title: 'x'.repeat(10_000), description: 'x'.repeat(10_000) }]) {
    assert.equal(h.analyze(first, content).responses[0].code, 'CONTENT_TOO_LONG');
  }
  assert.equal(h.ports.length, 0);
});

test('replacement closes the old process; stale and cross-tab cancellation cannot stop the new one', () => {
  const h = setup();
  const old = h.analyze(); const current = h.analyze(second);
  assert.equal(old.responses[0].code, 'REPLACED'); assert.equal(h.ports[0].disconnected, 1);
  h.send({ type: 'VOSS_CANCEL', requestId: first });
  h.send({ type: 'VOSS_CANCEL', requestId: second }, { ...h.sender, tab: { id: 2 } });
  assert.equal(current.responses.length, 0);
  const cancel = h.send({ type: 'VOSS_CANCEL', requestId: second });
  assert.equal(cancel.responses[0].cancelled, true);
  assert.equal(current.responses[0].code, 'CANCELLED'); assert.equal(h.ports[1].disconnected, 1);
});

test('timeout, tab navigation, removal and worker suspension close owned native ports', () => {
  for (const action of [h => [...h.timers.values()][0](), h => h.chrome.tabs.onUpdated.emit(1, { url: 'https://example.test/' }),
    h => h.chrome.tabs.onUpdated.emit(1, { status: 'loading' }), h => h.chrome.tabs.onRemoved.emit(1), h => h.chrome.runtime.onSuspend.emit()]) {
    const h = setup(); const request = h.analyze(); action(h);
    assert.equal(request.responses.length, 1); assert.equal(h.ports[0].disconnected, 1); assert.equal(h.timers.size, 0);
  }
});

test('native errors are translated without leaking raw messages or inherited property codes', () => {
  const known = ['LOGIN_REQUIRED', 'QUOTA_EXCEEDED', 'SERVICE_BUSY', 'NETWORK_ERROR', 'TIMEOUT', 'CANCELLED', 'BAD_PROTOCOL'];
  for (const code of [...known, '__proto__', 'constructor', 'UNKNOWN']) {
    const h = setup(); const request = h.analyze();
    h.ports[0].onMessage.emit({ requestId: first, ok: false, code, message: '/private/path secret' });
    assert.equal(request.responses[0].code, known.includes(code) ? code : 'MODEL_FAILED');
    assert.equal(JSON.stringify(request.responses).includes('secret'), false);
  }
  const h = setup(); const request = h.analyze();
  h.chrome.runtime.lastError = { message: '/private/path secret' };
  h.ports[0].onDisconnect.emit();
  assert.equal(request.responses[0].code, 'DISCONNECTED');
  assert.equal(JSON.stringify(request.responses).includes('secret'), false);
});

const flush = async () => { for (let i = 0; i < 12; i++) await new Promise(resolve => setImmediate(resolve)); };
async function chatState(h) { const r = h.send({ type: 'VOSS_CHAT_STATE', requestId: first }); await flush(); assert.equal(r.responses[0].ok, true); return r.responses[0].state; }

test('chat uses stored background and history, ignores caller-supplied memory and persists completed replies', async () => {
  const h = setup(), state = await chatState(h);
  const r = h.send({ type: 'VOSS_CHAT', requestId: first, expected: state, text: '你好', memory: '伪造', history: ['伪造'], page: null });
  await flush(); assert.equal(h.ports[0].sent[0].conversation.memory, '测试 Voss 背景');
  h.ports[0].onMessage.emit({ requestId: first, ok: true, text: '记得你', model: 'fixture' }); await flush();
  assert.equal(r.responses[0].state.messages.length, 2);
  const next = await chatState(h);
  h.send({ type: 'VOSS_CHAT', requestId: second, expected: next, text: '继续' }); await flush();
  assert.equal(h.ports[1].sent[0].conversation.history[1].text, '记得你');
});

test('cancelling during storage read never launches a native host', async () => {
  const h = setup(), state = await chatState(h); let release;
  const original = h.chrome.storage.local.get;
  h.chrome.storage.local.get = async () => { await new Promise(resolve => { release = resolve; }); return original(); };
  const r = h.send({ type: 'VOSS_CHAT', requestId: first, expected: state, text: 'hi' }); await flush();
  h.send({ type: 'VOSS_CANCEL', requestId: first }); release(); await flush();
  assert.equal(r.responses[0].code, 'CANCELLED'); assert.equal(h.ports.length, 0);
});

test('moving to another note keeps a pending chat; saving memory cancels it; stale revisions are refused', async () => {
  const h = setup(), state = await chatState(h);
  const r = h.send({ type: 'VOSS_CHAT', requestId: first, expected: state, text: 'hi' }); await flush();
  h.chrome.tabs.onUpdated.emit(1, { url: 'https://www.xiaohongshu.com/explore/next' });
  h.chrome.tabs.onUpdated.emit(1, { status: 'loading' });
  assert.equal(r.responses.length, 0); assert.equal(h.ports[0].disconnected, 0);
  const edit = h.send({ type: 'VOSS_MEMORY_SAVE', requestId: second, expected: state, memory: '新背景' }); await flush();
  assert.equal(r.responses[0].code, 'CANCELLED'); assert.equal(h.ports[0].disconnected, 1);
  assert.equal(edit.responses[0].state.memory, '新背景');
  const stale = h.send({ type: 'VOSS_CHAT', requestId: first, expected: state, text: 'hi' }); await flush();
  assert.equal(stale.responses[0].code, 'CHAT_CHANGED'); assert.equal(h.ports.length, 1);
});

test('a reply that arrives after moving to another note is still saved; closing the tab stops a chat', async () => {
  const h = setup(), state = await chatState(h);
  const r = h.send({ type: 'VOSS_CHAT', requestId: first, expected: state, text: '这条怎么样', page: { title: '第一篇' } }); await flush();
  h.chrome.tabs.onUpdated.emit(1, { url: 'https://www.xiaohongshu.com/explore/next' });
  h.ports[0].onMessage.emit({ requestId: first, ok: true, text: '挺好的', model: 'fixture' }); await flush();
  assert.equal(r.responses[0].ok, true);
  assert.equal(r.responses[0].state.messages[0].pageTitle, '第一篇');
  const next = await chatState(h);
  const closed = h.send({ type: 'VOSS_CHAT', requestId: second, expected: next, text: 'hi' }); await flush();
  h.chrome.tabs.onRemoved.emit(1);
  assert.equal(closed.responses[0].code, 'CANCELLED'); assert.equal(h.ports[1].disconnected, 1);
});

test('model list is fetched only when asked, cached, validated, and used for the next chat', async () => {
  const h = setup();
  let r = h.send({ type: 'VOSS_SETTINGS', requestId: first }); await flush();
  assert.deepEqual(r.responses[0], { ok: true, settings: { model: '', effort: 'low', vision: true, learn: true, theme: 'rose', name: 'Voss', avatar: { kind: 'emoji', value: '🦊' } }, models: null });
  assert.equal(h.ports.length, 0, 'opening a page must not start Codex');
  r = h.send({ type: 'VOSS_SETTINGS', requestId: first, fetch: true }); await flush();
  assert.equal(h.ports.length, 1); assert.equal(h.ports[0].sent[0].type, 'models');
  const listId = h.ports[0].sent[0].requestId;
  h.ports[0].onMessage.emit({ requestId: listId, ok: true, models: [
    { id: 'gpt-a', name: 'A', efforts: ['low', 'high', 'invented'], isDefault: true }, { id: 'gpt-b', name: 'B', efforts: ['low'] }
  ] }); await flush();
  assert.deepEqual(r.responses[0].models, [
    { id: 'gpt-a', name: 'A', efforts: ['low', 'high'], isDefault: true }, { id: 'gpt-b', name: 'B', efforts: ['low'], isDefault: false }
  ]);
  assert.equal(h.ports[0].disconnected, 1);
  r = h.send({ type: 'VOSS_SETTINGS', requestId: first, fetch: true }); await flush();
  assert.equal(h.ports.length, 1, 'a fresh cache is reused'); assert.equal(r.responses[0].models[1].id, 'gpt-b');
  for (const settings of [{ model: 'gpt-b', effort: 'high' }, { model: 'unknown', effort: 'low' }, { model: 'bad id', effort: 'low' }, { effort: 'extreme' }, { vision: 'yes' }, { learn: 1 }, null]) {
    const saved = h.send({ type: 'VOSS_SETTINGS_SAVE', requestId: first, settings }); await flush();
    assert.equal(saved.responses[0].code, 'INVALID_SETTINGS');
  }
  const saved = h.send({ type: 'VOSS_SETTINGS_SAVE', requestId: first, settings: { model: 'gpt-a', effort: 'high' } }); await flush();
  assert.deepEqual(saved.responses[0].settings, { model: 'gpt-a', effort: 'high', vision: true, learn: true, theme: 'rose', name: 'Voss', avatar: { kind: 'emoji', value: '🦊' } });
  const state = await chatState(h);
  h.send({ type: 'VOSS_CHAT', requestId: second, expected: state, text: 'hi' }); await flush();
  assert.deepEqual(h.ports.at(-1).sent[0].options, { model: 'gpt-a', effort: 'high' });
});

test('a failed model list reports null models without breaking settings', async () => {
  const h = setup();
  const r = h.send({ type: 'VOSS_SETTINGS', requestId: first, fetch: true }); await flush();
  h.ports[0].onMessage.emit({ requestId: h.ports[0].sent[0].requestId, ok: false, code: 'LOGIN_REQUIRED' }); await flush();
  assert.deepEqual(r.responses[0], { ok: true, settings: { model: '', effort: 'low', vision: true, learn: true, theme: 'rose', name: 'Voss', avatar: { kind: 'emoji', value: '🦊' } }, models: null });
});

const tinyJpeg = 'data:image/jpeg;base64,' + 'A'.repeat(400);
test('note images go to the host with the chat and the saved question records how many', async () => {
  const h = setup(), state = await chatState(h);
  const r = h.send({ type: 'VOSS_CHAT', requestId: first, expected: state, text: '图里是什么', page: { title: '有图的笔记' }, images: [tinyJpeg, tinyJpeg] }); await flush();
  assert.deepEqual(h.ports[0].sent[0].images, [tinyJpeg, tinyJpeg]);
  assert.equal(h.ports[0].sent[0].conversation.images, undefined, 'images travel beside the text conversation');
  h.ports[0].onMessage.emit({ requestId: first, ok: true, text: '一只猫', model: 'fixture' }); await flush();
  assert.equal(r.responses[0].state.messages[0].images, 2);
  const next = await chatState(h);
  h.send({ type: 'VOSS_CHAT', requestId: second, expected: next, text: '继续' }); await flush();
  assert.match(h.ports[1].sent[0].conversation.history[0].text, /附了 2 张笔记图片/);
  assert.deepEqual(h.ports[1].sent[0].images, []);
});

test('malformed, oversized or too many images are refused before a host starts', async () => {
  for (const images of [['https://example.test/a.jpg'], ['data:text/html;base64,AAAA'], ['data:image/jpeg;base64,AA"A'],
    ['data:image/jpeg;base64,' + 'A'.repeat(700_001)], Array(7).fill(tinyJpeg), 'data:image/jpeg;base64,AAAA', [42]]) {
    const h = setup(), state = await chatState(h);
    const r = h.send({ type: 'VOSS_CHAT', requestId: first, expected: state, text: 'hi', page: { title: 't' }, images }); await flush();
    assert.equal(r.responses[0].code, 'INVALID_IMAGES'); assert.equal(h.ports.length, 0);
  }
});

test('turning vision off, or chatting without a page, sends no images', async () => {
  const h = setup();
  const off = h.send({ type: 'VOSS_SETTINGS_SAVE', requestId: first, settings: { model: '', effort: 'low', vision: false } }); await flush();
  assert.equal(off.responses[0].settings.vision, false);
  let state = await chatState(h);
  h.send({ type: 'VOSS_CHAT', requestId: first, expected: state, text: 'hi', page: { title: 't' }, images: [tinyJpeg] }); await flush();
  assert.deepEqual(h.ports[0].sent[0].images, []);
  const g = setup(); state = await chatState(g);
  g.send({ type: 'VOSS_CHAT', requestId: first, expected: state, text: 'hi', page: null, images: [tinyJpeg] }); await flush();
  assert.deepEqual(g.ports[0].sent[0].images, []);
});

test('long-term memory: remembered facts go to the model; learned and forgotten items are saved with the reply', async () => {
  const h = setup(); let state = await chatState(h);
  h.send({ type: 'VOSS_CHAT', requestId: first, expected: state, text: '以后回答短一点' }); await flush();
  assert.equal(h.ports[0].sent[0].learn, true, 'learning is on by default');
  assert.deepEqual(h.ports[0].sent[0].conversation.remembered, []);
  const r1 = h.send({ type: 'VOSS_CHAT_STATE', requestId: second }); await flush();
  h.ports[0].onMessage.emit({ requestId: first, ok: true, text: '好的', model: 'fixture', remember: ['用户希望回答简短'], forget: [] }); await flush();
  state = await chatState(h);
  assert.equal(state.memories.length, 1); assert.equal(state.memories[0].text, '用户希望回答简短'); assert.equal(state.memories[0].source, 'auto');
  const id = state.memories[0].id;
  const r = h.send({ type: 'VOSS_CHAT', requestId: second, expected: state, text: '忘掉刚才那条' }); await flush();
  assert.deepEqual(h.ports[1].sent[0].conversation.remembered.map(item => [item.id, item.text]), [[id, '用户希望回答简短']]);
  assert.match(h.ports[1].sent[0].conversation.remembered[0].date, /^\d{4}-\d{2}-\d{2}$/);
  h.ports[1].onMessage.emit({ requestId: second, ok: true, text: '已忘掉', model: 'fixture', remember: ['用户在学写文案'], forget: [id] }); await flush();
  assert.deepEqual(r.responses[0].learned.map(item => item.text), ['用户在学写文案']);
  assert.deepEqual(r.responses[0].forgotten, ['用户希望回答简短']);
  assert.deepEqual(r.responses[0].state.memories.map(item => item.text), ['用户在学写文案']);
});

test('long-term memory: malformed updates are dropped but the reply is kept; duplicates are not stored twice', async () => {
  const h = setup(); let state = await chatState(h);
  const bad = h.send({ type: 'VOSS_CHAT', requestId: first, expected: state, text: 'hi' }); await flush();
  h.ports[0].onMessage.emit({ requestId: first, ok: true, text: '回复', model: 'fixture', remember: ['a', 'b', 'c'], forget: [] }); await flush();
  assert.equal(bad.responses[0].ok, true); assert.equal(bad.responses[0].state.memories.length, 0);
  state = await chatState(h);
  const dup = h.send({ type: 'VOSS_CHAT', requestId: second, expected: state, text: 'hi' }); await flush();
  h.ports[1].onMessage.emit({ requestId: second, ok: true, text: '回复', model: 'fixture', remember: ['用户喜欢猫', '用户喜欢猫。'], forget: ['m-notreal1'] }); await flush();
  assert.equal(dup.responses[0].state.memories.length, 1);
  assert.deepEqual(dup.responses[0].forgotten, []);
});

test('long-term memory: turning learning off still sends what is remembered; items can be deleted and survive a new chat', async () => {
  const h = setup(); let state = await chatState(h);
  h.send({ type: 'VOSS_CHAT', requestId: first, expected: state, text: '记住我叫小林' }); await flush();
  h.ports[0].onMessage.emit({ requestId: first, ok: true, text: '记住了', model: 'fixture', remember: ['用户叫小林', '用户喜欢雾粉色'], forget: [] }); await flush();
  const off = h.send({ type: 'VOSS_SETTINGS_SAVE', requestId: first, settings: { learn: false } }); await flush();
  assert.equal(off.responses[0].settings.learn, false);
  state = await chatState(h);
  h.send({ type: 'VOSS_CHAT', requestId: second, expected: state, text: 'hi' }); await flush();
  assert.equal(h.ports[1].sent[0].learn, false);
  assert.equal(h.ports[1].sent[0].conversation.remembered.length, 2);
  h.ports[1].onMessage.emit({ requestId: second, ok: true, text: '嗨', model: 'fixture', remember: ['用户不该被记住'], forget: [] }); await flush();
  state = await chatState(h);
  assert.equal(state.memories.length, 2, 'updates are ignored while learning is off');
  const del = h.send({ type: 'VOSS_MEMORY_DELETE', requestId: first, id: state.memories[0].id, expected: state }); await flush();
  assert.deepEqual(del.responses[0].state.memories.map(item => item.text), ['用户喜欢雾粉色']);
  const fresh = h.send({ type: 'VOSS_NEW_CHAT', requestId: first, expected: del.responses[0].state }); await flush();
  assert.deepEqual(fresh.responses[0].state.memories.map(item => item.text), ['用户喜欢雾粉色']);
  assert.equal(fresh.responses[0].state.messages.length, 0);
});

test('a shared note is saved with its question so later text-only follow-ups can refer to it', async () => {
  const h = setup(); let state = await chatState(h);
  h.send({ type: 'VOSS_CHAT', requestId: first, expected: state, text: '聊聊这条', page: { title: '苍蝇馆子', author: '阿明', description: '排队半小时，辣子鸡真的绝' } }); await flush();
  h.ports[0].onMessage.emit({ requestId: first, ok: true, text: '辣子鸡听着不错', model: 'fixture' }); await flush();
  state = await chatState(h);
  assert.equal(state.messages[0].pageText, '作者：阿明\n排队半小时，辣子鸡真的绝');
  h.send({ type: 'VOSS_CHAT', requestId: second, expected: state, text: '排队多久来着', page: null }); await flush();
  const followUp = h.ports[1].sent[0];
  assert.equal(followUp.conversation.page, null);
  assert.deepEqual(followUp.images, []);
  assert.match(followUp.conversation.history[0].text, /当时的笔记文字：作者：阿明\n排队半小时/);
  h.ports[1].onMessage.emit({ requestId: second, ok: true, text: '半小时', model: 'fixture' }); await flush();
  state = await chatState(h);
  assert.equal('pageText' in state.messages[2], false, 'a plain message stores no note');
});

test('appearance: theme, name and avatar save on their own, are validated, and the name reaches the model', async () => {
  const h = setup();
  const save = async settings => { const r = h.send({ type: 'VOSS_SETTINGS_SAVE', requestId: first, settings }); await flush(); return r.responses[0]; };
  let r = await save({ theme: 'green' });
  assert.equal(r.settings.theme, 'green'); assert.equal(r.settings.effort, 'low', 'other fields keep their values');
  r = await save({ name: ' 阿狸 ', avatar: { kind: 'emoji', value: '🐱' } });
  assert.equal(r.settings.name, '阿狸'); assert.deepEqual(r.settings.avatar, { kind: 'emoji', value: '🐱' }); assert.equal(r.settings.theme, 'green');
  const png = 'data:image/png;base64,' + 'A'.repeat(1000);
  r = await save({ avatar: { kind: 'image', data: png } });
  assert.deepEqual(r.settings.avatar, { kind: 'image', data: png });
  for (const bad of [{ theme: 'purple' }, { name: '' }, { name: 'x'.repeat(21) }, { name: '<b>坏</b>' }, { name: '换\n行' },
    { avatar: { kind: 'emoji', value: '🦊🦊🦊🦊🦊' } }, { avatar: { kind: 'image', data: 'https://example.test/a.png' } },
    { avatar: { kind: 'image', data: 'data:image/png;base64,' + 'A'.repeat(200_001) } }, { avatar: { kind: 'script', value: 'x' } }]) {
    assert.equal((await save(bad)).code, 'INVALID_SETTINGS', JSON.stringify(bad).slice(0, 60));
  }
  const state = await chatState(h);
  h.send({ type: 'VOSS_CHAT', requestId: second, expected: state, text: '你叫什么' }); await flush();
  assert.equal(h.ports.at(-1).sent[0].conversation.name, '阿狸');
  await save({ name: 'Voss' });
  const next = await chatState(h);
  h.send({ type: 'VOSS_CHAT', requestId: first, expected: next, text: 'hi' }); await flush();
  assert.equal('name' in h.ports.at(-1).sent[0].conversation, false, 'the default name adds nothing to the prompt');
});

const sampleComments = { total: 128, items: [
  { text: '辣子鸡真的绝', likes: '1.2万', pinned: true, replies: [{ text: '同意', likes: '12' }, { text: '谢谢喜欢～', byAuthor: true }] },
  { text: '排队太久了', likes: '8' }
] };
test('comments shared with a note reach the model and a short version is kept for follow-ups', async () => {
  const h = setup(); let state = await chatState(h);
  const page = { title: '苍蝇馆子', author: '阿明', description: '排队半小时', comments: sampleComments };
  h.send({ type: 'VOSS_CHAT', requestId: first, expected: state, text: '聊聊这条', page }); await flush();
  assert.deepEqual(h.ports[0].sent[0].conversation.page.comments, sampleComments);
  h.ports[0].onMessage.emit({ requestId: first, ok: true, text: '评论都在夸', model: 'fixture' }); await flush();
  state = await chatState(h);
  assert.equal(state.messages[0].comments, 2);
  assert.match(state.messages[0].pageText, /评论：\n- 辣子鸡真的绝\n- 排队太久了/);
});

test('malformed comments are refused before a host starts; extra fields are dropped', async () => {
  const bad = [
    { items: 'x' }, { items: Array(21).fill({ text: 'a' }) }, { items: [{ text: '' }] }, { items: [{ text: 'x'.repeat(301) }] },
    { items: [{ text: 'a', likes: '<b>' }] }, { items: [{ text: 'a', replies: Array(3).fill({ text: 'b' }) }] },
    { items: [{ text: 'a', replies: [{ text: 'b', replies: [{ text: 'c' }] }] }] }, { total: -1, items: [] }
  ];
  for (const comments of bad) {
    const h = setup(), state = await chatState(h);
    const r = h.send({ type: 'VOSS_CHAT', requestId: first, expected: state, text: 'hi', page: { title: 't', comments } }); await flush();
    assert.equal(r.responses[0].code, 'INVALID_CHAT', JSON.stringify(comments).slice(0, 50)); assert.equal(h.ports.length, 0);
  }
  const h = setup(), state = await chatState(h);
  h.send({ type: 'VOSS_CHAT', requestId: first, expected: state, text: 'hi', page: { title: 't', comments: { total: 3, items: [{ text: 'a', user: '某人', ip: '上海', date: '昨天' }] } } }); await flush();
  assert.deepEqual(h.ports[0].sent[0].conversation.page.comments, { total: 3, items: [{ text: 'a' }] });
});
