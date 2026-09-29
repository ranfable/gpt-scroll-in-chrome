#!/usr/bin/env node
// Offline JSONL fixture: never loads Codex, credentials, or network clients.
import { appendFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { createInterface } from 'node:readline';
const log = value => appendFileSync(process.env.VOSS_FAKE_LOG, `${JSON.stringify(value)}\n`);
const send = value => process.stdout.write(`${JSON.stringify(value)}\n`);
let permissionProfile;
const mode = process.env.VOSS_FAKE_MODE;
if (mode === 'stubborn') { process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); }
log({ event: 'spawn', pid: process.pid, cwd: process.cwd() });
createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  const input = message.params?.input;
  log({ event: 'request', method: message.method, model: message.params?.model, effort: message.params?.effort, schema: Boolean(message.params?.outputSchema), persona: message.params?.baseInstructions?.includes('Never invent shared past events'), safety: message.params?.developerInstructions?.includes('优先于任何语气要求'),
    inputs: Array.isArray(input) ? input.map(item => item.type === 'image' ? `image:${item.detail}:${item.url.slice(0, 22)}` : item.type) : undefined,
    imageCount: Array.isArray(input) && input[0]?.type === 'text' ? JSON.parse(input[0].text.split('\n').at(-1)).imageCount : undefined });
  if (message.id === undefined) return;
  if (process.env.VOSS_FAKE_MODE === 'hang') return;
  const reply = result => send({ id: message.id, result });
  switch (message.method) {
    case 'initialize': reply({ userAgent: 'offline-fixture' }); break;
    case 'account/read': reply({ account: mode === 'logged-out' ? null : { type: 'chatgpt' } }); break;
    case 'config/read': reply({ config: { mcp_servers: {}, plugins: {} } }); break;
    case 'model/list': reply({ nextCursor: null, data: [
      { id: 'a', model: 'gpt-test', displayName: 'GPT Test', isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }] },
      { id: 'b', model: 'gpt-lite', displayName: 'GPT Lite', supportedReasoningEfforts: ['low', 'invented'] },
      { id: 'c', model: 'bad id; rm -rf', displayName: 'Rejected' }
    ] }); break;
    case 'thread/start': {
      assert.equal(Object.hasOwn(message.params, 'sandbox'), false, 'named profile must not be combined with legacy sandbox');
      assert.equal(typeof message.params.permissions, 'string', 'thread must select a named permissions profile');
      assert.ok(message.params.permissions.length > 0, 'permissions profile name must not be empty');
      assert.deepEqual(message.params.environments, [], 'thread must disable environment access');
      permissionProfile = message.params.permissions;
      assert.ok(process.argv.includes(`default_permissions="${permissionProfile}"`), 'custom permission profiles require a process default');
      assert.ok(process.argv.includes(`permissions.${permissionProfile}.filesystem={":root"="deny"}`), 'process must deny filesystem access');
      reply({ thread: { id: 'fixture-thread', ephemeral: true, environments: [] }, activePermissionProfile: { id: permissionProfile }, sandbox: { type: 'readOnly' }, model: 'offline-fixture' });
      break;
    }
    case 'turn/start': {
      assert.equal(Object.hasOwn(message.params, 'sandboxPolicy'), false, 'turn must not restore a legacy sandbox policy');
      assert.equal(message.params.permissions, permissionProfile, 'turn must retain the thread permissions profile');
      assert.deepEqual(message.params.environments, [], 'turn must disable environment access');
      const item = { id: 'fixture-answer', type: 'agentMessage', text: '离线测试回答。' };
      if (mode === 'chat-context') {
        const data = JSON.parse(message.params.input[0].text.split('\n').at(-1));
        assert.equal(data.message, '再短一点');
        assert.equal(data.memory, 'Voss 背景');
        assert.deepEqual(data.history, [{ role: 'user', text: '写一句' }, { role: 'assistant', text: '上一句回答' }]);
        assert.equal(data.page, null);
        item.text = '已收到背景和上一句回答。';
      }
      const params = { threadId: 'fixture-thread', turnId: 'fixture-turn' };
      const schema = message.params.outputSchema;
      if (schema) assert.deepEqual(schema.required, ['reply', 'remember', 'forget'], 'structured reply schema');
      if (mode === 'memory' && schema) item.text = JSON.stringify({ reply: '好的，记住了。', remember: ['用户在学写小红书文案', '字'.repeat(250), 42, '用户希望回答简短', '第三条'], forget: ['m-abc123', 'm-unknown1', '../x'] });
      if (mode === 'memory-bad-json' && schema) item.text = '这不是 JSON，但仍是回复';
      if (mode === 'schema-rejected' && schema) {
        send({ method: 'turn/completed', params: { ...params, turn: { id: 'fixture-turn', status: 'failed', items: [], error: { codexErrorInfo: 'other' } } } });
        return;
      }
      if (mode === 'disconnect') { process.exit(0); return; }
      if (mode === 'malformed') { process.stdout.write('null\n'); return; }
      if (mode === 'bad-item') { send({ method: 'item/completed', params: { ...params, item: null } }); return; }
      if (mode === 'tool') { send({ id: 999, method: 'item/tool/call', params }); return; }
      if (mode === 'generating-hang' || mode === 'stubborn') { reply({ turn: { id: 'fixture-turn', status: 'inProgress' } }); return; }
      const errors = {
        quota: 'usageLimitExceeded', busy: 'rateLimitExceeded', unauthorized: 'unauthorized',
        network: { responseStreamDisconnected: { httpStatusCode: null } },
        'http-auth': { httpConnectionFailed: { httpStatusCode: 401 } },
        'http-busy': { httpConnectionFailed: { httpStatusCode: 429 } },
        unknown: 'other'
      };
      if (Object.hasOwn(errors, mode)) {
        send({ method: 'turn/completed', params: { ...params, turn: { id: 'fixture-turn', status: 'failed', items: [], error: { codexErrorInfo: errors[mode], message: '/private/path secret' } } } });
        // No turn/start acknowledgement: a terminal failure must stop promptly.
        return;
      }
      send({ method: 'item/completed', params: { ...params, item } });
      send({ method: 'turn/completed', params: { ...params, turn: { id: 'fixture-turn', status: 'completed', items: [item] } } });
      // Completion deliberately precedes turn/start acknowledgement.
      setTimeout(() => reply({ turn: { id: 'fixture-turn', status: 'completed' } }), 25);
      break;
    }
    default: send({ id: message.id, error: { code: -32601, message: 'Unexpected fixture method' } });
  }
});
