// Sends "download finished / failed" alerts to every device the person
// enabled notifications on.

import { sendPush } from "./webpush.js";
import { formatSize, formatClock } from "../shared/format.js";
import { userSettings } from "./routes/common.js";

const FRESH_MS = 15 * 60 * 1000;

export function notificationFor(entry) {
  const name = entry.notify_title;
  const size = formatSize(entry.bytes || 0);
  const took = entry.elapsed_ms ? formatClock(entry.elapsed_ms / 1000) : null;
  if (entry.state === "failed") {
    return { title: "Download failed", body: name ? `${name} didn't finish. Open the Library to see why.` : "A download didn't finish. Open the Library to see why." };
  }
  const title = entry.state === "partial" ? "Recording saved" : "Download finished";
  const detail = took ? `${size} in ${took}` : size;
  return { title, body: name ? `${name} · ${detail}` : detail };
}

/** True when this entry deserves an alert under the person's settings. */
export function shouldNotify(entry, user, now = Date.now()) {
  if (!["done", "partial", "failed"].includes(entry.state)) return false;
  if (!entry.finished_at || now - entry.finished_at > FRESH_MS) return false;
  const settings = userSettings(user);
  return entry.state === "failed" ? settings.notifyFailed : settings.notifyFinished;
}

export async function notifyUser(db, deps, userId, message) {
  const subscriptions = db.prepare("SELECT * FROM push_subscriptions WHERE user_id = ?").all(userId);
  let sent = 0;
  await Promise.all(subscriptions.map(async (subscription) => {
    const result = await sendPush(subscription, message, { vapid: deps.vapid, subject: deps.config.vapidSubject });
    if (result.ok) sent += 1;
    if (result.gone) db.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?").run(subscription.endpoint);
  }));
  return { sent, total: subscriptions.length };
}
