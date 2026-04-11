/**
 * KaiTalk Service Worker
 *
 * 策略：
 *   - 靜態資源（HTML/CSS/JS/圖片）→ Cache First, network fallback
 *   - API 請求 → Network First, 不快取
 *   - Socket.IO / WebRTC → 不攔截
 */

const CACHE_NAME = 'kaitalk-v1';

// 預快取的核心檔案
const PRECACHE_URLS = [
  '/',
  '/main.js',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png',
  '/apple-touch-icon.png',
  '/favicon-32.png',
];

// Install: 預快取核心檔案
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(PRECACHE_URLS);
    }).then(() => self.skipWaiting())
  );
});

// Activate: 清理舊版快取
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      );
    }).then(() => self.clients.claim())
  );
});

// Fetch: 根據請求類型選策略
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // 不攔截：API、Socket.IO、WebSocket、外部 CDN
  if (
    url.pathname.startsWith('/api/') ||
    url.pathname.startsWith('/socket.io/') ||
    url.pathname.startsWith('/config.json') ||
    event.request.url.includes('socket.io') ||
    event.request.url.includes('supabase') ||
    event.request.url.includes('cdn.') ||
    event.request.url.includes('cdnjs.') ||
    event.request.url.startsWith('ws')
  ) {
    return; // 讓瀏覽器正常處理
  }

  // 靜態資源：Cache First → Network Fallback
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) {
        // 背景更新快取（stale-while-revalidate）
        fetch(event.request).then((response) => {
          if (response && response.ok) {
            caches.open(CACHE_NAME).then((cache) => {
              cache.put(event.request, response);
            });
          }
        }).catch(() => {});
        return cached;
      }

      return fetch(event.request).then((response) => {
        // 只快取成功的 GET 請求
        if (response && response.ok && event.request.method === 'GET') {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, clone);
          });
        }
        return response;
      }).catch(() => {
        // 離線且沒快取 → 回首頁
        if (event.request.mode === 'navigate') {
          return caches.match('/');
        }
      });
    })
  );
});
