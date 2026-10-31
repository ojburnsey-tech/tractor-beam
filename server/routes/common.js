// Shapes database rows into the JSON the clients see.

import { DEFAULT_SETTINGS } from "../validate.js";

export function userSettings(user) {
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(user.settings || "{}") };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function publicUser(user) {
  return {
    id: user.id,
    email: user.email,
    createdAt: user.created_at,
    kdfIterations: user.kdf_iterations,
    vault: JSON.parse(user.vault),
    settings: userSettings(user)
  };
}

export function entryJson(row) {
  let samples = null;
  try { samples = row.samples ? JSON.parse(row.samples) : null; } catch {}
  return {
    id: row.id,
    deviceId: row.device_id,
    seq: row.seq,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    state: row.state,
    kind: row.kind,
    method: row.method,
    mode: row.mode,
    live: Boolean(row.live),
    bytes: row.bytes,
    received: row.received,
    mediaDuration: row.media_duration,
    elapsedMs: row.elapsed_ms,
    activeMs: row.active_ms,
    avgSpeed: row.avg_speed,
    peakSpeed: row.peak_speed,
    height: row.height,
    codecs: row.codecs,
    container: row.container,
    fps: row.fps,
    concurrency: row.concurrency,
    concurrencyAuto: Boolean(row.concurrency_auto),
    errorCode: row.error_code,
    samples,
    sealed: row.sealed
  };
}

export function deviceJson(row) {
  return {
    id: row.id,
    name: row.name,
    browser: row.browser,
    version: row.version,
    createdAt: row.created_at,
    lastSeen: row.last_seen
  };
}
