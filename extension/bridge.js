// Bridge between the Library website and this extension.
//
// Runs in the top frame of every page but stays silent: it only relays a
// page's messages to the background, which accepts the connection solely
// for the linked Library's origin and otherwise disconnects without a reply.
// Nothing is ever posted back to a page that wasn't accepted, so other
// sites can't tell the extension is installed.
(() => {
  if (window.top !== window) return;
  const CHANNEL = "mp4grabber";
  let port = null;
  let accepted = false;

  function toPage(message) {
    window.postMessage({ channel: CHANNEL, from: "extension", ...message }, location.origin);
  }

  function connect() {
    port = chrome.runtime.connect({ name: "web-bridge" });
    port.onMessage.addListener((message) => {
      if (message?.type === "hello") accepted = true;
      if (accepted) toPage(message);
    });
    port.onDisconnect.addListener(() => {
      port = null;
      if (accepted) toPage({ type: "disconnected" });
      accepted = false;
    });
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.origin !== location.origin) return;
    const data = event.data;
    if (!data || data.channel !== CHANNEL || data.from !== "page" || typeof data.type !== "string") return;
    try {
      if (!port) connect();
      port.postMessage({ type: data.type, jobId: data.jobId, action: data.action });
    } catch {
      port = null; // the extension was reloaded; the page will say hello again
    }
  });
})();
