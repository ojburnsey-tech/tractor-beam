// Web Push for "download finished" alerts on this device.

import { get, post, del } from "./api.js";
import { fromBase64Url } from "/shared/vault.js";

const isIos = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const isStandalone = () => matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;

/** { supported, reason } — reason explains what's missing in plain words. */
export function pushSupport() {
  if (!window.isSecureContext) return { supported: false, reason: "Notifications need your Library to be served over HTTPS (or opened at localhost)." };
  if (isIos() && !isStandalone()) return { supported: false, reason: "On iPhone and iPad, add this site to your Home Screen first (Share → Add to Home Screen), then open it from there." };
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) {
    return { supported: false, reason: "This browser doesn't support web notifications." };
  }
  if (Notification.permission === "denied") return { supported: false, reason: "Notifications are blocked for this site. Allow them in your browser's site settings, then try again." };
  return { supported: true, reason: "" };
}

function deviceLabel() {
  const ua = navigator.userAgent;
  if (/iphone/i.test(ua)) return "iPhone";
  if (/ipad/i.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)) return "iPad";
  if (/android/i.test(ua)) return "Android";
  if (/mac/i.test(navigator.platform)) return "Mac";
  if (/win/i.test(navigator.platform)) return "Windows PC";
  return "This device";
}

async function registration() {
  return navigator.serviceWorker.register("/sw.js", { scope: "/" });
}

export async function currentSubscription() {
  if (!pushSupport().supported && Notification?.permission !== "granted") return null;
  try {
    const existing = await navigator.serviceWorker.getRegistration("/");
    return (await existing?.pushManager.getSubscription()) || null;
  } catch {
    return null;
  }
}

export async function enablePush() {
  const support = pushSupport();
  if (!support.supported) throw new Error(support.reason);
  const permission = await Notification.requestPermission();
  if (permission !== "granted") throw new Error("Notifications weren't allowed. You can change this in your browser's site settings.");
  const ready = await registration();
  await navigator.serviceWorker.ready;
  const { publicKey } = await get("/api/push/key");
  let subscription = await ready.pushManager.getSubscription();
  if (!subscription) {
    subscription = await ready.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: fromBase64Url(publicKey) });
  }
  await post("/api/push/subscriptions", { subscription: subscription.toJSON(), label: deviceLabel() });
  return subscription;
}

export async function disablePush() {
  const subscription = await currentSubscription();
  if (!subscription) return;
  await del("/api/push/subscriptions", { endpoint: subscription.endpoint }).catch(() => {});
  await subscription.unsubscribe();
}

export function sendTest() {
  return post("/api/push/test");
}
