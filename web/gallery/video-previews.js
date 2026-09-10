"use strict";

const videoPreviews = (() => {
  const cache = new Map();
  const pending = new Map();
  const targets = new Map();
  const queue = [];
  let active = 0;

  function captureFrame(src) {
    return new Promise((resolve) => {
      const video = document.createElement("video");
      let finished = false;
      let seeked = false;
      let capturing = false;
      const timer = setTimeout(() => finish(null), 20000);
      function finish(blob) {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        video.onloadedmetadata = video.onloadeddata = video.onseeked = video.onerror = null;
        video.pause();
        video.removeAttribute("src");
        video.load();
        resolve(blob); // Releases the decoder and network request on success, unsupported codecs, or timeout.
      }
      function capture() {
        if (!seeked || capturing || finished || video.readyState < 2) return;
        capturing = true;
        try {
          if (!video.videoWidth || !video.videoHeight) { finish(null); return; }
          const scale = Math.min(1, 640 / Math.max(video.videoWidth, video.videoHeight));
          const canvas = document.createElement("canvas");
          canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
          canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
          canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);
          canvas.toBlob(finish, "image/jpeg", 0.82);
        } catch { finish(null); }
      }
      video.muted = true;
      video.playsInline = true;
      video.preload = "metadata";
      video.onerror = () => finish(null);
      video.onloadedmetadata = () => {
        try {
          video.currentTime = Number.isFinite(video.duration) && video.duration > 0 ? Math.min(1, video.duration / 4) : 0.1;
        } catch { finish(null); }
      }; // Seeks a separate, silent decoder near the beginning; the actual player still starts at zero.
      video.onseeked = () => { seeked = true; capture(); };
      video.onloadeddata = capture;
      video.src = src;
      video.load();
    });
  }

  function pump() {
    while (active < 2 && queue.length) {
      const { src, resolve } = queue.shift();
      if (![...targets].some(([node, target]) => node.isConnected && target.src === src)) {
        pending.delete(src);
        resolve(null);
        continue;
      }
      active += 1;
      captureFrame(src).then((blob) => {
        cache.set(src, blob);
        while (cache.size > 64) cache.delete(cache.keys().next().value);
        resolve(blob);
      }).finally(() => { pending.delete(src); active -= 1; pump(); });
    } // Limits concurrent decoding and retains only 64 small frame blobs, including failed attempts until eviction/reload.
  }

  function preview(src) {
    if (cache.has(src)) {
      const blob = cache.get(src);
      cache.delete(src);
      cache.set(src, blob);
      return Promise.resolve(blob);
    }
    if (!pending.has(src)) {
      pending.set(src, new Promise((resolve) => queue.push({ src, resolve })));
      pump();
    }
    return pending.get(src) || Promise.resolve(null); // Shares a single extraction across a collection cover, thumbnail, and viewer.
  }

  async function load(node) {
    const target = targets.get(node);
    if (!target || target.started || !node.isConnected) return;
    target.started = true;
    node.dataset.previewState = "loading";
    const blob = await preview(target.src);
    if (!node.isConnected || targets.get(node) !== target) return;
    if (!blob) { node.dataset.previewState = "unavailable"; return; }
    node.dataset.previewState = "ready";
    target.objectUrl = URL.createObjectURL(blob);
    if (node.tagName === "VIDEO") {
      if (node.paused && node.currentTime === 0) node.poster = target.objectUrl;
    } else {
      node.onload = () => node.classList.add("preview-ready");
      node.src = target.objectUrl;
    } // Applying a poster never seeks, replaces, or starts the viewer's playback.
  }

  const observer = "IntersectionObserver" in window ? new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) { observer.unobserve(entry.target); load(entry.target); }
    }
  }, { rootMargin: "150px" }) : null;

  function watch(node, src, immediate = false) {
    targets.set(node, { src, started: false, objectUrl: null });
    if (immediate || !observer) queueMicrotask(() => load(node));
    else observer.observe(node);
  }

  new MutationObserver(() => {
    for (const [node, target] of targets) {
      if (node.isConnected) continue;
      observer?.unobserve(node);
      if (target.objectUrl) URL.revokeObjectURL(target.objectUrl);
      if (node.tagName === "VIDEO") { node.pause(); node.removeAttribute("src"); node.load(); }
      targets.delete(node);
    } // Releases detached images/posters and stops closed players without retaining old cards after navigation.
  }).observe(document.body, { childList: true, subtree: true });

  return { watch };
})();
