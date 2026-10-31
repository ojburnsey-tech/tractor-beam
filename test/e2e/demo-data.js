// Generates a realistic spread of past downloads so the Library and Insights
// screens can be checked with plenty of data. Test-only: these entries are
// written into the real extension's history and synced through the normal
// path, exactly like genuine downloads.

const SITES = [
  { site: "vimeo.com", speed: 9.5e6, titles: ["Northern Lights Over Tromsø", "Patagonia in 4K", "The Art of Slow Living", "Making a Japanese Knife"] },
  { site: "bbc.co.uk", speed: 6.2e6, titles: ["Planet Earth III · Episode 2", "Gardeners' World Spring Special", "The Graham Norton Show", "Question Time"] },
  { site: "nasa.gov", speed: 4.1e6, titles: ["Artemis II Crew Briefing", "Webb Telescope Deep Field", "Mars Sample Return Update"] },
  { site: "archive.org", speed: 1.6e6, titles: ["Metropolis (1927)", "Prelinger: Duck and Cover", "The General (1926)"] },
  { site: "dailymotion.com", speed: 3.3e6, titles: ["Tour de France Stage 14 Highlights", "Le Mans 24h Recap"] },
  { site: "twitch.tv", speed: 5.4e6, titles: ["Speedrun Marathon Finale", "Late Night Synth Jam"], live: true }
];

// Deterministic pseudo-random numbers so screenshots are reproducible.
function random(seed) {
  let value = seed;
  return () => {
    value = (value * 1664525 + 1013904223) % 4294967296;
    return value / 4294967296;
  };
}

export function demoEntries(now = Date.now(), count = 46) {
  const next = random(42);
  const entries = [];
  for (let index = 0; index < count; index += 1) {
    const source = SITES[Math.floor(next() * SITES.length)];
    const daysAgo = Math.floor(next() ** 1.6 * 75);
    const hour = [8, 9, 12, 13, 19, 20, 21, 22, 23, 1][Math.floor(next() * 10)];
    const started = new Date(now - daysAgo * 86400000);
    started.setHours(hour, Math.floor(next() * 60), 0, 0);
    if (started.getTime() > now - 3600000) started.setTime(now - 3600000 - index * 600000);
    const concurrency = [1, 3, 3, 6][Math.floor(next() * 4)];
    const offPeak = hour >= 23 || hour <= 7 ? 1.35 : hour >= 19 ? 0.8 : 1;
    const avgSpeed = source.speed * offPeak * (0.6 + concurrency / 6 * 0.6) * (0.85 + next() * 0.3);
    const height = [2160, 1080, 1080, 1080, 720, 720, 480][Math.floor(next() * 7)];
    const mediaDuration = source.live ? 1800 + next() * 5400 : 240 + next() * 3400;
    const bitrate = { 2160: 16e6, 1080: 5e6, 720: 2.8e6, 480: 1.2e6 }[height];
    const bytes = Math.round((mediaDuration * bitrate) / 8);
    const activeMs = Math.round((bytes / avgSpeed) * 1000);
    const pausedMs = next() < 0.15 ? Math.round(30000 + next() * 120000) : 0;
    const roll = next();
    const state = source.live ? "partial" : roll < 0.08 ? "failed" : roll < 0.12 ? "cancelled" : "done";
    const errorCode = state === "failed" ? ["expired", "network", "drm"][Math.floor(next() * 3)] : state === "cancelled" ? "cancelled" : null;
    const finishedFraction = state === "done" || state === "partial" ? 1 : 0.2 + next() * 0.6;
    const points = Math.min(240, Math.max(20, Math.round((activeMs + pausedMs) / 1000)));
    const interval = Math.max(1000, 2 ** Math.ceil(Math.log2(Math.max(1, (activeMs + pausedMs) / 240000))) * 1000);
    const values = [];
    const pauseStart = pausedMs ? Math.floor(points * 0.4) : -1;
    const pauseLength = pausedMs ? Math.max(2, Math.round(pausedMs / interval)) : 0;
    let level = avgSpeed;
    for (let point = 0; point < points; point += 1) {
      if (point >= pauseStart && point < pauseStart + pauseLength) {
        values.push(null);
        continue;
      }
      level = level * 0.8 + avgSpeed * 0.2 + (next() - 0.5) * avgSpeed * 0.5;
      const ramp = Math.min(1, (point + 1) / 4);
      const dip = next() < 0.04 ? 0.25 : 1;
      values.push(Math.max(0, Math.round(level * ramp * dip)));
    }
    entries.push({
      id: `demo-${String(index).padStart(3, "0")}-${Math.floor(next() * 1e9).toString(36)}`,
      startedAt: started.getTime(),
      finishedAt: started.getTime() + activeMs * finishedFraction + pausedMs,
      state,
      kind: source.live ? "hls" : ["hls", "hls", "dash", "mp4"][Math.floor(next() * 4)],
      method: "stream",
      mode: next() < 0.07 ? "audio" : "both",
      live: Boolean(source.live),
      bytes: Math.round(bytes * finishedFraction),
      received: Math.round(bytes * finishedFraction * 1.01),
      mediaDuration: Math.round(mediaDuration),
      elapsedMs: Math.round(activeMs * finishedFraction + pausedMs),
      activeMs: Math.round(activeMs * finishedFraction),
      avgSpeed: Math.round(avgSpeed),
      peakSpeed: Math.round(avgSpeed * (1.3 + next() * 0.5)),
      height,
      codecs: "avc+aac",
      container: "mp4",
      fps: [24, 25, 29.97, 30, 60][Math.floor(next() * 5)],
      concurrency,
      concurrencyAuto: next() < 0.6,
      errorCode,
      samples: { interval, values },
      title: source.titles[Math.floor(next() * source.titles.length)],
      site: source.site,
      pageUrl: `https://www.${source.site}/watch/${index}`,
      filename: `${source.titles[0]}.mp4`,
      mediaHost: `media.${source.site}`,
      errorMessage: errorCode === "expired" ? "The server returned HTTP 403. Reload the video page, press play and try the fresh link." : errorCode === "network" ? "Failed to fetch" : ""
    });
  }
  return entries;
}
