(() => {
  window.addEventListener("message", (event) => {
    if (event.source !== window || event.data?.source !== "mp4-grabber-media") return;
    const data = event.data;
    if (!["manifest", "mse", "protected"].includes(data.type)) return;
    chrome.runtime.sendMessage({ type: "media-activity", activity: data.type, url: data.url, kind: data.kind,
      children: Array.isArray(data.children) ? data.children.slice(0, 300) : [], mime: String(data.mime || "").slice(0, 180) }).catch(() => {});
  });
  const reported = new Map();
  let timer;

  function report() {
    const found = [];
    document.querySelectorAll("video, audio").forEach((video) => {
      const urls = new Set([video.currentSrc, video.src]);
      video.querySelectorAll("source[src]").forEach((source) => urls.add(source.src));
      for (const url of urls) {
        if (/^https?:/i.test(url)) found.push({ url, playing: !video.paused && !video.ended });
      }
    });
    for (const entry of performance.getEntriesByType("resource")) {
      if (/\.(m3u8|mpd)(\?|$)/i.test(entry.name)) found.push({ url: entry.name, playing: false });
    }
    const changed = found.filter((video) => reported.get(video.url) !== video.playing);
    if (!changed.length) return;
    for (const video of changed) reported.set(video.url, video.playing);
    while (reported.size > 200) reported.delete(reported.keys().next().value);
    chrome.runtime.sendMessage({ type: "page-videos", videos: changed }).catch(() => {});
  }

  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(report, 300);
  }

  for (const event of ["play", "playing", "loadedmetadata", "pause"]) {
    document.addEventListener(event, schedule, true);
  }
  new MutationObserver(schedule).observe(document.documentElement || document, {
    childList: true, subtree: true, attributes: true, attributeFilter: ["src"]
  });
  new PerformanceObserver(schedule).observe({ type: "resource", buffered: true });
  report();
})();
