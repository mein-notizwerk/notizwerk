// Offline-Unterstützung: App-Dateien werden zwischengespeichert, Netzwerk hat Vorrang.
const CACHE = 'notizwerk-v10';
const FILES = ['./', 'index.html', 'style.css', 'app.js', 'extras.js', 'sync.js', 'config.js', 'icon.svg', 'icon-180.png', 'manifest.webmanifest'];
self.addEventListener('install', e => e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting())));
self.addEventListener('activate', e => e.waitUntil(
  caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE && k !== 'notizwerk-libs').map(k => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  if (u.hostname === 'cdnjs.cloudflare.com') { // Bibliotheken für PDF und Formeln: einmal laden, dann auch offline
    e.respondWith(caches.open('notizwerk-libs').then(async c => (await c.match(e.request)) || fetch(e.request).then(r => { if (r.ok) c.put(e.request, r.clone()); return r; })));
    return;
  }
  if (u.origin !== location.origin) return;
  e.respondWith((async () => {
    const c = await caches.open(CACHE);
    try {
      const r = await fetch(e.request, { cache: 'no-cache' });
      if (r.ok) c.put(e.request, r.clone());
      return r;
    } catch {
      return (await c.match(e.request, { ignoreSearch: true })) || (await c.match('index.html')) || Response.error();
    }
  })());
});
