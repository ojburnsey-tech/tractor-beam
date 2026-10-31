// In-memory hub for things that change by the second: live download progress,
// remote commands, and the Server-Sent Events channel each website tab holds.
// Nothing here is persisted; a restart simply waits for the next push.

const STALE_MS = 15000;
const COMMAND_TTL_MS = 30000;
const HEARTBEAT_MS = 25000;

export class LiveHub {
  constructor() {
    this.users = new Map();
    this.sweeper = setInterval(() => this.sweep(), 5000);
    this.heartbeat = setInterval(() => this.ping(), HEARTBEAT_MS);
    this.sweeper.unref();
    this.heartbeat.unref();
  }

  user(userId) {
    let state = this.users.get(userId);
    if (!state) {
      state = { jobs: new Map(), commands: new Map(), listeners: new Set(), pendingLive: null };
      this.users.set(userId, state);
    }
    return state;
  }

  /** Called by a device every ~2 s. Returns commands waiting for it. */
  push(userId, device, jobs = [], ended = []) {
    const state = this.user(userId);
    const now = Date.now();
    for (const job of jobs) {
      state.jobs.set(`${device.id}:${job.jobId}`, { ...job, deviceId: device.id, deviceName: device.name, receivedAt: now });
    }
    for (const jobId of ended) state.jobs.delete(`${device.id}:${jobId}`);
    if (jobs.length || ended.length) this.scheduleLive(userId);
    const waiting = (state.commands.get(device.id) || []).filter((command) => now - command.at < COMMAND_TTL_MS);
    state.commands.delete(device.id);
    return waiting.map(({ jobId, action }) => ({ jobId, action }));
  }

  /** Forgets everything a device reported, e.g. when it is disconnected. */
  dropDevice(userId, deviceId) {
    const state = this.users.get(userId);
    if (!state) return;
    for (const key of state.jobs.keys()) if (key.startsWith(`${deviceId}:`)) state.jobs.delete(key);
    state.commands.delete(deviceId);
    this.scheduleLive(userId);
  }

  command(userId, deviceId, jobId, action) {
    const state = this.user(userId);
    if (!state.jobs.has(`${deviceId}:${jobId}`)) return false;
    const list = state.commands.get(deviceId) || [];
    list.push({ jobId, action, at: Date.now() });
    state.commands.set(deviceId, list.slice(-20));
    return true;
  }

  list(userId) {
    const state = this.users.get(userId);
    if (!state) return [];
    return [...state.jobs.values()].sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0));
  }

  /** Attaches an SSE response. Sends the current live list immediately. */
  subscribe(userId, res) {
    const state = this.user(userId);
    state.listeners.add(res);
    this.write(res, "live", { jobs: this.list(userId) });
    res.on("close", () => state.listeners.delete(res));
  }

  emit(userId, event, data = {}) {
    const state = this.users.get(userId);
    if (!state) return;
    for (const res of state.listeners) this.write(res, event, data);
  }

  /** Coalesces bursts of live updates into one event per 250 ms. */
  scheduleLive(userId) {
    const state = this.user(userId);
    if (state.pendingLive) return;
    state.pendingLive = setTimeout(() => {
      state.pendingLive = null;
      this.emit(userId, "live", { jobs: this.list(userId) });
    }, 250);
  }

  write(res, event, data) {
    if (res.writableEnded) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  ping() {
    for (const state of this.users.values()) {
      for (const res of state.listeners) if (!res.writableEnded) res.write(": keep-alive\n\n");
    }
  }

  sweep() {
    const now = Date.now();
    for (const [userId, state] of this.users) {
      let changed = false;
      for (const [key, job] of state.jobs) {
        if (now - job.receivedAt > STALE_MS) {
          state.jobs.delete(key);
          changed = true;
        }
      }
      if (changed) this.scheduleLive(userId);
      if (!state.jobs.size && !state.listeners.size && !state.commands.size && !state.pendingLive) this.users.delete(userId);
    }
  }

  close() {
    clearInterval(this.sweeper);
    clearInterval(this.heartbeat);
    for (const state of this.users.values()) {
      clearTimeout(state.pendingLive);
      for (const res of state.listeners) res.end();
    }
    this.users.clear();
  }
}
