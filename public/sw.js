// GuideTalk minimal Service Worker
// 只做：殼骨架快取 + 跳過快取所有 API / socket / 第三方資源
const CACHE = 'guidetalk-v1';
const SHELL = ['/', '/index.html', '/main.js', '/manifest.json'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  // 只處理 GET 同源
  if (req.method !== 'GET' || url.origin !== location.origin) return;
  // socket.io / api / 房號路徑都不快取
  if (url.pathname.startsWith('/socket.io') ||
      url.pathname.startsWith('/api/') ||
      url.pathname.startsWith('/r/')) return;
  // 圖磚（OSM）不快取，由瀏覽器自行管理
  e.respondWith(
    caches.match(req).then(hit => hit || fetch(req).then(resp => {
      if (resp.ok && resp.type === 'basic') {
        const clone = resp.clone();
        caches.open(CACHE).then(c => c.put(req, clone)).catch(() => {});
      }
      return resp;
    }).catch(() => caches.match('/index.html')))
  );
});
