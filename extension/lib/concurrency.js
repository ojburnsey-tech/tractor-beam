// Chooses how many parallel connections to use for a site, from past speeds.
// Used by the extension to pick the setting and by the website to explain it.

export const LEVELS = [1, 3, 6];
export const DEFAULT_LEVEL = 3;
const MIN_BYTES = 20e6;      // small downloads finish before speed settles
const MIN_ACTIVE_MS = 10e3;
const TIE_MARGIN = 0.08;     // a lower level within 8% of the best wins

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** Entries that say something reliable about a level's speed on a site. */
export function usableSamples(entries, site) {
  return entries.filter((entry) =>
    entry.site === site &&
    entry.method !== "original" &&
    entry.state === "done" &&
    LEVELS.includes(Number(entry.concurrency)) &&
    entry.bytes >= MIN_BYTES &&
    entry.activeMs >= MIN_ACTIVE_MS &&
    entry.avgSpeed > 0
  );
}

/**
 * Returns { level, reason, basis } where basis maps each tried level to
 * { median, count }. `reason` is a short sentence for the interface.
 */
export function recommendConcurrency(entries, site) {
  const samples = usableSamples(entries, site);
  const basis = {};
  for (const level of LEVELS) {
    const speeds = samples.filter((entry) => Number(entry.concurrency) === level).map((entry) => entry.avgSpeed);
    if (speeds.length) basis[level] = { median: median(speeds), count: speeds.length };
  }
  const tried = LEVELS.filter((level) => basis[level]);
  if (!tried.length) {
    return { level: DEFAULT_LEVEL, reason: "No downloads from this site yet, so the balanced setting is used.", basis, exploring: false };
  }

  let best = tried[0];
  for (const level of tried) if (basis[level].median > basis[best].median) best = level;
  // Prefer the gentlest level that is practically as fast.
  for (const level of tried) {
    if (level < best && basis[level].median >= basis[best].median * (1 - TIE_MARGIN)) { best = level; break; }
  }

  const higher = LEVELS.find((level) => level > best && !basis[level]);
  const highestTried = Math.max(...tried);
  if (higher && best === highestTried) {
    return {
      level: higher,
      reason: `Trying ${higher} once to see if it beats ${best} on this site.`,
      basis,
      exploring: true
    };
  }
  const runnerUp = tried.filter((level) => level !== best).sort((a, b) => basis[b].median - basis[a].median)[0];
  const reason = runnerUp
    ? `${best} has been fastest here (${(basis[best].median / 1e6).toFixed(1)} MB/s vs ${(basis[runnerUp].median / 1e6).toFixed(1)} MB/s with ${runnerUp}).`
    : `${best} works well here (${(basis[best].median / 1e6).toFixed(1)} MB/s).`;
  return { level: best, reason, basis, exploring: false };
}
