// Turns raw download errors into a plain explanation and a next step.
// The extension classifies an error into a code when it happens; the code is
// stored in history in the clear (it reveals nothing about what was
// downloaded) and both sides render it with `explain()`.

const RULES = [
  { code: "drm", test: /\b(drm|protected|encrypted media|widevine|fairplay|playready|eme)\b/i },
  { code: "cancelled", test: /\b(cancel+ed|aborterror|the user aborted)\b/i },
  { code: "expired", test: /HTTP (401|403|410)\b|fresh link|expired/i },
  { code: "not-found", test: /HTTP 404\b/ },
  { code: "rate-limited", test: /HTTP 429\b/ },
  { code: "server", test: /HTTP 5\d\d\b/ },
  { code: "timeout", test: /stopped responding|timed? ?out/i },
  { code: "network", test: /failed to fetch|network|connection (interrupted|reset|refused)|err_/i },
  { code: "web-page", test: /this is a web page/i },
  { code: "fragment", test: /individual fragment|master playlist rather|select the master playlist|no complete media track/i },
  { code: "no-audio", test: /no audio track/i },
  { code: "mismatch", test: /different lengths/i },
  { code: "codec", test: /codec|(cannot|could not) be copied|output container/i },
  { code: "incomplete", test: /ended before the playlist|reached the end/i },
  { code: "live-changed", test: /live (dash )?(track selection|representation) changed|repeated a packet/i },
  { code: "live-empty", test: /recording stopped before every selected track/i },
  { code: "too-large", test: /too large|too many nested/i },
  { code: "disk", test: /quota|not enough space|disk|no space|NotReadableError|InvalidStateError.*writ/i },
  { code: "permission", test: /NotAllowedError|permission/i },
  { code: "browser", test: /cannot save directly to disk|update chrome/i }
];

const EXPLANATIONS = {
  drm: {
    title: "This video is copy-protected",
    detail: "The site encrypts it with DRM, which only its own player can decode.",
    fix: "There's no way to save protected video. Use the site's own download option if it has one."
  },
  cancelled: {
    title: "You cancelled this download",
    detail: "The download stopped before it finished, and the partial file was removed.",
    fix: "Open the video page again and start a new download."
  },
  expired: {
    title: "The video link expired",
    detail: "Streaming sites issue short-lived links. This one stopped working before the download finished.",
    fix: "Reload the video page, press play, then start the download again from the popup."
  },
  "not-found": {
    title: "The video is no longer there",
    detail: "The server said the file doesn't exist. It may have been removed or moved.",
    fix: "Reload the video page and try again. If it still fails, the video was taken down."
  },
  "rate-limited": {
    title: "The site slowed you down",
    detail: "The server refused requests because too many arrived at once.",
    fix: "Wait a minute, then try again with fewer parallel connections (1 or 3)."
  },
  server: {
    title: "The video server had a problem",
    detail: "The site's server returned an error. This is usually temporary.",
    fix: "Try again in a few minutes."
  },
  timeout: {
    title: "The server stopped responding",
    detail: "No data arrived for 45 seconds, so the download gave up.",
    fix: "Check your connection and try again. Fewer parallel connections can help on slow networks."
  },
  network: {
    title: "Your connection dropped",
    detail: "The download lost its network connection and couldn't recover after several retries.",
    fix: "Check you're online, then start the download again."
  },
  "web-page": {
    title: "That link is a web page, not a video",
    detail: "The link you pasted opens a page instead of a video file or playlist.",
    fix: "Open the page, press play, and choose the video from the MP4 Grabber popup instead."
  },
  fragment: {
    title: "Only a piece of the video was selected",
    detail: "This link points to one short segment of a stream, not the whole video.",
    fix: "Choose the item marked HLS or DASH stream in the popup. It contains the complete video."
  },
  "no-audio": {
    title: "No sound track was found",
    detail: "The stream's video and audio are stored separately, and the audio wasn't detected.",
    fix: "Choose the master playlist, or paste the matching audio link under Separate audio."
  },
  mismatch: {
    title: "The sound and picture don't match",
    detail: "The audio and video tracks have different lengths, so they can't be joined safely.",
    fix: "Choose the full-length playlist for both, usually the master playlist."
  },
  codec: {
    title: "This format can't be saved as-is",
    detail: "The video uses a codec that can't be copied into a standard file without re-encoding.",
    fix: "Try a different quality. Other qualities often use a more common codec."
  },
  incomplete: {
    title: "The video stopped early",
    detail: "A track ended before the playlist said it would, so the file would have been incomplete.",
    fix: "Try again. If it keeps happening, the stream itself is incomplete."
  },
  "live-changed": {
    title: "The live stream changed mid-recording",
    detail: "The broadcaster switched track layout, which breaks a continuous recording.",
    fix: "Start a new recording from the popup."
  },
  "live-empty": {
    title: "The recording captured nothing",
    detail: "It stopped before both sound and picture had started arriving.",
    fix: "Let the live stream play for a few seconds, then record again."
  },
  "too-large": {
    title: "The playlist is too large",
    detail: "The playlist is bigger than MP4 Grabber can safely process.",
    fix: "Choose a specific quality's playlist rather than the master playlist."
  },
  disk: {
    title: "The file couldn't be written",
    detail: "Your disk may be full, or the save location became unavailable.",
    fix: "Free up space or choose another folder, then try again."
  },
  permission: {
    title: "Chrome couldn't save to that location",
    detail: "Permission to write the file was refused.",
    fix: "Try again and choose a folder you own, such as Downloads."
  },
  browser: {
    title: "Chrome needs updating",
    detail: "This version of Chrome can't write large files directly to disk.",
    fix: "Update Chrome, then try again."
  },
  unknown: {
    title: "The download failed",
    detail: "Something unexpected went wrong.",
    fix: "Reload the video page and try again."
  }
};

export function classifyError(message, context = {}) {
  if (context.protected) return "drm";
  const text = String(message?.name ? `${message.name}: ${message.message}` : message || "");
  return RULES.find((rule) => rule.test.test(text))?.code || "unknown";
}

export function explain(code) {
  return EXPLANATIONS[code] || EXPLANATIONS.unknown;
}

export const ERROR_CODES = Object.keys(EXPLANATIONS);
