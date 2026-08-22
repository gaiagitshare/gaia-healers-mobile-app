/* Gaia — event push notifications (Web Push / VAPID).
 * Multi-event: subscribes per event the attendee opens; a targeted admin send
 * only reaches subscriptions whose attendee is in that event.
 * iOS delivers web push only for an INSTALLED PWA (Add to Home Screen, iOS
 * 16.4+); Android and desktop Chrome work in-browser. */
(function () {
  "use strict";

  function proxyBase() {
    return String((window.GAIA_SYNC && window.GAIA_SYNC.proxyBase)
      || (window.GAIA_APP_URLS && window.GAIA_APP_URLS.production && window.GAIA_APP_URLS.production.proxy)
      || "https://api.gaiahealers.app").replace(/\/+$/, "");
  }

  function supported() {
    return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
  }

  function urlB64ToUint8(base64) {
    const pad = "=".repeat((4 - (base64.length % 4)) % 4);
    const b64 = (base64 + pad).replace(/-/g, "+").replace(/_/g, "/");
    const raw = atob(b64);
    const out = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
    return out;
  }

  async function vapidKey() {
    try {
      const r = await fetch(proxyBase() + "/api/events/push/vapid-key");
      const d = await r.json().catch(function () { return {}; });
      return d && d.ok && d.key ? d.key : "";
    } catch (e) { return ""; }
  }

  async function isSubscribed() {
    if (!supported()) return false;
    try {
      const reg = await navigator.serviceWorker.ready;
      return !!(await reg.pushManager.getSubscription());
    } catch (e) { return false; }
  }

  async function enable(eventId) {
    if (!supported()) return { ok: false, reason: "unsupported" };
    if (Notification.permission === "denied") return { ok: false, reason: "denied" };
    const perm = await Notification.requestPermission();
    if (perm !== "granted") return { ok: false, reason: "denied" };
    const key = await vapidKey();
    if (!key) return { ok: false, reason: "not_configured" };
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToUint8(key) });
    }
    const r = await fetch(proxyBase() + "/api/events/" + encodeURIComponent(eventId) + "/push/subscribe", {
      method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ subscription: sub.toJSON() }),
    });
    const d = await r.json().catch(function () { return {}; });
    return d && d.ok ? { ok: true } : { ok: false, reason: (d && d.reason) || "subscribe_failed" };
  }

  async function disable(eventId) {
    if (!supported()) return { ok: true };
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        const endpoint = sub.endpoint;
        await fetch(proxyBase() + "/api/events/" + encodeURIComponent(eventId) + "/push/unsubscribe", {
          method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ endpoint: endpoint }),
        }).catch(function () {});
        await sub.unsubscribe().catch(function () {});
      }
    } catch (e) { /* best effort */ }
    return { ok: true };
  }

  window.GaiaPush = { supported: supported, isSubscribed: isSubscribed, enable: enable, disable: disable };
})();
