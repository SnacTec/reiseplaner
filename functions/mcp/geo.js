/* Ortssuche für den Konnektor (Einträge, Orte von Ausflügen): erst Photon (wie die App), bei Fehler Nominatim.
 * Beide: OpenStreetMap-Daten, kostenlos, ohne Schlüssel. Nominatim höchstens 1 Anfrage pro Sekunde (Nutzungsregeln).
 * Fehler werden protokolliert (Statuscode/Grund, ohne Suchtext), damit sie im Function-Log sichtbar sind.
 * fetch und log werden übergeben, damit sich alles ohne Netz testen lässt (functions/test/mcp.test.js). */
'use strict';
const UA = 'Reiseplaner-Konnektor/1.0 (private Reise-App; https://github.com/SnacTec/reiseplaner)';

function makeGeo({ fetch, log = () => {}, now = Date.now, sleep = ms => new Promise(r => setTimeout(r, ms)) }) {
  let lastNom = 0;
  async function photon(q, near) {
    const u = 'https://photon.komoot.io/api/?' + new URLSearchParams({ q, limit: '5', lang: 'de', ...(near ? { lat: String(near.lat), lon: String(near.lon), location_bias_scale: '0.5' } : {}) });
    const r = await fetch(u, { headers: { 'user-agent': UA, accept: 'application/json' }, signal: AbortSignal.timeout(6000) });
    if (!r.ok) throw new Error('Photon ' + r.status);
    const j = await r.json();
    return (j.features || []).map(f => { const p = f.properties || {}, [lon, lat] = (f.geometry && f.geometry.coordinates) || [], street = [p.street, p.housenumber].filter(Boolean).join(' ');
      return { name: p.name || street || p.city || q, addr: [p.name && street ? street : '', p.postcode && p.city ? p.postcode + ' ' + p.city : (p.city || p.town || p.village || ''), p.country].filter(Boolean).join(', '), lat: +lat, lon: +lon }; })
      .filter(x => isFinite(x.lat) && isFinite(x.lon));
  }
  async function nominatim(q, near) {
    const wait = lastNom + 1100 - now(); if (wait > 0) await sleep(wait); lastNom = now();
    const vb = near ? { viewbox: [near.lon - 1.5, near.lat + 1.5, near.lon + 1.5, near.lat - 1.5].join(','), bounded: '0' } : {};
    const u = 'https://nominatim.openstreetmap.org/search?' + new URLSearchParams({ q, format: 'jsonv2', limit: '5', 'accept-language': 'de', ...vb });
    const r = await fetch(u, { headers: { 'user-agent': UA, accept: 'application/json' }, signal: AbortSignal.timeout(7000) });
    if (!r.ok) throw new Error('Nominatim ' + r.status);
    const j = await r.json();
    return (Array.isArray(j) ? j : []).map(x => ({ name: x.name || String(x.display_name || q).split(',')[0], addr: String(x.display_name || '').split(',').slice(1, 4).map(s => s.trim()).join(', '), lat: +x.lat, lon: +x.lon }))
      .filter(x => isFinite(x.lat) && isFinite(x.lon));
  }
  // liefert Treffer (evtl. leer); wirft nur, wenn beide Dienste nicht erreichbar sind
  return async function geo(q, near) {
    try { const r = await photon(q, near); if (r.length) return r; }
    catch (e) { log('ortssuche', String(e && (e.name === 'TimeoutError' ? 'Photon Zeitüberschreitung' : e.message)).slice(0, 80)); }
    try { return await nominatim(q, near); }
    catch (e) { log('ortssuche', String(e && (e.name === 'TimeoutError' ? 'Nominatim Zeitüberschreitung' : e.message)).slice(0, 80)); throw new Error('Ortssuche nicht erreichbar'); }
  };
}
module.exports = { makeGeo, UA };
