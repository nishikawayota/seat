const CACHE_VERSION = "v29";
const CACHE_NAME = `seat-app-${CACHE_VERSION}`;
const ASSETS = [
  "./",
  "./index.html",
  "./style.css?v=29",
  "./app.js?v=29",
  "./manifest.json?v=29",
  "./data/names.json?v=29",
  "./data/names_by_mode.json?v=29",  // ← 使っていれば残す/無ければ削ってOK
  "./data/seat_layout.json?v=29",
  "./data/seat_preset.json?v=29",
  "./sounds/drumroll.mp3?v=29",
  "./sounds/fanfare.mp3?v=29"
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME)
      .then((c) => c.addAll(ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;

  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return;

  // data配下はネット優先（失敗時にキャッシュ）
  if (url.pathname.startsWith(location.pathname.replace(/\/$/, "") + "/data/")) {
    e.respondWith(
      fetch(e.request)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((c) => c.put(e.request, copy));
          return res;
        })
        .catch(() => caches.match(e.request))
    );
    return;
  }

  // それ以外はキャッシュ優先
  e.respondWith(
    caches.match(e.request).then((res) => res || fetch(e.request))
  );
});

self.addEventListener("message", (e) => {
  if (e.data && e.data.type === "SKIP_WAITING") self.skipWaiting();
});
