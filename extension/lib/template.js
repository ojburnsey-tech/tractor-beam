// Filename templates, e.g. "{site} – {title} – {quality}".
// Shared so the website can preview exactly what the extension will produce.

export const DEFAULT_TEMPLATE = "{title}";

export const TEMPLATE_TOKENS = [
  { token: "{title}", label: "Title", example: "Northern Lights Timelapse" },
  { token: "{site}", label: "Site", example: "vimeo.com" },
  { token: "{quality}", label: "Quality", example: "1080p" },
  { token: "{date}", label: "Date", example: "2026-10-31" },
  { token: "{time}", label: "Time", example: "21.40" },
  { token: "{type}", label: "Type", example: "HLS" }
];

const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:[ .]|$)/i;

/** Makes a string safe as a file name on Windows, macOS and Linux. */
export function sanitizeFilename(name) {
  let value = String(name || "")
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
    .replace(/\s+/g, " ")
    .replace(/[. ]+$/g, "")
    .trim()
    .slice(0, 140);
  if (RESERVED.test(value)) value = `_${value}`;
  return value;
}

function pad(value) {
  return String(value).padStart(2, "0");
}

/**
 * Renders a template to a base filename (no extension). Tokens with no value
 * are removed along with the separator that preceded them, so
 * "{title} – {quality}" with no quality becomes just the title.
 */
export function renderFilename(template, values = {}, now = new Date()) {
  const source = String(template || DEFAULT_TEMPLATE).slice(0, 200);
  const data = {
    title: values.title || "",
    site: values.site || "",
    quality: values.quality || "",
    date: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`,
    time: `${pad(now.getHours())}.${pad(now.getMinutes())}`,
    type: values.type ? String(values.type).toUpperCase() : ""
  };
  const rendered = source
    .replace(/(\s*[-–—_·|,]\s*)?\{(\w+)\}/g, (match, separator = "", name) => {
      const value = Object.hasOwn(data, name) ? data[name] : match;
      return value ? `${separator}${value}` : "";
    })
    .replace(/^\s*[-–—_·|,]\s*/, "");
  return sanitizeFilename(rendered) || sanitizeFilename(data.title) || "video";
}
