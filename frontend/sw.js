// Service worker: keeps the app shell available offline. The API, reports and anything
// signed-in are never cached; only the app's own static files are.
const CACHE = "saleshub-shell-v1";
const SHELL = ["./", "index.html", "styles.css", "manifest.webmanifest", "icons/icon-192.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);
  // Only same-origin GETs for the app's static files. API calls go straight to the network.
  if (req.method !== "GET" || url.origin !== location.origin) return;
  if (/^\/(auth|records|notes|cards|catalog|compare|analysis|leads|reports|finder|coach|health)(\/|$)/.test(url.pathname)) return;
  // Network first, so a deploy shows up immediately; the cached copy is the offline fallback.
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok && res.type === "basic") {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req).then((hit) => hit || (req.mode === "navigate" ? caches.match("index.html") : Response.error())))
  );
});
