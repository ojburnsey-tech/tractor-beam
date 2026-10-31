// A stand-in for claude.ai's artifact runtime, for end-to-end tests only.
//
// Serves the built Library page inside a SANDBOXED, CROSS-ORIGIN iframe
// (opaque origin: the hardest case for an extension's content script), and
// provides `window.claude.use()` with db / user / room / downloads backed
// by this test server, so several tabs share one database and one room,
// as a computer and a phone would.

import { createServer } from "node:http";
import { readFileSync } from "node:fs";

const SKELETON_HEAD = '<!doctype html><html><head><meta charset=utf8><meta name=viewport content="width=device-width,initial-scale=1,viewport-fit=cover"><style>:root{color-scheme:light;padding-top:env(safe-area-inset-top);padding-bottom:env(safe-area-inset-bottom)}body{margin:0;font:14px system-ui,sans-serif}img{max-width:100%}[hidden]{display:none!important}</style>';

function mockClient(base) {
  return `(() => {
  const BASE = ${JSON.stringify(base)};
  const peerId = Math.random().toString(36).slice(2);
  const dbListeners = new Set();
  const roomHandlers = new Map();
  const peerHandlers = new Set();
  let peers = [];
  const events = new EventSource(BASE + "/mock/events?peer=" + peerId);
  events.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.kind === "db") dbListeners.forEach((fn) => fn(message));
    if (message.kind === "room") (roomHandlers.get(message.topic) || []).forEach((fn) => fn({ topic: message.topic, data: message.data, peer: message.peer, by: null, isMe: message.peer === peerId, sameTab: message.peer === peerId, kind: "viewer", guest: false }));
    if (message.kind === "peers") {
      peers = Object.freeze(message.peers.map((peer) => Object.freeze({ ...peer, isMe: peer.peer === peerId, kind: "viewer", guest: false })));
      peerHandlers.forEach((fn) => fn({ peers, joined: [], left: [], updated: peers }));
    }
  };
  async function call(op, body) {
    const response = await fetch(BASE + "/mock/" + op, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const json = await response.json();
    if (json.error) throw { code: json.error, message: json.error };
    return json;
  }
  const meta = { fromCache: false, hasPendingWrites: false };
  const snap = (path, data) => Object.freeze({ id: path.split("/").pop(), exists: data != null, data: () => data ?? undefined, metadata: meta });
  function docRef(path) {
    if (path.split("/").length % 2) throw new TypeError("document paths need an even number of segments: " + path);
    const ref = {
      id: path.split("/").pop(), path,
      get: async () => snap(path, (await call("get", { path })).data),
      set: (data) => call("set", { path, data }).then(() => {}),
      update: (data) => call("update", { path, data }).then(() => {}),
      delete: () => call("delete", { path }).then(() => {}),
      onSnapshot(next, error) {
        let alive = true;
        const load = () => ref.get().then((value) => alive && next(value), (problem) => error && error(problem));
        const listener = (message) => { if (message.path === path) load(); };
        dbListeners.add(listener);
        load();
        return () => { alive = false; dbListeners.delete(listener); };
      },
      collection: (sub) => collectionRef(path + "/" + sub)
    };
    return ref;
  }
  function collectionRef(path) {
    if (path.split("/").length % 2 === 0) throw new TypeError("collection paths need an odd number of segments: " + path);
    const query = {
      path,
      doc: (id) => docRef(path + "/" + (id || Math.random().toString(36).slice(2))),
      add: async (data) => { const ref = query.doc(); await ref.set(data); return ref; },
      where: () => query, orderBy: () => query, limit: () => query,
      async get() {
        const { docs } = await call("list", { collection: path });
        const snaps = docs.map((doc) => snap(doc.path, doc.data));
        return { docs: snaps, size: snaps.length, empty: !snaps.length, docChanges: () => [], metadata: meta };
      },
      onSnapshot(next, error) {
        let alive = true;
        let timer;
        const load = () => query.get().then((value) => alive && next(value), (problem) => error && error(problem));
        const listener = (message) => { if (message.collection === path) { clearTimeout(timer); timer = setTimeout(load, 25); } };
        dbListeners.add(listener);
        load();
        return () => { alive = false; dbListeners.delete(listener); };
      }
    };
    return query;
  }
  const capabilities = {
    db: Object.freeze({ doc: docRef, collection: collectionRef }),
    user: Object.freeze({ id: async () => "mock-user-1", isOwner: () => true, canEdit: () => true, can: () => true }),
    room: Object.freeze({
      emit: (topic, data) => call("emit", { topic, data, peer: peerId }).then(() => {}),
      on(topic, handler) {
        if (!roomHandlers.has(topic)) roomHandlers.set(topic, new Set());
        roomHandlers.get(topic).add(handler);
        return () => roomHandlers.get(topic).delete(handler);
      },
      presence: (patch) => call("presence", { peer: peerId, patch }).then(() => {}),
      onPeers(handler) {
        peerHandlers.add(handler);
        setTimeout(() => handler({ peers, joined: peers, left: [], updated: [] }), 0);
        return () => peerHandlers.delete(handler);
      },
      peers: () => peers,
      connected: () => true
    }),
    downloads: Object.freeze({
      async save({ filename, data }) {
        const text = typeof data === "string" ? data : await new Response(data).text();
        window.__savedFiles = [...(window.__savedFiles || []), { filename, text }];
        return { saved: true };
      }
    })
  };
  window.claude = Object.freeze({ use: (name) => new Promise((resolve) => setTimeout(() => resolve(capabilities[name] || null), 20)) });
})();`;
}

export async function startArtifactHost({ pagePath }) {
  const docs = new Map();
  const streams = new Map();   // peer → response
  const presence = new Map();  // peer → presence

  function broadcast(message) {
    const line = `data: ${JSON.stringify(message)}\n\n`;
    for (const res of streams.values()) res.write(line);
  }
  const parentOf = (path) => path.split("/").slice(0, -1).join("/");
  const peerList = () => [...presence.entries()].map(([peer, value]) => ({ peer, presence: value }));

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
    const frameBase = `http://127.0.0.1:${server.address().port}`;

    if (url.pathname === "/host.html") {
      // The "claude.ai" page: a different origin from the frame below.
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><title>Host</title><style>html,body{margin:0;height:100%}iframe{border:0;width:100%;height:100%;display:block}</style>
<iframe id="artifact" src="${frameBase}/frame/library.html${url.searchParams.get("hash") ? `#${url.searchParams.get("hash")}` : ""}" sandbox="allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals"></iframe>`);
      return;
    }
    if (url.pathname === "/frame/library.html") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`${SKELETON_HEAD}<script>${mockClient(frameBase)}</script></head><body>${readFileSync(pagePath, "utf8")}</body></html>`);
      return;
    }
    if (url.pathname === "/mock/events") {
      const peer = url.searchParams.get("peer");
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store" });
      res.write(": hi\n\n");
      streams.set(peer, res);
      presence.set(peer, {});
      broadcast({ kind: "peers", peers: peerList() });
      req.on("close", () => {
        streams.delete(peer);
        presence.delete(peer);
        broadcast({ kind: "peers", peers: peerList() });
      });
      return;
    }
    if (req.method === "POST" && url.pathname.startsWith("/mock/")) {
      let body = "";
      for await (const chunk of req) body += chunk;
      const input = JSON.parse(body || "{}");
      const reply = (value) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(value)); };
      const op = url.pathname.slice("/mock/".length);
      if (op === "get") return reply({ data: docs.get(input.path) ?? null });
      if (op === "list") return reply({ docs: [...docs.entries()].filter(([path]) => parentOf(path) === input.collection).sort(([a], [b]) => a.localeCompare(b)).map(([path, data]) => ({ path, data })) });
      if (op === "set" || op === "update") {
        if (op === "update" && !docs.has(input.path)) return reply({ error: "invalid_argument" });
        if (JSON.stringify(input.data).length > 256 * 1024) return reply({ error: "invalid_argument" });
        docs.set(input.path, op === "set" ? input.data : { ...docs.get(input.path), ...input.data });
        broadcast({ kind: "db", path: input.path, collection: parentOf(input.path) });
        return reply({ ok: true });
      }
      if (op === "delete") {
        docs.delete(input.path);
        broadcast({ kind: "db", path: input.path, collection: parentOf(input.path) });
        return reply({ ok: true });
      }
      if (op === "emit") {
        if (JSON.stringify(input.data ?? null).length > 4096) return reply({ error: "invalid_argument" });
        broadcast({ kind: "room", topic: input.topic, data: input.data, peer: input.peer });
        return reply({ ok: true });
      }
      if (op === "presence") {
        presence.set(input.peer, { ...presence.get(input.peer), ...input.patch });
        broadcast({ kind: "peers", peers: peerList() });
        return reply({ ok: true });
      }
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  return { server, docs, hostUrl: (hash = "") => `http://localhost:${port}/host.html${hash ? `?hash=${hash}` : ""}`, frameOrigin: `http://127.0.0.1:${port}` };
}
