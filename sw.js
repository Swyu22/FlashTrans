/* FlashTrans Service Worker：网络优先、缓存兜底（离线可打开界面）；API 请求一律直连不缓存 */
const CACHE = "flashtrans-v4";
const ASSETS = ["./", "index.html", "style.css", "app.js", "manifest.json", "recorder-worklet.js"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== self.location.origin) return;
  // 网络优先：拿到新响应就更新缓存；网络失败时回退缓存（离线可用）
  e.respondWith(
    fetch(e.request)
      .then((resp) => {
        // 只缓存成功响应，避免把 404/500 固化进缓存
        if (resp.ok) {
          const copy = resp.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return resp;
      })
      .catch(async () => {
        const hit = await caches.match(e.request);
        if (hit) return hit;
        // 导航请求离线回退到首页；其余给受控错误
        if (e.request.mode === "navigate") {
          const home = await caches.match("./");
          if (home) return home;
        }
        return Response.error();
      })
  );
});
