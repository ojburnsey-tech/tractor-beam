import { safeUrl } from "./shared.js";

export class DownloadError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.status = status;
  }
}

export class Network {
  constructor({ signal, prepare = async () => {}, onRetry = () => {}, concurrency = 3, gate = async () => {} } = {}) {
    this.signal = signal;
    this.prepare = prepare;
    this.onRetry = onRetry;
    this.hosts = new Map();
    this.bytes = 0;
    this.failure = null;
    this.concurrency = Math.max(1, Math.min(6, Number(concurrency) || 3));
    this.gate = gate;
    this.active = 0;
    this.completed = new Set();
    this.segmentUrls = new Set();
  }

  async slot() {
    while (true) {
      await this.gate();
      if (this.active < this.concurrency) break;
      await this.wait(25);
    }
    this.signal?.throwIfAborted();
    this.active += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active -= 1;
    };
  }

  retryDelay(attempts, error) {
    if (this.signal?.aborted || [400, 401, 403, 404, 410, 416].includes(error.status) || attempts >= 5) return null;
    const delay = Math.min(2 ** Math.max(0, attempts - 1), 16);
    this.onRetry(`Connection interrupted. Retrying in ${delay} second${delay === 1 ? "" : "s"}…`);
    return delay;
  }

  async fetch(input, init = {}) {
    const url = safeUrl(typeof input === "string" ? input : input.url || String(input));
    const host = new URL(url).origin;
    if (!this.hosts.has(host)) {
      this.hosts.set(host, Promise.resolve().then(() => this.prepare(url)).catch((error) => {
        this.hosts.delete(host);
        throw error;
      }));
    }
    await this.hosts.get(host);
    const release = await this.slot();
    const controller = new AbortController();
    const signals = [this.signal, init.signal].filter(Boolean);
    const abort = () => controller.abort();
    signals.forEach((signal) => {
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
    });
    let timer;
    const startTimer = () => {
      clearTimeout(timer);
      timer = setTimeout(() => controller.abort(new DownloadError("The server stopped responding.")), 45000);
    };
    const cleanup = () => {
      release();
      clearTimeout(timer);
      signals.forEach((signal) => signal.removeEventListener("abort", abort));
    };
    startTimer();
    try {
      const response = await fetch(url, { ...init, credentials: "include", cache: "no-store", signal: controller.signal });
      release();
      clearTimeout(timer);
      if (!response.ok) {
        await response.body?.cancel();
        const advice = [401, 403, 410].includes(response.status) ? " Reload the video page, press play and try the fresh link." : "";
        throw new DownloadError(`The server returned HTTP ${response.status}.${advice}`, response.status);
      }
      if (!response.body) throw new DownloadError("The server returned no video data.");
      const reader = response.body.getReader();
      const owner = this;
      const body = new ReadableStream({
        async pull(stream) {
          const releaseRead = await owner.slot();
          startTimer();
          try {
            const { done, value } = await reader.read();
            clearTimeout(timer);
            if (done) {
              if (owner.segmentUrls.has(url)) owner.completed.add(`${url}:${response.headers.get("content-range") || "full"}`);
              cleanup();
              stream.close();
            } else {
              owner.bytes += value.byteLength;
              stream.enqueue(value);
            }
          } catch (error) {
            cleanup();
            stream.error(error);
          } finally {
            releaseRead();
          }
        },
        async cancel(reason) {
          cleanup();
          controller.abort();
          await reader.cancel(reason).catch(() => {});
        }
      }, { highWaterMark: 0 });
      const result = new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
      Object.defineProperty(result, "url", { value: response.url || url });
      return result;
    } catch (error) {
      cleanup();
      throw error;
    }
  }

  async read(url, limit = 8388608, headers = {}) {
    for (let attempt = 1; ; attempt += 1) {
      let reader;
      try {
        const response = await this.fetch(url, { headers });
        reader = response.body.getReader();
        const chunks = [];
        let length = 0;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          length += value.byteLength;
          if (length > limit) throw new DownloadError("This playlist or index is too large to process safely.", 400);
          chunks.push(value);
        }
        const bytes = new Uint8Array(length);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.length;
        }
        return { bytes, url: response.url, headers: response.headers, status: response.status };
      } catch (error) {
        await reader?.cancel().catch(() => {});
        const delay = this.retryDelay(attempt, error);
        if (delay === null) throw error;
        await this.wait(delay * 1000);
      }
    }
  }

  wait(milliseconds) {
    return new Promise((resolve, reject) => {
      const cancel = () => {
        clearTimeout(timer);
        reject(new DOMException("Download cancelled.", "AbortError"));
      };
      const timer = setTimeout(() => {
        this.signal?.removeEventListener("abort", cancel);
        resolve();
      }, milliseconds);
      if (this.signal?.aborted) cancel();
      else this.signal?.addEventListener("abort", cancel, { once: true });
    });
  }
}
