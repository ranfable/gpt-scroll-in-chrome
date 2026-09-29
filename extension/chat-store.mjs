const KEY = 'voss.chat.v1';
const MAX_MESSAGES = 100;
const MAX_SAVED_CHARS = 160000;
// Long-term memory: short facts about the user, kept across new chats.
export const MAX_MEMORIES = 80;
const MAX_MEMORY_TEXT = 200;
const MEMORY_ID = /^m-[a-z0-9]{6,20}$/;
const sameFact = (a, b) => a.replace(/[\s，。,.!！]/g, '') === b.replace(/[\s，。,.!！]/g, '');
const localDate = at => { const d = new Date(at); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
export class ChatStoreError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
const clone = value => structuredClone(value);
const fail = (code, message) => { throw new ChatStoreError(code, message); };
const cleanText = (value, limit, allowEmpty = false) => {
  if (typeof value !== 'string' || value.length > limit || (!allowEmpty && !value.trim())) fail('INVALID_CHAT', '聊天文字无效或过长。');
  return value.trim();
};

// Owned by the extension background. The caller supplies chrome.storage.local.
// Serialize mutations and compare revisions so simultaneous tabs cannot overwrite.
export function createChatStore(storage, initialMemory = '') {
  let queue = Promise.resolve();
  const access = storage.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  Promise.resolve(access).catch(() => {});
  const serialized = operation => {
    const result = queue.then(async () => { await access; return operation(); });
    queue = result.catch(() => {});
    return result;
  };
  async function load() {
    const stored = (await storage.get(KEY))[KEY];
    if (stored !== undefined) {
      if (stored?.schema !== 1 || !Number.isSafeInteger(stored.revision) || stored.revision < 0 || typeof stored.sessionId !== 'string'
        || typeof stored.memory !== 'string' || !Array.isArray(stored.messages) || !Array.isArray(stored.archives)
        || (stored.memories !== undefined && !Array.isArray(stored.memories))) {
        fail('STORAGE_INVALID', '聊天记录格式无法识别，未覆盖现有记录。');
      }
      // Records saved before long-term memory existed start with an empty list.
      return clone({ ...stored, memories: stored.memories ?? [] });
    }
    const state = { schema: 1, revision: 0, sessionId: crypto.randomUUID(), memory: cleanText(initialMemory, 6000, true), memories: [], messages: [], archives: [], droppedMessages: 0 };
    await storage.set({ [KEY]: state });
    return clone(state);
  }
  function check(state, expected) {
    if (!expected || state.revision !== expected.revision || state.sessionId !== expected.sessionId) fail('CHAT_CHANGED', '聊天已在另一处更新，请刷新聊天后重试。');
  }
  async function save(state) {
    const next = { ...state, revision: state.revision + 1 };
    await storage.set({ [KEY]: next });
    return clone(next);
  }
  return {
    read: () => serialized(load),
    saveMemory: (value, expected) => serialized(async () => {
      const memory = cleanText(value, 6000, true);
      const state = await load(); check(state, expected); state.memory = memory;
      return save(state);
    }),
    appendExchange: (value, expected, stillCurrent = () => true) => serialized(async () => {
      const question = cleanText(value.question, 4000), answer = cleanText(value.answer, 20000);
      const pageTitle = value.pageTitle === undefined ? '' : cleanText(value.pageTitle, 300, true);
      const pageText = value.pageText === undefined ? '' : cleanText(value.pageText, 1500, true);
      const images = value.images === undefined ? 0 : value.images;
      if (!Number.isInteger(images) || images < 0 || images > 6) fail('INVALID_CHAT', '聊天文字无效或过长。');
      const comments = value.comments === undefined ? 0 : value.comments;
      if (!Number.isInteger(comments) || comments < 0 || comments > 20) fail('INVALID_CHAT', '聊天文字无效或过长。');
      const remember = value.remember === undefined ? [] : value.remember;
      const forget = value.forget === undefined ? [] : value.forget;
      if (!Array.isArray(remember) || remember.length > 2 || !Array.isArray(forget) || forget.length > 5
        || forget.some(id => typeof id !== 'string' || !MEMORY_ID.test(id))) fail('INVALID_CHAT', '聊天文字无效或过长。');
      const facts = remember.map(item => cleanText(item, MAX_MEMORY_TEXT));
      const state = await load(); check(state, expected);
      if (!stillCurrent()) fail('CANCELLED', '已取消聊天。');
      const at = Date.now();
      // The reply and its memory changes are saved together or not at all.
      state.memories = state.memories.filter(item => !forget.includes(item.id));
      for (const text of facts) {
        if (state.memories.some(item => sameFact(item.text, text))) continue;
        state.memories.push({ id: `m-${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`, text, at, source: 'auto' });
      }
      state.memories = state.memories.slice(-MAX_MEMORIES);
      const user = { role: 'user', text: question, pageTitle, at };
      if (images) user.images = images;
      if (comments) user.comments = comments;
      if (pageText) user.pageText = pageText;
      state.messages.push(user, { role: 'assistant', text: answer, at });
      let chars = state.messages.reduce((sum, item) => sum + item.text.length, 0);
      while (state.messages.length > MAX_MESSAGES || chars > MAX_SAVED_CHARS) {
        const removed = state.messages.splice(0, 2); chars -= removed.reduce((sum, item) => sum + item.text.length, 0); state.droppedMessages += removed.length;
      }
      return save(state);
    }),
    deleteMemory: (id, expected) => serialized(async () => {
      if (typeof id !== 'string' || !MEMORY_ID.test(id)) fail('INVALID_CHAT', '聊天文字无效或过长。');
      const state = await load(); check(state, expected);
      state.memories = state.memories.filter(item => item.id !== id);
      return save(state);
    }),
    restoreChat: (sessionId, expected) => serialized(async () => {
      const state = await load(); check(state, expected);
      const selected = state.archives.find(item => item.sessionId === sessionId);
      if (!selected) fail('CHAT_CHANGED', '找不到这段聊天，请刷新后重试。');
      state.archives = state.archives.filter(item => item.sessionId !== sessionId);
      if (state.messages.length) state.archives.push({ sessionId: state.sessionId, messages: state.messages, droppedMessages: state.droppedMessages });
      state.archives = state.archives.slice(-5);
      state.sessionId = selected.sessionId; state.messages = selected.messages; state.droppedMessages = selected.droppedMessages;
      return save(state);
    }),
    newChat: expected => serialized(async () => {
      const state = await load(); check(state, expected);
      if (state.messages.length) state.archives = [...state.archives, { sessionId: state.sessionId, messages: state.messages, droppedMessages: state.droppedMessages }].slice(-5);
      state.sessionId = crypto.randomUUID(); state.messages = []; state.droppedMessages = 0;
      return save(state);
    })
  };
}

// Old messages remain in local storage; send only recent complete exchanges.
// A page title labels historical turns, so the model can distinguish old notes.
export function recentHistory(state, limit = 24, charBudget = 16000) {
  const result = []; let used = 0;
  for (let i = state.messages.length - 2; i >= 0 && result.length < limit; i -= 2) {
    const user = state.messages[i], assistant = state.messages[i + 1];
    // Earlier images are not re-sent; the note tells the model they existed.
    // A shared note travels once; later text-only follow-ups see it through history.
    const userText = (user.pageTitle ? `当时讨论的内容：${user.pageTitle}\n` : '')
      + (user.pageText ? `当时的笔记文字：${user.pageText.slice(0, 800)}\n` : '')
      + (user.images ? `（当时附了 ${user.images} 张笔记图片）\n` : '') + user.text;
    const remaining = charBudget - used;
    if (remaining < 100) break;
    const shorten = (value, max) => value.length <= max ? value : value.slice(0, max - 8) + '…[已截短]';
    // Include the latest exchange even when a model answer is unusually long.
    if (result.length && userText.length + assistant.text.length > remaining) break;
    const question = shorten(userText, Math.min(4300, Math.floor(remaining / 2)));
    const answer = shorten(assistant.text, remaining - question.length);
    result.unshift({ role: 'user', text: question }, { role: 'assistant', text: answer });
    used += question.length + answer.length;
  }
  return result;
}

// What the model sees of long-term memory: id (so it can ask to forget), text and date.
export function rememberedForPrompt(state) {
  return (state.memories || []).map(item => ({ id: item.id, text: item.text, date: localDate(item.at) }));
}
