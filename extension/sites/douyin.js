(() => {
  "use strict";
  const app = globalThis.__VOSS_SCROLL__;
  const u = app.utils;

  // Site-owned selectors are best effort, not a public API. Verify on the
  // signed-in live site after a redesign; never fall back to page-wide text.
  const ROOTS = [
    '[data-e2e="feed-active-video"]', '[data-e2e="feed-item"]',
    '[data-e2e="feed-video"]', '[data-e2e="video-detail"]',
    '[data-e2e="aweme-detail"]', '[data-e2e="video-player"]',
    '[data-video-id]', '.swiper-slide', '.xgplayer'
  ];
  const TITLES = ['[data-e2e="video-title"]', '[data-e2e="detail-title"]', '[data-testid="video-title"]'];
  const DESCRIPTIONS = [
    '[data-e2e="video-desc"]', '[data-e2e="video-description"]',
    '[data-e2e="feed-video-desc"]', '.video-info-detail .title', '.video-info-title'
  ];
  const AUTHORS = [
    '[data-e2e="video-author-name"]', '[data-e2e="feed-video-nickname"]',
    '[data-e2e="video-author"] .author-name', '[data-e2e="video-author"] a',
    'a[data-e2e="video-author"]', '.video-info-detail .author-name'
  ];
  const LINKS = ['a[href*="/video/"]'];
  const CONTENT = [...TITLES, ...DESCRIPTIONS].join(',');
  const ACTIVE = '[data-e2e="feed-active-video"], .swiper-slide-active, [aria-current="true"], [data-active="true"]';
  const rootSelector = [...ROOTS, 'video'].join(',');

  function routeInfo(href = location.href) {
    try {
      const url = new URL(href, location.href);
      if (!/(^|\.)douyin\.com$/i.test(url.hostname)) return { id: '', url: '' };
      const id = url.pathname.match(/^\/video\/([^/?#]+)/)?.[1] || url.searchParams.get('modal_id') || '';
      return { id, url: id ? u.safeUrl(url.href) : '' };
    } catch { return { id: '', url: '' }; }
  }

  function ownId(root) {
    // The active card can wrap a separate identity-bearing player element.
    const identity = root.matches('[data-video-id], [data-aweme-id]') ? root
      : u.firstVisible(root, '[data-video-id], [data-aweme-id]');
    return u.normalize(identity?.getAttribute('data-video-id') || identity?.getAttribute('data-aweme-id') || '', 120);
  }

  function descriptionId(root) {
    // The live recommendation feed exposes the current video's aweme_id on
    // its own hashtag links, even when the address bar remains on the feed.
    const field = u.firstVisible(root, DESCRIPTIONS);
    if (!field) return '';
    for (const link of field.querySelectorAll('a[href*="aweme_id="]')) {
      try {
        const url = new URL(link.getAttribute('href'), location.href);
        const id = url.searchParams.get('aweme_id') || '';
        if (/(^|\.)douyin\.com$/i.test(url.hostname) && /^\d{10,25}$/.test(id)) return id;
      } catch { /* A malformed link is not an identity source. */ }
    }
    return '';
  }

  function contentRoot(node) {
    // A video is a discovery anchor, not necessarily the metadata container.
    // Walk only its bounded ancestry, stopping before a multi-video feed/page.
    const video = node.matches('video') ? node : node.querySelector('video');
    if (!video) return node.matches(ROOTS.join(',')) && node.querySelector(CONTENT) ? node : null;
    let fallback = null;
    let metadataRoot = null;
    let preferredCard = null;
    for (let element = video, depth = 0; element && depth < 9; element = element.parentElement, depth++) {
      if (element === document.body || element === document.documentElement || element.matches('main, #root, #app')) break;
      if (element.querySelectorAll('video').length > 1) break;
      const knownCard = element.matches(ROOTS.join(','));
      if (knownCard) fallback = element;
      if (!metadataRoot && element.querySelector(CONTENT)) metadataRoot = element;
      // Keep walking after finding metadata: the enclosing feed card may carry
      // the active marker or ID needed to distinguish a paused current video.
      if (element.matches('[data-video-id], [data-aweme-id]') || (knownCard && element.matches(ACTIVE))) {
        preferredCard = element;
      }
    }
    if (preferredCard && (!metadataRoot || preferredCard.contains(metadataRoot))) return preferredCard;
    return metadataRoot || fallback || video;
  }

  function getCandidates() {
    return [...new Set([...document.querySelectorAll(rootSelector)].map(contentRoot).filter(Boolean))];
  }

  function visibleVideos(root) {
    return (root.matches('video') ? [root] : [...root.querySelectorAll('video')]).filter(u.visible);
  }

  function pickRoot(candidates) {
    const route = routeInfo();
    let best = null;
    let bestScore = -1;
    for (const root of candidates) {
      if (!u.visible(root)) continue;
      const videos = visibleVideos(root);
      // Reject preloaded slides even when their oversized wrapper intersects.
      if ((root.matches('video') || root.querySelector('video')) && !videos.length) continue;
      const active = u.firstVisible(root, ACTIVE);
      const media = videos[0] || root;
      const rect = media.getBoundingClientRect();
      const viewportShare = Math.min(1, rect.width * rect.height / Math.max(1, innerWidth * innerHeight));
      const playing = videos.some(video => !video.paused && !video.ended);
      const fraction = u.visibilityScore(media);
      const score = fraction * (1 + viewportShare + (active ? 4 : 0) + (playing ? 3 : 0)
        + (route.id && ownId(root) === route.id ? 2 : 0));
      if (score > bestScore) { best = root; bestScore = score; }
    }
    return best;
  }

  function read(root) {
    if (!root || !u.visible(root)) return null;
    const title = u.text(root, TITLES, 300);
    const description = u.text(root, DESCRIPTIONS, 4000);
    const author = u.text(root, AUTHORS, 120).replace(/^@\s*/, '');
    if (!title && !description && !author) return null;
    const link = u.firstVisible(root, LINKS);
    const linked = routeInfo(link?.getAttribute('href') || '');
    const route = routeInfo();
    const id = ownId(root) || linked.id || descriptionId(root) || route.id;
    const url = linked.id === id && linked.url ? linked.url
      : route.id === id && route.url ? route.url
      : id ? `https://www.douyin.com/video/${encodeURIComponent(id)}` : u.safeUrl(location.href);
    return {
      // Field-based fallback still changes when a route-less feed swaps content.
      id: id || `content:${u.normalize(`${author}|${title}|${description}`, 800)}`,
      title, description, author, url, site: '抖音'
    };
  }

  app.adapters.douyin = {
    label: '抖音',
    matches: hostname => /(^|\.)douyin\.com$/i.test(hostname),
    rootSelector,
    fieldSelector: [...TITLES, ...DESCRIPTIONS, ...AUTHORS, ...LINKS, 'video'].join(','),
    getCandidates, pickRoot, read,
    emptyMessage: '打开并播放一条抖音视频；如果仍未识别，可点“看这条”重试。'
  };
})();
