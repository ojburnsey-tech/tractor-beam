// Bridge between the Library page and this extension.
//
// Runs in every frame (an artifact Library lives in a frame inside
// claude.ai) but stays silent: it relays a page's messages to the
// background, which answers only the Library this browser is linked to.
// The single exception is the reply to a page's own "Connect This Browser"
// request, which opens MP4 Grabber's confirmation tab. Nothing is posted to
// any other page, so sites can't detect the extension.
(() => {
  const CHANNEL = "mp4grabber";
  const REPLIES_BEFORE_LINKING = new Set(["pair-pending", "paired", "pair-declined"]);
  let port = null;
  let accepted = false;

  function toPage(message) {
    // "*" because a sandboxed frame's real origin is opaque ("null") even
    // though location.origin reports its address; this only ever posts to
    // this script's own window.
    window.postMessage({ channel: CHANNEL, from: "extension", ...message }, "*");
  }

  function connect() {
    port = chrome.runtime.connect({ name: "web-bridge" });
    port.onMessage.addListener((message) => {
      if (message?.type === "hello" || message?.type === "paired") accepted = true;
      if (accepted || REPLIES_BEFORE_LINKING.has(message?.type)) toPage(message);
    });
    port.onDisconnect.addListener(() => {
      port = null;
      if (accepted) toPage({ type: "disconnected" });
      accepted = false;
    });
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.channel !== CHANNEL || data.from !== "page" || typeof data.type !== "string") return;
    const { channel, from, ...message } = data;
    try {
      if (!port) connect();
      port.postMessage(JSON.parse(JSON.stringify(message)));
    } catch {
      port = null; // the extension was reloaded; the page will say hello again
    }
  });
})();
