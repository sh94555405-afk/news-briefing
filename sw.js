/**
 * Service Worker - 일일 뉴스 브리핑 PWA
 * - 앱 셸(HTML/CSS/JS) 캐시: cache-first 전략
 * - RSS 피드: network-first, 실패 시 캐시 폴백
 * - 6시간마다 백그라운드 동기화(periodic sync 미지원 시 fetch 시 갱신)
 */

const CACHE_VERSION = 'v1.2';
const SHELL_CACHE  = `news-shell-${CACHE_VERSION}`;
const NEWS_CACHE   = `news-feed-${CACHE_VERSION}`;

const SHELL_ASSETS = [
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './apple-touch-icon.png'
];

// ── Install ──────────────────────────────────────────────
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL_ASSETS))
  );
  self.skipWaiting();
});

// ── Activate ─────────────────────────────────────────────
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => k !== SHELL_CACHE && k !== NEWS_CACHE)
          .map((k) => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

// ── Fetch ────────────────────────────────────────────────
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // RSS 프록시 요청 → Network-first, 캐시 폴백
  if (url.pathname.includes('/rss') || url.hostname.includes('rss') ||
      url.searchParams.has('rss') || url.hostname.includes('news.google')) {
    event.respondWith(networkFirstWithCache(request, NEWS_CACHE, 6 * 60 * 60 * 1000));
    return;
  }

  // 앱 셸 → Cache-first
  if (SHELL_ASSETS.some((a) => request.url.endsWith(a.replace('./', '')))) {
    event.respondWith(cacheFirst(request, SHELL_CACHE));
    return;
  }

  // 외부 요청(CORS 프록시 포함) → Network-first
  if (url.origin !== self.location.origin) {
    event.respondWith(networkFirstWithCache(request, NEWS_CACHE, 30 * 60 * 1000));
    return;
  }

  // 나머지 → Stale-while-revalidate
  event.respondWith(staleWhileRevalidate(request, SHELL_CACHE));
});

// ── 전략 헬퍼 ────────────────────────────────────────────
async function cacheFirst(request, cacheName) {
  const cached = await caches.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) {
    const cache = await caches.open(cacheName);
    cache.put(request, response.clone());
  }
  return response;
}

async function networkFirstWithCache(request, cacheName, maxAge) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(cacheName);
      // maxAge 메타데이터를 헤더로 저장
      const headers = new Headers(response.headers);
      headers.set('sw-fetched-at', Date.now().toString());
      const cloned = new Response(await response.clone().blob(), { headers });
      cache.put(request, cloned);
    }
    return response;
  } catch {
    const cached = await caches.match(request);
    if (cached) {
      const fetchedAt = parseInt(cached.headers.get('sw-fetched-at') || '0', 10);
      if (Date.now() - fetchedAt < maxAge) return cached;
    }
    return new Response(JSON.stringify({ error: 'offline', cached: false }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  const fetchPromise = fetch(request).then((response) => {
    if (response.ok) cache.put(request, response.clone());
    return response;
  });
  return cached || fetchPromise;
}
