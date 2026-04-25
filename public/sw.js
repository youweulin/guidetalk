// GuideTalk Service Worker
// 策略：
//   - index.html / main.js / sw.js 走 network-first（避免新版本被舊快取卡住）
//   - 其他靜態資源（icon、manifest）才用 cache-first
const CACHE = 'guidetalk-v3';   // ← 升版本即可清掉所有舊快取
const NETWORK_FIRST = ['/', '/index.html', '/main.js', '/sw.js'];

self.addEventListener('install', (e) => {
  // 不預先快取，讓使用者第一次進站直接拿最新
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

function isNetworkFirst(pathname) {
  return NETWORK_FIRST.some(p => pathname === p || pathname.startsWith('/r/'));
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  // 完全跳過 socket.io / api（不可快取）
  if (url.pathname.startsWith('/socket.io') ||
      url.pathname.startsWith('/api/')) return;

  if (isNetworkFirst(url.pathname)) {
    // network-first：先抓網路，失敗再用快取
    e.respondWith(
      fetch(req).then(resp => {
        if (resp.ok) {
          const clone = resp.clone();
          caches.open(CACHE).then(c => c.put(req, clone)).catch(() => {});
        }
        return resp;
      }).catch(() => caches.match(req).then(hit => hit || caches.match('/index.html')))
    );
    return;
  }

  // 其他資源 cache-first
  e.respondWith(
    caches.match(req).then(hit => hit || fetch(req).then(resp => {
      if (resp.ok && resp.type === 'basic') {
        const clone = resp.clone();
        caches.open(CACHE).then(c => c.put(req, clone)).catch(() => {});
      }
      return resp;
    }))
  );
});
