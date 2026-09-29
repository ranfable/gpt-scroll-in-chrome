import { createChatStore, recentHistory, rememberedForPrompt } from "./chat-store.mjs";
(() => {
  "use strict";
  const HOST = "com.voss.scroll";
  const TIMEOUT_MS = 95_000;
  const MAX_TEXT = 20_000;
  const MODES = new Set(["together", "roast", "learn", "viral"]);
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const pending = new Map();
  const chatJobs = new Map();
  let storePromise;
  function getStore() {
    if (!storePromise) storePromise = fetch(chrome.runtime.getURL('voss-memory.json'))
      .then(response => { if (!response.ok) throw new Error('memory unavailable'); return response.json(); })
      .then(seed => createChatStore(chrome.storage.local, seed.text))
      .catch(error => { storePromise = null; throw error; });
    return storePromise;
  }
  const safeFailure = error => failure(Object.hasOwn(MESSAGES, error?.code) ? error.code : 'STORAGE_UNAVAILABLE');
  function cancelTab(tabId, code = 'CANCELLED') {
    chatJobs.get(tabId)?.finish(failure(code));
    pending.get(tabId)?.finish(failure(code));
  }
  function cancelAll() {
    for (const tabId of new Set([...chatJobs.keys(), ...pending.keys()])) cancelTab(tabId);
  }
  const MESSAGES = Object.freeze({
    FORBIDDEN: "只能在抖音或小红书的当前页面发起分析。",
    INVALID_INPUT: "分析请求无效，请刷新页面后重试。",
    INVALID_MODE: "请选择有效的分析模式。",
    EMPTY_CONTENT: "请先打开一篇有文字的笔记或视频。",
    CONTENT_TOO_LONG: "这条文字太长，暂时无法分析。",
    NATIVE_UNAVAILABLE: "本机分析连接尚未就绪，请确认已安装 Voss 本机桥接。",
    DISCONNECTED: "本机分析连接已断开，请确认本机桥接已安装并重试。",
    CANCELLED: "已取消分析。",
    REPLACED: "已切换到新的分析请求。",
    TIMEOUT: "分析超时，请稍后重试。",
    LOGIN_REQUIRED: "请在 Codex 中登录 ChatGPT；若已登录，请重新登录后重试。",
    QUOTA_EXCEEDED: "Codex 额度不足，请等待额度恢复后重试。",
    SERVICE_BUSY: "模型服务繁忙，请稍后重试。",
    NETWORK_ERROR: "模型连接中断，请检查网络后重试。",
    START_FAILED: "无法启动本机 Codex，请确认已完成安装。",
    UNEXPECTED_TOOL: "分析请求试图使用工具，已停止。",
    UNSAFE_CONFIG: "本机分析权限设置不符合预期，已停止。",
    EMPTY_RESPONSE: "模型没有返回文字，请重试。",
    RESPONSE_TOO_LONG: "模型回答过长，请重试。",
    BAD_PROTOCOL: "本机分析返回了无法识别的数据，请重试。",
    MODEL_FAILED: "模型未完成回答，请稍后重试。",
    INVALID_CHAT: "聊天内容无效或过长，请缩短后重试。",
    CHAT_CHANGED: "聊天已在另一处更新，已为你保留输入，请重新发送。",
    STORAGE_INVALID: "聊天记录格式无法识别，现有记录未被覆盖。",
    STORAGE_UNAVAILABLE: "聊天记录暂时无法保存，请稍后重试。",
    INVALID_SETTINGS: "这个模型或思考深度不可用，请重新选择。",
    MODELS_UNAVAILABLE: "暂时读不到可用模型，请稍后重试。",
    INVALID_IMAGES: "笔记图片没能准备好，请重新发送。"
  });
  const MAX_IMAGES = 6;
  const MAX_IMAGE_CHARS = 700_000;
  const IMAGE_DATA_URL = /^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/;
  const validImages = value => Array.isArray(value) && value.length <= MAX_IMAGES
    && value.every(url => typeof url === "string" && url.length <= MAX_IMAGE_CHARS && IMAGE_DATA_URL.test(url));
  const SETTINGS_KEY = "voss.settings.v1";
  const MODELS_KEY = "voss.models.v1";
  const MODELS_TTL = 24 * 60 * 60 * 1000;
  const EFFORTS = ["low", "medium", "high", "xhigh", "max", "ultra"];
  const MODEL_ID = /^[\w.-]{1,80}$/;
  let modelsFetch = null;

  function cleanModels(value) {
    if (!Array.isArray(value) || !value.length || value.length > 50) return null;
    const models = [];
    for (const item of value) {
      if (!record(item) || typeof item.id !== "string" || !MODEL_ID.test(item.id)) return null;
      const efforts = Array.isArray(item.efforts) ? item.efforts.filter(effort => EFFORTS.includes(effort)) : [];
      models.push({ id: item.id, name: typeof item.name === "string" && item.name ? item.name.slice(0, 80) : item.id, efforts: efforts.length ? efforts : ["low"], isDefault: item.isDefault === true });
    }
    return models;
  }
  async function readCachedModels() {
    const value = (await chrome.storage.local.get(MODELS_KEY))[MODELS_KEY];
    const models = cleanModels(value?.models);
    return models && Number.isSafeInteger(value.at) ? { at: value.at, models } : null;
  }
  // Listing models starts Codex without a thread or turn: no page text, no quota.
  function fetchModels() {
    modelsFetch ||= new Promise(resolve => {
      let port, timer, done = false;
      const requestId = crypto.randomUUID();
      const finish = models => {
        if (done) return; done = true; clearTimeout(timer);
        try { port?.disconnect(); } catch {}
        modelsFetch = null; resolve(models);
      };
      try {
        port = chrome.runtime.connectNative(HOST);
        port.onDisconnect.addListener(() => { void chrome.runtime.lastError; finish(null); });
        port.onMessage.addListener(message => {
          if (record(message) && message.requestId === requestId) finish(message.ok === true ? cleanModels(message.models) : null);
        });
        timer = setTimeout(() => finish(null), TIMEOUT_MS);
        port.postMessage({ type: "models", requestId });
      } catch { finish(null); }
    });
    return modelsFetch;
  }
  async function loadModels(allowFetch) {
    const cached = await readCachedModels();
    if (cached && Date.now() - cached.at < MODELS_TTL) return cached.models;
    if (!allowFetch) return cached?.models ?? null;
    const fetched = await fetchModels();
    if (fetched) await chrome.storage.local.set({ [MODELS_KEY]: { at: Date.now(), models: fetched } });
    return fetched ?? cached?.models ?? null;
  }
  const THEMES = ["rose", "blue", "green", "orange"];
  const DEFAULT_AVATAR = Object.freeze({ kind: "emoji", value: "🦊" });
  const AVATAR_IMAGE = /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/;
  // A display name: short, single line, no control characters or angle brackets.
  const cleanName = value => typeof value === "string" && /^[^\u0000-\u001f\u007f<>]{1,20}$/u.test(value.trim()) ? value.trim() : null;
  function cleanAvatar(value) {
    if (!record(value)) return null;
    if (value.kind === "emoji" && typeof value.value === "string" && value.value.trim() && [...value.value.trim()].length <= 4 && !/[<>\u0000-\u001f]/.test(value.value)) return { kind: "emoji", value: value.value.trim() };
    if (value.kind === "image" && typeof value.data === "string" && value.data.length <= 200_000 && AVATAR_IMAGE.test(value.data)) return { kind: "image", data: value.data };
    return null;
  }
  async function readSettings() {
    const value = (await chrome.storage.local.get(SETTINGS_KEY))[SETTINGS_KEY];
    return {
      model: typeof value?.model === "string" && (value.model === "" || MODEL_ID.test(value.model)) ? value.model : "",
      effort: EFFORTS.includes(value?.effort) ? value.effort : "low",
      vision: value?.vision !== false,
      learn: value?.learn !== false,
      theme: THEMES.includes(value?.theme) ? value.theme : "rose",
      name: cleanName(value?.name) ?? "Voss",
      avatar: cleanAvatar(value?.avatar) ?? { ...DEFAULT_AVATAR }
    };
  }
  // Saves only the fields given; everything else keeps its current value.
  async function saveSettings(value) {
    if (!record(value)) throw Object.assign(new Error(), { code: "INVALID_SETTINGS" });
    const next = { ...(await readSettings()), ...value };
    const { model, effort, vision, learn, theme } = next;
    const name = cleanName(next.name), avatar = cleanAvatar(next.avatar);
    if (typeof model !== "string" || (model && !MODEL_ID.test(model)) || !EFFORTS.includes(effort) || typeof vision !== "boolean" || typeof learn !== "boolean"
      || !THEMES.includes(theme) || !name || !avatar) throw Object.assign(new Error(), { code: "INVALID_SETTINGS" });
    const models = (await readCachedModels())?.models;
    // Only a model or depth change is checked against the model list.
    if (models && ("model" in value || "effort" in value)) {
      const target = model ? models.find(item => item.id === model) : models.find(item => item.isDefault) || models[0];
      if (!target || !target.efforts.includes(effort)) throw Object.assign(new Error(), { code: "INVALID_SETTINGS" });
    }
    const settings = { model, effort, vision, learn, theme, name, avatar };
    await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
    return { settings, models: models ?? null };
  }
  const failure = code => ({ ok: false, code, message: MESSAGES[code] || MESSAGES.MODEL_FAILED });
  const record = value => value !== null && typeof value === "object" && !Array.isArray(value);

  function allowedSender(sender) {
    if (sender?.id !== chrome.runtime.id || sender.frameId !== 0 || !Number.isInteger(sender.tab?.id) || sender.tab.id < 0) return false;
    try {
      const url = new URL(sender.url);
      return url.protocol === "https:" && /(^|\.)(douyin|xiaohongshu)\.com$/i.test(url.hostname);
    } catch { return false; }
  }

  function prepareContent(value) {
    if (!record(value)) return { error: "INVALID_INPUT" };
    const content = {};
    for (const field of ["title", "author", "description"]) {
      const text = value[field] === undefined ? "" : value[field];
      if (typeof text !== "string") return { error: "INVALID_INPUT" };
      if (text.length > MAX_TEXT) return { error: "CONTENT_TOO_LONG" };
      content[field] = text.trim();
    }
    if (!content.title && !content.description) return { error: "EMPTY_CONTENT" };
    if (JSON.stringify(content).length > MAX_TEXT) return { error: "CONTENT_TOO_LONG" };
    return { content };
  }

  function respond(sendResponse, value) {
    try { sendResponse(value); } catch { /* The requesting document may have closed. */ }
  }

  function analyze(tabId, requestId, content, mode, sendResponse, chat = null, options = null, images = [], learn = false) {
    pending.get(tabId)?.finish(failure("REPLACED"));
    let port;
    try { port = chrome.runtime.connectNative(HOST); }
    catch { respond(sendResponse, failure("NATIVE_UNAVAILABLE")); return; }
    let done = false;
    let timer;
    const request = {
      requestId,
      finish(result) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (pending.get(tabId) === request) pending.delete(tabId);
        port.onMessage.removeListener(onMessage);
        port.onDisconnect.removeListener(onDisconnect);
        // Every request owns its process. Closing the port cancels native work.
        try { port.disconnect(); } catch {}
        respond(sendResponse, result);
      }
    };
    function onDisconnect() {
      // Consume Chrome's error without exposing paths or host diagnostics.
      void chrome.runtime.lastError;
      request.finish(failure("DISCONNECTED"));
    }
    function onMessage(message) {
      if (!record(message) || message.requestId !== requestId) return;
      if (message.ok === false) {
        const aliases = { RPC_TIMEOUT: "TIMEOUT", CLOSED: "DISCONNECTED", PROTOCOL_ERROR: "MODEL_FAILED" };
        const hostCode = typeof message.code === "string" ? message.code : "";
        const code = Object.hasOwn(aliases, hostCode) ? aliases[hostCode]
          : Object.hasOwn(MESSAGES, hostCode) ? hostCode : "MODEL_FAILED";
        request.finish(failure(code));
        return;
      }
      if (message.ok !== true || typeof message.text !== "string" || typeof message.model !== "string"
        || !/^[\w.-]{1,120}$/.test(message.model)) {
        request.finish(failure("BAD_PROTOCOL")); return;
      }
      if (!message.text.trim()) { request.finish(failure("EMPTY_RESPONSE")); return; }
      if (message.text.length > MAX_TEXT) { request.finish(failure("RESPONSE_TOO_LONG")); return; }
      const result = { ok: true, text: message.text.trim(), model: message.model };
      // Memory updates are optional extras: malformed ones are dropped, the reply is kept.
      if (learn && Array.isArray(message.remember) && Array.isArray(message.forget)
        && message.remember.length <= 2 && message.remember.every(item => typeof item === "string" && item.trim() && item.length <= 200)
        && message.forget.length <= 5 && message.forget.every(id => typeof id === "string" && /^m-[a-z0-9]{6,20}$/.test(id))) {
        result.remember = message.remember; result.forget = message.forget;
      }
      request.finish(result);
    }
    pending.set(tabId, request);
    port.onMessage.addListener(onMessage);
    port.onDisconnect.addListener(onDisconnect);
    timer = setTimeout(() => request.finish(failure("TIMEOUT")), TIMEOUT_MS);
    try { port.postMessage(chat ? { type: "chat", requestId, conversation: chat, options, images, learn } : { type: "analyze", requestId, content, mode }); }
    catch { request.finish(failure("DISCONNECTED")); }
  }

  // Kept with the question so text-only follow-ups can still refer to the note.
  const pageText = page => {
    if (!page) return '';
    // A few top comments too, so "what did people say" still works in follow-ups.
    const comments = (page.comments?.items || []).slice(0, 5).map(item => `- ${item.byAuthor ? '（作者）' : ''}${item.text.slice(0, 120)}`);
    return [page.author ? `作者：${page.author}` : '', page.description || '', comments.length ? `评论：\n${comments.join('\n')}` : ''].filter(Boolean).join('\n').slice(0, 1500);
  };
  // Comments are other people's words: bounded, no names, only the fields the model needs.
  const LIKES = /^[\d.,]+[万wWkK]?$/;
  function cleanComment(value, allowReplies) {
    if (!record(value) || typeof value.text !== 'string' || !value.text.trim() || value.text.length > 300) return null;
    const comment = { text: value.text.trim() };
    if (value.likes !== undefined) { if (typeof value.likes !== 'string' || value.likes.length > 12 || !LIKES.test(value.likes)) return null; comment.likes = value.likes; }
    if (value.byAuthor === true) comment.byAuthor = true;
    if (allowReplies && value.pinned === true) comment.pinned = true;
    if (value.replies !== undefined) {
      if (!allowReplies || !Array.isArray(value.replies) || value.replies.length > 2) return null;
      const replies = value.replies.map(reply => cleanComment(reply, false));
      if (replies.includes(null)) return null;
      if (replies.length) comment.replies = replies;
    }
    return comment;
  }
  function cleanComments(value) {
    if (!record(value) || !Array.isArray(value.items) || value.items.length > 20) return null;
    if (value.total !== null && value.total !== undefined && (!Number.isSafeInteger(value.total) || value.total < 0)) return null;
    const items = value.items.map(item => cleanComment(item, true));
    if (items.includes(null) || JSON.stringify(items).length > 12000) return null;
    return { total: value.total ?? null, items };
  }

  function startChat(tabId, message, sendResponse) {
    cancelTab(tabId, 'REPLACED');
    let done = false;
    const timer = setTimeout(() => { job.finish(failure('TIMEOUT')); pending.get(tabId)?.finish(failure('TIMEOUT')); }, TIMEOUT_MS);
    const job = {
      requestId: message.requestId,
      finish(result) {
        if (done) return;
        done = true; clearTimeout(timer);
        if (chatJobs.get(tabId) === job) chatJobs.delete(tabId);
        respond(sendResponse, result);
      }
    };
    chatJobs.set(tabId, job);
    void (async () => {
      try {
        const store = await getStore(); const state = await store.read();
        const settings = await readSettings();
        if (done) return;
        if (state.revision !== message.expected?.revision || state.sessionId !== message.expected?.sessionId) {
          job.finish(failure('CHAT_CHANGED')); return;
        }
        const conversation = { message: message.text.trim(), memory: state.memory, remembered: rememberedForPrompt(state), history: recentHistory(state), page: message.page, ...(settings.name !== "Voss" ? { name: settings.name } : {}) };
        // Images are only ever sent with a page, and only while the user allows it.
        const images = settings.vision && message.page ? message.images : [];
        analyze(tabId, message.requestId, null, null, result => {
          if (done) return;
          if (!result.ok) { job.finish(result); return; }
          const { remember = [], forget = [] } = result;
          void store.appendExchange({ question: conversation.message, answer: result.text, pageTitle: message.page?.title || '', pageText: pageText(message.page), images: images.length, comments: message.page?.comments?.items.length || 0, remember, forget }, state, () => !done)
            .then(saved => {
              // Tell the page exactly what changed so it can offer an undo.
              const before = new Set(state.memories.map(item => item.id)), after = new Set(saved.memories.map(item => item.id));
              const learned = saved.memories.filter(item => !before.has(item.id)).map(({ id, text }) => ({ id, text }));
              const forgotten = state.memories.filter(item => !after.has(item.id)).map(item => item.text);
              job.finish({ ok: true, text: result.text, model: result.model, state: saved, learned, forgotten });
            }, error => job.finish(safeFailure(error)));
        }, conversation, { model: settings.model, effort: settings.effort }, images, settings.learn);
      } catch (error) { job.finish(safeFailure(error)); }
    })();
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!record(message) || !["VOSS_ANALYZE", "VOSS_CANCEL", "VOSS_CHAT", "VOSS_CHAT_STATE", "VOSS_MEMORY_SAVE", "VOSS_NEW_CHAT", "VOSS_RESTORE_CHAT", "VOSS_SETTINGS", "VOSS_SETTINGS_SAVE", "VOSS_MEMORY_DELETE"].includes(message.type)) return false;
    if (!allowedSender(sender)) { respond(sendResponse, failure("FORBIDDEN")); return true; }
    if (typeof message.requestId !== "string" || message.requestId.length !== 36 || !UUID.test(message.requestId)) {
      respond(sendResponse, failure("INVALID_INPUT")); return true;
    }
    const tabId = sender.tab.id;
    if (message.type === "VOSS_CANCEL") {
      const request = chatJobs.get(tabId) || pending.get(tabId);
      const cancelled = request?.requestId === message.requestId;
      if (cancelled) cancelTab(tabId);
      respond(sendResponse, { ok: true, cancelled });
      return true;
    }
    if (message.type === "VOSS_SETTINGS") {
      void Promise.all([readSettings(), loadModels(message.fetch === true)])
        .then(([settings, models]) => respond(sendResponse, { ok: true, settings, models }))
        .catch(() => respond(sendResponse, failure("MODELS_UNAVAILABLE")));
      return true;
    }
    if (message.type === "VOSS_SETTINGS_SAVE") {
      void saveSettings(message.settings)
        .then(result => respond(sendResponse, { ok: true, ...result }))
        .catch(error => respond(sendResponse, failure(error?.code === "INVALID_SETTINGS" ? "INVALID_SETTINGS" : "STORAGE_UNAVAILABLE")));
      return true;
    }
    if (['VOSS_CHAT_STATE', 'VOSS_MEMORY_SAVE', 'VOSS_MEMORY_DELETE', 'VOSS_NEW_CHAT', 'VOSS_RESTORE_CHAT'].includes(message.type)) {
      if (message.type !== 'VOSS_CHAT_STATE') cancelAll();
      void getStore().then(async store => {
        const state = message.type === 'VOSS_CHAT_STATE' ? await store.read()
          : message.type === 'VOSS_MEMORY_SAVE' ? await store.saveMemory(message.memory, message.expected)
          : message.type === 'VOSS_MEMORY_DELETE' ? await store.deleteMemory(message.id, message.expected)
          : message.type === 'VOSS_RESTORE_CHAT' ? await store.restoreChat(message.sessionId, message.expected)
          : await store.newChat(message.expected);
        respond(sendResponse, { ok: true, state });
      }).catch(error => respond(sendResponse, safeFailure(error)));
      return true;
    }
    if (message.type === 'VOSS_CHAT') {
      if (typeof message.text !== 'string' || !message.text.trim() || message.text.length > 4000) { respond(sendResponse, failure('INVALID_CHAT')); return true; }
      let page = null;
      if (message.page != null) {
        const prepared = prepareContent(message.page);
        if (prepared.error || prepared.content.title.length > 6000 || prepared.content.author.length > 120 || prepared.content.description.length > 6000) { respond(sendResponse, failure('INVALID_CHAT')); return true; }
        page = prepared.content;
        if (message.page.comments !== undefined) {
          const comments = cleanComments(message.page.comments);
          if (!comments) { respond(sendResponse, failure('INVALID_CHAT')); return true; }
          if (comments.items.length) page.comments = comments;
        }
      }
      const images = message.images === undefined ? [] : message.images;
      if (!validImages(images)) { respond(sendResponse, failure('INVALID_IMAGES')); return true; }
      startChat(tabId, { requestId: message.requestId, text: message.text, expected: message.expected, page, images }, sendResponse);
      return true;
    }
    chatJobs.get(tabId)?.finish(failure('REPLACED'));
    const prepared = prepareContent(message.content);
    if (prepared.error) { respond(sendResponse, failure(prepared.error)); return true; }
    const mode = message.mode === undefined ? "together" : message.mode;
    if (!MODES.has(mode)) { respond(sendResponse, failure("INVALID_MODE")); return true; }
    analyze(tabId, message.requestId, prepared.content, mode, sendResponse);
    return true; // Keep sendResponse alive for the native process result.
  });

  chrome.tabs.onRemoved.addListener(tabId => cancelTab(tabId));
  chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.status !== "loading" && changeInfo.url === undefined) return;
    // A chat question is saved with the page it was about, so moving to the next
    // note in a single-page feed must not discard the reply. A real page unload
    // cancels from the content script's pagehide handler instead.
    if (!chatJobs.has(tabId)) cancelTab(tabId);
  });
  chrome.runtime.onSuspend.addListener(() => {
    cancelAll();
  });
})();
