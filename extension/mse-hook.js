(() => {
  const publish = (data) => window.postMessage({ source: "mp4-grabber-media", ...data }, location.origin === "null" ? "*" : location.origin);
  const manifests = new Set();

  function inspect(text, url, type = "") {
    if (typeof text !== "string" || text.length > 2097152) return;
    const hls = text.trimStart().startsWith("#EXTM3U");
    const dash = /<(?:[\w-]+:)?MPD[\s>]/i.test(text);
    if (!hls && !dash) return;
    const children = [];
    if (hls) {
      for (const line of text.split(/\r?\n/)) {
        if (line.trim() && !line.startsWith("#")) children.push(line.trim());
        for (const match of line.matchAll(/URI="([^"]+)"/g)) children.push(match[1]);
      }
    } else {
      const document = new DOMParser().parseFromString(text, "application/xml");
      for (const node of document.getElementsByTagNameNS("*", "BaseURL")) children.push(node.textContent.trim());
    }
    const urls = children.slice(0, 300).map((value) => {
      try { return new URL(value, url).href; } catch { return ""; }
    }).filter((value) => /^https?:/.test(value));
    const key = `${url}:${urls.length}:${urls[0]}`;
    if (manifests.has(key)) return;
    manifests.add(key);
    while (manifests.size > 100) manifests.delete(manifests.values().next().value);
    publish({ type: "manifest", url, kind: hls ? "hls" : "dash", children: urls });
  }

  const originalFetch = window.fetch;
  window.fetch = function (...args) {
    return originalFetch.apply(this, args).then((response) => {
      const type = response.headers.get("content-type") || "";
      if (/mpegurl|dash\+xml/i.test(type) || /\.(m3u8|mpd)(\?|$)/i.test(response.url)) {
        const clone = response.clone();
        const reader = clone.body?.getReader();
        if (reader) {
          (async () => {
            const decoder = new TextDecoder();
            let text = "";
            try {
              while (text.length <= 2097152) {
                const { done, value } = await reader.read();
                if (done) {
                  inspect(text + decoder.decode(), response.url, type);
                  return;
                }
                text += decoder.decode(value, { stream: true });
              }
            } catch {} finally { await reader.cancel().catch(() => {}); }
          })();
        }
      }
      return response;
    });
  };

  const originalOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (...args) {
    this.addEventListener("load", () => {
      try {
        const type = this.getResponseHeader("content-type") || "";
        if (this.responseType === "" || this.responseType === "text") inspect(this.responseText, this.responseURL, type);
      } catch {}
    }, { once: true });
    return originalOpen.apply(this, args);
  };

  if (window.MediaSource) {
    const originalAdd = MediaSource.prototype.addSourceBuffer;
    MediaSource.prototype.addSourceBuffer = function (type) {
      const buffer = originalAdd.call(this, type);
      publish({ type: "mse", mime: String(type).slice(0, 180) });
      return buffer;
    };
  }
  document.addEventListener("encrypted", () => publish({ type: "protected" }), true);
})();
