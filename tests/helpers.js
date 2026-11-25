/* Test-Hilfen für den Reiseplaner (Playwright, ohne Firebase).
 * Die App läuft im lokalen Modus mit einer erfundenen Beispielreise aus docs/beispiel/.
 * Alle Anfragen nach außen werden abgefangen; Ortssuche/Routen/Google-Links liefern feste Testantworten. */
'use strict';
const http = require('http'), fs = require('fs'), path = require('path');
const ROOT = path.resolve(__dirname, '..');
const tripCheck = require(path.join(ROOT, 'tripcheck.js'));
let chromium, devices;
try { ({ chromium, devices } = require('playwright')); } catch (e) {
  console.error('Playwright fehlt. Installieren: npm i -D playwright && npx playwright install chromium'); process.exit(2);
}
/* feste Testorte für die Ortssuche (Name → [lon, lat]); sonst Mallorca */
const PLACES = { Musterstadt: [-16.254, 28.468], Testort: [2.65, 39.57] };
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json', '.txt': 'text/plain; charset=utf-8', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml' };

/* kleiner Webserver für den Projektordner */
function serve(port = 0) {
  return new Promise(res => {
    const srv = http.createServer((q, r) => {
      let f = decodeURIComponent(q.url.split('?')[0].split('#')[0]); if (f === '/') f = '/index.html';
      const p = path.join(ROOT, path.normalize(f)); if (!p.startsWith(ROOT) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { r.writeHead(404); return r.end('404'); }
      r.writeHead(200, { 'Content-Type': TYPES[path.extname(p)] || 'application/octet-stream' }); fs.createReadStream(p).pipe(r);
    }).listen(port, () => res({ srv, url: 'http://localhost:' + srv.address().port }));
  });
}

/* Beispielreise laden (geprüft und aufbereitet wie beim echten Import) */
function trip(name = 'kreuzfahrt') {
  const r = tripCheck(fs.readFileSync(path.join(ROOT, 'docs/beispiel/BEISPIEL-' + name + '.json'), 'utf8'));
  if (!r.ok) throw new Error('Beispielreise ungültig: ' + r.errors.join('; '));
  return r.trip;
}

/* Browser-Kontext: Handy (Pixel 7) oder PC (Fenstergröße), alle externen Dienste abgefangen */
async function context(browser, { device = 'Pixel 7', viewport = null, dark = false } = {}) {
  const c = await browser.newContext({ ...(viewport ? { viewport } : devices[device]), serviceWorkers: 'block', locale: 'de-DE', colorScheme: dark ? 'dark' : 'light' });
  await c.route(/gstatic|openstreetmap|fonts\.|firebase-config|overpass|open-meteo|private\.coffee|mail\.ru/, r => r.abort());
  // Ortssuche (Photon): liefert einen Treffer aus der Anfrage, Rückwärtssuche PLZ+Ort
  await c.route(/photon\.komoot\.io/, r => {
    const u = new URL(r.request().url()), q = u.searchParams.get('q') || '';
    const body = u.pathname.includes('reverse') ? { features: [{ properties: { postcode: '12345', city: 'Teststadt' } }] }
      : { features: q.length < 3 ? [] : [{ geometry: { coordinates: PLACES[q.split(',')[0]] || [2.65, 39.57] }, properties: { name: q.split(',')[0], city: 'Teststadt', country: 'Testland' } }] };
    r.fulfill({ contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(body) });
  });
  // Routen (OSRM): gerade Linie, 100 km, 1:20 Std.
  await c.route(/fake-osrm|router\.project-osrm/, r => {
    const m = /driving\/([-\d.]+),([-\d.]+);([-\d.]+),([-\d.]+)/.exec(r.request().url()) || [0, 0, 0, 1, 1];
    r.fulfill({ contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ routes: [{ distance: 100000, duration: 4800, geometry: { coordinates: [[+m[1], +m[2]], [+m[3], +m[4]]] } }] }) });
  });
  // Cloud Function mapLink (Google-Maps-Kurzlinks)
  await c.route(/fake-maplink/, r => r.fulfill({ contentType: 'application/json', body: JSON.stringify({ found: true, lat: 39.57, lon: 2.65, name: 'Testort' }) }));
  return c;
}

/* Seite mit Reise öffnen; errs sammelt JavaScript-Fehler */
async function open(c, base, t, hash = '', pre = '') {
  const p = await c.newPage(); p.errs = [];
  p.on('pageerror', e => p.errs.push(e.message));
  await p.addInitScript(`window.__TEST_OSRM='${base}/fake-osrm';window.__TEST_MAPLINK='${base}/fake-maplink';window.__TEST_TRIP=${JSON.stringify(t)};${pre}`);
  await p.goto(base + '/index.html' + hash); await p.waitForTimeout(1500);
  return p;
}
const go = async (p, base, hash) => { await p.goto(base + '/index.html' + hash); await p.waitForTimeout(1200); };

module.exports = { ROOT, serve, trip, context, open, go, chromium, devices, tripCheck };
