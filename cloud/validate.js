import { HttpError } from "./http.js";
export function bad(message) {
    return new HttpError(400, message, "invalid");
}
export function string(value, { max = 200, min = 0, pattern, name = "value", optional = false } = {}) {
    if ((value === undefined || value === null || value === "") && optional)
        return null;
    if (typeof value !== "string")
        throw bad(`${name} must be text.`);
    if (value.length < min || value.length > max)
        throw bad(`${name} is the wrong length.`);
    if (pattern && !pattern.test(value))
        throw bad(`${name} isn't valid.`);
    return value;
}
export function number(value, { min = 0, max = Number.MAX_SAFE_INTEGER, integer = false, optional = true } = {}) {
    if (value === undefined || value === null || value === "") {
        if (optional)
            return null;
        throw bad("A required number is missing.");
    }
    const parsed = Number(value);
    if (!Number.isFinite(parsed))
        return null;
    const clamped = Math.min(max, Math.max(min, parsed));
    return integer ? Math.round(clamped) : clamped;
}
function oneOf(value, allowed, fallback = null) {
    return allowed.includes(value) ? value : fallback;
}
export const ID = /^[A-Za-z0-9_-]{8,64}$/;
const B64URL = /^[A-Za-z0-9_-]+$/;
const DAY = 86400000;
export function email(value) {
    const text = string(String(value || "").trim().toLowerCase(), { max: 254, name: "Email" });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text))
        throw bad("Enter a valid email address.");
    return text;
}
export function authHash(value) {
    return string(value, { min: 43, max: 43, pattern: B64URL, name: "Password proof" });
}
export function wrappedVault(value) {
    if (!value || typeof value !== "object")
        throw bad("The encryption key is missing.");
    return JSON.stringify({
        v: 1,
        iv: string(value.iv, { min: 16, max: 16, pattern: B64URL, name: "Key nonce" }),
        ct: string(value.ct, { min: 40, max: 80, pattern: B64URL, name: "Wrapped key" })
    });
}
export function sealed(value, max = 16384) {
    const text = string(value, { max, min: 10, name: "Sealed data" });
    let envelope;
    try {
        envelope = JSON.parse(text);
    }
    catch {
        throw bad("Sealed data isn't valid.");
    }
    if (envelope?.v !== 1 || ![0, 1].includes(envelope.e))
        throw bad("Sealed data isn't valid.");
    return text;
}
const STATES = ["done", "partial", "failed", "cancelled"];
const KINDS = ["hls", "dash", "mp4", "webm", "mkv", "mov", "audio", "unknown"];
function samples(value) {
    if (!value || typeof value !== "object")
        return null;
    const interval = number(value.interval, { min: 250, max: 3600000, integer: true });
    if (!interval || !Array.isArray(value.values))
        return null;
    const values = value.values.slice(0, 600).map((sample) => (sample === null ? null : number(sample, { min: 0, max: 1e11 }) ?? null));
    return JSON.stringify({ interval, values });
}
export function entry(value, now = Date.now()) {
    if (!value || typeof value !== "object")
        throw bad("A history entry is missing.");
    const startedAt = number(value.startedAt, { min: 0, max: now + DAY, integer: true });
    const finishedAt = number(value.finishedAt, { min: 0, max: now + DAY, integer: true });
    const state = oneOf(value.state, STATES);
    if (!state)
        throw bad("A history entry has an unknown state.");
    return {
        id: string(value.id, { pattern: ID, name: "Entry id" }),
        started_at: startedAt,
        finished_at: finishedAt,
        state,
        kind: oneOf(value.kind, KINDS, "unknown"),
        method: oneOf(value.method, ["stream", "original"], "stream"),
        mode: oneOf(value.mode, ["both", "video", "audio"], "both"),
        live: value.live ? 1 : 0,
        bytes: number(value.bytes, { max: 1e14, integer: true }),
        received: number(value.received, { max: 1e14, integer: true }),
        media_duration: number(value.mediaDuration, { max: 1e7 }),
        elapsed_ms: number(value.elapsedMs, { max: 1e10, integer: true }),
        active_ms: number(value.activeMs, { max: 1e10, integer: true }),
        avg_speed: number(value.avgSpeed, { max: 1e11 }),
        peak_speed: number(value.peakSpeed, { max: 1e11 }),
        height: number(value.height, { max: 10000, integer: true }),
        codecs: string(value.codecs, { max: 60, optional: true, pattern: /^[\w.+ -]*$/, name: "Codecs" }),
        container: string(value.container, { max: 10, optional: true, pattern: /^[a-z0-9]*$/, name: "Container" }),
        fps: number(value.fps, { max: 1000 }),
        concurrency: number(value.concurrency, { min: 1, max: 6, integer: true }),
        concurrency_auto: value.concurrencyAuto ? 1 : 0,
        error_code: string(value.errorCode, { max: 32, optional: true, pattern: /^[a-z-]+$/, name: "Error code" }),
        samples: samples(value.samples),
        sealed: sealed(value.sealed),
        notify_title: string(value.notifyTitle, { max: 120, optional: true, name: "Title" })
    };
}
const QUALITIES = ["highest", "2160", "1440", "1080", "720", "480", "lowest"];
export const DEFAULT_SETTINGS = {
    encryptHistory: true,
    quality: "highest",
    mode: "both",
    concurrency: "auto",
    filenameTemplate: "{title}",
    neverSync: [],
    notifyFinished: true,
    notifyFailed: true
};
export function settings(update, current = DEFAULT_SETTINGS) {
    if (!update || typeof update !== "object")
        throw bad("Settings are missing.");
    const next = { ...DEFAULT_SETTINGS, ...current };
    if ("encryptHistory" in update)
        next.encryptHistory = Boolean(update.encryptHistory);
    if ("quality" in update)
        next.quality = oneOf(String(update.quality), QUALITIES, next.quality);
    if ("mode" in update)
        next.mode = oneOf(update.mode, ["both", "video", "audio"], next.mode);
    if ("concurrency" in update)
        next.concurrency = oneOf(String(update.concurrency), ["auto", "1", "3", "6"], next.concurrency);
    if ("filenameTemplate" in update) {
        next.filenameTemplate = string(String(update.filenameTemplate || "").trim() || "{title}", { max: 120, name: "File name" });
    }
    if ("neverSync" in update) {
        if (!Array.isArray(update.neverSync))
            throw bad("The site list isn't valid.");
        next.neverSync = [...new Set(update.neverSync.map((site) => string(site, { max: 253, pattern: /^[a-z0-9.-]+$/, name: "Site" })))].slice(0, 200);
    }
    if ("notifyFinished" in update)
        next.notifyFinished = Boolean(update.notifyFinished);
    if ("notifyFailed" in update)
        next.notifyFailed = Boolean(update.notifyFailed);
    return next;
}
const LIVE_STATES = ["inspecting", "ready", "busy", "paused", "recording", "finishing", "done", "error", "cancelled"];
export function snapshot(value) {
    if (!value || typeof value !== "object")
        throw bad("A live update is missing.");
    return {
        jobId: string(value.jobId, { max: 64, pattern: /^[A-Za-z0-9_.:-]+$/, name: "Job id" }),
        state: oneOf(value.state, LIVE_STATES, "busy"),
        method: oneOf(value.method, ["stream", "original"], "stream"),
        startedAt: number(value.startedAt, { integer: true }),
        fraction: number(value.fraction, { max: 1 }),
        speed: number(value.speed, { max: 1e11 }),
        avgSpeed: number(value.avgSpeed, { max: 1e11 }),
        received: number(value.received, { max: 1e14, integer: true }),
        written: number(value.written, { max: 1e14, integer: true }),
        estimatedBytes: number(value.estimatedBytes, { max: 1e14, integer: true }),
        eta: number(value.eta, { max: 1e7 }),
        mediaDuration: number(value.mediaDuration, { max: 1e7 }),
        height: number(value.height, { max: 10000, integer: true }),
        live: Boolean(value.live),
        canPause: Boolean(value.canPause),
        paused: Boolean(value.paused),
        errorCode: string(value.errorCode, { max: 32, optional: true, pattern: /^[a-z-]+$/, name: "Error code" }),
        recent: Array.isArray(value.recent) ? value.recent.slice(-120).map((sample) => number(sample, { max: 1e11 })) : [],
        sealed: value.sealed ? sealed(value.sealed, 4096) : null
    };
}
export const COMMANDS = ["pause", "resume", "cancel", "stop"];
