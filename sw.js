// Service Worker: App offline verfügbar machen.
// Bei jeder Änderung an den App-Dateien VERSION erhöhen.
const VERSION = 'v90';
const APP = 'rp-app-' + VERSION;
const LIB = 'rp-lib-v1';     // Firebase-SDK und Schriften (versioniert, ändern sich nicht)
const TILES = 'rp-tiles-v1';
const PLACES = 'rp-places-v1'; // Ortsliste (GeoNames) für die Offline-Suche, wird im Hintergrund geladen // Kartenkacheln (v1: CARTO mit Wasserzeichen, v2: undurchsichtige Antworten)
const TILE_MAX = 3000;

const SHELL = ['./', 'app.js', 'firebase-config.js', 'manifest.webmanifest', 'mapgen.js', 'world.json', 'wizard.js', 'editor.js', 'tzlookup.js', 'airports.txt', 'tripcheck.js',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png'];
const SDK = ['app', 'auth', 'firestore', 'storage', 'app-check'].map(n => `https://www.gstatic.com/firebasejs/10.14.1/firebase-${n}-compat.js`);

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const c = await caches.open(APP);
    await c.addAll(SHELL.map(u => new Request(u, { cache: 'reload' })));
    const l = await caches.open(LIB);
    await Promise.all(SDK.map(u => l.match(u).then(h => h || fetch(u, { mode: 'cors', credentials: 'omit' }).then(r => r.ok && l.put(u, r)).catch(() => {}))));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys())
      if (k.startsWith('rp-') && ![APP, LIB, TILES, PLACES].includes(k)) await caches.delete(k);
    await self.clients.claim();
  })());
});

// Gespeicherte Version sofort liefern, im Hintergrund aktualisieren ("stale-while-revalidate").
// So startet die App auch bei schlechtem Netz sofort. Hat sich etwas geändert, bekommt die Seite eine Nachricht
// und bietet „Neu laden“ an. Ohne gespeicherte Version (erster Start) wird normal aus dem Netz geladen.
async function swr(req, key, ev) {
  const c = await caches.open(APP);
  const h = await c.match(key);
  const net = fetch(req.url.split('#')[0], { cache: 'no-store', credentials: 'same-origin' }).then(async r => {
    if (!r || !r.ok) return r;
    const b = await r.blob();
    const res = new Response(b, { status: r.status, statusText: r.statusText, headers: r.headers });
    let changed = false;
    if (h) { try { const old = await h.clone().text(), neu = await b.text(); changed = old !== neu; } catch (e) {} }
    await c.put(key, res.clone());
    if (changed) (await self.clients.matchAll()).forEach(cl => cl.postMessage({ type: 'rp-update', file: key }));
    return res;
  });
  if (!h) return net;
  if (ev) ev.waitUntil(net.catch(() => {}));
  return h;
}

// Fremde Dateien per CORS holen: "undurchsichtige" Antworten belegen im Browser-Speicher je mehrere MB.
async function cacheFirst(req, name, trim) {
  const c = await caches.open(name);
  const h = await c.match(req.url);
  if (h) return h;
  let r;
  try { r = await fetch(req.url, { mode: 'cors', credentials: 'omit' }); } catch (e) { r = null; }
  if (!r || !r.ok) return fetch(req);
  if (r.ok) {
    c.put(req.url, r.clone());
    if (trim) trimCache(c);
  }
  return r;
}

let trimming = false;
async function trimCache(c) {
  if (trimming) return; trimming = true;
  try { const k = await c.keys(); for (let i = 0; i < k.length - TILE_MAX; i++) await c.delete(k[i]); } finally { trimming = false; }
}

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const u = new URL(req.url);

  if (u.origin === location.origin) {
    if (req.mode === 'navigate' || u.pathname.endsWith('/index.html'))
      { e.respondWith(swr(req, './', e)); return; }
    if (u.pathname.endsWith('/app.js'))
      { e.respondWith(swr(req, 'app.js', e)); return; }
    if (u.pathname.endsWith('/manifest.webmanifest'))
      return e.respondWith(fetch(req, { cache: 'no-store' }).then(r => { if (r && r.ok) caches.open(APP).then(c => c.put('manifest.webmanifest', r.clone())); return r; }).catch(() => caches.match('manifest.webmanifest')));
    { const f = u.pathname.split('/').pop(); if (['wizard.js', 'editor.js', 'mapgen.js', 'tzlookup.js'].includes(f)) return e.respondWith(swr(req, f, e)); }
    if (u.pathname.endsWith('/places.txt'))
      return e.respondWith(caches.open(PLACES).then(c => c.match('places.txt').then(h => h || fetch(req).then(r => { if (r && r.ok) c.put('places.txt', r.clone()); return r; }))));
    if (u.pathname.endsWith('/firebase-config.js'))
      return e.respondWith(swr(req, 'firebase-config.js', e));
    return e.respondWith(caches.match(req).then(h => h || fetch(req)));
  }
  if (u.hostname === 'www.gstatic.com' && u.pathname.startsWith('/firebasejs/'))
    return e.respondWith(cacheFirst(req, LIB));
  if (u.hostname === 'cdnjs.cloudflare.com' && u.pathname.startsWith('/ajax/libs/pdf.js/'))
    return e.respondWith(cacheFirst(req, LIB));
  if (u.hostname === 'fonts.googleapis.com' || u.hostname === 'fonts.gstatic.com')
    return e.respondWith(cacheFirst(req, LIB));
  if (u.hostname === 'tile.openstreetmap.org' || /^[abc]\.tile\.openstreetmap\.fr$/.test(u.hostname))
    return e.respondWith(cacheFirst(req, TILES, true));
  // Alles andere (Firestore, Google-Anmeldung) geht unverändert ans Netz.
});
