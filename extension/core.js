(() => {
  "use strict";
  // Re-injection replaces listeners as well as the panel.
  globalThis.__VOSS_SCROLL__?.runtime?.destroy();
  const normalize = (value, maxLength = 2000) => String(value || "").replace(/\s+/g, " ").trim().slice(0, maxLength);
  function rendered(element) {
    if (!element?.isConnected || element.closest('[hidden], [aria-hidden="true"]')) return false;
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    for (let node = element; node && node !== document.documentElement; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return false;
    }
    return true;
  }
  function visible(element) {
    if (!rendered(element)) return false;
    const rect = element.getBoundingClientRect();
    return rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth;
  }
  function visibilityScore(element) {
    if (!visible(element)) return 0;
    const r = element.getBoundingClientRect();
    const area = Math.max(0, Math.min(r.right, innerWidth) - Math.max(0, r.left)) * Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(0, r.top));
    return area / Math.min(r.width * r.height, innerWidth * innerHeight);
  }
  function firstVisible(root, selectors) {
    for (const selector of Array.isArray(selectors) ? selectors : [selectors]) {
      if (root.matches?.(selector) && rendered(root)) return root;
      for (const element of root.querySelectorAll(selector)) if (rendered(element)) return element;
    }
    return null;
  }
  const text = (root, selectors, maxLength = 2000) => {
    const element = firstVisible(root, selectors);
    // innerText is read only on a known field, never on the page or a whole card.
    return normalize(element?.innerText || "", maxLength);
  };
  function safeUrl(href) {
    try {
      const url = new URL(href, location.href);
      return /^https?:$/.test(url.protocol) ? url.href : "";
    } catch { return ""; }
  }
  const MAX_IMAGE_CHARS = 700_000;
  function loadImage(url) {
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.decoding = "async";
    image.src = url;
    return Promise.race([
      image.decode().then(() => image),
      new Promise((_, reject) => setTimeout(() => reject(new Error("image timeout")), 6000))
    ]);
  }
  // Re-encodes a note image as a small JPEG data URL. A CORS-enabled image that
  // is already on screen is reused; otherwise its URL is loaded again with CORS.
  // A server without CORS taints the canvas and toDataURL throws, so nothing leaks.
  async function imageToJpeg({ img, url }, { maxSide = 1024 } = {}) {
    let image = img && img.crossOrigin === "anonymous" && img.complete && img.naturalWidth > 0 ? img : null;
    if (!image) {
      if (!url) return null;
      image = await loadImage(url);
    }
    for (const [side, quality] of [[maxSide, 0.82], [768, 0.7], [512, 0.6]]) {
      const scale = Math.min(1, side / Math.max(image.naturalWidth, image.naturalHeight));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
      const context = canvas.getContext("2d");
      context.fillStyle = "#fff";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      const data = canvas.toDataURL("image/jpeg", quality);
      if (data.length <= MAX_IMAGE_CHARS) return data;
    }
    return null;
  }
  globalThis.__VOSS_SCROLL__ = { version: "0.8.1", chatEnabled: true, adapters: {}, utils: { normalize, visible, visibilityScore, firstVisible, text, safeUrl, imageToJpeg } };
})();
