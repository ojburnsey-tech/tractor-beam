// Records download speed over time.
//
// Two series are kept from the same byte counter:
//  • a fixed one-second series (last 120 s) for live graphs and peak speed;
//  • an archival series that starts at one second and halves its resolution
//    whenever it reaches `maxPoints`, so long downloads keep their whole shape
//    in a bounded size.
// Seconds spent paused become gaps (null) so graphs show them honestly.
// Average speed counts only active (unpaused) time. Peak speed is the best
// 3-second moving average, so a single burst doesn't count as the peak.

class Buckets {
  constructor(interval, start) {
    this.interval = interval;
    this.start = start;
    this.bytes = 0;
    this.pausedMs = 0;
  }

  add(bytes, pausedMs) {
    this.bytes += bytes;
    this.pausedMs += pausedMs;
  }

  /** Closes every whole interval up to `now`, returning one value per interval. */
  close(now) {
    const count = Math.floor((now - this.start) / this.interval);
    if (count < 1) return [];
    const span = count * this.interval;
    const value = this.pausedMs / span > 0.5 ? null : (this.bytes / count) / (this.interval / 1000);
    this.start += span;
    this.bytes = 0;
    this.pausedMs = 0;
    return Array(count).fill(value);
  }
}

export class SpeedRecorder {
  constructor({ maxPoints = 240, recentPoints = 120, window = 3000 } = {}) {
    this.maxPoints = maxPoints + (maxPoints % 2); // even, so merges never leave a half-filled pair
    this.recentPoints = recentPoints;
    this.windowMs = window;
    this.started = false;
  }

  start(now, bytes) {
    this.started = true;
    this.startedAt = now;
    this.startBytes = bytes;
    this.lastTime = now;
    this.lastBytes = bytes;
    this.archive = new Buckets(1000, now);
    this.seconds = new Buckets(1000, now);
    this.values = [];
    this.recentValues = [];
    this.smoothing = [];
    this.window = [{ time: now, bytes }];
    this.activeMs = 0;
    this.peak = 0;
    this.paused = false;
  }

  update(now, bytes, paused = false) {
    if (!this.started) this.start(now, bytes);
    const elapsed = Math.max(0, now - this.lastTime);
    const delta = Math.max(0, bytes - this.lastBytes);
    const pausedMs = paused ? elapsed : 0;
    if (!paused) this.activeMs += elapsed;
    this.lastTime = now;
    this.lastBytes = Math.max(this.lastBytes, bytes);
    this.paused = paused;

    this.archive.add(delta, pausedMs);
    this.seconds.add(delta, pausedMs);

    if (paused) this.window = [{ time: now, bytes: this.lastBytes }];
    else {
      this.window.push({ time: now, bytes: this.lastBytes });
      while (this.window.length > 2 && now - this.window[1].time >= this.windowMs) this.window.shift();
    }

    for (const value of this.seconds.close(now)) this.pushSecond(value);
    for (const value of this.archive.close(now)) this.pushArchive(value);
  }

  pushSecond(value) {
    this.recentValues.push(value);
    if (this.recentValues.length > this.recentPoints) this.recentValues.shift();
    if (value === null) return;
    this.smoothing.push(value);
    if (this.smoothing.length > 3) this.smoothing.shift();
    if (this.smoothing.length === 3) {
      this.peak = Math.max(this.peak, (this.smoothing[0] + this.smoothing[1] + this.smoothing[2]) / 3);
    }
  }

  pushArchive(value) {
    this.values.push(value);
    if (this.values.length >= this.maxPoints) this.halve();
  }

  halve() {
    const merged = [];
    for (let index = 0; index < this.values.length; index += 2) {
      const pair = [this.values[index], this.values[index + 1]].filter((value) => value !== null && value !== undefined);
      merged.push(pair.length ? pair.reduce((sum, value) => sum + value, 0) / pair.length : null);
    }
    this.values = merged;
    this.archive.interval *= 2;
  }

  get interval() {
    return this.started ? this.archive.interval : 1000;
  }

  /** Speed over the last few seconds, in bytes per second. */
  current() {
    if (!this.started || this.paused || this.window.length < 2) return 0;
    const first = this.window[0];
    const last = this.window[this.window.length - 1];
    const seconds = (last.time - first.time) / 1000;
    return seconds > 0.25 ? (last.bytes - first.bytes) / seconds : 0;
  }

  get received() {
    return this.started ? this.lastBytes - this.startBytes : 0;
  }

  average() {
    return this.activeMs > 0 ? this.received / (this.activeMs / 1000) : 0;
  }

  /** The last `count` one-second samples, for live graphs. */
  recent(count = 90) {
    return this.recentValues.slice(-count).map((value) => (value === null ? null : Math.round(value)));
  }

  finish(now, bytes) {
    if (!this.started) this.start(now, bytes);
    this.update(now, bytes, false);
    // Keep a final partial sample if it covers a meaningful slice of time.
    const partial = now - this.archive.start;
    if (partial >= this.archive.interval * 0.3 && this.archive.bytes > 0) {
      this.pushArchive(this.archive.bytes / (partial / 1000));
    }
    const avgSpeed = this.average();
    const values = this.values.map((value) => (value === null ? null : Math.round(value)));
    const shortPeak = this.smoothing.length < 3 ? Math.max(0, ...this.smoothing) : 0;
    return {
      samples: { interval: this.archive.interval, values },
      avgSpeed: Math.round(avgSpeed),
      peakSpeed: Math.round(Math.max(this.peak, shortPeak, avgSpeed)),
      activeMs: Math.round(this.activeMs),
      elapsedMs: Math.round(now - this.startedAt),
      received: this.received
    };
  }
}
