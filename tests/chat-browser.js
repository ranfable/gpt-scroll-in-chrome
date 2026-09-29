(async () => {
  const results = document.querySelector('#results'), fixture = document.querySelector('#fixture');
  const log = [], requests = [], pending = new Map(); let passed = 0, failed = 0, runtime;
  let state = { schema: 1, revision: 0, sessionId: 'test-session', memory: '离线 Voss 背景', memories: [], messages: [], archives: [], droppedMessages: 0 };
  let settings = { model: '', effort: 'low' };
  const models = [{ id: 'gpt-a', name: 'GPT A', efforts: ['low', 'medium', 'high'], isDefault: true }, { id: 'gpt-b', name: 'GPT B', efforts: ['low'], isDefault: false }];
  const wait = (ms = 240) => new Promise(resolve => setTimeout(resolve, ms));
  const check = (name, ok) => { ok ? passed++ : failed++; log.push(`${ok ? 'PASS' : 'FAIL'} ${name}`); results.textContent = log.join('\n'); };
  const start = () => globalThis.__VOSS_SCROLL__.start(globalThis.__VOSS_SCROLL__.adapters.xiaohongshu);
  const $ = selector => document.querySelector(selector);
  const input = () => $('#vs-input');
  const submit = text => { input().value = text; $('#vs-compose').requestSubmit(); };
  const chats = () => requests.filter(item => item.type === 'VOSS_CHAT');
  const note = (id, title) => { fixture.innerHTML = `<div class="note-container" data-note-id="${id}"><h2 id="detail-title">${title}</h2><div id="detail-desc">测试正文</div></div>`; };
  const reply = (request, text, save = true) => {
    if (save) { state.messages.push({ role: 'user', text: request.text }, { role: 'assistant', text }); state.revision++; }
    pending.get(request.requestId)({ ok: true, text, model: 'offline-fixture', state: structuredClone(state) }); pending.delete(request.requestId);
  };
  try {
    let failNextSave = false;
    const fakeRuntime = { id: 'offline-test-extension', lastError: undefined, sendMessage(message, callback) {
      requests.push(structuredClone(message));
      if (message.type === 'VOSS_CHAT') { pending.set(message.requestId, callback); return; }
      if (message.type === 'VOSS_SETTINGS') { queueMicrotask(() => callback({ ok: true, settings: { ...settings }, models: message.fetch ? models : null })); return; }
      if (message.type === 'VOSS_SETTINGS_SAVE') {
        if (failNextSave) { failNextSave = false; queueMicrotask(() => callback({ ok: false, code: 'STORAGE_UNAVAILABLE', message: '未保存' })); return; }
        settings = { ...settings, ...message.settings }; queueMicrotask(() => callback({ ok: true, settings: { ...settings }, models })); return;
      }
      if (message.type === 'VOSS_MEMORY_SAVE') { state.memory = message.memory; state.revision++; }
      if (message.type === 'VOSS_MEMORY_DELETE') { state.memories = state.memories.filter(item => item.id !== message.id); state.revision++; }
      if (message.type === 'VOSS_NEW_CHAT') { state.archives.push({ sessionId: state.sessionId, messages: state.messages }); state.messages = []; state.sessionId = 'next-session'; state.revision++; }
      if (message.type === 'VOSS_RESTORE_CHAT') { const old = state.archives.find(item => item.sessionId === message.sessionId); state.messages = old.messages; state.sessionId = old.sessionId; state.archives = []; state.revision++; }
      queueMicrotask(() => callback?.({ ok: true, state: structuredClone(state) }));
    } };
    if (!globalThis.chrome) globalThis.chrome = {};
    Object.defineProperty(globalThis.chrome, 'runtime', { value: fakeRuntime, configurable: true });
    globalThis.__VOSS_SCROLL__.chatEnabled = true;
    note('64a111111111111111111111', '第一篇'); runtime = start(); await wait();
    check('输入框和背景可见；网页文案默认折叠', !!input() && !$('#vs-card').open && $('#vs-memory-input').value === '离线 Voss 背景');
    check('顶部模式按钮和旧的「看这条」按钮已移除', !document.querySelector('#voss-scroll-panel [data-mode]') && !$('#vs-eye'));
    check('折叠行显示正在看的标题', $('#vs-context-title').textContent === '第一篇');
    check('加载记忆不发送模型请求，打开页面不读取模型列表', chats().length === 0 && requests.some(item => item.type === 'VOSS_SETTINGS' && item.fetch === false) && !requests.some(item => item.type === 'VOSS_SETTINGS' && item.fetch));
    submit('我们刚才聊的是什么？'); await wait(40);
    check('打字发的消息是纯文字：不带笔记、不带图，也不由网页提供历史或记忆', chats().length === 1 && chats()[0].page === null && !('images' in chats()[0]) && !('memory' in chats()[0]) && !('history' in chats()[0]));
    check('等待时立刻显示问题和输入中气泡，发送键变为停止', document.querySelectorAll('#vs-chat-log .vs-pending').length === 2 && $('#vs-chat-log').textContent.includes('我们刚才聊的是什么？') && $('#vs-send').textContent === '停止');
    reply(chats().at(-1), '<img src=x onerror=alert(1)>这是回答'); await wait(40);
    check('回复进入聊天主体且作为纯文字显示', document.querySelectorAll('.vs-message').length === 2 && !$('#vs-chat-log img') && $('#vs-chat-log').textContent.includes('<img'));
    check('成功后清空输入、移除等待气泡、恢复发送键', input().value === '' && $('#vs-comment').hidden && !$('#vs-chat-log .vs-pending') && $('#vs-send').textContent === '发送');
    submit('再说短一点'); await wait(40); reply(chats().at(-1), '短一点的回答'); await wait(40);
    check('连续追问追加问答，不覆盖上一轮', document.querySelectorAll('.vs-message').length === 4);
    runtime.destroy(); runtime = start(); await wait();
    check('面板重建可恢复历史和背景', document.querySelectorAll('.vs-message').length === 4 && $('#vs-memory-input').value === '离线 Voss 背景');
    note('64a222222222222222222222', '第二篇'); await wait();
    check('换笔记更新引用但保留聊天', $('#vs-content-title').textContent === '第二篇' && document.querySelectorAll('.vs-message').length === 4);
    submit('这篇呢'); await wait(40); const during = chats().at(-1);
    note('64a333333333333333333333', '第三篇'); await wait();
    reply(during, '回答在换笔记后才到'); await wait(40);
    check('回复途中换笔记，回答仍然保留', document.querySelectorAll('.vs-message').length === 6 && $('#vs-chat-log').textContent.includes('回答在换笔记后才到'));
    $('#vs-quick').click(); await wait(40);
    check('「聊聊这条」带着当前页面发出一句提问', chats().at(-1).page.title === '第三篇' && chats().at(-1).text.includes('正在看的这条'));
    reply(chats().at(-1), '快捷回答'); await wait(40);
    submit('不要发完'); await wait(40); const old = chats().at(-1); $('#vs-send').click(); reply(old, '已取消的旧回答', false); await wait(40);
    check('停止保留草稿并丢弃晚到回复', input().value === '不要发完' && !$('#vs-chat-log').textContent.includes('已取消的旧回答') && requests.some(item => item.type === 'VOSS_CANCEL' && item.requestId === old.requestId));
    $('#vs-settings-toggle').click(); await wait(40);
    check('打开设置才读取模型列表并列出可选模型', !$('#vs-settings').hidden && requests.some(item => item.type === 'VOSS_SETTINGS' && item.fetch === true) && $('#vs-model').options.length === 3 && $('#vs-model').options[0].textContent.includes('GPT A'));
    const modelSelect = $('#vs-model'); modelSelect.value = 'gpt-b'; modelSelect.dispatchEvent(new Event('change')); await wait(40);
    check('换成只支持快速的模型时，思考深度自动回到快速', settings.model === 'gpt-b' && settings.effort === 'low' && $('#vs-effort').options.length === 1 && $('.vs-sub').textContent.includes('GPT B'));
    modelSelect.value = 'gpt-a'; modelSelect.dispatchEvent(new Event('change')); await wait(40);
    const effort = $('#vs-effort'); effort.value = 'high'; effort.dispatchEvent(new Event('change')); await wait(40);
    check('可以选择思考深度并提示生效时间', settings.model === 'gpt-a' && settings.effort === 'high' && $('#vs-settings-status').textContent.includes('下一句'));
    const memory = $('#vs-memory-input'); memory.value = '我喜欢简短回答'; memory.dispatchEvent(new Event('input')); $('#vs-memory-save').click(); await wait(40);
    check('背景保存成功有明确提示', state.memory === '我喜欢简短回答' && $('#vs-memory-status').textContent === '背景已保存');
    $('#vs-new-chat').click(); await wait(40);
    check('新聊天保留背景并归档旧对话', document.querySelectorAll('.vs-message').length === 0 && state.memory === '我喜欢简短回答' && $('#vs-archives').options.length === 2);
    check('空聊天提示说明「聊聊这条」的用法', $('#vs-chat-log .vs-empty')?.textContent.includes('聊聊这条'));
    const select = $('#vs-archives'); select.value = 'test-session'; select.dispatchEvent(new Event('change')); await wait(40);
    check('旧对话可以恢复', document.querySelectorAll('.vs-message').length === 8);
    fixture.replaceChildren(); await wait();
    check('没有识别到内容时「聊聊这条」不可点', $('#vs-quick').disabled);
    submit('没有网页也想聊'); await wait(40);
    check('无当前笔记仍可聊天', chats().at(-1).page === null);
    pending.get(chats().at(-1).requestId)({ ok: false, code: 'STORAGE_UNAVAILABLE', message: '未保存，请重试' }); await wait(40);
    check('保存失败显示错误、保留草稿并移除等待气泡', input().value === '没有网页也想聊' && $('#vs-comment').textContent === '未保存，请重试' && !$('#vs-comment').hidden && !$('#vs-chat-log .vs-pending'));
    // Vision: carousel slides are de-duplicated and ordered; nothing is downloaded here.
    const cdn = name => `https://voss-test.xhscdn.com/${name}.jpg`;
    const captured = [];
    globalThis.__VOSS_SCROLL__.utils.imageToJpeg = async ({ url }) => { captured.push(url); return 'data:image/jpeg;base64,' + btoa(url.split('/').pop()); };
    fixture.innerHTML = `<div class="note-container" data-note-id="64a444444444444444444444"><div class="media-container"><div class="note-slider"><div class="swiper-wrapper">
      <div class="swiper-slide swiper-slide-duplicate" data-swiper-slide-index="2" style="background: url(&quot;${cdn('three')}&quot;) center / contain"></div>
      <div class="swiper-slide" data-swiper-slide-index="0"><div class="note-slider-img"><img src="${cdn('one')}"></div></div>
      <div class="swiper-slide" data-swiper-slide-index="1"><div class="note-slider-img"><img src="${cdn('two')}"></div></div>
      <div class="swiper-slide" data-swiper-slide-index="2" style="background: url(&quot;${cdn('three')}&quot;) center / contain"></div>
      <div class="swiper-slide swiper-slide-duplicate" data-swiper-slide-index="0"><img src="${cdn('one')}"></div>
      <div class="swiper-slide" data-swiper-slide-index="3"><img src="https://evil.example.com/tracker.jpg"></div>
    </div></div></div><h2 id="detail-title">有图的笔记</h2><div id="detail-desc">正文 <img class="note-content-emoji" src="${cdn('emoji')}"></div>
    <div class="comments-container"><img src="${cdn('comment')}"></div></div>`;
    await wait();
    check('识别出 3 张笔记图，跳过重复、表情、评论图和非小红书图床', $('#vs-context-images').textContent === '📷 3' && !$('#vs-context-images').hidden);
    captured.length = 0; submit('这几张图拍的是什么？'); await wait(60);
    check('有图的笔记上打字聊天也不带图、不读取图片', chats().at(-1).page === null && !('images' in chats().at(-1)) && captured.length === 0);
    reply(chats().at(-1), '点「聊聊这条」给我看看'); await wait(40);
    $('#vs-quick').click(); await wait(60);
    const withImages = chats().at(-1);
    check('「聊聊这条」按顺序带上 3 张图和笔记', withImages.page?.title === '有图的笔记' && withImages.images?.length === 3 && withImages.images.map(url => atob(url.split(',')[1])).join(',') === 'one.jpg,two.jpg,three.jpg');
    check('等待气泡标出带了几张图', $('#vs-chat-log .vs-pending .vs-image-tag')?.textContent.includes('3'));
    state.messages.push({ role: 'user', text: withImages.text, images: 3 }, { role: 'assistant', text: '三张猫片' }); state.revision++;
    pending.get(withImages.requestId)({ ok: true, text: '三张猫片', model: 'offline-fixture', state: structuredClone(state) }); await wait(40);
    check('保存后的问题也标出带了图', [...document.querySelectorAll('.vs-message .vs-image-tag')].some(tag => tag.textContent.includes('3')));
    const visionSwitch = $('#vs-vision'), switchBox = visionSwitch.getBoundingClientRect();
    check('看图开关在站点重置 input 样式后仍可见，默认开启', switchBox.width >= 30 && switchBox.height >= 16 && visionSwitch.getAttribute('aria-checked') === 'true' && visionSwitch.getAttribute('role') === 'switch');
    visionSwitch.click(); await wait(60);
    check('关闭看图后设置已保存，开关显示为关，「正在看」不再显示图片数', settings.vision === false && visionSwitch.getAttribute('aria-checked') === 'false' && $('#vs-context-images').hidden);
    captured.length = 0; $('#vs-quick').click(); await wait(60);
    check('关闭看图后「聊聊这条」只带笔记文字，不读取图片', chats().at(-1).page?.title === '有图的笔记' && !('images' in chats().at(-1)) && captured.length === 0);
    reply(chats().at(-1), '好的');
    document.querySelector('label[for="vs-vision"]').click(); await wait(60);
    check('点文字也能重新打开看图', settings.vision === true && visionSwitch.getAttribute('aria-checked') === 'true');
    fixture.innerHTML = '<div class="note-container" data-note-id="64a555555555555555555555"><div class="media-container"><video></video><img src="' + cdn('poster') + '"></div><h2 id="detail-title">视频笔记</h2><div id="detail-desc">视频正文</div></div>';
    await wait();
    captured.length = 0; $('#vs-quick').click(); await wait(60);
    check('视频笔记「聊聊这条」不带图片', $('#vs-context-images').hidden && chats().at(-1).page?.title === '视频笔记' && !('images' in chats().at(-1)) && captured.length === 0);
    reply(chats().at(-1), '我看不到视频');
    // Long-term memory
    note('64a666666666666666666666', '记忆测试笔记'); await wait();
    const learnSwitch = $('#vs-learn'), learnBox = learnSwitch.getBoundingClientRect();
    check('「自动记住」开关可见且默认开启；记得的事为 0', learnBox.width >= 30 && learnSwitch.getAttribute('aria-checked') === 'true' && $('#vs-remembered-count').textContent === '0' && $('#vs-remembered-list').textContent.includes('还没有记住'));
    submit('以后回答短一点'); await wait(60);
    const learnChat = chats().at(-1);
    state.messages.push({ role: 'user', text: learnChat.text }, { role: 'assistant', text: '好的' });
    state.memories.push({ id: 'm-aaaaaa111', text: '用户希望回答简短', at: Date.now(), source: 'auto' }); state.revision++;
    pending.get(learnChat.requestId)({ ok: true, text: '好的', model: 'offline-fixture', state: structuredClone(state), learned: [{ id: 'm-aaaaaa111', text: '用户希望回答简短' }], forgotten: [] }); await wait(40);
    const memoryNote = [...document.querySelectorAll('#vs-chat-log .vs-memory-note')].find(item => item.textContent.includes('用户希望回答简短'));
    check('记住新事时聊天里出现「记住了」提示，设置里的列表同步更新', !!memoryNote && $('#vs-remembered-count').textContent === '1' && $('#vs-remembered-list').textContent.includes('用户希望回答简短'));
    memoryNote.querySelector('button').click(); await wait(60);
    check('点「撤销」会删掉这条记忆', state.memories.length === 0 && $('#vs-remembered-count').textContent === '0' && requests.some(item => item.type === 'VOSS_MEMORY_DELETE' && item.id === 'm-aaaaaa111') && $('#vs-comment').textContent.includes('已删掉'));
    state.memories.push({ id: 'm-bbbbbb222', text: '用户喜欢<b>雾粉色</b>', at: Date.now(), source: 'auto' }); state.revision++;
    submit('随便聊聊'); await wait(60);
    check('回复进行中不能删记忆', $('#vs-remembered-list .vs-remembered-remove').disabled && !$('#vs-remembered-list b'));
    reply(chats().at(-1), '好呀'); await wait(40);
    $('#vs-remembered-list .vs-remembered-remove').click(); await wait(60);
    check('设置里点 × 删掉一条记忆，文字按纯文本显示', state.memories.length === 0 && requests.some(item => item.type === 'VOSS_MEMORY_DELETE' && item.id === 'm-bbbbbb222'));
    const forgotChat = (submit('忘掉我喜欢猫'), await wait(60), chats().at(-1));
    state.messages.push({ role: 'user', text: forgotChat.text }, { role: 'assistant', text: '忘掉了' }); state.revision++;
    pending.get(forgotChat.requestId)({ ok: true, text: '忘掉了', model: 'offline-fixture', state: structuredClone(state), learned: [], forgotten: ['用户喜欢猫'] }); await wait(40);
    check('按要求忘掉时显示「已忘掉」', [...document.querySelectorAll('#vs-chat-log .vs-memory-note')].some(item => item.textContent.includes('已忘掉：用户喜欢猫')));
    learnSwitch.click(); await wait(60);
    check('可以关掉自动记住', settings.learn === false && learnSwitch.getAttribute('aria-checked') === 'false');
    // Appearance: theme, name, avatar and a roomier settings area
    const panelEl = $('#voss-scroll-panel');
    const settingsBox = $('#vs-settings').getBoundingClientRect(), bodyBox = $('#vs-body').getBoundingClientRect();
    check('设置区大约占侧栏一半', settingsBox.height >= bodyBox.height * 0.45);
    check('四个配色色块，默认雾粉', document.querySelectorAll('.vs-swatch').length === 4 && $('.vs-swatch[data-theme="rose"]').getAttribute('aria-checked') === 'true' && panelEl.dataset.theme === 'rose');
    $('.vs-swatch[data-theme="blue"]').click(); await wait(60);
    check('点雾蓝立刻换色并保存', panelEl.dataset.theme === 'blue' && settings.theme === 'blue' && getComputedStyle(panelEl).getPropertyValue('--vs-accent-strong').trim() === '#4c6379');
    failNextSave = true; $('.vs-swatch[data-theme="orange"]').click(); await wait(60);
    check('保存失败时配色退回原来的', panelEl.dataset.theme === 'blue' && settings.theme === 'blue' && $('#vs-appearance-status').textContent.includes('没有保存'));
    const nameField = $('#vs-name-input'), nameBox = nameField.getBoundingClientRect();
    check('名字输入框在站点重置 input 样式后仍可见', nameBox.width >= 100 && nameBox.height >= 20 && nameField.value === 'Voss');
    nameField.value = '阿狸'; nameField.dispatchEvent(new Event('change')); await wait(60);
    check('改名后标题、输入提示、聊天气泡都跟着变', settings.name === '阿狸' && $('.vs-title').textContent === '阿狸' && $('#vs-input').placeholder === '和 阿狸 说点什么…'
      && [...document.querySelectorAll('.vs-assistant .vs-speaker')].every(label => label.textContent === '阿狸') && $('#vs-remembered summary').textContent.startsWith('阿狸'));
    nameField.value = '<b>x</b>'; nameField.dispatchEvent(new Event('change')); await wait(60);
    check('名字里有 < > 时不保存', settings.name === '阿狸' && nameField.value === '阿狸');
    [...document.querySelectorAll('.vs-emoji')].find(button => button.textContent === '🐱').click(); await wait(60);
    check('选 emoji 头像后标题栏头像更新', $('.vs-avatar').textContent === '🐱' && settings.avatar?.kind === 'emoji' && settings.avatar.value === '🐱');
    // Connection errors say what to do.
    const workingRuntime = globalThis.chrome.runtime;
    Object.defineProperty(globalThis.chrome, 'runtime', { value: { ...workingRuntime, id: undefined }, configurable: true });
    submit('扩展更新后发消息'); await wait(60);
    check('页面没刷新时提示先刷新页面', $('#vs-comment').textContent.includes('刷新页面') && !$('#vs-chat-log .vs-pending') && input().value === '扩展更新后发消息');
    Object.defineProperty(globalThis.chrome, 'runtime', { value: { id: 'offline-test-extension', lastError: undefined, sendMessage(message, callback) {
      this.lastError = { message: 'Could not establish connection. Receiving end does not exist.' }; callback(undefined); this.lastError = undefined;
    } }, configurable: true });
    submit('后台没响应时发消息'); await wait(60);
    check('后台没响应时提示去重新加载扩展', $('#vs-comment').textContent.includes('chrome://extensions'));
    Object.defineProperty(globalThis.chrome, 'runtime', { value: workingRuntime, configurable: true });
    // Comments: the structure mirrors xiaohongshu.com (checked 2026-09-30).
    const commentItem = (text, likes, { author = false, sub = false, pinned = false } = {}) => `<div class="comment-item${sub ? ' comment-item-sub' : ''}"><div class="comment-inner-container">
      <div class="avatar"><a><img class="avatar-item" src="data:,"></a></div>
      <div class="right"><div class="author-wrapper"><div class="author"><a class="name">用户昵称${text.length}</a>${author ? '<span class="tag">作者</span>' : ''}</div></div>
      <div class="content"><span class="note-text"><span>${text}</span></span></div>
      ${pinned ? '<div class="labels"><span class="top">置顶评论</span></div>' : ''}
      <div class="info"><div class="date"><span>3 天前</span><span class="location">上海</span></div>
      <div class="interactions"><div class="like"><span class="like-wrapper"><span class="count">${likes}</span></span></div><div class="reply icon-container"><span class="count">回复</span></div></div></div></div></div></div>`;
    fixture.innerHTML = `<div class="note-container" data-note-id="64a888888888888888888888"><h2 id="detail-title">评论测试笔记</h2><div id="detail-desc">正文</div>
      <div class="comments-el"><div class="comments-container"><div class="total">共 128 条评论</div><div class="list-container">
        <div class="parent-comment">${commentItem('辣子鸡真的绝', '1.2万', { pinned: true })}<div class="reply-container"><div class="list-container">
          ${commentItem('同意', '12', { sub: true })}${commentItem('谢谢喜欢～', '赞', { sub: true, author: true })}${commentItem('第三条回复不带', '1', { sub: true })}
        </div><div class="show-more">展开 5 条回复</div></div></div>
        <div class="parent-comment">${commentItem('&lt;img src=x onerror=alert(1)&gt;排队太久了', '8')}</div>
      </div></div></div></div>`;
    await wait();
    check('「正在看」显示已加载的评论条数', $('#vs-context-comments').textContent === '💬 2' && !$('#vs-context-comments').hidden);
    submit('随口一问'); await wait(60);
    check('打字发的消息不带评论', chats().at(-1).page === null);
    reply(chats().at(-1), '好'); await wait(40);
    $('#vs-quick').click(); await wait(60);
    const withComments = chats().at(-1).page?.comments;
    check('「聊聊这条」带上评论：文字、点赞、置顶、作者回复，最多 2 条回复', withComments?.total === 128 && withComments.items.length === 2
      && withComments.items[0].text === '辣子鸡真的绝' && withComments.items[0].likes === '1.2万' && withComments.items[0].pinned === true
      && withComments.items[0].replies.length === 2 && withComments.items[0].replies[1].byAuthor === true && !('likes' in withComments.items[0].replies[1]));
    check('评论里不带用户名、日期或 IP 属地，页面里的 HTML 只当文字', !JSON.stringify(withComments).includes('用户昵称') && !JSON.stringify(withComments).includes('上海') && !JSON.stringify(withComments).includes('3 天前')
      && withComments.items[1].text === '<img src=x onerror=alert(1)>排队太久了');
    check('等待气泡标出带了几条评论', $('#vs-chat-log .vs-pending .vs-image-tag')?.textContent.includes('💬 2 条评论'));
    reply(chats().at(-1), '评论区都在夸 **辣子鸡**，但也有人嫌 **排队** 久'); await wait(40);
    const lastAnswer = [...document.querySelectorAll('.vs-message.vs-assistant .vs-text')].at(-1);
    check('回复里的 **加粗** 显示成加粗，不露出星号', lastAnswer.querySelectorAll('strong').length === 2 && !lastAnswer.textContent.includes('**') && lastAnswer.querySelector('strong').textContent === '辣子鸡');
  } catch (error) { failed++; log.push(`ERROR ${error.stack}`); }
  finally {
    runtime?.destroy(); results.textContent = `${passed} passed · ${failed} failed\n${log.join('\n')}`;
    document.title = `Voss 聊天测试：${passed} PASS / ${failed} FAIL`;
  }
})();
