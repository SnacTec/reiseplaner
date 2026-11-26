/* Einziger Lesebaustein für Reisedaten (das Admin SDK umgeht die Firestore-Regeln – deshalb feste Positivliste):
 *   config/app · trips/<id> · ships/<id> (nur Deckplan) · trips/<id>/{planitems, picks, plandays/meta, plandays/d<N> (alt),
 *   travel, stays, files, members/<uid> (nur Existenz)}
 * NIE: users/…, config/user_*, plandays/quiz_*, backups, photos, lists, tasks.
 * Bereinigt wird beim Lesen (keine Sitzplätze, Buchungsnummern, Kabine, Namen). Aufbereitung wie in der App (index.html/app.js). */
'use strict';
const TRIP_RE = /^[\w-]{1,80}$/;
const TYPES = ['sight', 'beach', 'nature', 'factory', 'town'];

function reader(S) {
  const cache = new Map();   // je Reise 30 s, spart Lesezugriffe bei mehreren Werkzeug-Aufrufen hintereinander
  async function load(trip) {
    if (!TRIP_RE.test(String(trip || ''))) throw new Error('Reise ungültig');
    const c = cache.get(trip); if (c && Date.now() - c.at < 30e3) return c.v;
    const t = await S.get('trips/' + trip); if (!t) throw new Error('Reise nicht gefunden');
    let j = {}; try { j = JSON.parse(t.json || '{}'); } catch (e) { j = {}; }
    const meta = { title: t.title || '', kind: t.kind || '', start: t.start, end: t.end, tz: t.tz, operator: t.operator || '', ship: t.ship || null };
    const ports = Array.isArray(j.ports) ? j.ports : [];
    // wie die App: unbekannte Tipp-Typen → Sehenswertes, feste Kennung je Tipp
    ports.forEach(p => (p.pois || []).forEach((q, i) => { if (!TYPES.includes(q.t)) q.t = 'sight'; if (!q.id) q.id = 't' + p.day + '_' + i; }));
    let ship = null;
    if (meta.ship && TRIP_RE.test(meta.ship)) { const s = await S.get('ships/' + meta.ship); if (s) { try { const d = JSON.parse(s.json || '{}'); ship = { dk: Array.isArray(d.dk) ? d.dk : [] }; } catch (e) { ship = { dk: [] }; } } }
    const base = 'trips/' + trip + '/';
    const [items, pk, m, tv, st, fl] = await Promise.all([S.list(base + 'planitems'), S.list(base + 'picks'), S.get(base + 'plandays/meta'), S.list(base + 'travel'), S.list(base + 'stays'), S.list(base + 'files')]);
    // Tagesplan: je Tag nach o, dann Kennung sortieren (wie planMigrate in app.js)
    const plan = {};
    if (items.length || (m && m.planV2)) {
      items.forEach(({ id, data }) => { const { d, o, ...r } = data || {}; if (!(+d >= 1)) return; (plan[+d] = plan[+d] || []).push({ ...r, id, _o: typeof o === 'number' ? o : 0 }); });
      Object.values(plan).forEach(a => { a.sort((p, q) => p._o - q._o || String(p.id).localeCompare(q.id)); a.forEach(x => delete x._o); });
    } else {  // Altbestand vor planV2
      for (const p of ports) { const d = await S.get(base + 'plandays/d' + p.day); if (d && Array.isArray(d.items)) plan[p.day] = d.items; }
    }
    // Tipp-Einträge: Position i aus der festen Kennung ti (planTipFix)
    Object.entries(plan).forEach(([d, a]) => { const L = ((ports.find(p => p.day === +d) || {}).pois) || []; a.forEach(s => { if (!s || s.x) return; if (s.ti) { const k = L.findIndex(q => q.id === s.ti); if (k >= 0) s.i = k; } }); });
    const picks = {}; pk.forEach(({ data }) => { if (data && typeof data.k === 'string') picks[data.k] = !!data.v; });
    const dn = (m && m.dinner) || {};
    const din = { at: dn.at || '', dk: dn.dk ?? null, dv: dn.dv ?? null, s: dn.s || 90, table: '', skip: Array.isArray(dn.skip) ? dn.skip : [], ov: dn.ov || {} };   // Tischnummer bewusst weggelassen
    // An-/Abreise: ohne Sitzplatz, Buchungsnummer, Notiz; Adressen nur als Ort (ohne Straße, PLZ, Koordinaten)
    const place = x => { if (!x) return null; const o = { tz: x.tz }; if (x.c) { o.c = x.c; o.n = x.n; } else { const a = String(x.a || '').replace(/^\s*\d{4,5}\s+/, '').trim(); o.n = a || (/\d/.test(x.n || '') ? 'Adresse' : (x.n || 'Ort')); } return o; };
    const travel = {}; tv.forEach(({ id, data }) => { if (id === 'out' || id === 'back') travel[id] = { mode: data.mode, segs: (data.segs || []).map(s => ({ m: s.m, f: place(s.f), t: place(s.t), dd: s.dd, dt: s.dt, ad: s.ad, at: s.at, no: s.no, km: s.km, min: s.min, calc: s.calc })) }; });
    const stays = st.map(({ id, data }) => ({ id, n: data.n, d1: data.d1, d2: data.d2, ci: data.ci, co: data.co }));   // ohne Adresse, Buchungsnummer
    const files = fl.map(({ data }) => ({ title: data.title, days: data.days || [], tv: data.tv || [], ts: data.ts || 0 }));
    const v = { trip, meta, ports, ship, plan, picks, din, travel, stays, files };
    cache.set(trip, { at: Date.now(), v }); if (cache.size > 10) cache.delete(cache.keys().next().value);
    return v;
  }
  return { load };
}
module.exports = { reader, TRIP_RE };
