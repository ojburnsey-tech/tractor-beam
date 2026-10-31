// Formatting shared by the website and the extension.
// Sizes use decimal units (1 GB = 1000³ bytes), matching macOS and iOS.

const SIZE_UNITS = ["bytes", "KB", "MB", "GB", "TB"];

export function formatSize(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 KB";
  if (bytes < 1000) return `${Math.round(bytes)} bytes`;
  const index = Math.min(Math.floor(Math.log10(bytes) / 3), SIZE_UNITS.length - 1);
  const value = bytes / 1000 ** index;
  return `${value >= 100 || index === 1 ? Math.round(value) : value.toFixed(1)} ${SIZE_UNITS[index]}`;
}

/** Speed in bytes per second → "7.3 MB/s". */
export function formatSpeed(bytesPerSecond) {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return "0 KB/s";
  return `${formatSize(bytesPerSecond).replace(" bytes", " B")}/s`;
}

/** Splits a speed into a number and unit for display with a fixed unit. */
export function speedIn(bytesPerSecond, unit = "MB") {
  const divisor = { KB: 1e3, MB: 1e6, GB: 1e9 }[unit];
  return (bytesPerSecond || 0) / divisor;
}

/** Media length or elapsed time: 75 → "1:15", 3725 → "1:02:05". */
export function formatClock(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "–";
  const total = Math.round(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor(total / 60) % 60;
  const secs = String(total % 60).padStart(2, "0");
  return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${secs}` : `${minutes}:${secs}`;
}

/** Remaining time in words: "About 3 minutes left". */
export function formatRemaining(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "";
  if (seconds < 10) return "Almost done";
  if (seconds < 60) return "Less than a minute left";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `About ${minutes} minute${minutes === 1 ? "" : "s"} left`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return `About ${hours} hr${rest ? ` ${rest} min` : ""} left`;
}

/** Long durations in words: "2 hr 14 min", "48 sec". */
export function formatDurationWords(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0 sec";
  if (seconds < 60) return `${Math.round(seconds)} sec`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} hr ${rest} min` : `${hours} hr`;
}

export function formatCount(value) {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(value || 0);
}

export function formatPercent(fraction, digits = 0) {
  if (!Number.isFinite(fraction)) return "–";
  return `${(fraction * 100).toFixed(digits)}%`;
}

export function qualityLabel(height) {
  if (!height) return "";
  if (height >= 2160) return "4K";
  return `${height}p`;
}

const KIND_LABELS = {
  hls: "HLS stream",
  dash: "DASH stream",
  mp4: "MP4 file",
  webm: "WebM file",
  mkv: "MKV file",
  mov: "MOV file",
  audio: "Audio file",
  unknown: "Media file"
};

export function kindLabel(kind) {
  return KIND_LABELS[kind] || "Media file";
}

export function stateLabel(state) {
  return { done: "Saved", partial: "Saved early", failed: "Failed", cancelled: "Cancelled" }[state] || state;
}
