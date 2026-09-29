(() => {
  "use strict";
  const app = globalThis.__VOSS_SCROLL__;
  if (!app) return;

  function start(adapter) {
    app.runtime?.destroy();
    let root = null;
    let candidates = [];
    let timer = null;
    let stopped = false;
    let needsDiscovery = true;
    let previous = "";
    let previousId = "";
    let currentItem = null;
    let activeRequest = null;
    let refreshPending = false;
    let rootObserver = null;
    let visibilityObserver = null;
    let discoveryObserver = null;
    let intersectionObserver = null;
    const listeners = [];
    const stats = { discoveries: 0, reads: 0, renders: 0 };
    const modelEnabled = typeof globalThis.chrome?.runtime?.sendMessage === "function";
    const chatEnabled = modelEnabled && app.chatEnabled === true;
    let chatState = null;
    let settings = { model: '', effort: 'low', vision: true, learn: true };
    const QUICK_PROMPT = '聊聊我正在看的这条：它在讲什么，有什么值得注意的地方？';
    const panel = app.createPanel({
      siteLabel: adapter.label, onRefresh: refresh, chatEnabled,
      onSend: text => sendChat(text),
      // Only this button shares the open note; typed messages are plain chat.
      onQuick: () => sendChat(QUICK_PROMPT, { withPage: true }),
      onCancel: () => cancelAnalysis("已停止，输入已保留。"),
      onMemorySave: memory => changeConversation('VOSS_MEMORY_SAVE', { memory }),
      onNewChat: () => changeConversation('VOSS_NEW_CHAT'),
      onRestore: sessionId => changeConversation('VOSS_RESTORE_CHAT', { sessionId }),
      onOpenSettings: () => loadSettings(true),
      onSettingsChange: saveSettings,
      onForget: id => changeConversation('VOSS_MEMORY_DELETE', { id })
    });

    function refresh() {
      refreshPending = true;
      schedule(true);
    }

    function refreshNow() {
      clearTimeout(timer);
      timer = null;
      needsDiscovery = true;
      refreshPending = true;
      update(true);
      return currentItem;
    }

    // Errors the panel can show as they are, with what to do next.
    const uiError = text => Object.assign(new Error(text), { userMessage: text });
    function connectionError(raw) {
      let stale;
      try { stale = !globalThis.chrome?.runtime?.id; } catch { stale = true; }
      const detail = String(raw?.message || raw || "");
      // After the extension is reloaded, pages opened earlier keep the old, disconnected panel.
      if (stale || /context invalidated/i.test(detail)) return uiError("扩展刚更新过，这个页面还连着旧版本。请刷新页面（Cmd + R）后再发；刷新前可以先复制输入框里的字。");
      if (/receiving end does not exist|could not establish connection/i.test(detail)) return uiError("扩展后台没有响应。请到 chrome://extensions 重新加载 Voss，再刷新这个页面。");
      if (/port closed before a response/i.test(detail)) return uiError("扩展后台中途断开了，输入已保留，请再发一次。");
      return uiError("扩展连接已断开，请刷新页面后重试。");
    }
    function sendMessage(message) {
      return new Promise((resolve, reject) => {
        try {
          const runtime = globalThis.chrome.runtime;
          if (!runtime?.id) { reject(connectionError()); return; }
          // Callback support also works on Chrome versions predating Promise replies.
          const pending = runtime.sendMessage(message, response => {
            const error = runtime.lastError;
            if (error) reject(connectionError(error));
            else resolve(response);
          });
          if (pending?.then) pending.then(resolve, error => reject(connectionError(error)));
        } catch (error) {
          reject(connectionError(error));
        }
      });
    }

    function cancelAnalysis(message = "") {
      const request = activeRequest;
      activeRequest = null;
      if (request) {
        clearTimeout(request.timer);
        void sendMessage({ type: "VOSS_CANCEL", requestId: request.id }).catch(() => {});
      }
      panel.setAnalysis({ state: "idle", text: message });
    }

    function acceptConversation(state) {
      if (stopped || !state || (chatState && state.revision < chatState.revision)) return;
      chatState = state; panel.setConversation(state);
    }
    async function loadConversation() {
      const response = await sendMessage({ type: 'VOSS_CHAT_STATE', requestId: crypto.randomUUID() });
      if (!response?.ok) throw uiError(response?.message || '无法读取聊天记录，请刷新页面后重试。');
      acceptConversation(response.state);
      return response.state;
    }
    async function changeConversation(type, values = {}) {
      cancelAnalysis();
      try {
        const expected = chatState || await loadConversation();
        const response = await sendMessage({ type, requestId: crypto.randomUUID(), expected: { revision: expected.revision, sessionId: expected.sessionId }, ...values });
        if (!response?.ok) { panel.setAnalysis({ state: 'error', text: response?.message || '聊天修改未保存。' }); await loadConversation(); return false; }
        acceptConversation(response.state); return true;
      } catch (error) { panel.setAnalysis({ state: 'error', text: error?.userMessage || '聊天修改未保存，请刷新后重试。' }); return false; }
    }
    async function loadSettings(fetch = false) {
      const response = await sendMessage({ type: 'VOSS_SETTINGS', requestId: crypto.randomUUID(), fetch });
      if (stopped) return;
      if (!response?.ok) { panel.setSettings({ status: response?.message || '暂时读不到可用模型，请稍后重试。' }); return; }
      if (response.settings) settings = response.settings;
      panel.setSettings({ settings: response.settings, models: response.models, status: response.models ? '' : (fetch ? '暂时读不到可用模型，请稍后重试。' : '') });
    }
    async function saveSettings(next) {
      const response = await sendMessage({ type: 'VOSS_SETTINGS_SAVE', requestId: crypto.randomUUID(), settings: next });
      if (stopped || !response?.ok) return false;
      settings = response.settings;
      panel.setSettings({ settings: response.settings, models: response.models });
      return true;
    }
    async function sendChat(text, { withPage = false } = {}) {
      if (stopped || !chatEnabled || typeof text !== 'string' || !text.trim()) return false;
      const item = withPage ? refreshNow() : null; cancelAnalysis();
      const captureRoot = root;
      const wantImages = Boolean(item?.images && settings.vision !== false && typeof adapter.captureImages === 'function' && captureRoot);
      const request = { id: crypto.randomUUID(), timer: null };
      activeRequest = request;
      // Read now, from the note that is open when the question is asked.
      const comments = item && typeof adapter.readComments === 'function' ? adapter.readComments(captureRoot) : null;
      const pageExtras = comments?.items.length ? { comments } : {};
      panel.showPending(text.trim(), wantImages ? item.images : 0, comments?.items.length || 0);
      panel.setAnalysis({ state: 'waiting', text: wantImages ? '正在准备笔记图片…' : '' });
      request.timer = setTimeout(() => { if (activeRequest === request) { cancelAnalysis(); panel.setAnalysis({ state: 'error', text: '等待回复超时，输入已保留。' }); } }, 105000);
      try {
        // Captured from the note that was open when the question was asked.
        const images = wantImages ? await adapter.captureImages(captureRoot).catch(() => []) : [];
        if (stopped || activeRequest !== request) return false;
        const state = await loadConversation();
        if (stopped || activeRequest !== request) return false;
        const reply = sendMessage({ type: 'VOSS_CHAT', requestId: request.id, text,
          expected: { revision: state.revision, sessionId: state.sessionId },
          page: item ? { title: item.title || '', author: item.author || '', description: item.description || '', ...pageExtras } : null,
          ...(images.length ? { images } : {}) });
        panel.setAnalysis({ state: 'generating' });
        const response = await reply;
        // The reply belongs to the question, not to whatever note is open now.
        if (stopped || activeRequest !== request) return false;
        if (!response?.ok) {
          panel.setAnalysis({ state: 'error', text: response?.message || '回复未完成，输入已保留。' });
          if (response?.code === 'CHAT_CHANGED') await loadConversation();
          return false;
        }
        panel.setAnalysis({ state: 'complete' });
        acceptConversation(response.state);
        if (response.learned?.length || response.forgotten?.length) panel.showLearned({ learned: response.learned || [], forgotten: response.forgotten || [] });
        return true;
      } catch (error) {
        if (!stopped && activeRequest === request) panel.setAnalysis({ state: 'error', text: error?.userMessage || '聊天连接中断，输入已保留，请重试。' });
        return false;
      } finally {
        clearTimeout(request.timer); if (activeRequest === request) activeRequest = null;
      }
    }

    const ownNode = node => (node.nodeType === 1 ? node : node.parentElement)?.closest?.("[data-voss-scroll]");
    function containsSelector(node, selector) {
      return node.nodeType === 1 && !ownNode(node) && (node.matches(selector) || Boolean(node.querySelector(selector)));
    }
    function fieldMutation(record) {
      if (ownNode(record.target)) return false;
      const target = record.target.nodeType === 1 ? record.target : record.target.parentElement;
      if (!target) return false;
      if (record.type === "attributes" && target === root) return true;
      if (target.closest(adapter.fieldSelector)) return true;
      if (record.type === "childList") {
        return [...record.addedNodes, ...record.removedNodes].some(node => containsSelector(node, adapter.fieldSelector));
      }
      return false;
    }
    function schedule(discover = false) {
      if (stopped) return;
      needsDiscovery ||= discover;
      if (document.hidden || timer !== null) return;
      // One trailing task per burst; continuous mutations cannot starve updates.
      timer = setTimeout(() => { timer = null; update(); }, 160);
    }
    function bindRoot(next) {
      if (next === root) return;
      rootObserver?.disconnect();
      root = next;
      if (!root) return;
      rootObserver = new MutationObserver(records => {
        if (records.some(fieldMutation)) schedule(false);
      });
      rootObserver.observe(root, {
        subtree: true, childList: true, characterData: true, attributes: true,
        attributeFilter: ["class", "style", "hidden", "aria-hidden", "aria-current", "data-id", "data-note-id", "data-video-id", "data-e2e", "href", "src"]
      });
    }
    function discover() {
      stats.discoveries++;
      candidates = [...new Set(adapter.getCandidates())].filter(node => node.isConnected && !ownNode(node));
      // Watch known candidates even when hidden: opacity/visibility changes do
      // not necessarily produce an IntersectionObserver geometry notification.
      visibilityObserver?.disconnect();
      visibilityObserver = new MutationObserver(() => schedule(false));
      const watched = new Set();
      for (const candidate of candidates) {
        for (let node = candidate; node && node !== document.documentElement; node = node.parentElement) {
          if (watched.has(node)) break;
          watched.add(node);
          visibilityObserver.observe(node, { attributes: true, attributeFilter: ["class", "style", "hidden", "aria-hidden", "aria-current", "data-e2e", "data-active", "data-state"] });
        }
      }
      if (intersectionObserver) {
        intersectionObserver.disconnect();
        for (const candidate of candidates) intersectionObserver.observe(candidate);
      }
      needsDiscovery = false;
    }
    function update(force = false) {
      if (stopped || (document.hidden && !force)) return;
      try {
        if (needsDiscovery) discover();
        bindRoot(adapter.pickRoot(candidates));
        stats.reads++;
        const item = root ? adapter.read(root) : null;
        const signature = JSON.stringify(item);
        currentItem = item;
        if (signature !== previous) {
          // Scrolling on while Voss replies is normal; the reply is kept.
          const switched = item && previousId && previousId !== item.id;
          previous = signature;
          previousId = item?.id || "";
          stats.renders++;
          panel.render(item);
          panel.setStatus(item ? (switched ? "换下一条了，页面文字已同步。" : "当前页面文字已同步。") : adapter.emptyMessage);
        } else if (refreshPending) {
          panel.setStatus(item ? "当前页面文字已同步。" : adapter.emptyMessage);
        }
        refreshPending = false;
      } catch (error) {
        currentItem = null;
        refreshPending = false;
        previous = "";
        panel.render(null);
        panel.setStatus("暂时无法识别这条内容。可以点「重新读取」重试。");
        console.warn("[Voss Scroll] 页面解析失败", error);
      }
    }
    function listen(target, event, handler, options) {
      target?.addEventListener(event, handler, options);
      if (target) listeners.push(() => target.removeEventListener(event, handler, options));
    }
    function attachDiscovery() {
      discoveryObserver = new MutationObserver(records => {
        const relevant = records.some(record => {
          if (ownNode(record.target)) return false;
          const target = record.target.nodeType === 1 ? record.target : record.target.parentElement;
          return [...record.addedNodes, ...record.removedNodes].some(node => {
            if (ownNode(node)) return false;
            if (root && node.nodeType === 1 && (node === root || node.contains(root))) return true;
            if (containsSelector(node, adapter.rootSelector)) return true;

            // A detail/player shell can arrive before its title or description.
            // In that case the shell is not a candidate yet; a later field
            // insertion must still trigger discovery without scanning the page.
            if (containsSelector(node, adapter.fieldSelector)) {
              return Boolean(
                target?.closest?.(adapter.rootSelector) ||
                (root && target?.contains?.(root))
              );
            }
            return false;
          });
        });
        if (relevant) schedule(true);
      });
      // Discovery observes structure only. Text and attributes are watched solely
      // inside the selected content and along its visibility ancestor chain.
      discoveryObserver.observe(document.body, { subtree: true, childList: true });
      if (globalThis.IntersectionObserver) {
        intersectionObserver = new IntersectionObserver(() => schedule(false), { threshold: [0, 0.25, 0.5, 0.75, 1] });
      }
    }
    const navigationChanged = () => schedule(true);
    listen(globalThis.navigation, "currententrychange", navigationChanged);
    listen(window, "popstate", navigationChanged);
    listen(window, "hashchange", navigationChanged);
    listen(window, "resize", () => schedule(false), { passive: true });
    listen(document, "scroll", event => { if (!ownNode(event.target)) schedule(false); }, { capture: true, passive: true });
    listen(document, "play", event => { if (event.target.tagName === "VIDEO") schedule(true); }, true);
    listen(document, "loadedmetadata", event => { if (event.target.tagName === "VIDEO") schedule(true); }, true);
    listen(document, "keydown", event => {
      if (["ArrowDown", "ArrowUp", "PageDown", "PageUp", "Escape"].includes(event.key) && !ownNode(event.target)) schedule(true);
    }, true);
    listen(document, "visibilitychange", () => {
      if (document.hidden) { clearTimeout(timer); timer = null; }
      else schedule(true);
    });
    // Preserve bfcache pages: disconnect while frozen and rebind on restoration.
    listen(window, "pagehide", () => {
      cancelAnalysis();
      clearTimeout(timer); timer = null;
      rootObserver?.disconnect(); visibilityObserver?.disconnect();
      discoveryObserver?.disconnect(); intersectionObserver?.disconnect();
    });
    listen(window, "pageshow", event => {
      if (event.persisted) { root = null; attachDiscovery(); schedule(true); }
    });
    const runtime = {
      stats,
      refresh,
      destroy() {
        cancelAnalysis();
        stopped = true;
        clearTimeout(timer);
        rootObserver?.disconnect(); visibilityObserver?.disconnect();
        discoveryObserver?.disconnect(); intersectionObserver?.disconnect();
        listeners.forEach(remove => remove());
        panel.destroy();
      }
    };
    app.runtime = runtime;
    attachDiscovery();
    update();
    if (chatEnabled) {
      void loadConversation().catch(error => { if (!stopped) panel.setAnalysis({ state: 'error', text: error?.userMessage || '暂时无法读取聊天记录，请刷新后重试。' }); });
      // Cached list only: opening a page must not start Codex.
      void loadSettings(false).catch(() => {});
    }
    return runtime;
  }
  app.start = start;
  const adapter = Object.values(app.adapters).find(site => site.matches(location.hostname));
  if (adapter) start(adapter);
})();
