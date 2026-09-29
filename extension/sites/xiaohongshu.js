(() => {
  "use strict";
  const app = globalThis.__VOSS_SCROLL__;
  const u = app.utils;

  // These detail-page selectors need signed-in live-site verification after
  // site updates. Feed-card titles, navigation and comment authors are excluded.
  const INNER_ROOTS = [
    '.note-detail-mask .note-container', '.note-detail-container',
    '[data-testid="note-detail"]', '.note-container', '#noteContainer'
  ];
  const ROOTS = [...INNER_ROOTS, '.note-detail-mask'];
  const TITLES = ['#detail-title', '[data-testid="note-title"]', '.note-content .title', '.note-content h1'];
  const DESCRIPTIONS = ['#detail-desc', '[data-testid="note-desc"]', '.note-content .desc'];
  const AUTHORS = [
    '.author-container .username', '.author-wrapper .username',
    '[data-testid="note-author-name"]', '.note-author .username',
    '.author-container .name', '.author-container a[href*="/user/profile/"] .name',
    '.author-container a[href*="/user/profile/"]'
  ];
  // Body/comment links may refer to another note. Only explicit permalinks
  // can identify the current note when the route has no note ID.
  const LINKS = ['a[data-testid="note-permalink"]', 'a[data-e2e="note-permalink"]', 'a[rel="canonical"]'];
  const CONTENT = [...TITLES, ...DESCRIPTIONS].join(',');
  // Note pictures live in the media carousel. Loop duplicates share a slide
  // index; emoji, avatars and comment pictures sit outside .media-container.
  const MEDIA = '.media-container';
  const MEDIA_IMAGES = '.media-container .swiper-slide img, .media-container .note-slider-img img';
  const MAX_IMAGES = 6;
  // Comments that the page has already loaded. Only the words, like counts and
  // "author"/"pinned" marks are read: no names, avatars, dates or IP locations.
  const COMMENT_ITEMS = '.comments-container .parent-comment';
  const MAX_COMMENTS = 20;
  const MAX_REPLIES = 2;
  const rootSelector = ROOTS.join(',');

  function routeInfo(href = location.href) {
    try {
      const url = new URL(href, location.href);
      if (!/(^|\.)xiaohongshu\.com$/i.test(url.hostname)) return { id: '', url: '' };
      const id = url.pathname.match(/^\/(?:explore|discovery\/item|search_result)\/([^/?#]+)/)?.[1] || '';
      return { id, url: id ? u.safeUrl(url.href) : '' };
    } catch { return { id: '', url: '' }; }
  }

  function cdnUrl(value) {
    try {
      const url = new URL(value || '', location.href);
      return url.protocol === 'https:' && /(^|\.)xhscdn\.com$/i.test(url.hostname) ? url.href : '';
    } catch { return ''; }
  }
  function backgroundUrl(element) {
    const style = element.style?.backgroundImage || element.style?.background || '';
    return style.match(/url\(["']?([^"')]+)["']?\)/)?.[1] || '';
  }
  function imageSources(root) {
    const media = root.querySelector(MEDIA);
    // Video notes have no picture carousel; the video itself is not captured.
    if (!media || media.querySelector('video')) return [];
    const bySlide = new Map();
    [...media.querySelectorAll('.swiper-slide')].forEach((slide, order) => {
      const index = Number(slide.getAttribute('data-swiper-slide-index'));
      const key = Number.isInteger(index) ? index : order;
      const duplicate = slide.classList.contains('swiper-slide-duplicate');
      if (bySlide.has(key) && duplicate) return;
      const img = slide.querySelector('img');
      const url = cdnUrl(img?.currentSrc || img?.getAttribute('src')) || cdnUrl(backgroundUrl(slide));
      if (url) bySlide.set(key, { img, url, key });
    });
    let sources = [...bySlide.values()].sort((a, b) => a.key - b.key);
    if (!sources.length) {
      sources = [...media.querySelectorAll('img')].map(img => ({ img, url: cdnUrl(img.currentSrc || img.getAttribute('src')) })).filter(item => item.url);
    }
    return sources.slice(0, MAX_IMAGES);
  }
  function likeCount(item) {
    const value = u.normalize(item.querySelector(':scope > .comment-inner-container .interactions .like .count')?.textContent || '', 12);
    return /^[\d.,]+[万wWkK]?$/.test(value) ? value : '';
  }
  function commentOf(item) {
    const text = u.normalize(item.querySelector(':scope > .comment-inner-container .content .note-text')?.innerText || '', 300);
    if (!text) return null;
    const comment = { text };
    const likes = likeCount(item);
    if (likes) comment.likes = likes;
    if ([...item.querySelectorAll(':scope > .comment-inner-container .author .tag')].some(tag => tag.textContent.trim() === '作者')) comment.byAuthor = true;
    return comment;
  }
  function readComments(root) {
    const items = [];
    for (const parent of root.querySelectorAll(COMMENT_ITEMS)) {
      if (items.length >= MAX_COMMENTS) break;
      const main = parent.querySelector(':scope > .comment-item');
      const comment = main && commentOf(main);
      if (!comment) continue;
      if (main.querySelector('.labels .top')?.textContent.includes('置顶')) comment.pinned = true;
      const replies = [...parent.querySelectorAll('.reply-container .comment-item-sub')].map(commentOf).filter(Boolean).slice(0, MAX_REPLIES);
      if (replies.length) comment.replies = replies;
      items.push(comment);
    }
    const total = Number(root.querySelector('.comments-container .total')?.textContent.match(/\d+/)?.[0]);
    return { total: Number.isSafeInteger(total) ? total : null, items };
  }

  async function captureImages(root) {
    const images = [];
    for (const source of imageSources(root)) {
      try {
        const data = await u.imageToJpeg(source);
        if (data) images.push(data);
      } catch { /* One unreadable picture must not block the others. */ }
    }
    return images;
  }

  function ownId(root) {
    return u.normalize(root.getAttribute('data-note-id') || root.getAttribute('data-id') || '', 120);
  }

  function detailRoot(node) {
    const inner = node.matches('.note-detail-mask') ? node.querySelector(INNER_ROOTS.join(',')) || node : node;
    // An explicit detail field is required. Do not guess from a generic title
    // or from any card that happens to carry data-note-id on the feed.
    return inner.querySelector(CONTENT) ? inner : null;
  }

  function getCandidates() {
    const roots = [...new Set([...document.querySelectorAll(rootSelector)].map(detailRoot).filter(Boolean))];
    return roots.filter(root => !roots.some(other => root !== other && root.contains(other)));
  }

  function pickRoot(candidates) {
    const route = routeInfo();
    let best = null;
    let bestScore = -1;
    for (const root of candidates) {
      if (!u.visible(root)) continue;
      // The modal's current detail takes priority over an underlying page.
      const inModal = Boolean(root.closest('.note-detail-mask, [role="dialog"]'));
      const score = u.visibilityScore(root) + (inModal ? 4 : 0) + (route.id && ownId(root) === route.id ? 2 : 0);
      if (score > bestScore) { best = root; bestScore = score; }
    }
    return best;
  }

  function read(root) {
    if (!root || !u.visible(root)) return null;
    const title = u.text(root, TITLES, 300);
    const description = u.text(root, DESCRIPTIONS, 6000);
    const author = u.text(root, AUTHORS, 120);
    if (!title && !description) return null;
    const route = routeInfo();
    // A visible detail link is useful for in-feed modals whose URL did not
    // change, but only accept it when it agrees with a known container ID.
    const own = ownId(root);
    const link = u.firstVisible(root, LINKS);
    const linked = routeInfo(link?.getAttribute('href') || '');
    const id = own || route.id || linked.id;
    const url = route.id === id && route.url ? route.url
      : linked.id === id && linked.url ? linked.url
      : id ? `https://www.xiaohongshu.com/explore/${encodeURIComponent(id)}` : u.safeUrl(location.href);
    return {
      id: id || `content:${u.normalize(`${author}|${title}|${description}`, 800)}`,
      title, description, author, url, site: '小红书',
      images: imageSources(root).length,
      comments: readComments(root).items.length
    };
  }

  app.adapters.xiaohongshu = {
    label: '小红书',
    matches: hostname => /(^|\.)xiaohongshu\.com$/i.test(hostname),
    rootSelector,
    fieldSelector: [...TITLES, ...DESCRIPTIONS, ...AUTHORS, ...LINKS, MEDIA_IMAGES, COMMENT_ITEMS].join(','),
    getCandidates, pickRoot, read, captureImages, readComments,
    emptyMessage: '点开一篇小红书笔记后，我会显示这篇的标题、作者和正文。'
  };
})();
