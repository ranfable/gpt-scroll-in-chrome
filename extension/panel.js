(() => {
  "use strict";

  const voss = globalThis.__VOSS_SCROLL__ = globalThis.__VOSS_SCROLL__ || {};
  const EFFORT_LABELS = { low: "快速", medium: "平衡", high: "深入", xhigh: "更深入", max: "很深入", ultra: "最深入" };
  const THEMES = [["rose", "雾粉"], ["blue", "雾蓝"], ["green", "鼠尾草绿"], ["orange", "杏橙"]];
  const AVATAR_EMOJI = ["🦊", "🐱", "🐰", "🐻", "🐼", "🐶", "🐹", "🌙"];
  const DEFAULT_SETTINGS = Object.freeze({ model: "", effort: "low", vision: true, learn: true, theme: "rose", name: "Voss", avatar: Object.freeze({ kind: "emoji", value: "🦊" }) });

  voss.createPanel = function createPanel({ siteLabel = "", onRefresh, onSend, onQuick, onCancel, onMemorySave, onNewChat, onRestore, onOpenSettings, onSettingsChange, onForget, chatEnabled = false } = {}) {
    document.getElementById("voss-scroll-panel")?.remove();

    const panel = document.createElement("aside");
    panel.id = "voss-scroll-panel";
    panel.setAttribute("data-voss-scroll", "");
    panel.setAttribute("aria-label", "陪刷聊天");
    // This template is constant. Page-derived text is assigned only with textContent.
    panel.innerHTML = `
      <div class="vs-head">
        <div class="vs-brand">
          <span class="vs-avatar" aria-hidden="true">🦊</span>
          <div>
            <div class="vs-title vs-name">Voss</div>
            <div class="vs-sub"></div>
          </div>
        </div>
        <div class="vs-head-actions">
          <button id="vs-settings-toggle" class="vs-icon-button" type="button" aria-label="设置" aria-expanded="false" aria-controls="vs-settings">⚙︎</button>
          <button id="vs-collapse" class="vs-icon-button" type="button" aria-label="收起面板" aria-expanded="true" aria-controls="vs-body">—</button>
        </div>
      </div>
      <div id="vs-body" class="vs-body">
        <section id="vs-settings" class="vs-settings" hidden aria-label="设置">
          <h3 class="vs-section-title">外观</h3>
          <div class="vs-field"><span>配色</span><div class="vs-swatches" role="radiogroup" aria-label="配色"></div></div>
          <label class="vs-field"><span>名字</span><input id="vs-name-input" class="vs-text-input" type="text" maxlength="20" autocomplete="off" spellcheck="false"></label>
          <div class="vs-field vs-field-top"><span>头像</span>
            <div class="vs-avatar-picker">
              <div class="vs-emoji-row" role="group" aria-label="选一个头像"></div>
              <button id="vs-avatar-upload" class="vs-soft-button" type="button">上传图片</button>
              <input id="vs-avatar-file" type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden>
            </div>
          </div>
          <div id="vs-appearance-status" class="vs-small" role="status"></div>

          <h3 class="vs-section-title">模型</h3>
          <label class="vs-field"><span>模型</span><select id="vs-model"></select></label>
          <label class="vs-field"><span>思考深度</span><select id="vs-effort"></select></label>
          <div id="vs-settings-status" class="vs-small" role="status"></div>

          <h3 class="vs-section-title">看图与记忆</h3>
          <div class="vs-toggle">
            <label class="vs-toggle-text" for="vs-vision">让 <span class="vs-name">Voss</span> 看笔记图片<small class="vs-small">点「聊聊这条」时带上当前笔记最多 6 张图，更耗额度。</small></label>
            <button id="vs-vision" class="vs-switch" type="button" role="switch" aria-checked="true"><span class="vs-switch-knob" aria-hidden="true"></span></button>
          </div>
          <div class="vs-toggle">
            <label class="vs-toggle-text" for="vs-learn">自动记住关于你的事<small class="vs-small">从聊天里记下你的偏好和近况，随回复一起完成，不额外花额度。</small></label>
            <button id="vs-learn" class="vs-switch" type="button" role="switch" aria-checked="true"><span class="vs-switch-knob" aria-hidden="true"></span></button>
          </div>
          <details class="vs-memory" id="vs-remembered"><summary><span class="vs-name">Voss</span> 记得的事（<span id="vs-remembered-count">0</span>）</summary>
            <p class="vs-small">每次回复都会参考这些。点 × 删掉；也可以直接跟 <span class="vs-name">Voss</span> 说「忘掉……」。</p>
            <ul id="vs-remembered-list" class="vs-remembered-list"></ul>
          </details>
          <details class="vs-memory"><summary>你写给 <span class="vs-name">Voss</span> 的背景</summary>
            <p class="vs-small"><span class="vs-name">Voss</span> 每次回复都会参考这里。可以写你是谁、喜欢怎么聊天；不会自动同步 ChatGPT。</p>
            <textarea id="vs-memory-input" maxlength="6000" aria-label="背景记忆"></textarea>
            <button id="vs-memory-save" class="vs-soft-button" type="button">保存背景</button>
            <div id="vs-memory-status" class="vs-small" role="status"></div>
          </details>

          <h3 class="vs-section-title">聊天记录</h3>
          <div class="vs-chat-toolbar">
            <button id="vs-new-chat" class="vs-soft-button" type="button">新聊天</button>
            <select id="vs-archives" aria-label="打开旧聊天"><option value="">旧聊天</option></select>
            <button id="vs-export" class="vs-soft-button" type="button">导出</button>
          </div>
          <div id="vs-history-note" class="vs-small"></div>
        </section>
        <details id="vs-card" class="vs-card">
          <summary class="vs-context-summary"><span class="vs-context-label">正在看</span><span id="vs-context-title">还没有识别到内容</span><span id="vs-context-images" class="vs-image-count" hidden></span><span id="vs-context-comments" class="vs-image-count" hidden></span></summary>
          <div id="vs-status" role="status" aria-live="polite"></div>
          <div id="vs-current" hidden>
            <div id="vs-content-title"></div>
            <div id="vs-author" hidden></div>
            <div id="vs-description" hidden></div>
            <a id="vs-source" target="_blank" rel="noopener noreferrer" hidden>打开原内容 ↗</a>
          </div>
          <button id="vs-refresh" class="vs-link-button" type="button">重新读取</button>
        </details>
        <div id="vs-chat-log" role="log" aria-label="与 Voss 的聊天"></div>
        <div id="vs-comment" class="vs-comment" role="status" aria-live="polite" hidden></div>
        <form id="vs-compose">
          <button id="vs-quick" class="vs-quick" type="button">👀 聊聊这条</button>
          <div class="vs-compose-row">
            <textarea id="vs-input" maxlength="4000" rows="2" aria-label="发给 Voss 的话" placeholder="和 Voss 说点什么…"></textarea>
            <button id="vs-send" type="submit">发送</button>
          </div>
        </form>
        <div class="vs-model-note" hidden>未连接模型 · 仅同步页面文字</div>
      </div>
    `;

    const find = selector => panel.querySelector(selector);
    const subtitle = find(".vs-sub");
    const body = find(".vs-body");
    const collapse = find("#vs-collapse");
    const settingsToggle = find("#vs-settings-toggle");
    const settingsPanel = find("#vs-settings");
    const modelSelect = find("#vs-model");
    const effortSelect = find("#vs-effort");
    const visionToggle = find("#vs-vision");
    const learnToggle = find("#vs-learn");
    const rememberedList = find("#vs-remembered-list");
    const contextImages = find("#vs-context-images");
    const contextComments = find("#vs-context-comments");
    const settingsStatus = find("#vs-settings-status");
    const card = find("#vs-card");
    const contextTitle = find("#vs-context-title");
    const status = find("#vs-status");
    const current = find("#vs-current");
    const title = find("#vs-content-title");
    const author = find("#vs-author");
    const description = find("#vs-description");
    const source = find("#vs-source");
    const comment = find("#vs-comment");
    const chatLog = find("#vs-chat-log");
    const input = find("#vs-input");
    const send = find("#vs-send");
    const quick = find("#vs-quick");
    let conversation = null, memoryDirty = false, busy = false;
    let settings = { ...DEFAULT_SETTINGS }, models = null, currentImages = 0, currentComments = 0;
    const nameInput = find("#vs-name-input");
    const avatarFile = find("#vs-avatar-file");
    const appearanceStatus = find("#vs-appearance-status");
    const swatches = THEMES.map(([theme, label]) => {
      const swatch = document.createElement("button");
      swatch.type = "button"; swatch.className = "vs-swatch"; swatch.dataset.theme = theme;
      swatch.setAttribute("role", "radio"); swatch.setAttribute("aria-label", label); swatch.title = label;
      find(".vs-swatches").appendChild(swatch);
      return swatch;
    });
    const emojiButtons = AVATAR_EMOJI.map(emoji => {
      const button = document.createElement("button");
      button.type = "button"; button.className = "vs-emoji"; button.textContent = emoji;
      button.setAttribute("aria-label", `用 ${emoji} 当头像`);
      find(".vs-emoji-row").appendChild(button);
      return button;
    });

    // Outside the extension (offline test pages) only page reading is available.
    find("#vs-compose").hidden = !chatEnabled;
    chatLog.hidden = !chatEnabled;
    settingsToggle.hidden = !chatEnabled;
    find(".vs-model-note").hidden = chatEnabled;
    card.open = !chatEnabled;
    panel.classList.toggle("vs-with-chat", chatEnabled);

    function modelName(id) {
      if (!id) {
        const fallback = models?.find(item => item.isDefault);
        return fallback ? fallback.name : "默认模型";
      }
      return models?.find(item => item.id === id)?.name || id;
    }
    const displayName = () => settings.name || "Voss";
    function renderAppearance() {
      panel.dataset.theme = settings.theme;
      for (const swatch of swatches) swatch.setAttribute("aria-checked", String(swatch.dataset.theme === settings.theme));
      for (const node of panel.querySelectorAll(".vs-name")) node.textContent = displayName();
      panel.setAttribute("aria-label", `${displayName()} 陪刷聊天`);
      chatLog.setAttribute("aria-label", `与 ${displayName()} 的聊天`);
      input.placeholder = `和 ${displayName()} 说点什么…`;
      input.setAttribute("aria-label", `发给 ${displayName()} 的话`);
      if (document.activeElement !== nameInput) nameInput.value = displayName();
      const avatar = find(".vs-avatar");
      avatar.replaceChildren();
      if (settings.avatar?.kind === "image") {
        const img = document.createElement("img");
        img.alt = ""; img.src = settings.avatar.data;
        // Some sites block data: images; fall back to the fox.
        img.addEventListener("error", () => { avatar.textContent = "🦊"; }, { once: true });
        avatar.appendChild(img);
      } else avatar.textContent = settings.avatar?.value || "🦊";
      for (const button of emojiButtons) button.setAttribute("aria-pressed", String(settings.avatar?.kind === "emoji" && settings.avatar.value === button.textContent));
      for (const label of chatLog.querySelectorAll(".vs-assistant .vs-speaker")) label.textContent = displayName();
    }
    // Applied at once, saved in the background, and undone if saving fails.
    async function saveAppearance(change, done = "已保存") {
      const previous = settings;
      settings = { ...settings, ...change };
      renderAppearance();
      appearanceStatus.textContent = "正在保存…";
      const saved = await Promise.resolve(onSettingsChange?.(change)).catch(() => false);
      if (!saved) { settings = previous; renderAppearance(); }
      appearanceStatus.textContent = saved ? done : "没有保存，请再试一次。";
    }
    for (const swatch of swatches) swatch.addEventListener("click", () => { if (swatch.dataset.theme !== settings.theme) void saveAppearance({ theme: swatch.dataset.theme }, `已换成${swatch.title}`); });
    for (const button of emojiButtons) button.addEventListener("click", () => void saveAppearance({ avatar: { kind: "emoji", value: button.textContent } }, "头像已换好"));
    function commitName() {
      const value = nameInput.value.trim();
      if (!value || value === settings.name) { nameInput.value = displayName(); return; }
      if (/[<>\u0000-\u001f]/.test(value)) { appearanceStatus.textContent = "名字里不能有 < > 这类符号。"; nameInput.value = displayName(); return; }
      void saveAppearance({ name: value }, `以后叫「${value}」啦`);
    }
    nameInput.addEventListener("change", commitName);
    nameInput.addEventListener("keydown", event => {
      // Keys typed here belong to the panel, not to the site's shortcuts.
      event.stopPropagation();
      if (event.key === "Enter" && !event.isComposing) { event.preventDefault(); nameInput.blur(); }
      if (event.key === "Escape") { nameInput.value = displayName(); nameInput.blur(); }
    });
    find("#vs-avatar-upload").addEventListener("click", () => avatarFile.click());
    avatarFile.addEventListener("change", async () => {
      const file = avatarFile.files?.[0];
      avatarFile.value = "";
      if (!file) return;
      try {
        const data = await squareAvatar(file);
        await saveAppearance({ avatar: { kind: "image", data } }, "头像已换好");
      } catch { appearanceStatus.textContent = "这张图读不了，换一张试试。"; }
    });
    // Crops to a centred square and shrinks to 128px, small enough to store.
    async function squareAvatar(file) {
      if (!/^image\//.test(file.type) || file.size > 15 * 1024 * 1024) throw new Error("not an image");
      const bitmap = await createImageBitmap(file);
      const side = Math.min(bitmap.width, bitmap.height);
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 128;
      canvas.getContext("2d").drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, 128, 128);
      bitmap.close?.();
      let data = canvas.toDataURL("image/png");
      if (data.length > 190_000) data = canvas.toDataURL("image/jpeg", 0.85);
      return data;
    }
    function renderSubtitle() {
      subtitle.textContent = [siteLabel, chatEnabled ? modelName(settings.model) : "", `v${voss.version}`].filter(Boolean).join(" · ");
    }
    function renderSettings() {
      const selectedModel = settings.model;
      modelSelect.replaceChildren(new Option(`默认（${modelName("")}）`, ""));
      for (const item of models || []) modelSelect.appendChild(new Option(item.name, item.id));
      if (selectedModel && !models?.some(item => item.id === selectedModel)) modelSelect.appendChild(new Option(selectedModel, selectedModel));
      modelSelect.value = selectedModel;
      const target = selectedModel ? models?.find(item => item.id === selectedModel) : models?.find(item => item.isDefault);
      const efforts = target?.efforts || Object.keys(EFFORT_LABELS);
      effortSelect.replaceChildren(...efforts.map(effort => new Option(`${EFFORT_LABELS[effort] || effort}（${effort}）`, effort)));
      if (!efforts.includes(settings.effort)) effortSelect.appendChild(new Option(settings.effort, settings.effort));
      effortSelect.value = settings.effort;
      visionToggle.setAttribute("aria-checked", String(settings.vision !== false));
      learnToggle.setAttribute("aria-checked", String(settings.learn !== false));
      renderImageCount();
      renderAppearance();
      renderSubtitle();
    }
    function setSettings(next = {}) {
      if (next.settings) {
        const given = next.settings;
        settings = {
          model: given.model || "", effort: given.effort || "low", vision: given.vision !== false, learn: given.learn !== false,
          theme: THEMES.some(([theme]) => theme === given.theme) ? given.theme : "rose",
          name: typeof given.name === "string" && given.name ? given.name : "Voss",
          avatar: given.avatar?.kind === "image" || given.avatar?.kind === "emoji" ? given.avatar : DEFAULT_SETTINGS.avatar
        };
      }
      if (Array.isArray(next.models)) models = next.models;
      renderSettings();
      if (typeof next.status === "string") settingsStatus.textContent = next.status;
    }
    async function changeSettings() {
      let effort = effortSelect.value;
      const model = modelSelect.value;
      const target = model ? models?.find(item => item.id === model) : models?.find(item => item.isDefault);
      // A newly picked model may not support the previous depth.
      if (target && !target.efforts.includes(effort)) effort = target.efforts.includes("low") ? "low" : target.efforts[0];
      modelSelect.disabled = effortSelect.disabled = visionToggle.disabled = learnToggle.disabled = true;
      settingsStatus.textContent = "正在保存…";
      try {
        const saved = await onSettingsChange?.({ model, effort, vision: visionToggle.getAttribute("aria-checked") === "true", learn: learnToggle.getAttribute("aria-checked") === "true" });
        settingsStatus.textContent = saved ? "已保存，下一句开始生效。越深入越慢，也更耗额度。" : "没有保存，请重新选择。";
      } catch {
        settingsStatus.textContent = "没有保存，请重新选择。";
      } finally {
        modelSelect.disabled = effortSelect.disabled = visionToggle.disabled = learnToggle.disabled = false;
        renderSettings();
      }
    }
    modelSelect.addEventListener("change", changeSettings);
    effortSelect.addEventListener("change", changeSettings);
    // Styled buttons, not checkboxes: some sites reset every <input> to zero size.
    for (const toggle of [visionToggle, learnToggle]) {
      toggle.addEventListener("click", () => {
        toggle.setAttribute("aria-checked", String(toggle.getAttribute("aria-checked") !== "true"));
        void changeSettings();
      });
    }
    async function forget(id, button) {
      button.disabled = true;
      const ok = await Promise.resolve(onForget?.(id)).catch(() => false);
      if (ok) setAnalysis({ state: "idle", text: `已删掉，${displayName()} 不会再参考这条。` });
      else button.disabled = false;
    }
    function renderRemembered(memories = []) {
      find("#vs-remembered-count").textContent = String(memories.length);
      rememberedList.replaceChildren();
      if (!memories.length) {
        const empty = document.createElement("li"); empty.className = "vs-small vs-remembered-empty";
        empty.textContent = `还没有记住什么。聊天时 ${displayName()} 会记下关于你的事。`;
        rememberedList.appendChild(empty);
        return;
      }
      for (const item of [...memories].reverse()) {
        const row = document.createElement("li");
        const text = document.createElement("span"); text.className = "vs-remembered-text"; text.textContent = item.text;
        const remove = document.createElement("button"); remove.type = "button"; remove.className = "vs-remembered-remove";
        remove.textContent = "×"; remove.setAttribute("aria-label", `删掉：${item.text}`); remove.disabled = busy;
        remove.addEventListener("click", () => forget(item.id, remove));
        row.append(text, remove);
        rememberedList.appendChild(row);
      }
    }
    // Shown after a reply; not saved, so it disappears with the next message.
    function showLearned({ learned = [], forgotten = [] } = {}) {
      for (const item of learned) {
        const note = document.createElement("div"); note.className = "vs-memory-note";
        const text = document.createElement("span"); text.textContent = `📝 记住了：${item.text}`;
        const undo = document.createElement("button"); undo.type = "button"; undo.className = "vs-link-button"; undo.textContent = "撤销";
        undo.addEventListener("click", () => forget(item.id, undo));
        note.append(text, undo);
        chatLog.appendChild(note);
      }
      for (const text of forgotten) {
        const note = document.createElement("div"); note.className = "vs-memory-note"; note.textContent = `🗑 已忘掉：${text}`;
        chatLog.appendChild(note);
      }
      chatLog.scrollTop = chatLog.scrollHeight;
    }
    function renderImageCount() {
      const shown = chatEnabled && settings.vision !== false && currentImages > 0;
      contextImages.hidden = !shown;
      contextImages.textContent = shown ? `📷 ${currentImages}` : "";
      contextImages.title = shown ? `点「聊聊这条」时会带上这 ${currentImages} 张图` : "";
      const withComments = chatEnabled && currentComments > 0;
      contextComments.hidden = !withComments;
      contextComments.textContent = withComments ? `💬 ${currentComments}` : "";
      contextComments.title = withComments ? `点「聊聊这条」时会带上已加载的 ${currentComments} 条评论` : "";
    }
    settingsToggle.addEventListener("click", () => {
      settingsPanel.hidden = !settingsPanel.hidden;
      settingsToggle.setAttribute("aria-expanded", String(!settingsPanel.hidden));
      settingsToggle.classList.toggle("active", !settingsPanel.hidden);
      if (!settingsPanel.hidden) {
        if (!models) settingsStatus.textContent = "正在读取可用模型…";
        void Promise.resolve(onOpenSettings?.()).catch(() => { settingsStatus.textContent = "暂时读不到可用模型，请稍后重试。"; });
      }
    });

    find("#vs-memory-input").addEventListener("input", () => { memoryDirty = true; });
    const control = async (button, callback) => {
      button.disabled = true;
      try { await callback?.(); } catch { setAnalysis({ state: "error", text: "操作未完成，请重试。" }); }
      finally { button.disabled = false; }
    };
    find("#vs-memory-save").addEventListener("click", () => control(find("#vs-memory-save"), async () => {
      find("#vs-memory-status").textContent = "正在保存…";
      const ok = await onMemorySave?.(find("#vs-memory-input").value);
      if (ok) memoryDirty = false;
      find("#vs-memory-status").textContent = ok ? "背景已保存" : "未保存，请检查提示后重试";
    }));
    find("#vs-new-chat").addEventListener("click", () => control(find("#vs-new-chat"), onNewChat));
    find("#vs-archives").addEventListener("change", event => { if (event.target.value) void onRestore?.(event.target.value); });
    find("#vs-export").addEventListener("click", () => {
      if (!conversation) return;
      const url = URL.createObjectURL(new Blob([JSON.stringify(conversation, null, 2)], { type: "application/json" }));
      const link = document.createElement("a"); link.href = url; link.download = "voss-chat.json"; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    });

    find("#vs-compose").addEventListener("submit", async event => {
      event.preventDefault();
      if (busy) { onCancel?.(); return; }
      if (!input.value.trim()) return;
      const draft = input.value;
      const ok = await onSend?.(draft);
      if (ok && input.value === draft) input.value = "";
    });
    input.addEventListener("keydown", event => {
      // Keys typed here belong to the chat, not to the site's feed shortcuts.
      event.stopPropagation();
      if (event.key === "Enter" && !event.shiftKey && !event.isComposing) { event.preventDefault(); if (!busy) find("#vs-compose").requestSubmit(); }
    });
    quick.addEventListener("click", () => { if (!busy) void Promise.resolve(onQuick?.()).catch(() => setAnalysis({ state: "error" })); });

    // Plain text, except **bold** becomes <strong>; built from text nodes, never HTML.
    function fillText(element, text) {
      const parts = String(text).split(/\*\*([^*\n]+?)\*\*/g);
      element.replaceChildren(...parts.map((part, index) => {
        if (index % 2 === 0) return document.createTextNode(part);
        const strong = document.createElement("strong"); strong.textContent = part; return strong;
      }));
    }
    function bubble(role, text, extraClass = "", images = 0, comments = 0) {
      const item = document.createElement("div");
      item.className = `${extraClass || "vs-message"} vs-${role}`;
      const label = document.createElement("div"); label.className = "vs-small vs-speaker"; label.textContent = role === "user" ? "你" : displayName();
      const content = document.createElement("div"); content.className = "vs-text";
      if (role === "user") content.textContent = text; else fillText(content, text);
      item.append(label, content);
      const shared = [images > 0 ? `📷 ${images} 张图` : "", comments > 0 ? `💬 ${comments} 条评论` : ""].filter(Boolean);
      if (shared.length) {
        const tag = document.createElement("div"); tag.className = "vs-small vs-image-tag"; tag.textContent = `带了 ${shared.join(" · ")}`;
        item.appendChild(tag);
      }
      return item;
    }
    function clearPending() { for (const node of chatLog.querySelectorAll(".vs-pending")) node.remove(); }
    // Shows the question at once; the saved conversation replaces it on reply.
    function showPending(text, images = 0, comments = 0) {
      clearPending();
      chatLog.querySelector(".vs-empty")?.remove();
      chatLog.append(bubble("user", text, "vs-pending", images, comments), bubble("assistant", "…", "vs-pending vs-typing"));
      chatLog.scrollTop = chatLog.scrollHeight;
    }
    function setConversation(state) {
      if (!state) return;
      // Reloading saved history while a reply is on its way keeps the waiting bubbles.
      const waiting = busy ? [...chatLog.querySelectorAll(".vs-pending")] : [];
      conversation = state; chatLog.replaceChildren();
      for (const item of state.messages || []) chatLog.appendChild(bubble(item.role === "user" ? "user" : "assistant", item.text, "", item.role === "user" && Number.isInteger(item.images) ? item.images : 0, item.role === "user" && Number.isInteger(item.comments) ? item.comments : 0));
      chatLog.append(...waiting);
      if (!state.messages?.length && !waiting.length) {
        const empty = document.createElement("div"); empty.className = "vs-empty";
        empty.textContent = "我在这里。点「聊聊这条」让我看看你在看什么，或者直接跟我聊。";
        chatLog.appendChild(empty);
      }
      if (!memoryDirty) find("#vs-memory-input").value = state.memory || "";
      renderRemembered(state.memories || []);
      const archives = find("#vs-archives"); archives.replaceChildren(new Option("旧聊天", ""));
      for (const old of [...(state.archives || [])].reverse()) archives.appendChild(new Option(old.messages?.[0]?.text?.slice(0, 24) || "旧聊天", old.sessionId));
      find("#vs-history-note").textContent = "本机保留最近 100 条消息与 5 段旧聊天；回复参考最近的记录。卸载扩展前可以导出。";
      chatLog.scrollTop = chatLog.scrollHeight;
    }

    collapse.addEventListener("click", () => {
      body.hidden = !body.hidden;
      panel.classList.toggle("vs-collapsed", body.hidden);
      collapse.textContent = body.hidden ? "+" : "—";
      collapse.setAttribute("aria-expanded", String(!body.hidden));
      collapse.setAttribute("aria-label", body.hidden ? "展开面板" : "收起面板");
    });

    function setStatus(message = "") {
      status.textContent = String(message);
      status.hidden = !message;
    }

    function setAnalysis({ state = "idle", text = "" } = {}) {
      busy = state === "waiting" || state === "generating";
      comment.dataset.state = state;
      const message = text || ({ waiting: "正在连接…", generating: `${displayName()} 正在想…`, error: "暂时没能回复，请稍后重试。" })[state] || "";
      // Progress is shown by the typing bubble; the status line is for notices.
      comment.textContent = state === "generating" ? "" : message;
      comment.hidden = state === "generating" || state === "complete" || !comment.textContent;
      if (!busy) clearPending();
      send.textContent = busy ? "停止" : "发送";
      send.setAttribute("aria-label", busy ? "停止这次回复" : "发送");
      send.classList.toggle("vs-stop", busy);
      // Deleting a memory mid-reply would cancel it, so wait until it is done.
      for (const button of rememberedList.querySelectorAll(".vs-remembered-remove")) button.disabled = busy;
      quick.disabled = busy;
    }

    function render(item) {
      title.textContent = "";
      author.textContent = "";
      description.textContent = "";
      source.removeAttribute("href");
      source.hidden = true;
      author.hidden = true;
      description.hidden = true;
      current.hidden = !item;
      quick.disabled = busy || !item;
      currentImages = Number.isInteger(item?.images) ? item.images : 0;
      currentComments = Number.isInteger(item?.comments) ? item.comments : 0;
      renderImageCount();
      if (!item) {
        contextTitle.textContent = "还没有识别到内容";
        setStatus("还没有识别到当前内容，请打开一条笔记或视频。");
        return;
      }

      setStatus("");
      const heading = item.title || (item.description ? "当前内容" : "页面暂未提供标题或文案");
      title.textContent = heading;
      contextTitle.textContent = item.title || item.description || heading;
      author.textContent = item.author ? `作者：${item.author}` : "";
      author.hidden = !item.author;
      description.textContent = item.description || "";
      description.hidden = !item.description || item.description === item.title;
      if (item.url) {
        try {
          const url = new URL(item.url, location.href);
          if (url.protocol === "https:" || url.protocol === "http:") {
            source.href = url.href;
            source.hidden = false;
          }
        } catch {
          // A malformed page URL is not a usable content link.
        }
      }
    }

    find("#vs-refresh").addEventListener("click", () => {
      setStatus("正在重新读取当前内容……");
      try {
        Promise.resolve(onRefresh?.()).catch(() => {
          render(null);
          setStatus("暂时无法读取当前内容，请稍后再试。");
        });
      } catch {
        render(null);
        setStatus("暂时无法读取当前内容，请稍后再试。");
      }
    });

    render(null);
    renderAppearance();
    renderSubtitle();
    (document.body || document.documentElement).appendChild(panel);
    return { render, setStatus, setAnalysis, setConversation, setSettings, showPending, showLearned, destroy: () => panel.remove() };
  };
})();
