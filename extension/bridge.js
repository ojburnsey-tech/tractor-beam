// Bridge between the Library website and this extension.
//
// Runs in the top frame of every page but stays silent: it only relays a
// page's messages to the background, which accepts the connection solely
// for the linked Library's origin and otherwise disconnects without a reply.
// Other sites therefore can't tell the extension is installed.
(() => {
  if (window.top !== window) return;
  const CHANNEL = "mp4grabber";
  let port = null;

  function connect() {
    port = chrome.runtime.connect({ name: "web-bridge" });
    port.onMessage.addListener((message) => {
      window.postMessage({ channel: CHANNEL, from: "extension", ...message }, location.origin);
    });
    port.onDisconnect.addListener(() => {
      port = null;
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
