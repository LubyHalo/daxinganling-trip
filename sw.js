/* 离线优先的 Service Worker。
   策略：同源 GET 一律「先给缓存、后台顺手更新」（stale-while-revalidate）——
   在草原上打开是瞬时的；有网时下一次打开会拿到新版本，并被界面提示"有新版本"。*/

const VERSION = 'v1';
const CACHE = `dtrip-${VERSION}`;

const ASSETS = [
  './',
  './index.html',
  './app.css',
  './app/main.js',
  './app/ui.js',
  './app/render.js',
  './app/core.js',
  './app/store.js',
  './data/trip.json',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(ASSETS.map((u) => new Request(u, { cache: 'reload' }))))
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // 导航请求：离线时也要能直接打开
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);
      const cached = (await cache.match('./index.html')) || (await cache.match('./'));
      const network = fetch(req).then((res) => {
        if (res && res.ok) cache.put('./index.html', res.clone());
        return res;
      }).catch(() => null);
      return cached || (await network) || Response.error();
    })());
    return;
  }

  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(req);
    const network = fetch(req).then((res) => {
      if (res && res.ok && res.type === 'basic') cache.put(req, res.clone());
      return res;
    }).catch(() => null);
    return cached || (await network) || new Response('离线且没有缓存', { status: 504, statusText: 'Offline' });
  })());
});
