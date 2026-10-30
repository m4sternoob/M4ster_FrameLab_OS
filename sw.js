/* m4ster FrameLab service worker — offline cache, network-first for code
 * (test builds change often: a cache-first CSS/JS means visitors keep an
 * old build forever — screenshots on 2026-10-20 showed a fixed bug
 * returning because the old stylesheet was served from this cache). */
var CACHE = "framelab-v5";
var ASSETS = [
  "/", "/index.html",
  "/css/style.css", "/js/app.js",
  "/manifest.json",
  "/icons/icon-192.png", "/icons/icon-512.png", "/icons/maskable-512.png", "/icons/apple-touch-icon.png",
  "/logo-mf.svg"
];
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
  e.respondWith(fetch(e.request).then(function (res) {
    var copy = res.clone();
    caches.open(CACHE).then(function (c) { c.put(e.request, copy); });
    return res;
  }).catch(function () {
    return caches.match(e.request).then(function (hit) { return hit || caches.match("/index.html"); });
  }));
});
