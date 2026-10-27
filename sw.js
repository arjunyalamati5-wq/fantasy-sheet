// Offline support. The app's own files are served from a local copy and
// refreshed in the background; league data (GET /api/...) always tries the
// network first and falls back to the last answer saved for that exact
// request, marked so the page can say it is showing saved data.
// Nothing here ever sends data anywhere; it only keeps copies of answers.

const SHELL = 'ff-shell-v5';
// The folder the app lives in: '/' locally, '/<repo>/' on GitHub Pages.
const BASE = new URL('./', self.registration.scope).pathname;
const DATA = 'ff-data-v1';

/**
 * Every file the app needs, found by following the page's stylesheets and
 * scripts and each script's imports, so the list never goes stale.
 */
async function appFiles() {
  const files = new Set([`${BASE}index.html`]);
  const queue = [];
  const html = await (await fetch(`${BASE}index.html`, { cache: 'no-store' })).text();
  for (const m of html.matchAll(/(?:href|src)="([\w./-]+\.(?:css|js))"/g)) queue.push(new URL(m[1], location.origin + BASE).pathname);
  while (queue.length) {
    const path = queue.shift();
    if (files.has(path)) continue;
    files.add(path);
    if (!path.endsWith('.js')) continue;
    const text = await (await fetch(path, { cache: 'no-store' })).text().catch(() => '');
    for (const m of text.matchAll(/(?:from|import)\s*\(?\s*['"](\.\/[\w.-]+\.js)['"]/g)) queue.push(new URL(m[1], location.origin + path).pathname);
  }
  return [...files];
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL);
    const files = await appFiles();
    await cache.addAll(files);
    await cache.put(BASE, (await cache.match(`${BASE}index.html`)).clone());
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (![SHELL, DATA].includes(key)) await caches.delete(key);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // League data: network first, saved copy when the network is gone.
  if (url.origin === location.origin && url.pathname.startsWith(`${BASE}api/`)) {
    if (/^\/api\/(clear-cache|cache|health)/.test(url.pathname)) return;
    event.respondWith((async () => {
      const cache = await caches.open(DATA);
      try {
        const res = await fetch(req);
        if (res.ok) cache.put(req, res.clone());
        return res;
      } catch (err) {
        const hit = await cache.match(req);
        if (!hit) throw err;
        const headers = new Headers(hit.headers);
        headers.set('x-ff-offline', '1');
        return new Response(await hit.blob(), { status: hit.status, headers });
      }
    })());
    return;
  }

  // The app itself and its fonts: always the server's current files when it
  // answers, so an update never runs half old and half new code; the saved
  // copy only when the network is gone.
  const sameOrigin = url.origin === location.origin;
  const fonts = /fonts\.(googleapis|gstatic)\.com$/.test(url.hostname);
  if (!sameOrigin && !fonts) return;
  event.respondWith((async () => {
    const cache = await caches.open(SHELL);
    const key = sameOrigin && (url.pathname === BASE || url.pathname === `${BASE}index.html`) ? `${BASE}index.html` : req;
    try {
      const res = await fetch(req);
      if (res.ok || res.type === 'opaque') cache.put(key, res.clone());
      return res;
    } catch {
      const hit = await cache.match(key, { ignoreSearch: sameOrigin });
      return hit || new Response('Offline, and this page has not been saved yet.', { status: 503, headers: { 'content-type': 'text/plain; charset=utf-8' } });
    }
  })());
});

// Tapping a game-day alert brings the app forward at the lineup, or opens it.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const open = all.find((c) => new URL(c.url).origin === location.origin);
    if (open) {
      await open.focus();
      if ('navigate' in open) await open.navigate(`${BASE}#lineup`).catch(() => {});
      return;
    }
    await self.clients.openWindow(`${BASE}#lineup`);
  })());
});
