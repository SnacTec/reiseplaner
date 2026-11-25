// Google-Maps-Link → Koordinaten. Kein Firebase hier, damit es sich lokal testen lässt.
'use strict';
// Nur Google-Adressen aufrufen (sonst wäre die Funktion ein offener Proxy)
const HOST = /^(maps\.app\.goo\.gl|goo\.gl|(www\.|maps\.|consent\.)?google\.[a-z]{2,3}(\.[a-z]{2})?)$/i;
const okUrl = u => { try { const x = new URL(u); return x.protocol === 'https:' && HOST.test(x.hostname); } catch (e) { return false; } };
const valid = (la, lo) => isFinite(la) && isFinite(lo) && Math.abs(la) <= 90 && Math.abs(lo) <= 180 && !(la === 0 && lo === 0);

// Reihenfolge: Pin des Ortes (!3d/!4d) vor Kartenmitte (@lat,lon)
function coords(s) {
  if (!s) return null;
  let t = String(s); try { t = decodeURIComponent(t); } catch (e) {}
  const P = [
    /!3d(-?\d{1,2}\.\d+)!4d(-?\d{1,3}\.\d+)/,
    /[?&](?:q|query|ll|destination|daddr|center)=(-?\d{1,2}\.\d+)\s*,\s*(-?\d{1,3}\.\d+)/i,
    /\/search\/(-?\d{1,2}\.\d+),\s*\+?(-?\d{1,3}\.\d+)/,
    /@(-?\d{1,2}\.\d+),(-?\d{1,3}\.\d+)/,
  ];
  for (const p of P) { const m = t.match(p); if (m && valid(+m[1], +m[2])) return { lat: +m[1], lon: +m[2] }; }
  return null;
}
function placeName(s) {
  let t = String(s || ''); try { t = decodeURIComponent(t); } catch (e) {}
  const m = t.match(/\/place\/([^/@?]+)/) || t.match(/[?&]q=([^&]+)/);
  return m ? m[1].replace(/\+/g, ' ').trim().slice(0, 120) : '';
}
// Seite selbst (Kurzlinks ohne Koordinaten in der Adresse): Vorschaubild bzw. Startzustand enthält sie
function coordsFromHtml(h) {
  let m = h.match(/center=(-?\d{1,2}\.\d+)%2C(-?\d{1,3}\.\d+)/);
  if (m && valid(+m[1], +m[2])) return { lat: +m[1], lon: +m[2] };
  m = h.match(/!3d(-?\d{1,2}\.\d+)!4d(-?\d{1,3}\.\d+)/);
  if (m && valid(+m[1], +m[2])) return { lat: +m[1], lon: +m[2] };
  m = h.match(/APP_INITIALIZATION_STATE=\[\[\[-?[\d.e+]+,(-?\d{1,3}\.\d+),(-?\d{1,2}\.\d+)\]/);
  if (m && valid(+m[2], +m[1])) return { lat: +m[2], lon: +m[1] };
  return null;
}
const HDR = {
  'User-Agent': 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36',
  'Accept-Language': 'de-DE,de;q=0.9',
  // Einwilligungsseite von Google (EU) überspringen
  Cookie: 'CONSENT=YES+; SOCS=CAESEwgDEgk0ODE3Nzk3MjQaAmRlIAEaBgiA_LyaBg',
};

async function resolveLink(url, fetchFn = fetch) {
  if (!okUrl(url)) throw Object.assign(new Error('Kein Google-Maps-Link'), { status: 400 });
  let u = url, name = placeName(u), c = coords(u);
  for (let i = 0; i < 6 && !c; i++) {
    const r = await fetchFn(u, { redirect: 'manual', headers: HDR, signal: AbortSignal.timeout(8000) });
    const loc = r.headers.get('location');
    if (r.status >= 300 && r.status < 400 && loc) {
      let next = new URL(loc, u).href;
      // consent.google.com/…?continue=<eigentlicher Link>
      const cont = new URL(next).searchParams.get('continue');
      if (/^consent\./i.test(new URL(next).hostname) && cont) next = cont;
      if (!okUrl(next)) break;
      u = next; name = placeName(u) || name; c = coords(u);
      continue;
    }
    if (r.ok) { const h = (await r.text()).slice(0, 3e6); c = coordsFromHtml(h); }
    break;
  }
  return { ...(c || {}), name, url: u, found: !!c };
}
module.exports = { resolveLink, coords, coordsFromHtml, placeName, okUrl };
