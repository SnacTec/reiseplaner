/* Reiseplaner – gemeinsame Tageslogik (ohne Oberfläche).
 * Genutzt von der App (app.js) und später vom Server (Cloud Function für den Claude-Konnektor),
 * damit beide garantiert dasselbe rechnen: Liegezeit, „Ab Schiff“ / „Zurück an Bord“, Puffer,
 * Veranstalter-Ausflüge, Abendessen, Ein-/Ausschiffung, An-/Abreise, „heute“ und „jetzt“.
 * Keine Abhängigkeit von DOM oder Gerätespeicher: alles Reisebezogene kommt über einen Kontext
 * (RPDP.make(ctx)), die Uhr über ctx.now(). Lädt im Browser (window.RPDP) und in Node (require).
 * Änderungen hier betreffen App und Server gleichermaßen – Tests: node tests/run.js. */
(function (root) {
  'use strict';
  /* ---------- reine Helfer ---------- */
  const addDays = (s, n) => { const d = new Date(s + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10) };
  const hm = m => { m = ((Math.round(m) % 1440) + 1440) % 1440; return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0') };
  const tm = s => { const a = s.split(':'); return +a[0] * 60 + +a[1] };
  const MODE = { walk: 'zu Fuß', taxi: 'Taxi', tour: 'Taxi oder Mietwagen' };
  function portWin(p) { const m = /(\d\d:\d\d)\D+(\d\d:\d\d)/.exec(p.times || ''); const a = m ? tm(m[1]) : 480, b = m ? tm(m[2]) : 1080; return { on: a + 30, off: b - 30, dep: b } }
  const hav = (a, b) => { const r = x => x * Math.PI / 180, dl = r(b.lat - a.lat), dn = r(b.lon - a.lon); const h = Math.sin(dl / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(dn / 2) ** 2; return 12742 * Math.asin(Math.sqrt(h)) };
  function leg(p, a, b) {
    if (!a || !b) { const g = (a || b).g; return { m: g.m, t: g.t, c: g.m === 'walk' ? 0 : g.c || 0, u: g.u } }
    const d = hav(a, b);
    if (a.g.m === 'walk' && b.g.m === 'walk') return { m: 'walk', t: Math.max(3, Math.round(d * 1.3 / 4.5 * 60)), c: 0, u: b.g.u };
    const dp = Math.max(1, hav(p, b));
    return { m: 'taxi', t: Math.max(8, Math.round(d * 1.4 / 30 * 60)), c: Math.round((b.g.c || 0) * Math.min(1, Math.max(.25, d / dp)) / 5) * 5, u: b.g.u };
  }
  const durMin = s => { const m = /(\d+(?:[.,]\d+)?)\s*Std/.exec(s || ''); return m ? Math.round(parseFloat(m[1].replace(',', '.')) * 60) : 240 };
  const moneyU = (n, u) => n.toLocaleString('de-DE') + ' ' + u;
  function legTxt(l) { if (l.m === 'custom') return l.t ? `Weg ca. ${l.t} Min` : ''; return `${MODE[l.m] || l.m} ca. ${l.t} Min${l.c ? `, ca. ${moneyU(l.c, l.u)} (Taxi pro Auto)` : ''}` }
  const durTxt = m => { m = Math.round(m); return Math.floor(m / 60) + ':' + String(m % 60).padStart(2, '0') + ' Std.' };
  const tzTxt = o => 'UTC' + (o < 0 ? '−' : '+') + Math.abs(o);
  /* Zeitzonen (IANA) für An-/Abreise: Versatz zu UTC an Datum/Uhrzeit, mit Sommerzeit */
  const tzOffAt = (z, date, time) => { try { const v = new Intl.DateTimeFormat('en-US', { timeZone: z, timeZoneName: 'shortOffset' }).formatToParts(new Date(date + 'T' + (time || '12:00') + ':00Z')).find(x => x.type === 'timeZoneName').value;
    const m = /GMT([+-]\d+)(?::(\d+))?/.exec(v); return m ? +m[1] + (m[2] ? Math.sign(+m[1] || 1) * m[2] / 60 : 0) : 0 } catch (e) { return 0 } };
  const utcOf = (date, time, z) => { const [y, mo, d] = date.split('-').map(Number), [h, mi] = (time || '12:00').split(':').map(Number); return Date.UTC(y, mo - 1, d, h, mi) - tzOffAt(z, date, time) * 36e5 };
  const localOf = (ms, z) => { const off = tzOffAt(z, new Date(ms).toISOString().slice(0, 10), new Date(ms).toISOString().slice(11, 16)); const d = new Date(ms + off * 36e5).toISOString(); return { d: d.slice(0, 10), t: d.slice(11, 16) } };
  /* Deutschland am Datum: Winterzeit +1, Sommerzeit +2 */
  const deOff = d => { try { const v = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Berlin', timeZoneName: 'shortOffset' }).formatToParts(new Date(d + 'T12:00:00Z')).find(x => x.type === 'timeZoneName').value; const m = /GMT([+-]\d+)/.exec(v); return m ? +m[1] : 1 } catch (e) { return 1 } };
  /* An-/Abreise zusammenfassen: Dauer, Umstiege, Zeitumstellung, Ankunft in Heimatzeit */
  function tvSum(o) { const S = (o && o.segs || []).filter(s => s.f && s.t && s.dd && s.dt); if (!S.length) return null; const a = S[0], z = S[S.length - 1];
    const dep = utcOf(a.dd, a.dt, a.f.tz), arr = z.ad && z.at ? utcOf(z.ad, z.at, z.t.tz) : null, lay = [];
    for (let i = 1; i < S.length; i++) { const p = S[i - 1]; if (p.ad && p.at) { lay.push({ at: p.t, min: (utcOf(S[i].dd, S[i].dt, S[i].f.tz) - utcOf(p.ad, p.at, p.t.tz)) / 6e4 }) } }
    const shift = arr != null && a.f.tz && z.t.tz ? tzOffAt(z.t.tz, z.ad, z.at) - tzOffAt(a.f.tz, a.dd, a.dt) : 0;
    return { S, a, z, dep, arr, dur: arr != null ? (arr - dep) / 6e4 : null, lay, shift, plus: z.ad && z.ad > a.dd ? Math.round((new Date(z.ad) - new Date(a.dd)) / 864e5) : 0, home: arr != null && a.f.tz ? localOf(arr, a.f.tz) : null } }

  /* ---------- Logik mit Reise-Kontext ----------
   ctx: { trip, ports, plan {Tag:[Einträge]}, picks {'Tag:Code':bool}, din (Abendessen), ship ({dk:[…]}), cruise (bool), now() (ms) }
   Felder werden bei jedem Aufruf neu gelesen (Getter erlaubt), damit Änderungen sofort gelten. */
  function make(ctx) {
    const nowMs = () => ctx.now();
    const pickKey = (d, c) => d + ':' + c;
    const isPicked = (p, e) => { const picks = ctx.picks || {}, k = pickKey(p.day, e.c); return k in picks ? picks[k] : !!e.rec && !e.sold };
    const tzOf = p => { const T = ctx.trip; return p && p.tz != null ? p.tz : (T.tz != null ? T.tz : 0) };
    /* „heute“: während der Reise (Vortag bis Folgetag) Datum in Ortszeit des Reiseziels (je Station über tz), sonst lokales Datum
       (Browser: Gerät; Server: Zeitzone des Prozesses – dort auf Europe/Berlin stellen) */
    const todayStr = () => {
      const T = ctx.trip, tz0 = T.tz != null ? T.tz : 0, k = new Date(nowMs() + tz0 * 36e5).toISOString().slice(0, 10);
      if (k >= addDays(T.start, -1) && k <= addDays(T.end, 1)) { const P = ctx.ports, p = P && P.find(q => q.date === k); if (p && p.tz != null && p.tz !== tz0) return new Date(nowMs() + p.tz * 36e5).toISOString().slice(0, 10); return k }
      const t = new Date(nowMs()); return t.getFullYear() + '-' + String(t.getMonth() + 1).padStart(2, '0') + '-' + String(t.getDate()).padStart(2, '0') };
    const portNow = p => { const d = new Date(nowMs() + tzOf(p) * 36e5); return { date: d.toISOString().slice(0, 10), min: d.getUTCHours() * 60 + d.getUTCMinutes(), hm: d.toISOString().slice(11, 16) } };
    const deckOf = n => { const S = ctx.ship; return S && S.dk ? S.dk.find(x => x[0] === n) : undefined };
    const dinVenue = () => { const DIN = ctx.din || {}; return DIN.dk != null && ctx.ship ? ((deckOf(DIN.dk) || [0, 0, []])[2][DIN.dv] || null) : null };
    const dinName = () => { const v = dinVenue(); return v ? v[0].replace(/\s*\(.*\)$/, '').replace(/^(Restaurant|Buffet-Restaurant) /, '') : '' };
    function dinRow(p) { const DIN = ctx.din || {}; if (!DIN.at || !p || p.kind === 'end') return null; const at = DIN.ov && DIN.ov[p.day] || DIN.at, a = tm(at), st = +DIN.s || 90, sk = (DIN.skip || []).includes(p.day);
      return { dinner: true, skip: sk, board: true, x: false, q: { n: 'Abendessen' + (dinName() ? ' · ' + dinName() : ''), g: { o: '', n: DIN.table ? 'Tisch ' + DIN.table : '', f: null, u: '$', v: 0, s: st } }, a, b: a + st, st, ov: !!(DIN.ov && DIN.ov[p.day]) } }
    /* Tagesplan berechnen: Zeilen mit Beginn a / Ende b (Minuten), Rückweg, „zurück an Bord“, Puffer, Eintritt/Taxi */
    function calc(p) {
      const plan = ctx.plan || {};
      const W = portWin(p), items = (plan[p.day] || []).map((s, pi) => ({ s, pi }));
      const rows = []; let fee = 0, cost = 0, u = /Guadeloupe/.test(p.land || '') ? '€' : '$';
      const cq = s => ({ n: s.n, g: { o: '', n: s.note || '', f: null, u, v: 0, s: s.s || 60 } });
      if (p.kind === 'port') {
        const sched = order => { const rows = []; let cur = W.on, prev = null, lastT = 0, fee = 0, cost = 0, uu = u;
          (p.ex || []).filter(e => e.p && isPicked(p, e)).forEach(e => { const d = durMin(e.dur); rows.push({ tour: true, e, q: { n: e.c + ' ' + e.n, g: { o: '', n: '', f: null, u, v: 0, s: d } }, a: cur, b: cur + d, st: d }); cur += d });
          order.forEach(({ s, pi }) => {
            if (s.x && s.dk) { const st = s.s || 60, a = s.at ? tm(s.at) : W.off + 30; rows.push({ s, pi, x: true, q: cq(s), lg: null, a, b: a + st, st, board: true }); return }
            if (s.x) { const t = +s.t || 0, st = s.s || 60; cur += t; if (s.at) cur = tm(s.at); rows.push({ s, pi, x: true, q: cq(s), lg: { m: 'custom', t, c: 0, u }, a: cur, b: cur + st, st }); cur += st; prev = null; lastT = t; return }
            const q = p.pois[s.i]; if (!q || !q.g) return;
            const lg = leg(p, prev, q), st = s.s || q.g.s; cur += lg.t; if (s.at) cur = tm(s.at); rows.push({ s, pi, q, lg, a: cur, b: cur + st, st }); cur += st; fee += q.g.f || 0; cost += lg.c; uu = q.g.u; prev = q; lastT = 0;
          });
          let ret = null; if (rows.some(r => !r.tour && !r.board)) { ret = prev ? leg(p, prev, null) : { m: 'custom', t: lastT, c: 0, u: uu }; cur += ret.t; cost += ret.c }
          return { rows, ret, cur, fee, cost, uu } };
        // Einträge nach ihrer (festen oder berechneten) Uhrzeit ordnen und mit dieser Reihenfolge neu rechnen
        let R = sched(items); const at = new Map(R.rows.filter(r => !r.tour).map(r => [r.pi, r.a]));
        const ord = items.slice().sort((x, y) => (at.get(x.pi) ?? 1e9) - (at.get(y.pi) ?? 1e9));
        if (ord.some((x, i) => x !== items[i])) R = sched(ord);
        { const dr = dinRow(p); if (dr) R.rows.push(dr) }
        R.rows.sort((x, y) => x.a - y.a);
        return { W, rows: R.rows, ret: R.ret, back: R.cur, slack: W.off - R.cur, fee: R.fee, cost: R.cost, u: R.uu, port: true };
      }
      items.forEach(({ s, pi }) => { if (s.x) rows.push({ s, pi, x: true, q: cq(s), lg: null, st: s.s || 60, a: s.at ? tm(s.at) : null }) });
      { const dr = dinRow(p); if (dr) rows.push(dr) }
      rows.sort((x, y) => (x.a == null) - (y.a == null) || (x.a - y.a));
      rows.forEach(r => { r.b = r.a == null ? null : r.a + r.st });
      return { W, rows, ret: null, back: null, slack: null, fee: 0, cost: 0, u, port: false };
    }
    /* Ein-/Ausschiffung (nur Kreuzfahrt): Marken mit Uhrzeit; Text ohne HTML, extra = freier Text aus den Reisedaten */
    const embOf = p => ctx.cruise && p && (p.kind === 'start' || p.kind === 'end') && p.emb || null;
    function embList(p) { const out = [], e = embOf(p), n = ctx.ports[p.day];
      if (e && p.kind === 'start') { if (e.ci1) out.push([e.ci1, `🚢 Check-in${e.ci2 ? ' bis ' + e.ci2 : ''}`, e.pier]); if (e.ab) out.push([e.ab, '🚢 Alle an Bord']); if (e.dep) out.push([e.dep, '⚓ Ablegen']) }
      if (e && p.kind === 'end') { if (e.arr) out.push([e.arr, '🏁 Ankunft im Hafen']); if (e.w1) out.push([e.w1, `🏁 Ausschiffung${e.w2 ? ' bis ' + e.w2 : ''}`, e.grp]) }
      const ne = embOf(n); if (ne && n.kind === 'end' && ne.bag) out.push([ne.bag, '🧳 Koffer vor die Kabinentür', ne.grp]);
      return out.map(([t, txt, extra]) => ({ a: tm(t), t, txt, extra: extra || '' })).sort((a, b) => a.a - b.a) }
    /* „Jetzt“ am Tag (Minuten, Ortszeit); Seetage rechnen mit der Zeitzone des letzten Nicht-Seetags */
    function dayNow(p) { if (!p || p.date !== todayStr()) return null; const P = ctx.ports, ref = p.kind === 'sea' ? P.slice(0, P.indexOf(p)).reverse().find(q => q.kind !== 'sea') : p; return portNow(ref || p).min }
    function rowLive(p, r) { const n = dayNow(p); if (n == null || r.a == null || r.skip) return ''; const b = r.b != null ? r.b : r.a + (r.st || 60); return n >= r.a && n < b ? 'live' : n >= b ? 'past' : '' }
    /* Was läuft gerade, was kommt als Nächstes (nur heute) */
    function nowNext(p) { if (!p || p.date !== todayStr()) return null; const P = ctx.ports, ref = p.kind === 'sea' ? P.slice(0, P.indexOf(p)).reverse().find(q => q.kind !== 'sea') : p; const now = portNow(ref || p).min;
      const R = calc(p).rows.filter(r => r.a != null && !r.skip).sort((a, b) => a.a - b.a); if (!R.length) return null;
      return { now, cur: R.find(r => r.a <= now && now < r.b) || null, nx: R.find(r => r.a > now) || null } }
    /* Countdown „bis alle an Bord“ bzw. bis zum Check-in (nur am jeweiligen Tag) */
    function aabInfo(p) { const e = embOf(p); if (e && p.kind === 'start' && (e.ci1 || e.ab)) { const N = portNow(p); if (p.date !== N.date) return null; const now = N.min, a = e.ci1 ? tm(e.ci1) : null, b = e.ab ? tm(e.ab) : null, f = x => { const h = Math.floor(x / 60), mi = x % 60; return h ? h + ':' + String(mi).padStart(2, '0') + ' h' : mi + ' Min' };
        let r; if (a != null && now < a) r = { big: f(a - now), txt: 'bis zum Check-in (' + e.ci1 + ' Uhr)', cls: '', pc: 0 }; else if (b != null && now < b) r = { big: f(b - now), txt: 'bis alle an Bord (' + e.ab + ' Uhr)', cls: b - now <= 60 ? 'warn' : '', pc: a != null ? Math.round((now - a) / Math.max(1, b - a) * 100) : 50 }; else r = { big: 'An Bord!', txt: 'Gute Reise!', cls: '', pc: 100 };
        return { ...r, sub: 'Ortszeit jetzt ' + N.hm + (e.ci2 ? ' · Check-in bis ' + e.ci2 : '') + (e.pier ? ' · ' + e.pier : '') } }
      if (!p || p.kind !== 'port') return null; const N = portNow(p); if (p.date !== N.date) return null;
      const m = /[–-]\s*(\d{1,2}):(\d{2})/.exec(p.times || ''), st = /^(\d{1,2}):(\d{2})/.exec(p.times || ''); if (!m) return null;
      const end = +m[1] * 60 + +m[2] - 30, s0 = st ? +st[1] * 60 + +st[2] : 0, now = N.min, left = end - now, hh = String(Math.floor(end / 60)).padStart(2, '0') + ':' + String(end % 60).padStart(2, '0');
      const pc = Math.max(0, Math.min(100, Math.round((now - s0) / Math.max(1, end - s0) * 100)));
      let cls = '', big, txt;
      if (now < s0) { big = p.times.slice(0, 5); txt = 'Ankunft um ' + p.times.slice(0, 5) + ' Uhr Ortszeit' }
      else if (left > 0) { const h = Math.floor(left / 60), mi = left % 60; big = (h ? h + ':' + String(mi).padStart(2, '0') + ' h' : mi + ' Min'); txt = 'bis alle an Bord (' + hh + ' Uhr)'; cls = left <= 30 ? 'late' : left <= 60 ? 'warn' : '' }
      else { big = 'An Bord!'; txt = 'Alle-an-Bord-Zeit ' + hh + ' Uhr ist vorbei'; cls = 'late' }
      return { cls, big, txt, pc, sub: 'Ortszeit jetzt ' + N.hm + ' (' + tzTxt(tzOf(p)) + ') · maßgeblich ist die Bordzeit im Tagesprogramm' } }
    return { pickKey, isPicked, tzOf, todayStr, portNow, deckOf, dinVenue, dinName, dinRow, calc, embOf, embList, dayNow, rowLive, nowNext, aabInfo };
  }
  const RPDP = { V: 1, addDays, hm, tm, MODE, portWin, hav, leg, durMin, moneyU, legTxt, durTxt, tzTxt, tzOffAt, utcOf, localOf, deOff, tvSum, make };
  root.RPDP = RPDP;
  if (typeof module !== 'undefined' && module.exports) module.exports = RPDP;
})(typeof window !== 'undefined' ? window : globalThis);
