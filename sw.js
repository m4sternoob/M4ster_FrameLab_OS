/* m4ster FrameLab service worker — offline cache, network-first for code
 * (test builds change often: a cache-first CSS/JS means visitors keep an
 * old build forever — screenshots on 2026-10-20 showed a fixed bug
 * returning because the old stylesheet was served from this cache).
 *
 * Fetch rules (v6):
 * - Only same-origin GET requests are intercepted. Cross-origin traffic
 *   (Hugging Face spaces, AI Horde, CDNs) goes straight to the network —
 *   the worker never touches it, so a queue stream or a model download
 *   behaves exactly as the provider sent it.
 * - Same-origin GETs are network-first; a copy is cached only for small
 *   app files (never .onnx / .glb / .wasm payloads, never anything over
 *   6 MB), so the cache cannot fill with generated meshes and models.
 * - On a network failure, page navigations fall back to the cached app
 *   shell; every other request fails loudly instead of being answered
 *   with HTML it never asked for. */
var CACHE = "framelab-v6";
var ASSETS = [
  "/", "/index.html",
  "/css/style.css", "/js/app.js",
  "/manifest.json",
  "/icons/icon-192.png", "/icons/icon-512.png", "/icons/maskable-512.png", "/icons/apple-touch-icon.png",
  "/logo-mf.svg"
];
var CACHE_MAX_BYTES = 6 * 1024 * 1024;
var CACHE_SKIP_EXT = [".onnx", ".glb", ".wasm"];
self.addEventListener("install", function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(ASSETS); }).then(function () { return self.skipWaiting(); }));
});
self.addEventListener("activate", function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});
self.addEventListener("fetch", function (e) {
  if (e.request.method !== "GET") return;
  var url;
  try { url = new URL(e.request.url); } catch (err) { return; }
  if (url.origin !== self.location.origin) return; /* cross-origin: hands off */
  e.respondWith(fetch(e.request).then(function (res) {
    if (res.status === 200 && cacheable(url, res)) {
      var copy = res.clone();
      caches.open(CACHE).then(function (c) { c.put(e.request, copy); });
    }
    return res;
  }).catch(function (err) {
    if (e.request.mode === "navigate") {
      return caches.match(e.request).then(function (hit) { return hit || caches.match("/index.html"); });
    }
    return caches.match(e.request).then(function (hit) {
      if (hit) return hit;
      throw err; /* a data request gets a real failure, never the app shell */
    });
  }));
});
function cacheable(url, res) {
  var path = url.pathname.toLowerCase();
  for (var i = 0; i < CACHE_SKIP_EXT.length; i++) {
    if (path.slice(-CACHE_SKIP_EXT[i].length) === CACHE_SKIP_EXT[i]) return false;
  }
  var len = parseInt(res.headers.get("Content-Length") || "", 10);
  if (!isNaN(len) && len > CACHE_MAX_BYTES) return false;
  return true;
}
