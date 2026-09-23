/* Offline-Cache für LagerBuddy (Muster wie MeinMoney). Scans und Listen liegen in localStorage, nicht hier. */
const CACHE = 'lagerbuddy-v2'; // neuer Name räumt beim Aktivieren alte Stände weg
const SHELL = ['./', './index.html', './manifest.webmanifest', './icon-192.png', './icon-512.png', './icon.svg'];

// Eigene Dateien immer am GitHub-Pages-CDN vorbei holen (?sw= macht die URL einmalig): das CDN liefert nach
// einem Deploy bis zu 10 Min. die alte index.html, app.js?v=alt aber schon mit NEUEM Inhalt (Query wird ignoriert).
// Landet dieses Paar im Offline-Speicher, sucht der neue Code Knöpfe, die die alte Seite nicht hat -> Absturz.
const bust = u => { const x = new URL(u, location.href); x.searchParams.set('sw', Date.now()); return x; };
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => Promise.all(SHELL.map(u => fetch(bust(u), { cache: 'no-store' })
    .then(r => { if (!r.ok) throw new Error('Laden fehlgeschlagen: ' + u); return c.put(u, r); }))))
    .then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

const put = (req, res) => { if (res && res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); } return res; };

/* vendor/ (Barcode, Texterkennung, Excel, ~11 MB): Cache zuerst, damit sie nicht bei jedem Start geladen werden
   und im Lager auch ohne Empfang funktionieren. Eigene App-Dateien: sofort aus dem Cache, im Hintergrund
   die neueste holen (stale-while-revalidate). ?nocache = Update-Prüfung, immer direkt vom Server. */
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin) return;
  if (u.searchParams.has('nocache')) return;
  if (u.pathname.includes('/vendor/')) {
    e.respondWith(caches.match(e.request).then(hit => hit || fetch(e.request).then(r => put(e.request, r))));
    return;
  }
  e.respondWith(
    caches.match(e.request).then(cached => {
      const fresh = fetch(bust(e.request.url), { cache: 'no-store' }).then(r => put(e.request, r)).catch(() => cached || caches.match('./index.html'));
      if (cached) { e.waitUntil(fresh.catch(() => {})); return cached; }
      return fresh;
    })
  );
});
