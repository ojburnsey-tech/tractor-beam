// Starts a throwaway server and provides a cookie-keeping client.

import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadConfig } from "../../server/config.js";
import { createApp } from "../../server/app.js";

export async function startServer(overrides = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), "grabber-test-"));
  const config = loadConfig({ dataDir, port: 0, host: "127.0.0.1", quiet: true, allowSignup: false, ...overrides });
  const app = createApp(config);
  const server = createServer((req, res) => app.handle(req, res));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    app,
    base,
    async stop() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      app.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  };
}

export class Client {
  constructor(base, { bearer } = {}) {
    this.base = base;
    this.cookie = "";
    this.bearer = bearer;
  }

  async request(method, pathname, body, headers = {}) {
    const init = { method, headers: { ...headers }, redirect: "manual" };
    if (this.cookie) init.headers.Cookie = this.cookie;
    if (this.bearer) init.headers.Authorization = `Bearer ${this.bearer}`;
    if (method !== "GET" && !this.bearer && !("X-Requested-With" in headers)) init.headers["X-Requested-With"] = "grabber";
    if (body !== undefined) {
      init.headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    const response = await fetch(this.base + pathname, init);
    const setCookie = response.headers.get("set-cookie");
    if (setCookie) {
      const [pair] = setCookie.split(";");
      this.cookie = pair.endsWith("=") ? "" : pair;
    }
    const text = await response.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { status: response.status, json, text, headers: response.headers };
  }

  get(pathname, headers) { return this.request("GET", pathname, undefined, headers); }
  post(pathname, body = {}, headers) { return this.request("POST", pathname, body, headers); }
  patch(pathname, body = {}, headers) { return this.request("PATCH", pathname, body, headers); }
  delete(pathname, body, headers) { return this.request("DELETE", pathname, body, headers); }
}
