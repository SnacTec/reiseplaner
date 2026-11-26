/* Reisedaten kommen aus Firestore (siehe index.html, Lader). Nichts Reisespezifisches steht im Code. */
/* === dayplan.js eingebettet: nicht hier ändern, sondern dayplan.js bearbeiten und `node tools/dayplan-sync.js` ausführen === */
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
      const rows = []; let fee = 0, cost = 0, u = '$';   // Standard-Währungszeichen; Tipps bringen ihr eigenes mit (g.u)
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
/* === Ende dayplan.js === */
const TRIP=window.__T.trip,TRIP_ID=window.__T.id;
/* Wortwahl: Kreuzfahrt (Hafen, Liegezeit, an Bord) oder andere Reisen (Ort, Aufenthalt) */
const CRUISE=TRIP.kind==='kreuzfahrt'||!!TRIP.ship;
const V=h=>CRUISE||typeof h!=='string'?h:h.replace(/Häfen/g,'Orte').replace(/Hafentag/g,'Reisetag').replace(/Hafen-Zoom/g,'Orts-Zoom').replace(/Im Hafen öffnen/g,'Tag öffnen')
  .replace(/vom Hafen/g,'vom Ort').replace(/zum Hafen/g,'zum Ort').replace(/um den Hafen/g,'um den Ort').replace(/den Hafen/g,'den Ort').replace(/Hafen/g,'Ort').replace(/Liegezeit/g,'Aufenthalt').replace(/ab Pier/g,'ab Unterkunft');
const SHIPNAME=window.__T.shipName||'',SHIPNOTE=window.__T.shipNote||'';
const fmtD=(s)=>{const [y,m,d]=s.split('-');return d+'.'+m+'.'};
if(!TRIP.ship)document.body.classList.add('noship');
/* Name des Reiseveranstalters (z. B. Reederei) aus den Reisedaten – steht nicht im Code */
const OP=TRIP.operator||'Veranstalter';
const TRIP_DAYS=window.__T.D.ports.length,TRIP_NIGHTS=TRIP_DAYS-1;
{const L=x=>x.split('-').reverse().join('.'),h=document.getElementById('ttl');if(h)h.textContent=(TRIP.title||'Reise')+' '+L(TRIP.start)+' – '+L(TRIP.end);document.title=TRIP.title||'Reiseplaner'}
const addDays=RPDP.addDays;
/* ---------- Sync-Anzeige: ☁︎ synchron · ⟳ wird übertragen · ⚠ offline ---------- */
var SYNCST={last:+(localStorage.getItem('rp-lastsync')||0),pending:false,since:0};
function syncSeen(){SYNCST.last=Date.now();try{localStorage.setItem('rp-lastsync',String(SYNCST.last))}catch(e){}syncDraw()}
function syncPoke(){clearTimeout(syncPoke.t);syncPoke.t=setTimeout(syncCheck,350)}
function syncCheck(){const db=FBX&&FBX.real;if(!db||!db.waitForPendingWrites){syncDraw();return}let done=false;
  db.waitForPendingWrites().then(()=>{done=true;const was=SYNCST.pending;SYNCST.pending=false;if(navigator.onLine!==false&&was)syncSeen();else syncDraw()}).catch(()=>{});
  setTimeout(()=>{if(!done&&!SYNCST.pending){SYNCST.pending=true;SYNCST.since=Date.now();syncDraw()}},500)}
function syncInfo(){const off=navigator.onLine===false,q=UPQN||0,pend=SYNCST.pending,slow=pend&&Date.now()-SYNCST.since>15000;
  return {k:off?'off':pend||q?'busy':'ok',off,q,pend,slow}}
function syncDraw(){const b=document.getElementById('syncb');if(!b)return;const i=syncInfo();b.dataset.s=i.k;b.hidden=i.k==='ok'||TS.mode!=='db';
  b.title=i.off?'Offline – Änderungen werden später übertragen':i.k==='busy'?'Wird synchronisiert …':'Alles synchron';
  b.innerHTML=i.k==='ok'?'<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 18a5 5 0 0 1-.6-9.96A6 6 0 0 1 18 9a4 4 0 0 1 0 9z"/><path d="M9.5 13.5l2 2 3.5-3.5"/></svg>'
   :i.k==='busy'?'<svg class="spin" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M20 12a8 8 0 1 1-2.3-5.6"/><path d="M20 4v4h-4"/></svg>'
   :'<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 18a5 5 0 0 1-.6-9.96A6 6 0 0 1 18 9a4 4 0 0 1 0 9z"/><path d="M4 4l16 16"/></svg>'+((i.pend||i.q)?'<i class="sdot"></i>':'');
  b.setAttribute('aria-label',b.title)}
function syncDlg(){const i=syncInfo(),t=SYNCST.last?new Date(SYNCST.last).toLocaleString('de-DE',{weekday:'short',hour:'2-digit',minute:'2-digit'}).replace('.,','.'):'noch nie';
  openSheet('<div class="hd"><h3 style="margin:0">'+(i.off?'⚠ Offline':i.k==='busy'?'⟳ Wird synchronisiert':'☁︎ Alles synchron')+'</h3></div>'+
   '<p style="margin:0 0 8px">'+(i.off?'Du kannst ganz normal weiterarbeiten. Alle Änderungen bleiben auf dem Handy und werden automatisch übertragen, sobald wieder Internet da ist.':i.k==='busy'?(i.slow?'Die Verbindung ist langsam. Änderungen sind auf dem Handy gespeichert und werden übertragen, sobald es klappt.':'Änderungen werden gerade übertragen.'):'Alle Änderungen sind bei allen Mitreisenden angekommen.')+'</p>'+
   '<p class="src" style="margin:0 0 8px">Zuletzt mit dem Server abgeglichen: '+t+(TS.mode!=='db'?' · nur auf diesem Gerät (nicht angemeldet)':'')+'</p>'+
   (i.pend?'<p class="src" style="margin:0 0 8px">⏳ Änderungen warten auf die Übertragung.</p>':'')+(i.q?'<p class="src" style="margin:0 0 8px">⏳ '+i.q+' Datei'+(i.q>1?'en warten':' wartet')+' auf das Hochladen.</p>':'')+
   '<div class="btns bar"><button class="chip btn" id="synow">Jetzt abgleichen</button></div>',d=>{
    d.querySelector('#synow').onclick=()=>{try{FBX.real&&FBX.real.enableNetwork()}catch(e){}fUpRun(true);syncCheck();closeDlg();undoToast(navigator.onLine===false?'Kein Internet – es wird später automatisch abgeglichen.':'Abgleich angestoßen.',null,2500)}})}
addEventListener('online',()=>{syncCheck();fUpRun(true)});addEventListener('offline',syncDraw);
setInterval(()=>{if(SYNCST.pending||UPQN)syncCheck();else syncDraw()},10000);
/* Upload-Warteschlange (IndexedDB rp-up): Dateien werden sofort lokal gespeichert und im Hintergrund hochgeladen */
var UPQN=0;let upDbP=null,upRun=false;
const upDb=()=>upDbP||(upDbP=new Promise(res=>{try{const r=indexedDB.open('rp-up',1);r.onupgradeneeded=()=>r.result.createObjectStore('q',{keyPath:'id'});r.onsuccess=()=>res(r.result);r.onerror=()=>res(null)}catch(e){res(null)}}));
async function upOp(mode,fn){const db=await upDb();if(!db)return null;return new Promise(res=>{try{const t=db.transaction('q',mode),st=t.objectStore('q'),r=fn(st);t.oncomplete=()=>res(r&&r.result);t.onerror=()=>res(null)}catch(e){res(null)}})}
async function upCount(){const a=await upOp('readonly',st=>st.getAll())||[];UPQN=a.filter(x=>x.trip===TRIP_ID).length;syncDraw();return a}
async function fUpRun(force){if(upRun)return;if(navigator.onLine===false||!FST())return;upRun=true;
  try{const a=(await upCount()).filter(x=>x.trip===TRIP_ID);
    for(const x of a){try{await FST().put(x.path,x.blob,{contentType:x.type});await upOp('readwrite',st=>st.delete(x.id));
        const f=FILES.find(y=>y.id===x.id);if(f){const {pending,...r}=f;fPut(r)}}catch(e){break}}}
  finally{upRun=false;upCount()}}
setTimeout(()=>{upCount().then(()=>fUpRun())},5000);
/* ---------- Reise-Mappe: Dateien in Firebase Storage, Einträge in Firestore (trips/<id>/files bzw. users/<uid>/files) ---------- */
const FCAT={plan:['🗺','Pläne'],ticket:['🎟','Tickets'],hotel:['🏨','Unterkünfte'],flight:['✈','Flüge'],doc:['📄','Dokumente'],misc:['📸','Sonstiges']};
const FKEY='rp-'+TRIP_ID+'-files',FCACHE='rp-files';
let FILES=[];const FSRC=[[],[]];let fmCat='all',fmQ='',fmRb=null;
try{FILES=JSON.parse(localStorage.getItem(FKEY)||'[]')}catch(e){}
function fStore(){try{localStorage.setItem(FKEY,JSON.stringify(FILES))}catch(e){}}
function FST(){if(window.__TEST_STORAGE)return window.__TEST_STORAGE;
  try{if(window.firebase&&firebase.storage&&FBX.user){const st=firebase.storage();return {
    put:(path,blob,meta,prog)=>new Promise((res,rej)=>{const t=st.ref(path).put(blob,meta);t.on('state_changed',s=>prog&&prog(s.bytesTransferred/(s.totalBytes||1)),rej,()=>res())}),
    url:path=>st.ref(path).getDownloadURL(),del:path=>st.ref(path).delete()}}}catch(e){}return null}
function fInit(db){const sub=pv=>db.collection(pv?privPath('files'):'files').onSnapshot({includeMetadataChanges:true},s=>{
    s.docs.forEach(d=>{if(!d.metadata.hasPendingWrites)SYNC['files:'+d.id]=d.data()});
    FSRC[pv?1:0]=s.docs.map(d=>{if(pv)PRIV.add('files:'+d.id);const x={id:d.id,...d.data()};if(pv)x.priv=true;return x});
    FILES=FSRC[0].concat(FSRC[1]);fStore();fChanged()},()=>{});sub(0);sub(1)}
addEventListener('online',()=>{fAutoT=0;setTimeout(fAutoCache,2000)});setTimeout(fAutoCache,6000);
function fChanged(){if(fmRb&&document.getElementById('fmlist')){fmRb();return}
  const a=document.activeElement;if(!(a&&a.closest&&a.closest('#panel input,#panel textarea,#panel select'))&&(todayView||tripView||sel!=null))renderPanel();setTimeout(fAutoCache,1500)}
function fPut(o){const i=FILES.findIndex(x=>x.id===o.id);if(i<0)FILES.push(o);else FILES[i]=o;fStore();if(TS.mode==='db'&&dbh)putDoc('files',o);fChanged()}
const fSafe=n=>String(n||'datei').normalize('NFKD').replace(/[^\w.-]+/g,'_').slice(-60);
const fIcon=f=>/pdf/.test(f.type||'')?'📄':/^image\//.test(f.type||'')?'🖼':/^video\//.test(f.type||'')?'🎬':(FCAT[f.cat]||['📎'])[0];
const fSize=n=>n>1048576?(n/1048576).toFixed(1).replace('.',',')+' MB':Math.max(1,Math.round(n/1024))+' KB';
const fDays=f=>(f.days||[]).slice().sort((a,b)=>a-b);
const fThumb=f=>typeof f.thumb==='string'&&/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(f.thumb)?f.thumb:'';
const fOfDay=d=>FILES.filter(f=>(f.days||[]).includes(d)).sort((a,b)=>(a.ts||0)-(b.ts||0));
/* Verknüpfung: Tage (Zahl, f.days) und An-/Abreise ('out'/'back', f.tv) */
const fKey=v=>v==='out'||v==='back'?v:+v,fKL=k=>k==='out'?'Anreise':k==='back'?'Abreise':'Tag '+k;
const fOfKey=k=>typeof k==='number'?fOfDay(k):FILES.filter(f=>(f.tv||[]).includes(k)).sort((a,b)=>(a.ts||0)-(b.ts||0));
const fHas=(f,k)=>typeof k==='number'?(f.days||[]).includes(k):(f.tv||[]).includes(k);
const fSel=f=>[...(f.tv||[]).filter(k=>k==='out'),...fDays(f),...(f.tv||[]).filter(k=>k==='back')];
const fSplit=sel=>({days:sel.filter(k=>typeof k==='number'),tv:sel.filter(k=>typeof k!=='number')});
const fWhere=f=>{const t=f.tv||[],d=fDays(f);return [t.includes('out')?'Anreise':'',d.length?'Tag '+d.join(', '):'',t.includes('back')?'Abreise':''].filter(Boolean).join(' · ')};
const fLink=(f,k,on)=>{const S=fSel(f).filter(x=>x!==k);if(on)S.push(k);return {...f,...fSplit(S)}};
/* Gerätespeicher (Cache Storage) für offline */
const fCk=f=>'./__files/'+f.path;
async function fCached(f){try{const c=await caches.open(FCACHE);return !!(await c.match(fCk(f)))}catch(e){return false}}
async function fBlob(f){let c=null;try{c=await caches.open(FCACHE);const h=await c.match(fCk(f));if(h)return await h.blob()}catch(e){}
  const st=FST();if(!st)throw new Error('Nicht angemeldet oder offline');const u=await st.url(f.path);const r=await fetch(u);if(!r.ok)throw new Error('Laden fehlgeschlagen ('+r.status+')');
  const b=await r.blob();try{if(c)await c.put(fCk(f),new Response(b,{headers:{'Content-Type':f.type||b.type||'application/octet-stream'}}))}catch(e){}return b}
async function fCachePut(f,b){try{const c=await caches.open(FCACHE);await c.put(fCk(f),new Response(b,{headers:{'Content-Type':f.type||b.type||'application/octet-stream'}}))}catch(e){}}
/* Alle Dateien der geöffneten Reise automatisch aufs Handy (nacheinander; nicht bei aktivem Datensparmodus) */
let fAutoT=0,fAutoRun=false;function fAutoCache(){if(fAutoRun||Date.now()-fAutoT<20000||navigator.onLine===false||!FST())return;
  const cn=navigator.connection;if(cn&&cn.saveData)return;fAutoT=Date.now();fAutoRun=true;
  (async()=>{for(const f of FILES.slice()){try{if(!(await fCached(f)))await fBlob(f)}catch(e){}}fAutoRun=false;if(fmRb&&document.getElementById('fmlist'))fmRb()})();
  if(FILES.some(f=>/pdf/.test(f.type||'')))pdfLib().then(()=>fetch(PDFJS+'pdf.worker.min.js').catch(()=>{})).catch(()=>{})}
/* Bilder verkleinern (große Fotos/Screenshots), Vorschaubild erzeugen */
function fImg(file){return new Promise(res=>{if(!/^image\/(jpeg|png|webp|gif)/.test(file.type))return res(null);const u=URL.createObjectURL(file),im=new Image();
  im.onload=()=>{const mk=(max,q,url)=>{const k=Math.min(1,max/Math.max(im.width,im.height)),c=document.createElement('canvas');c.width=Math.max(1,Math.round(im.width*k));c.height=Math.max(1,Math.round(im.height*k));const g=c.getContext('2d');g.fillStyle='#fff';g.fillRect(0,0,c.width,c.height);g.drawImage(im,0,0,c.width,c.height);return url?c.toDataURL('image/jpeg',q):new Promise(r=>c.toBlob(r,'image/jpeg',q))};
    const thumb=mk(160,.6,1);(file.size>1.2*1048576?mk(2400,.85):Promise.resolve(null)).then(big=>{URL.revokeObjectURL(u);res({thumb,big})})};
  im.onerror=()=>{URL.revokeObjectURL(u);res(null)};im.src=u})}
function fDayChips(sel){const tv=k=>(TRV[k]||sel.includes(k))?'<button type="button" class="chip'+(sel.includes(k)?' on':'')+'" data-dd="'+k+'" aria-pressed="'+sel.includes(k)+'"><b>'+(k==='out'?'An':'Ab')+'</b><small>'+fKL(k)+'</small></button>':'';
  return '<div class="fdays">'+tv('out')+D.ports.map(p=>'<button type="button" class="chip'+(sel.includes(p.day)?' on':'')+'" data-dd="'+p.day+'" aria-pressed="'+sel.includes(p.day)+'"><b>'+p.day+'</b><small>'+esc(p.name.split(' / ')[0])+'</small></button>').join('')+tv('back')+'</div>'}
function fBindDays(d,sel){d.querySelectorAll('[data-dd]').forEach(b=>b.onclick=()=>{const n=fKey(b.dataset.dd),i=sel.indexOf(n);if(i<0)sel.push(n);else sel.splice(i,1);b.classList.toggle('on',i<0);b.setAttribute('aria-pressed',i<0)})}
/* Hochladen */
function fUploadDlg(day){
  if(!FST()){openSheet('<div class="hd"><h3 style="margin:0">Datei hochladen</h3></div><p>Dateien gehen nur mit Anmeldung.</p>');return}
  const sel=day!=null?[day]:[];
  openSheet(`<div class="hd"><h3 style="margin:0">Datei hochladen${day!=null?`<small class="hds">verknüpft mit ${fKL(day)}</small>`:''}</h3></div>
  <form class="sform" id="fuf"><label>Datei<input type="file" name="f" required></label>
  <label>Titel<input name="t" maxlength="80" required placeholder="z. B. Parkplan Magic Kingdom"></label>
  <label>Kategorie<select name="c">${Object.entries(FCAT).map(([k,v])=>`<option value="${k}">${v[0]} ${v[1]}</option>`).join('')}</select></label>
  <div><div style="font-size:12px;color:var(--muted);margin-bottom:4px">Verknüpfen mit (optional, mehrere möglich)</div>${fDayChips(sel)}</div>
  <label class="pick" style="flex-direction:row;align-items:center;gap:8px;font-size:14px;color:var(--ink)"><input type="checkbox" name="pv" style="width:auto"> 🔒 Nur für mich</label>
  <p class="src" id="fum" style="margin:0"></p>
  <div class="btns"><button class="chip btn" type="submit">Hochladen</button><button class="chip" type="button" data-close>Abbrechen</button></div></form>`,d=>{
    const f=d.querySelector('#fuf'),m=d.querySelector('#fum');fBindDays(d,sel);
    f.f.onchange=()=>{const x=f.f.files[0];if(!x)return;if(!f.t.value)f.t.value=x.name.replace(/\.[^.]+$/,'').replace(/[_-]+/g,' ').slice(0,80);
      f.c.value=/pdf/.test(x.type)?'doc':/^image\//.test(x.type)?(f.c.value||'plan'):'doc';m.textContent=fSize(x.size)+(x.size>25*1048576?' – zu groß (höchstens 25 MB)':'')};
    let busy=false;f.onsubmit=async ev=>{ev.preventDefault();if(busy)return;const x=f.f.files[0];if(!x)return;
      busy=true;f.querySelector('[type=submit]').disabled=true;
      try{m.textContent='Wird vorbereitet …';const im=await fImg(x);const blob=im&&im.big||x;if(blob.size>25*1048576)throw new Error('Die Datei ist größer als 25 MB.');
        const pv=f.pv.checked,id=nid('f'),uid=FBX.user?FBX.user.uid:'test',path='trips/'+TRIP_ID+(pv?'/users/'+uid:'')+'/files/'+id+'-'+fSafe(im&&im.big?x.name.replace(/\.[^.]+$/,'.jpg'):x.name);
        const type=blob.type||x.type||'application/octet-stream';
        const o={id,title:f.t.value.trim()||x.name,cat:f.c.value,...fSplit(sel),path,name:x.name,type,size:blob.size,thumb:im?im.thumb:'',ts:Date.now(),by:qzName(),pending:1};if(pv){o.priv=true;o.owner=uid}
        m.textContent='Wird gespeichert …';await upOp('readwrite',st=>st.put({id,path,blob,type,trip:TRIP_ID}));await fCachePut(o,blob);fPut(o);closeDlg();
        undoToast('„'+o.title+'“ gespeichert'+(sel.length?' ('+fWhere(o)+')':'')+(navigator.onLine===false?' – wird hochgeladen, sobald Internet da ist.':' – wird hochgeladen.'),null,3500);upCount().then(()=>fUpRun())}
      catch(e){m.textContent='Fehler: '+(e.message||e.code||e);busy=false;f.querySelector('[type=submit]').disabled=false}}})}
/* Bearbeiten */
function fEditDlg(id){const f=FILES.find(x=>x.id===id);if(!f)return;const sel=fSel(f);
  openSheet(`<div class="hd"><h3 style="margin:0">Datei bearbeiten</h3></div>
  <form class="sform" id="fef"><label>Titel<input name="t" maxlength="80" required value="${esc(f.title)}"></label>
  <label>Kategorie<select name="c">${Object.entries(FCAT).map(([k,v])=>`<option value="${k}" ${k===f.cat?'selected':''}>${v[0]} ${v[1]}</option>`).join('')}</select></label>
  <div><div style="font-size:12px;color:var(--muted);margin-bottom:4px">Verknüpft mit</div>${fDayChips(sel)}</div>
  <p class="src" style="margin:0">${esc(f.name||'')} · ${fSize(f.size||0)}${f.priv?' · 🔒 nur für dich':''}${f.by?' · von '+esc(f.by):''}</p>
  <div class="btns"><button class="chip btn" type="submit">Speichern</button><button class="chip" type="button" data-close>Abbrechen</button><button class="chip del" type="button" id="fdel">Löschen</button></div></form>`,d=>{
    const fm=d.querySelector('#fef');fBindDays(d,sel);
    fm.onsubmit=ev=>{ev.preventDefault();fPut({...f,title:fm.t.value.trim()||f.title,cat:fm.c.value,...fSplit(sel)});closeDlg()};
    d.querySelector('#fdel').onclick=()=>{const old={...f};if(f.pending)upOp('readwrite',st=>st.delete(f.id)).then(upCount);FILES=FILES.filter(x=>x.id!==f.id);fStore();if(TS.mode==='db'&&dbh)delDoc('files',f.id);closeDlg();fChanged();
      let undone=false;const t=setTimeout(()=>{if(undone)return;const st=FST();if(st)st.del(old.path).catch(()=>{});caches.open(FCACHE).then(c=>c.delete(fCk(old))).catch(()=>{})},9000);
      undoToast('„'+old.title+'“ gelöscht.',()=>{undone=true;clearTimeout(t);fPut(old)},8000)}})}
/* Öffnen: Bilder im eigenen Betrachter, alles andere im passenden Programm des Handys */
let fv=null;
const PDFJS='https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/';
let pdfP=null;function pdfLib(){return pdfP||(pdfP=new Promise((res,rej)=>{if(window.pdfjsLib)return res(window.pdfjsLib);const sc=document.createElement('script');sc.src=PDFJS+'pdf.min.js';
  sc.onload=()=>{try{pdfjsLib.GlobalWorkerOptions.workerSrc=PDFJS+'pdf.worker.min.js';res(pdfjsLib)}catch(e){rej(e)}};sc.onerror=()=>{pdfP=null;rej(new Error('PDF-Anzeige nicht geladen (offline?)'))};document.head.appendChild(sc)}))}
function fErr(e){const m=String(e&&(e.message||e.code)||e);if(/object-not-found/.test(m))return 'die Datei wird gerade noch hochgeladen';return /Failed to fetch|NetworkError|Load failed/i.test(m)?(navigator.onLine===false?'offline und noch nicht auf dem Handy gespeichert':'Speicher blockiert das Laden (CORS nicht eingerichtet?)'):m}
function fPdf(f){fvClose();const o=document.createElement('div');o.id='fview';o.innerHTML='<div class="fvh"><button class="fvb" data-fvx aria-label="Zurück">‹</button><b class="fvt"></b><span class="fvn"></span></div><div class="fvpdf"><p class="fvm">PDF wird geladen …</p></div>';
  document.body.appendChild(o);fv={o,list:[f],i:0,url:null};try{history.pushState({fv:1},'',location.href)}catch(e){}
  o.querySelector('.fvt').textContent=f.title;o.querySelector('[data-fvx]').onclick=()=>history.back();const box=o.querySelector('.fvpdf');
  (async()=>{try{const [lib,b]=await Promise.all([pdfLib(),fBlob(f)]);const doc=await lib.getDocument({data:new Uint8Array(await b.arrayBuffer())}).promise;
    if(!fv||fv.o!==o)return;box.innerHTML='';o.querySelector('.fvn').textContent=doc.numPages>1?doc.numPages+' Seiten':'';
    const W=Math.min(box.clientWidth||360,900),dpr=Math.min(3,(window.devicePixelRatio||1)*1.5);
    const PG=[],goPage=async d=>{try{const dest=typeof d==='string'?await doc.getDestination(d):d;if(!dest)return;const i=await doc.getPageIndex(dest[0]);PG[i]&&PG[i].scrollIntoView({behavior:'smooth',block:'start'})}catch(e){}};
    for(let n=1;n<=doc.numPages;n++){if(!fv||fv.o!==o)return;const pg=await doc.getPage(n),v0=pg.getViewport({scale:1}),sc=W/v0.width,vc=pg.getViewport({scale:sc}),v=pg.getViewport({scale:sc*dpr}),c=document.createElement('canvas');
      // Seite: Bild (canvas) + unsichtbare Textebene (markieren/kopieren) + Link-Ebene (antippbar)
      const wr=document.createElement('div');wr.className='fvpg';wr.style.width=Math.round(vc.width)+'px';wr.style.height=Math.round(vc.height)+'px';PG.push(wr);
      c.width=Math.round(v.width);c.height=Math.round(v.height);c.style.width='100%';c.style.height='100%';wr.appendChild(c);box.appendChild(wr);
      await pg.render({canvasContext:c.getContext('2d'),viewport:v}).promise;
      try{const tl=document.createElement('div');tl.className='textLayer';tl.style.setProperty('--scale-factor',sc);wr.appendChild(tl);
        await lib.renderTextLayer({textContentSource:pg.streamTextContent(),container:tl,viewport:vc,textDivs:[]}).promise}catch(e){}
      try{const an=await pg.getAnnotations();an.filter(a=>a.subtype==='Link'&&(a.url||a.dest)).forEach(a=>{const r=vc.convertToViewportRectangle(a.rect),x=Math.min(r[0],r[2]),y=Math.min(r[1],r[3]);
          const l=document.createElement('a');l.className='fvlink';l.style.cssText=`left:${x}px;top:${y}px;width:${Math.abs(r[2]-r[0])}px;height:${Math.abs(r[3]-r[1])}px`;
          if(a.url){l.href=a.url;l.target='_blank';l.rel='noopener';l.title=a.url}else{l.href='#';l.onclick=ev=>{ev.preventDefault();goPage(a.dest)}}wr.appendChild(l)})}catch(e){}}
    const ex=document.createElement('button');ex.className='chip';ex.textContent='Im Handy-Programm öffnen ›';ex.style.margin='12px auto 24px';ex.onclick=async()=>{const u=URL.createObjectURL(b),a=document.createElement('a');a.href=u;a.download=f.name||f.title+'.pdf';document.body.appendChild(a);a.click();a.remove()};box.appendChild(ex)}
  catch(e){if(fv&&fv.o===o)box.innerHTML='<p class="fvm">PDF konnte nicht geöffnet werden: '+esc(fErr(e))+'</p>'}})()}
async function fOpen(id,day){const f=FILES.find(x=>x.id===id);if(!f)return;
  if(/^image\//.test(f.type||'')){const list=(day?fOfKey(fKey(day)):FILES).filter(x=>/^image\//.test(x.type||''));fView(list,Math.max(0,list.indexOf(f)));return}
  if(/pdf/.test(f.type||'')||/\.pdf$/i.test(f.name||'')){fPdf(f);return}
  const cached=await fCached(f);
  const w=!cached&&navigator.onLine!==false?window.open('','_blank'):null;
  try{if(w){const st=FST();let u=null;if(st)try{u=await st.url(f.path)}catch(e){}if(u){w.location=u;fBlob(f).catch(()=>{});return}}
    const b=await fBlob(f),u=URL.createObjectURL(b);if(w){w.location=u;return}const a=document.createElement('a');a.href=u;a.download=f.name||f.title;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(u),60000)}
  catch(e){if(w)w.close();undoToast('Datei nicht verfügbar: '+fErr(e)+'.',null,4000)}}
function fView(list,i){fvClose(true);const o=document.createElement('div');o.id='fview';o.innerHTML='<div class="fvh"><button class="fvb" data-fvx aria-label="Zurück">‹</button><b class="fvt"></b><span class="fvn"></span></div><div class="fvs"><img alt=""></div><p class="fvm"></p>'+(list.length>1?'<button class="fvp" data-fvd="-1" aria-label="Vorheriges Bild">‹</button><button class="fvp nx" data-fvd="1" aria-label="Nächstes Bild">›</button>':'');
  document.body.appendChild(o);fv={o,list,i,url:null,s:1,x:0,y:0};try{history.pushState({fv:1},'',location.href)}catch(e){}
  const img=o.querySelector('img'),apply=()=>{img.style.transform='translate('+fv.x+'px,'+fv.y+'px) scale('+fv.s+')'};
  const show=async()=>{const f=fv.list[fv.i];fv.s=1;fv.x=fv.y=0;apply();o.querySelector('.fvt').textContent=f.title;o.querySelector('.fvn').textContent=fv.list.length>1?(fv.i+1)+'/'+fv.list.length:'';
    o.querySelector('.fvm').textContent='';if(fThumb(f))img.src=fThumb(f);try{const b=await fBlob(f);if(fv.url)URL.revokeObjectURL(fv.url);fv.url=URL.createObjectURL(b);if(fv&&fv.list[fv.i]===f)img.src=fv.url}catch(e){o.querySelector('.fvm').textContent='Nur Vorschau – '+fErr(e)+'.'}};
  const step=d=>{if(fv.list.length<2)return;fv.i=(fv.i+d+fv.list.length)%fv.list.length;show()};fv.step=step;
  o.querySelector('[data-fvx]').onclick=()=>history.back();o.querySelectorAll('[data-fvd]').forEach(b=>b.onclick=()=>step(+b.dataset.fvd));
  // Zoomen (zwei Finger, Doppeltippen) und Verschieben
  const P=new Map();let d0=0,s0=1,last=0,sx=0,sy=0,x0=0,y0=0,moved=false;const sc=o.querySelector('.fvs');
  sc.addEventListener('pointerdown',e=>{sc.setPointerCapture(e.pointerId);P.set(e.pointerId,[e.clientX,e.clientY]);moved=false;if(P.size===2){const [a,b]=[...P.values()];d0=Math.hypot(a[0]-b[0],a[1]-b[1]);s0=fv.s}else{sx=e.clientX;sy=e.clientY;x0=fv.x;y0=fv.y}});
  sc.addEventListener('pointermove',e=>{if(!P.has(e.pointerId))return;P.set(e.pointerId,[e.clientX,e.clientY]);
    if(P.size===2){const [a,b]=[...P.values()];fv.s=Math.max(1,Math.min(6,s0*Math.hypot(a[0]-b[0],a[1]-b[1])/(d0||1)));moved=true;apply()}
    else if(fv.s>1){fv.x=x0+e.clientX-sx;fv.y=y0+e.clientY-sy;moved=true;apply()}});
  const up=e=>{const was=P.size;P.delete(e.pointerId);if(was!==1)return;
    if(fv.s===1&&!moved&&Math.abs(e.clientX-sx)>60)return step(e.clientX<sx?1:-1);
    if(!moved&&Math.abs(e.clientX-sx)<10){const t=Date.now();if(t-last<300){fv.s=fv.s>1?1:2.5;fv.x=fv.y=0;apply();last=0}else last=t}};
  sc.addEventListener('pointerup',up);sc.addEventListener('pointercancel',e=>P.delete(e.pointerId));
  show()}
function fvClose(){if(!fv)return;if(fv.url)URL.revokeObjectURL(fv.url);fv.o.remove();fv=null}
/* Mappe (eigene Seite) */
let mappeView=false;
function mappeDlg(){showMappe()}
function mappePanel(){return '<div class="eyebrow">Dateien der Reise</div><h2>Reise-Mappe</h2><button class="chip btn" id="fmadd" style="width:100%;justify-content:center;padding:12px;margin:0 0 10px">+ Datei hochladen</button><div class="sfield"><svg class="sfi" viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg><input id="fmq" type="search" placeholder="In der Mappe suchen" autocomplete="off" value="'+esc(fmQ)+'"><button type="button" class="sfx" aria-label="Eingabe löschen">✕</button></div><div class="drtabs" id="fmc"></div><div id="fmlist"></div>'}
function mappeBind(d){
    const box=d.querySelector('#fmlist'),cb=d.querySelector('#fmc');
    fmRb=()=>{const q=nrm(fmQ.trim()),L=FILES.filter(f=>!q||nrm(f.title+' '+(f.name||'')+' '+(FCAT[f.cat]||['',''])[1]).includes(q));
      cb.innerHTML='<button class="chip'+(fmCat==='all'?' on':'')+'" data-fc="all">Alle '+L.length+'</button>'+Object.entries(FCAT).filter(([k])=>L.some(f=>f.cat===k)).map(([k,v])=>'<button class="chip'+(fmCat===k?' on':'')+'" data-fc="'+k+'">'+v[0]+' '+v[1]+' '+L.filter(f=>f.cat===k).length+'</button>').join('');
      cb.querySelectorAll('[data-fc]').forEach(b=>b.onclick=()=>{fmCat=b.dataset.fc;fmRb()});
      if(!FILES.length){box.innerHTML='<p class="empty">Noch keine Dateien. Lade Pläne, Tickets, Buchungen oder Fotos hoch – auf Wunsch gleich passend zu einem Tag.</p>';return}
      const cats=Object.keys(FCAT).filter(k=>(fmCat==='all'||fmCat===k)&&L.some(f=>f.cat===k));
      box.innerHTML=cats.map(k=>'<h3 class="drh">'+FCAT[k][0]+' '+FCAT[k][1]+'</h3>'+L.filter(f=>f.cat===k).sort((a,b)=>(b.ts||0)-(a.ts||0)).map(f=>'<div class="frow"><button class="fopen" data-fopen="'+f.id+'">'+(fThumb(f)?'<img src="'+fThumb(f)+'" alt="">':'<span class="fic">'+fIcon(f)+'</span>')+'<span class="ftx"><b>'+esc(f.title)+'</b><small>'+[f.pending?'⏳ wird hochgeladen':'',fWhere(f)||'keinem Tag zugeordnet',f.priv?'🔒 nur für dich':'',fSize(f.size||0)].filter(Boolean).join(' · ')+' <i class="foff" data-foff="'+f.id+'"></i></small></span></button><button class="lnk" data-fedit="'+f.id+'" aria-label="Bearbeiten">Bearbeiten</button></div>').join('')).join('')||'<p class="empty">Nichts gefunden.</p>';
      box.querySelectorAll('[data-foff]').forEach(i=>{const f=FILES.find(x=>x.id===i.dataset.foff);if(f)fCached(f).then(h=>{i.textContent=h?'· ✓ offline':'';i.classList.toggle('on',h)})});
      box.querySelectorAll('[data-fedit]').forEach(b=>b.onclick=()=>{const id=b.dataset.fedit;fEditDlg(id)})};
    d.querySelector('#fmq').oninput=e=>{fmQ=e.target.value;fmRb()};
    d.querySelector('#fmadd').onclick=()=>{fUploadDlg()};
    fmRb()}
function showMappe(fromHash){if(fromHash!==true)saveScroll();todoView=true;bordView=false;tripView=false;todayView=false;mappeView=true;sel=null;renderDays();renderBar();drawOverview();renderPanel();$('#panel').scrollTop=0;hideTip2();if(fromHash!==true)nav('#mappe');navMark()}
/* Am Tag: Dateien anzeigen, „+ Datei“ */
function filesDayHTML(p,compact,withEntry){const L=fOfDay(p.day);if(compact&&!L.length)return '';
  const chips=L.length?'<div class="fday">'+L.map(f=>'<button class="fchip" data-fopen="'+f.id+'" data-fday="'+p.day+'">'+(fThumb(f)?'<img src="'+fThumb(f)+'" alt="">':'<span>'+fIcon(f)+'</span>')+esc(f.title)+'</button>').join('')+'</div>':'';
  return chips+(compact?'':'<div class="acts dayacts">'+(withEntry?'<button class="lnk addpt" data-addmode="eigen">+ Eintrag</button>':'')+'<button class="lnk addpt" data-fadd="'+p.day+'">+ Datei</button></div>')}
const fChipsHTML=(L,k)=>L.length?'<div class="fday">'+L.map(f=>'<button class="fchip" data-fopen="'+f.id+'" data-fday="'+k+'">'+(fThumb(f)?'<img src="'+fThumb(f)+'" alt="">':'<span>'+fIcon(f)+'</span>')+esc(f.title)+'</button>').join('')+'</div>':'';
function fDayDlg(day){const other=FILES.filter(f=>!fHas(f,day));
  if(!other.length)return fUploadDlg(day);
  openSheet(`<div class="hd"><h3 style="margin:0">Datei zu ${fKL(day)}</h3></div><button class="chip btn" id="fdnew" style="width:100%;justify-content:center;padding:12px;margin:0 0 12px">Neue Datei hochladen</button><b style="font-size:13px">Oder aus der Mappe anhängen</b>
  <div style="margin-top:6px">${other.map(f=>`<div class="frow"><span class="fopen" style="cursor:default">${fThumb(f)?`<img src="${fThumb(f)}" alt="">`:`<span class="fic">${fIcon(f)}</span>`}<span class="ftx"><b>${esc(f.title)}</b><small>${FCAT[f.cat]?FCAT[f.cat][0]+' '+FCAT[f.cat][1]:''}${fWhere(f)?' · '+fWhere(f):''}</small></span></span><button class="lnk" data-fatt="${f.id}">+ anhängen</button></div>`).join('')}</div>`,d=>{
    d.querySelector('#fdnew').onclick=()=>{closeDlg();setTimeout(()=>fUploadDlg(day),60)};
    d.querySelectorAll('[data-fatt]').forEach(b=>b.onclick=()=>{const f=FILES.find(x=>x.id===b.dataset.fatt);if(!f)return;fPut(fLink(f,day,1));closeDlg();undoToast('„'+f.title+'“ an '+fKL(day)+' angehängt.',null,2500)})})}
/* Lange drücken auf eine Datei: Menü mit „Von Tag lösen“ */
function fMenu(id,day){const f=FILES.find(x=>x.id===id);if(!f)return;const ds=day?[fKey(day)]:fSel(f);
  const unlink=d=>{fPut(fLink(f,d,0));undoToast('„'+f.title+'“ von '+fKL(d)+' gelöst.',()=>{const c=FILES.find(x=>x.id===id);if(c)fPut(fLink(c,d,1))},6000)};
  openSheet(`<div class="hd"><h3 style="margin:0">${esc(f.title)}<small class="hds">${fWhere(f)||'keinem Tag zugeordnet'}</small></h3></div>
  <div class="mnu">${ds.map(d=>`<button data-fu="${d}"><span style="font-size:20px">📎</span><span>Von ${fKL(d)} lösen<small style="display:block;font:400 12.5px var(--body);color:var(--muted)">Die Datei bleibt in der Mappe</small></span></button>`).join('')}
  <button data-fo><span style="font-size:20px">👁</span><span>Öffnen</span></button><button data-fs><span style="font-size:20px">⬇</span><span>Offline speichern<small id="fsm" style="display:block;font:400 12.5px var(--body);color:var(--muted)">prüfe …</small></span></button><button data-fe><span style="font-size:20px">✏️</span><span>Bearbeiten</span></button></div>`,d=>{
    d.querySelectorAll('[data-fu]').forEach(b=>b.onclick=()=>{closeDlg();unlink(fKey(b.dataset.fu))});
    {const m=d.querySelector('#fsm');fCached(f).then(h=>{m.textContent=h?'✓ ist auf diesem Handy gespeichert':'noch nicht auf dem Handy'});
     d.querySelector('[data-fs]').onclick=async()=>{m.textContent='Wird gespeichert …';try{await fBlob(f);m.textContent=(await fCached(f))?'✓ ist auf diesem Handy gespeichert':'Gespeichert, aber Zwischenspeicher nicht verfügbar'}catch(e){m.textContent='Fehler: '+fErr(e)}}}
    d.querySelector('[data-fo]').onclick=()=>{closeDlg();setTimeout(()=>fOpen(id,day),80)};
    d.querySelector('[data-fe]').onclick=()=>{closeDlg();setTimeout(()=>fEditDlg(id),80)}})}
{let lpT=0,lpX=0,lpY=0,lpEl=null,lpFired=0;
  document.addEventListener('pointerdown',e=>{const o=e.target.closest&&e.target.closest('[data-fopen]');if(!o)return;lpEl=o;lpX=e.clientX;lpY=e.clientY;clearTimeout(lpT);
    lpT=setTimeout(()=>{if(!lpEl)return;lpFired=Date.now();if(navigator.vibrate)try{navigator.vibrate(15)}catch(x){}fMenu(lpEl.dataset.fopen,lpEl.dataset.fday);lpEl=null},500)},true);
  const cancel=e=>{if(!lpEl)return;if(e.type==='pointermove'&&Math.hypot(e.clientX-lpX,e.clientY-lpY)<10)return;clearTimeout(lpT);lpEl=null};
  ['pointerup','pointercancel','pointermove','scroll'].forEach(t=>document.addEventListener(t,cancel,true));
  document.addEventListener('contextmenu',e=>{if(e.target.closest&&e.target.closest('[data-fopen]'))e.preventDefault()},true);
  window.__lpRecent=()=>Date.now()-lpFired<700}
document.addEventListener('click',e=>{const o=e.target.closest&&e.target.closest('[data-fopen]');if(o){e.stopPropagation();e.preventDefault();if(window.__lpRecent())return;fOpen(o.dataset.fopen,o.dataset.fday);return}
  const a=e.target.closest&&e.target.closest('[data-fadd]');if(a){e.stopPropagation();e.preventDefault();fDayDlg(fKey(a.dataset.fadd))}},true);
const D=window.__T.D;
/* Veranstalter-Ausflüge, Fabriken und Quellen gibt es nur in Reisen aus einer Import-Datei – sonst ausblenden */
const HAS_EX=D.ports.some(p=>(p.ex||[]).length),HAS_FA=D.ports.some(p=>(p.fact||[]).length),HAS_SRC=Object.keys(D.src||{}).length>0;
const SRC0=(()=>{try{const sc=[...document.scripts].find(x=>!x.src&&x.textContent.includes('const TYPES='));const bd=document.body.cloneNode(true);bd.querySelectorAll('script').forEach(x=>x.remove());return{main:sc?sc.textContent:null,body:bd.innerHTML,css:[...document.querySelectorAll('style')].map(x=>x.textContent).join('\n')}}catch(e){return null}})();
const TYPES={sight:['Sehenswürdigkeit','--t-sight'],beach:['Strand','--t-beach'],nature:['Natur','--t-nature'],factory:['Fabrik / Plantage','--t-factory'],town:['Ort / Stadt','--t-town']};
const WALK={walk:['Zu Fuß vom Hafen','g'],taxi:['Taxi nötig','y'],tour:['Nur per Ausflug oder Tour','y']};
const $=s=>document.querySelector(s);
/* Zeit-Simulation zum Testen (Einstellungen): verschiebt nur die App-Uhr, nicht Firebase */
let SIM_OFF=0;try{const r=JSON.parse(localStorage.getItem('rp-sim')||'null');if(r&&r.off&&!window.__SEED)SIM_OFF=r.off}catch(e){}
const nowMs=()=>Date.now()+SIM_OFF,nowD=()=>new Date(nowMs());
/* Tageslogik aus dayplan.js (gemeinsam mit dem Server); Kontext liest die aktuellen Werte bei jedem Aufruf */
const DP=RPDP.make({get trip(){return TRIP},get ports(){return D.ports},get plan(){return plan},get picks(){return picks},get din(){return DIN},get ship(){return SHIP},cruise:CRUISE,now:()=>nowMs()});
const todayStr=()=>DP.todayStr();
const KUL=window.__T.KUL;
function kulHTML(p){const L=KUL.L[p.land],P=KUL.P[p.name];if(!L)return '';
  const T=[['g','🏛 Geschichte',(P||[]).concat(L.g)],['p','⚖️ Politik & Alltag',L.p],['k','🎭 Kultur',L.k],['e','🍽 Essen & Trinken',L.e]];
  return '<h3>Land & Leute'+(p.land?' · '+esc(p.land.replace(/\s*\(.*\)$/,'').replace(/^[^,]*, /,'')):'')+'</h3>'+T.map(([k,h,a])=>'<details class="kul"><summary>'+h+'</summary><ul class="tips">'+a.map(t=>'<li>'+esc(t)+'</li>').join('')+'</ul></details>').join('')+'<p class="src" style="margin:6px 0 0">Eigene Kurzzusammenfassung, Stand 2026, ohne Gewähr.</p>'}
var bordView=false;
let TODAY=todayStr();
let prevKey=null;
function seasonKey(){if(prevKey)return prevKey;const t=TODAY,y=t.slice(0,4),md=t.slice(5),SZ=Object.assign({advent:true,xmas:true,nye:true},TRIP.seasons||{});if(specialToday())return 'sp-'+specialToday().style;if(md==='12-31')return SZ.nye?'nye':'std';if(md>='12-24'&&md<='12-26')return SZ.xmas?'xmas':'std';if(!SZ.advent)return 'std';
  // 4. Advent = letzter Sonntag vor dem 25.12.
  const x=new Date(y+'-12-24T12:00:00Z'),a4=addDays(y+'-12-24',-x.getUTCDay()),a1=addDays(a4,-21);
  if(t>=a1&&t<=y+'-12-23'){const n=t<addDays(a1,7)?1:t<addDays(a1,14)?2:t<a4?3:4;return 'adv'+n+(md==='12-06'?'h':'')}return 'std'}
function specialToday(){return (TRIP.special||[]).find(x=>x&&x.date===TODAY)||null}
function applySeasonAttrs(){const r=document.documentElement,k=seasonKey(),m=/^adv(\d)(h?)$/.exec(k);
  {const sp=/^sp-(\w+)$/.exec(k);if(sp)r.setAttribute('data-special',sp[1]);else r.removeAttribute('data-special');
   const e=document.getElementById('spc');if(e)e.textContent=sp?({party:'🎉 🎊 🥳 🎈 🎉 🎊',herz:'❤️ 💕 ❤️ 💖 ❤️ 💕',torte:'🎂 🎁 🎈 🎂 🎁 🎈'}[sp[1]]||'✨ ⭐ ✨ ⭐'):''}
  r.toggleAttribute('data-nye',k==='nye');r.toggleAttribute('data-xmas',k==='xmas');
  if(m){r.setAttribute('data-adv',m[1])}else r.removeAttribute('data-adv');
  r.toggleAttribute('data-hat',!!(m&&m[2]));
  const c=document.getElementById('cdl');if(c){const n=m?+m[1]:0;let h='';for(let i=0;i<4;i++){const x=14+i*27,lit=i<n;h+=`<rect x="${x-4}" y="17" width="8" height="19" rx="1.5" fill="#f4eddc"/><rect x="${x-.7}" y="12.5" width="1.4" height="5" fill="#444"/>`+(lit?`<circle cx="${x}" cy="8" r="9" fill="#ffd25a" opacity=".28"/><path d="M${x} 0C${x-5} 6 ${x-4.5} 10 ${x} 12.5C${x+4.5} 10 ${x+5} 6 ${x} 0Z" fill="#ffb02e"/><path d="M${x} 5C${x-2.4} 8 ${x-2.2} 10 ${x} 11.5C${x+2.2} 10 ${x+2.4} 8 ${x} 5Z" fill="#fff3b0"/>`:'')}c.innerHTML=h}}
applySeasonAttrs();
const esc=s=>String(s==null?'':s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const NS='http://www.w3.org/2000/svg';
const el=(n,a={},p)=>{const e=document.createElementNS(NS,n);for(const k in a)e.setAttribute(k,a[k]);if(p)p.appendChild(e);return e};
const cssv=n=>getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const eur=n=>n.toLocaleString('de-DE')+' €';
const fmtDate=(s,l)=>{const d=new Date(s+'T12:00:00Z');return new Intl.DateTimeFormat('de-DE',{timeZone:'UTC',weekday:l?'long':'short',day:'2-digit',month:'2-digit'}).format(d).replace('.,','.')};
const byDay=n=>D.ports.find(p=>p.day===n);

/* ---------- state ---------- */
let sel=null, tab='ov', filt=new Set(Object.keys(TYPES)), picks={};
try{picks=JSON.parse(localStorage.getItem('rp-'+TRIP_ID+'-picks-v1')||'{}')}catch(e){}
const pickKey=DP.pickKey,isPicked=DP.isPicked;
let picksSync={},planSync={};
const pid=k=>'p_'+k.replace(/[^A-Za-z0-9]/g,'_');
function persistPicks(){
  try{localStorage.setItem('rp-'+TRIP_ID+'-picks-v1',JSON.stringify(picks))}catch(e){}
  if(!dbh||TS.mode!=='db')return;const col=dbh.collection('picks');
  Object.keys(picks).forEach(k=>{if(picksSync[k]!==picks[k]){picksSync[k]=picks[k];col.doc(pid(k)).set({k,v:picks[k]}).catch(tdFail)}});syncPoke();
  Object.keys(picksSync).forEach(k=>{if(!(k in picks)){delete picksSync[k];col.doc(pid(k)).delete().catch(tdFail)}});
}
/* Tagesplan: jeder eigene Eintrag ist ein eigenes Dokument trips/<id>/planitems/<eintrag-id> {d:Tag, o:Reihenfolge, …} */
let planReady=false;
function planIds(){planTipFix();Object.values(plan).forEach(a=>(a||[]).forEach(it=>{if(!it.id)it.id=nid('e')}))}
function persistPlan(){
  planIds();try{localStorage.setItem('rp-'+TRIP_ID+'-plan-v1',JSON.stringify(plan))}catch(e){}
  if(!dbh||TS.mode!=='db'||!planReady)return;const col=dbh.collection('planitems'),cur={};
  Object.entries(plan).forEach(([d,a])=>(a||[]).forEach((it,o)=>{const {id,...r}=it;cur[id]={...r,d:+d,o}}));
  Object.entries(cur).forEach(([id,x])=>{if(JSON.stringify(SYNC['planitems:'+id])!==JSON.stringify(x))fsWrite(col.doc(id),'planitems:'+id,'planitems',x).catch(tdFail)});
  Object.keys(SYNC).forEach(k=>{if(k.startsWith('planitems:')&&!(k.slice(10) in cur)){delete SYNC[k];col.doc(k.slice(10)).delete().catch(tdFail)}});
  syncPoke()}
/* Lange drücken und ziehen zum Sortieren (ToDos, eigene Einträge im Reiseplan/Mein Tag) */
let sortLift=null;
/* Ziehen im Tagesplan setzt die Uhrzeit passend zur neuen Position */
const hhmm=m=>{m=Math.max(0,Math.min(23*60+55,Math.round(m/5)*5));return String(Math.floor(m/60)).padStart(2,'0')+':'+String(m%60).padStart(2,'0')};
function sortTime(key,els,el){
  const day=+key.slice(3),p=byDay(day),k=els.indexOf(el),pi=+el.dataset.sid,it=(plan[day]||[])[pi];if(!it||!p)return renderPanel();
  const A=x=>x.dataset.a===''?null:+x.dataset.a,B=x=>x.dataset.b===''?null:+x.dataset.b;
  const prev=els[k-1],next=els[k+1],st=+el.dataset.st||60,t=it.x?(+it.t||0):10;
  let at=null;
  if(prev&&(B(prev)!=null||A(prev)!=null))at=(B(prev)!=null?B(prev):A(prev)+30)+t;
  else if(next&&A(next)!=null){at=A(next)-st-t;if(p.kind==='port')at=Math.max(at,portWin(p).on)}
  if(at==null)return renderPanel();
  const nv=hhmm(at);if(it.at===nv)return renderPanel();
  const u=planSnap(day),np=plan[day].map(x=>({...x}));np[pi].at=nv;
  // folgende Einträge mit fester Uhrzeit nach hinten schieben, wenn sie sich sonst überschneiden
  let end=tm(nv)+st,moved=0;
  els.slice(k+1).forEach(x=>{if(x.dataset.sortfix){if(B(x)!=null)end=Math.max(end,B(x));return}
    const j=+x.dataset.sid,q=np[j];if(!q)return;const sx=+x.dataset.st||60,tx=q.x?(+q.t||0):10;
    if(q.at){if(tm(q.at)<end+tx){q.at=hhmm(end+tx);moved++}end=tm(q.at)+sx}else end+=tx+sx});
  plan[day]=np;savePlan();renderPanel();renderDays();updatePills();if(sel===day&&pm(p))drawPort(p,true);
  undoToast(`„${rmName(day,pi)}“ auf ${nv} Uhr gelegt${moved?`, ${moved} folgende${moved>1?'':'r'} Eintr${moved>1?'äge':'ag'} nach hinten verschoben`:''}.`,u)}
function sortDrop(key,ids){
  if(key==='task'){const open=ids.map(id=>TS.tasks.find(t=>t.id===id)).filter(Boolean);
    const rest=TS.tasks.filter(t=>t.list===tdList&&tdOpen(t)&&!ids.includes(t.id));
    [...open,...rest].forEach((t,i)=>{if(t.ord!==i*10)tsPutTask({...t,ord:i*10})});renderPanel();return}
  const day=+key.slice(4),L=plan[day]||[],idx=ids.map(Number),used=new Set(idx);
  const np=[...idx.map(i=>L[i]),...L.filter((_,i)=>!used.has(i))];if(JSON.stringify(np)===JSON.stringify(L))return renderPanel();
  plan[day]=np;savePlan();renderPanel();renderDays();updatePills();const p=byDay(day);if(sel===day&&p&&pm(p))drawPort(p,true)}
(function(){let pd=null,tmr=null;
  const cancel=()=>{clearTimeout(tmr);pd=null};
  document.addEventListener('pointerdown',e=>{const fx=e.target.closest&&e.target.closest('[data-sortfix]');if(fx&&e.button<=0){pd={el:null,x:e.clientX,y:e.clientY,id:e.pointerId};clearTimeout(tmr);tmr=setTimeout(()=>{if(!pd)return;pd=null;swJust=Date.now();try{navigator.vibrate&&navigator.vibrate([10,40,10])}catch(x){}undoToast(fx.dataset.fixmsg==='din'?'Die Uhrzeit fürs Abendessen änderst du durch Antippen (nur an diesem Tag) oder in den Einstellungen.':OP+'-Ausflüge haben feste Zeiten und lassen sich nicht verschieben.',null,4000)},430);return}
    const el=e.target.closest&&e.target.closest('[data-sortk]');if(!el||e.button>0||e.target.closest('input,select,textarea,.tsubn,a'))return;
    pd={el,x:e.clientX,y:e.clientY,id:e.pointerId};clearTimeout(tmr);
    tmr=setTimeout(()=>{if(!pd)return;const el=pd.el,r=el.getBoundingClientRect();const nx=el.nextElementSibling;if(nx&&nx.classList.contains('tsubs2'))nx.remove();
      sortLift={el,key:el.dataset.sortk,off:pd.y-r.top,id:pd.id,y:pd.y};el.classList.add('lifted');document.body.classList.add('sorting');try{navigator.vibrate&&navigator.vibrate(15)}catch(x){}},430)});
  document.addEventListener('pointermove',e=>{
    if(pd&&!sortLift&&e.pointerId===pd.id&&Math.hypot(e.clientX-pd.x,e.clientY-pd.y)>8)cancel();
    if(!sortLift||e.pointerId!==sortLift.id)return;e.preventDefault();const L=sortLift,el=L.el;L.y=e.clientY;
    const sib=[...el.parentElement.children].filter(x=>x!==el&&x.dataset&&(x.dataset.sortk===L.key||x.dataset.sortfix===L.key));
    const before=sib.find(x=>{const r=x.getBoundingClientRect();return e.clientY<r.top+r.height/2});
    if(before){if(el.nextElementSibling!==before)before.before(el)}else if(sib.length){const last=sib[sib.length-1];if(last.nextElementSibling!==el)last.after(el)}
    el.style.transform='';const base=el.getBoundingClientRect().top;el.style.transform=`translateY(${e.clientY-L.off-base}px)`;
    const m=60;if(e.clientY<m)window.scrollBy(0,-12);else if(e.clientY>innerHeight-m-60)window.scrollBy(0,12)},{passive:false});
  const end=e=>{if(pd&&e.pointerId===pd.id&&!sortLift)cancel();if(!sortLift||e.pointerId!==sortLift.id)return;const L=sortLift;sortLift=null;pd=null;clearTimeout(tmr);
    L.el.classList.remove('lifted');L.el.style.transform='';document.body.classList.remove('sorting');swJust=Date.now();
    const els=[...L.el.parentElement.children].filter(x=>x.dataset&&(x.dataset.sortk===L.key||x.dataset.sortfix===L.key));
    if(L.key.startsWith('day'))return sortTime(L.key,els,L.el);sortDrop(L.key,els.map(x=>x.dataset.sid))};
  document.addEventListener('pointerup',end);document.addEventListener('pointercancel',end);
  document.addEventListener('touchmove',e=>{if(sortLift)e.preventDefault()},{passive:false});
  document.addEventListener('contextmenu',e=>{if(e.target.closest&&e.target.closest('[data-sortk]'))e.preventDefault()});
})();
/* Wischen nach links zum Löschen (Reiseplan, Mein Tag) */
let swJust=0;
function swDelete(code){const [k,d,x]=code.split('|');
  if(k==='din'){const r=dinRow(byDay(+d));if(r)dinSkip(+d,!r.skip);return}
  if(k==='task'){const T=TS.tasks.find(t=>t.id===d);if(!T)return;const c={...T};tsDelTask(d);renderPanel();undoToast(`Aufgabe „${c.text}“ gelöscht.`,()=>{tsPutTask(c);renderPanel()});return}
  if(k==='trm'){const u=planSnap(+d),n=rmName(+d,+x);plan[+d].splice(+x,1);savePlan();renderPanel();renderDays();updatePills();{const pp=byDay(+d);if(sel===+d&&pp&&pm(pp))drawPort(pp,true)}undoToast(`„${n}“ aus Tag ${d} entfernt.`,u)}
  else{const p=byDay(+d),e=p&&p.ex.find(z=>z.c===x);if(e){const u=picksSnap();setPick(p,e,false);savePlan();renderPanel();renderDays();updatePills();undoToast(`Ausflug ${e.c} abgewählt.`,u)}}}
(function(){let st=null;
  document.addEventListener('pointerdown',e=>{const r=e.target.closest&&e.target.closest('.swr>[data-swdel]');if(!r||!/^task\|/.test(r.dataset.swdel)||e.button>0||e.target.closest('input,select,textarea'))return;st={r,x:e.clientX,y:e.clientY,id:e.pointerId,on:false,dx:0}});
  document.addEventListener('pointermove',e=>{if(!st||e.pointerId!==st.id)return;if(sortLift){st=null;return}const dx=e.clientX-st.x,dy=e.clientY-st.y;
    if(!st.on){if(Math.abs(dy)>12&&Math.abs(dy)>Math.abs(dx)){st=null;return}if(dx<-10&&Math.abs(dx)>Math.abs(dy)*1.4){st.on=true;st.r.classList.add('drag');st.r.parentElement.classList.add('swiping');try{st.r.setPointerCapture(e.pointerId)}catch(x){}}else return}
    st.dx=Math.min(0,dx);st.r.style.transform=`translateX(${st.dx}px)`});
  const end=e=>{if(!st||e.pointerId!==st.id)return;const s0=st;st=null;if(!s0.on)return;swJust=Date.now();s0.r.classList.remove('drag');setTimeout(()=>s0.r.parentElement&&s0.r.parentElement.classList.remove('swiping'),260);
    const w=s0.r.offsetWidth;if(e.type==='pointerup'&&s0.dx<-Math.min(110,w*.35)){s0.r.style.transform=`translateX(${-w}px)`;setTimeout(()=>swDelete(s0.r.dataset.swdel),180)}else s0.r.style.transform=''};
  document.addEventListener('pointerup',end);document.addEventListener('pointercancel',end);
  window.addEventListener('click',e=>{if(Date.now()-swJust<300){e.stopPropagation();e.preventDefault()}},true);
})();
/* Einmalige Tipps: erscheinen, bis man sie mit „Verstanden“ schließt */
const TIPS={todo:'Antippen bearbeitet · nach links wischen löscht · lange drücken und ziehen sortiert.',plan:'Eintrag antippen zum Bearbeiten oder Löschen · lange drücken und an eine andere Stelle ziehen legt ihn auf diese Uhrzeit.',
  port:'Die Stecknadel rechts auf der Karte zeigt Restaurants, Strände, Läden und mehr aus OpenStreetMap.',deck:'Kategorie antippen (z. B. Bars) zeigt alle Treffer an Bord, sortiert nach Nähe. „Weg“ beschreibt den Weg dorthin.',
  today:'Nach links oder rechts wischen wechselt den Tag.'};
const tipDone=()=>{try{return JSON.parse(localStorage.getItem('rp-tips')||'[]')}catch(e){return []}};
function tipHTML(k){if(window.__SEED||tipDone().includes(k)||!TIPS[k])return '';return `<div class="tipx" data-tipbox="${k}"><span>💡</span><p>${TIPS[k]}</p><button data-tipok="${k}">Verstanden</button></div>`}
document.addEventListener('click',e=>{const b=e.target.closest&&e.target.closest('[data-tipok]');if(!b)return;e.stopPropagation();const k=b.dataset.tipok,L=tipDone();if(!L.includes(k))L.push(k);try{localStorage.setItem('rp-tips',JSON.stringify(L))}catch(x){}document.querySelectorAll(`[data-tipbox="${k}"]`).forEach(x=>x.remove())},true);
/* Rückgängig-Hinweis unten mit ablaufendem Balken */
let undoT=null;
function undoToast(msg,restore,ms){ms=ms||7000;let t=document.getElementById('toast');if(!t){t=document.createElement('div');t.id='toast';t.setAttribute('role','status');t.setAttribute('aria-live','polite');document.body.appendChild(t)}
  clearTimeout(undoT);t.className='';t.innerHTML=`<span class="tmsg">${esc(msg)}</span>${restore?'<button class="tundo">Rückgängig</button>':''}<i class="tbar" style="animation-duration:${ms}ms"></i>`;
  void t.offsetWidth;t.className='show';
  const b=t.querySelector('.tundo');if(b)b.onclick=()=>{clearTimeout(undoT);try{restore()}catch(e){}t.innerHTML='<span class="tmsg">Wiederhergestellt.</span>';undoT=setTimeout(()=>t.className='',1800)};
  undoT=setTimeout(()=>{t.className=''},ms)}
/* Meldung wegwischen (seitlich oder nach unten) */
{let tx=null;document.addEventListener('pointerdown',e=>{const t=e.target.closest&&e.target.closest('#toast.show');if(!t)return;tx={t,x:e.clientX,y:e.clientY,id:e.pointerId};t.style.transition='none'},true);
  document.addEventListener('pointermove',e=>{if(!tx||e.pointerId!==tx.id)return;const dx=e.clientX-tx.x,dy=Math.max(0,e.clientY-tx.y);tx.dx=dx;tx.dy=dy;tx.t.style.transform=`translate(calc(-50% + ${dx}px),${dy}px)`;tx.t.style.opacity=String(Math.max(.2,1-Math.max(Math.abs(dx)/220,dy/120)))},true);
  const end=e=>{if(!tx||e.pointerId!==tx.id)return;const t=tx.t,go=Math.abs(tx.dx||0)>70||(tx.dy||0)>40,moved=Math.abs(tx.dx||0)>8||(tx.dy||0)>8;tx=null;if(moved)window.__toastSw=Date.now();t.style.transition='';
    if(go){clearTimeout(undoT);t.style.transform=`translate(calc(-50% + ${(t.style.transform.match(/\+ (-?[\d.]+)px/)||[0,0])[1]>0?'':'-'}120vw),0)`;t.style.opacity='0';setTimeout(()=>{t.className='';t.style.transform='';t.style.opacity=''},250)}
    else{t.style.transform='';t.style.opacity=''}};
  document.addEventListener('pointerup',end,true);document.addEventListener('pointercancel',end,true);
  document.addEventListener('click',e=>{if(e.target.closest&&e.target.closest('#toast')&&Date.now()-(window.__toastSw||0)<400){e.stopPropagation();e.preventDefault()}},true)}
function infoToast(msg,label,fn,ms){ms=ms||9000;undoToast(msg,fn,ms);const b=document.querySelector('#toast .tundo');if(b){b.textContent=label;b.onclick=()=>{clearTimeout(undoT);fn()}}}
if(navigator.serviceWorker)navigator.serviceWorker.addEventListener('message',e=>{if(e.data&&e.data.type==='rp-update'&&!window.__updShown){window.__updShown=1;infoToast('Neue App-Version geladen.','Neu laden',()=>location.reload(),12000)}});
addEventListener('rp-trip-updated',()=>infoToast('Reisedaten wurden aktualisiert.','Neu laden',()=>location.reload()));
const planSnapPre=(day,idx)=>()=>{(plan[day]||[]).splice(idx,1);savePlan();renderPanel();renderDays();updatePills()};
const planSnap=day=>{const c=JSON.parse(JSON.stringify(plan[day]||[]));return()=>{plan[day]=c;savePlan();const p=byDay(+day);if(sel===+day&&p&&p.pois)refreshPlan(p);else{renderPanel();renderDays();updatePills()}}};
const picksSnap=()=>{const c={...picks};return()=>{picks=c;persistPicks();renderTotals();renderPanel();renderDays();updatePills()}};
const rmName=(day,i)=>{const s=(plan[day]||[])[i],p=byDay(+day);if(!s)return 'Eintrag';return s.x?s.n:(p&&p.pois&&p.pois[s.i]?p.pois[s.i].n:'Eintrag')};
function setPick(p,e,v){picks[pickKey(p.day,e.c)]=v;persistPicks();renderTotals()}
function updateBadges(){
  const bs=document.querySelectorAll('#days .day');
  D.ports.forEach((p,i)=>{const b=bs[i];if(!b)return;const g=b.querySelector('.st');if(!g)return;
    const n=(p.ex||[]).filter(e=>e.p&&isPicked(p,e)).length,k=(plan[p.day]||[]).length,ok=n+k>0;
    g.classList.toggle('ok',ok);g.textContent=ok?'✓':'';
    g.title=ok?[n?n+(n>1?' Ausflüge':' Ausflug'):'',k?k+(k>1?' Einträge':' Eintrag'):''].filter(Boolean).join(' · '):'Noch nichts geplant';
    b.setAttribute('aria-label',`Tag ${p.day}, ${p.name}, ${ok?'geplant':'noch nichts geplant'}`)});
}
function pickedFor(days){
  const L=[];days.forEach(d=>{const p=byDay(d);(p.ex||[]).forEach(e=>{if(e.p&&isPicked(p,e))L.push({p,e})})});return L;
}
function updatePills(){
  if(mapKey!=='ov'||!M)return;
  mks.forEach(it=>{if(!it.dayList)return;const n=pickedFor(it.dayList).length;const d=it.g.querySelector('.dot');if(d&&it.baseColor)d.setAttribute('fill',n?cssv('--pick'):it.baseColor);});
  const t=$('#tip');if(t&&!t.hidden&&tipIt)showTip(tipIt);
}
let tipIt=null;
function hideTip(){tipIt=null;const t=$('#tip');if(t)t.hidden=true}
function tipBody(title,days){
  const L=pickedFor(days);let sum=0;L.forEach(({e})=>sum+=e.p);
  const own=[];days.forEach(d=>calc(byDay(d)).rows.forEach(r=>{if(!r.tour)own.push({d,r})}));
  let h=`<b class="h">${esc(title)}</b>`;
  if(L.length)h+=L.map(({p,e})=>`<div class="r"><span>Tag ${p.day} · ${esc(e.c)} ${esc(e.n)}</span><span>${eur(e.p)}</span></div>`).join('')+`<div class="r s"><span>Pro Person</span><span>${eur(sum)}</span></div>`;
  if(own.length)h+=`<div class="r s"><span>Eigener Plan</span><span></span></div>`+own.map(({d,r})=>`<div class="r"><span>${days.length>1?'Tag '+d+' · ':''}${r.a==null?'':hm(r.a)+' '}${esc(r.q.n)}</span><span></span></div>`).join('');
  if(!L.length&&!own.length)h+=`<div class="e">${days.some(d=>byDay(d).kind==='port')?'Kein Ausflug ausgewählt':'Noch nichts geplant'}</div>`;
  return h;
}
function showTip(it){
  const t=$('#tip');if(!t||mapKey!=='ov')return;tipIt=it;
  t.innerHTML=tipBody(it.pname,it.dayList);
  t.hidden=false;
  const w=t.offsetWidth,h=t.offsetHeight;
  let x=Math.max(10,Math.min(cw-w-10,it.px-w/2));
  let y=it.py-h-22;if(y<10)y=Math.min(ch-h-10,it.py+22);
  t.style.left=x+'px';t.style.top=y+'px';
}
let tip2Day=null,tip2El=null;
function tip2At(ev,day){const t=$('#tip2');tip2Day=null;const p=byDay(day);t.innerHTML=tipBody('Tag '+day+' · '+p.name,[day]);t.hidden=false;
  const w=t.offsetWidth,h=t.offsetHeight;let x=ev.clientX+14,y=ev.clientY+16;if(x+w>innerWidth-8)x=ev.clientX-w-14;if(y+h>innerHeight-8)y=ev.clientY-h-14;
  t.style.left=Math.max(8,x)+'px';t.style.top=Math.max(8,y)+'px'}
function hideTip2(){tip2Day=null;const t=$('#tip2');if(t)t.hidden=true}
function showTip2(b,day){
  const t=$('#tip2');if(!t)return;tip2Day=day;tip2El=b;const p=byDay(day);
  t.innerHTML=tipBody('Tag '+day+' · '+p.name,[day]);t.hidden=false;
  const r=b.getBoundingClientRect(),w=t.offsetWidth;
  const h=t.offsetHeight;let y=r.bottom+8;if(y+h>innerHeight-8)y=Math.max(8,r.top-h-8);t.style.left=Math.max(8,Math.min(innerWidth-w-8,r.left+r.width/2-w/2))+'px';t.style.top=y+'px';
}
let plan={};try{plan=JSON.parse(localStorage.getItem('rp-'+TRIP_ID+'-plan-v1'))||{}}catch(e){plan={}}
const savePlan=()=>{persistPlan();mapSoon()};
const hm=RPDP.hm,tm=RPDP.tm,MODE=RPDP.MODE,hav=RPDP.hav,durMin=RPDP.durMin;
function portWin(p){return RPDP.portWin(p)}
function leg(p,a,b){return RPDP.leg(p,a,b)}
function calc(p){return DP.calc(p)}
const moneyU=RPDP.moneyU;
function legTxt(l){return RPDP.legTxt(l)}
function rowTxt(r){
  const time=r.a==null?'':`${hm(r.a)}–${hm(r.b)} `;
  if(r.tour)return `${time}${OP}-Ausflug ${r.q.n} (${r.e.dur||'-'}, ${eur(r.e.p)} p. P.)`;
  const l=r.lg?legTxt(r.lg):'',o=r.q.g.o,n=r.q.g.n;
  const extra=[l&&'Anreise: '+l,o&&'Öffnung: '+o,r.x&&n?n:''].filter(Boolean).join('; ');
  return `${time}${r.q.n}${extra?' ('+extra+')':''}`;
}
function tripText(){
  const out=[];
  D.ports.forEach(p=>{
    const c=calc(p);
    out.push(`Tag ${p.day}, ${fmtDate(p.date)}, ${p.name}${p.land?' ('+p.land+')':''}${p.kind==='port'?', Liegezeit '+p.times:''}`);
    if(!c.rows.length)out.push('  Nichts geplant.');
    c.rows.forEach(r=>out.push('  '+rowTxt(r)));
    if(c.port&&CRUISE&&c.rows.length)out.push(`  Zurück am Schiff ca. ${hm(c.back)}, an Bord spätestens ${hm(c.W.off)}`);
  });
  return out.join('\n');
}
let addMode=null,expKey=null,openSec=new Set();
const rowColor=r=>r.dinner?'#e8590c':r.tour?'var(--accent)':r.x?(r.s&&r.s.lat!=null?'var(--plan)':'var(--muted)'):`var(${TYPES[r.q.t][1]})`;
function fRowsHTML(p){return fOfDay(p.day).map(f=>`<div class="trw tfile"><div class="tm">${fThumb(f)?`<img src="${fThumb(f)}" alt="">`:fIcon(f)}</div><div class="tb"><button class="tfn" data-fopen="${f.id}" data-fday="${p.day}">${esc(f.title)}</button></div></div>`).join('')}
const dayCol=p=>p.kind==='port'?'var(--port)':p.kind==='sea'?'#6f8fa3':'var(--accent)';
function dayView(p,today){
  const c=calc(p),port=p.kind==='port';
  let h=`<div class="tl dcard" style="--c:${dayCol(p)}">`,backDone=!port||!CRUISE||!c.rows.length;
  const mk=(t,txt,cls)=>`<div class="blk mkr${cls?' '+cls:''}"><div class="t">${t}</div><div class="mkt">${txt}</div></div>`;
  const back=()=>{if(backDone)return '';backDone=true;let o='';
    if(c.ret){const rt=legTxt(c.ret);if(rt)o+=`<div class="lg">Rückweg: ${esc(rt)}</div>`}
    const pf=c.slack<0?`${-c.slack} Min zu spät – bitte kürzen (an Bord ${hm(c.W.off)})`:c.slack<30?`nur ${c.slack} Min Puffer (an Bord ${hm(c.W.off)})`:`${c.slack>=90?String(Math.round(c.slack/30)/2).replace('.',',')+' Std.':c.slack+' Min'} Puffer`;
    o+=mk(hm(c.back),`🚢 Zurück an Bord <span class="pf">· ${pf}</span>`,c.slack<0?'bad':c.slack<30?'warnc':'');
    const ex=[c.fee?`Eintritt ca. ${moneyU(c.fee*2,c.u)} für zwei`:'',c.cost?`Taxi ca. ${moneyU(c.cost,c.u)} pro Auto`:''].filter(Boolean).join(' · ');
    if(ex)o+=`<p class="src mkx">${esc(ex)} (Richtwerte)</p>`;return o};
  h+=travelTop(p,1);
  if(port&&CRUISE)h+=mk(hm(c.W.on),'🚢 Ab Schiff');
  const EMPTY=!c.rows.length;if(EMPTY&&!embMarks(p).length)h+=`<p class="dempty">Noch nichts geplant.</p>`;
  const EX=embMarks(p),exFlush=a=>{while(EX.length&&(a==null||EX[0].a<=a)){const x=EX.shift();h+=mk(x.t,x.h)}};
  c.rows.forEach(r=>{if(r.a!=null)exFlush(r.a);if(!backDone&&(r.dinner||r.board))h+=back();
    if(r.dinner){h+=dinBlkHTML(p,r);return}
    const lt=r.lg?legTxt(r.lg):'';if(lt)h+=`<div class="lg">${esc(lt)}</div>`;
    const lv=rowLive(p,r),g=r.q.g;
    const meta=[r.b!=null?`bis ${hm(r.b)}`:`${r.st} Min`,r.tour?`${eur(r.e.p)} p. P.`:'',g.o,!r.tour&&!r.x?(g.f?`Eintritt ca. ${moneyU(g.f,g.u)} p. P.`:g.f===0?'Eintritt frei':''):''].filter(Boolean).join(' · ');
    const del=r.tour?`tcx|${p.day}|${esc(r.e.c)}`:`trm|${p.day}|${r.pi}`;
    const act=r.tour?`data-exinfo="${p.day}|${esc(r.e.c)}"`:r.x?(r.s.lat!=null?`data-pinfo="${p.day}|${r.pi}"`:`data-pedit="${p.day}|${r.pi}"`):`data-tipdlg="${p.day}|${r.s.i}"`;
    h+=`<div class="blk${lv?' '+lv:''}" ${r.tour?`data-sortfix="day${p.day}"`:`data-sortk="day${p.day}" data-sid="${r.pi}"`} data-a="${r.a??''}" data-b="${r.b??''}" data-st="${r.st||60}"><div class="t">${r.a==null?'–':hm(r.a)}</div><div class="swr blkw"><div class="swbg" aria-hidden="true">Löschen 🗑</div><div class="c" style="--c:${rowColor(r)}" data-swdel="${del}" ${act} tabindex="0" role="button">${lv==='live'?liveBadge(p,r):''}<h4>${r.tour?'<span class="tcos">'+esc(OP)+'</span> ':''}${r.x&&r.s.lat!=null?'<span class="tpin">★</span> ':''}${r.x&&r.s.dk?'🛳 ':''}${esc(r.q.n)}</h4><div class="m">${esc(meta)}${r.x&&r.s.dk?` · <span class="tmore" data-dkgo="${r.s.dk}|${r.s.dv}" role="link" tabindex="0">Deckplan ›</span>`:''}</div>${r.x&&g.n?`<div class="m">${esc(g.n)}</div>`:''}</div></div></div>`;
  });
  exFlush(null);h+=back();
  if(!today)h+=`<div class="dyadd"><button class="lnk addpt" data-addmode="eigen">+ Eintrag</button></div>`;
  h+=travelBottom(p)+fRowsHTML(p)+(today?'':`<div class="dyadd dyaddf"><button class="lnk addpt" data-fadd="${p.day}">+ Datei</button></div>`);
  return tvDayHTML(p,'out')+h+`</div>`+tvDayHTML(p,'back');
}
function addArea(p){
  const port=p.kind==='port',modes=[];
  if(p.pois)modes.push(['orte','Orte']);
  if((p.ex||[]).some(e=>e.p&&!e.sold))modes.push(['tour',OP+'-Ausflug']);
  modes.push(['eigen','Eigener Eintrag']);
  if(!addMode)return '';
  let h=`<div class="sheet"><div class="modes">${modes.map(([k,l])=>`<button class="chip" aria-pressed="${addMode===k}" data-addmode="${k}">${l}</button>`).join('')}<button class="chip" data-addmode="">Schließen</button></div>`;
  if(addMode==='orte'&&p.pois){
    const used=new Set((plan[p.day]||[]).map(s=>s.i));
    const rest=p.pois.map((q,i)=>({q,i})).filter(({q,i})=>!used.has(i)&&q.g);
    h+=rest.length?rest.map(({q,i})=>`<div class="addl"><div><b>${esc(q.n)}</b><small>${esc(MODE[q.g.m])} ca. ${q.g.t} Min · ${q.g.s} Min vor Ort${q.g.o?' · '+esc(q.g.o):''}${q.g.v?' · geprüft':''}</small></div><button class="chip btn" data-add="${i}" aria-label="Hinzufügen">+</button></div>`).join(''):'<p class="empty">Alle Orte sind im Plan.</p>';
    h+=`<ul class="tips">${(p.tr||[]).map(t=>`<li>${esc(t)}</li>`).join('')}</ul>`;
  }else if(addMode==='tour'){
    h+=(p.ex||[]).map((e,i)=>e.p&&!e.sold?`<label class="pick addl" style="cursor:pointer"><span><b>${esc(e.c)} · ${esc(e.n)}</b><small>${esc(e.dur||'')} · ${eur(e.p)} p. P.</small></span><input type="checkbox" data-pick="${i}" ${isPicked(p,e)?'checked':''}></label>`:'').join('');
  }else{
    h+=`<form class="cform" id="cf"><input name="n" placeholder="z. B. Frühstück, Poolzeit, Strandbar" required maxlength="80" aria-label="Name">
  <label>Uhrzeit (optional)<input name="at" type="time"></label>${port?'<label>Weg (Min)<input name="t" type="number" min="0" max="240" value="0"></label>':''}
  <label>Dauer (Min)<input name="s" type="number" min="5" max="720" value="60"></label><input name="note" placeholder="Notiz (optional)" maxlength="160" aria-label="Notiz"><button class="chip btn" type="submit">Hinzufügen</button></form>`;
  }
  return h+`</div>`;
}
function plannerHTML(p){return dayView(p)+addArea(p)}
/* ---------- Verlauf (Zurück-Taste) ---------- */
let lastHash=null,dlgPushed=false,scrollMem={},noSave=false;
const saveScroll=()=>{const p=$('#panel');if(p)scrollMem[lastHash||'']={p:p.scrollTop,w:scrollY}};
function restoreScroll(h){const m=scrollMem[h]||{p:0,w:0};noSave=true;const p=$('#panel');if(p){p.style.scrollBehavior='auto';p.scrollTop=m.p;p.style.scrollBehavior=''}window.scrollTo({top:m.w,behavior:'instant'});setTimeout(()=>{noSave=false},120)}
function nav(hash,repl){
  try{const cur=location.hash||'';if(cur!==hash){history[repl?'replaceState':'pushState']({v:1},'',location.pathname+location.search+hash)}lastHash=hash}catch(e){}
}
function dlgOpened(){if(!dlgPushed){dlgPushed=true;try{history.pushState({dlg:1},'',location.href)}catch(e){dlgPushed=false}}}
/* ---------- Sheet-Dialog ---------- */
/* Große Ansichten als eigene Seite: Kopfleiste mit „‹“ links statt ✕ */
function asPage(){const d=$('#dlg');d.classList.add('full','page');const x=d.querySelector('.hd .x');if(x){x.textContent='‹';x.setAttribute('aria-label','Zurück');x.classList.add('pgback');x.onclick=()=>{if(subDepth>0)history.back();else closeDlg()}}}
/* Leere Datums-/Uhrzeitfelder zeigen grau, was hinein gehört (Handy zeigt sonst ein leeres Feld) */
function phMark(r){(r||document).querySelectorAll('input[type=date],input[type=time]').forEach(i=>i.classList.toggle('empty',!i.value))}
['input','change'].forEach(ev=>document.addEventListener(ev,e=>{const t=e.target;if(t&&t.matches&&t.matches('input[type=date],input[type=time]'))t.classList.toggle('empty',!t.value)},true));
function openSheet(html,setup){
  lastFocus=document.activeElement;$('#dlg').classList.remove('wide','full','page');$('#dlg').style.transform='';$('#dlg').style.minHeight='';$('#dlg').innerHTML='<div class="grab" aria-hidden="true"></div>'+V(html);$('#ov').hidden=false;dlgOpened();$('#dlg').scrollTop=0;
  const x=$('#dlg').querySelector('[data-close]');$('#dlg').querySelectorAll('[data-close]').forEach(b=>b.onclick=closeDlg);
  {const h=$('#dlg').querySelector('h2,h3');if(h&&!h.id)h.id='dt'}
  if(setup)setup($('#dlg'));phMark($('#dlg'));
  const f=$('#dlg').querySelector('input:not([type=hidden]),select');if(f&&matchMedia('(pointer:fine)').matches)f.focus();
}
/* Ortssuche (kostenlos, OpenStreetMap über Photon) und Teilen aus Google Maps */
const PHOTON='https://photon.komoot.io/api/';
/* Suchgebiet: alle Stationen der Reise + Rand (verhindert Treffer auf anderen Kontinenten) */
function tripBox(){const P=D.ports.filter(p=>p.lat!=null);if(!P.length)return '';const la=P.map(p=>p.lat),lo=P.map(p=>p.lon),m=1.5;
  return [Math.min(...lo)-m,Math.min(...la)-m,Math.max(...lo)+m,Math.max(...la)+m].map(x=>x.toFixed(3)).join(',')}
async function placeSearch(q,near,any){const one=async qq=>{const bb=any?'':tripBox(),u=PHOTON+'?q='+encodeURIComponent(qq)+'&limit=7&lang=de'+(bb?'&bbox='+bb:'')+(near&&near.lat!=null?'&lat='+near.lat+'&lon='+near.lon+'&location_bias_scale=0.5':'');
    const r=await fetch(u);if(!r.ok)throw new Error('Suche nicht erreichbar ('+r.status+')');return r.json()};
  let j=await one(q);
  // Ersatzsuche: Zusätze wie „– Only Adults“, „(…)“ oder „, Stadt“ weglassen
  const short=q.split(/\s+[-–|·]\s+|\s*\(|,/)[0].trim();if(!(j.features||[]).length&&short&&short!==q&&short.length>=3)j=await one(short);
  return (j.features||[]).map(f=>{const p=f.properties||{},[lon,lat]=f.geometry.coordinates;const street=[p.street,p.housenumber].filter(Boolean).join(' ');
    return {name:p.name||street||p.city||q,addr:[p.name&&street?street:'',p.postcode&&p.city?p.postcode+' '+p.city:(p.city||p.town||p.village||''),p.country].filter(Boolean).join(', '),lat:+lat.toFixed(6),lon:+lon.toFixed(6),kind:p.osm_value||'',country:p.country||'',city:p.city||p.town||p.village||'',hn:p.housenumber||''}})}
/* Google-Maps-Kurzlinks über die Cloud Function „mapLink“ in Koordinaten auflösen (functions/, docs/CLOUD-FUNCTION.md).
   Liefert {lat,lon,name} | {found:false} (Google kennt keine Koordinaten) | null (offline/nicht erreichbar → später nochmal). */
const MAPFN=window.__TEST_MAPLINK||('https://europe-west3-'+((window.FIREBASE_CONFIG||{}).projectId||'')+'.cloudfunctions.net/mapLink');
async function mapResolve(gurl){if(!gurl||navigator.onLine===false)return null;if(!/^https:\/\/(maps\.app\.goo\.gl|goo\.gl|(www\.|maps\.)?google\.)/i.test(gurl))return {found:false};
  let tok='test';if(!window.__TEST_MAPLINK){if(!FBX.user||TS.mode!=='db')return null;try{tok=await FBX.user.getIdToken()}catch(e){return null}}
  try{const r=await fetch(MAPFN,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+tok,...(await acToken().then(t=>t?{'X-Firebase-AppCheck':t}:{}))},body:JSON.stringify({url:gurl,trip:TRIP_ID}),signal:AbortSignal.timeout(15000)});
    if(r.status===400)return {found:false};if(!r.ok)return null;const j=await r.json();return j.found&&j.lat!=null?{lat:+j.lat,lon:+j.lon,name:j.name||'',found:true}:{found:false,name:j.name||''}}catch(e){return null}}
/* Nachholen: Einträge mit Google-Link, aber ohne Pin (z. B. offline geteilt) bekommen ihren Ort, sobald Netz da ist */
let gResBusy=false;
async function gResolveAll(){if(gResBusy||navigator.onLine===false)return;gResBusy=true;const K='rp-'+TRIP_ID+'-gres';let T={};try{T=JSON.parse(localStorage.getItem(K)||'{}')}catch(e){}
  try{const todo=[];Object.values(plan).forEach(a=>(a||[]).forEach(it=>{if(it&&it.gurl&&it.lat==null&&it.id&&(T[it.id]||0)<3)todo.push(it.id)}));
    for(const id of todo){const r=await mapResolve(findItem(id)&&findItem(id).gurl);if(r==null)break;
      const it=findItem(id);if(!it||it.lat!=null)continue;
      if(r.found){it.lat=r.lat;it.lon=r.lon;it.osm='';delete T[id];savePlan();const dd=+Object.keys(plan).find(k=>(plan[k]||[]).includes(it)),p=byDay(dd);renderDays();renderPanel();if(sel===dd&&p&&pm(p))drawPort(p,true);
        infoToast('📍 Ort für „'+it.n+'“ von Google Maps nachgetragen.','Karte ›',()=>{if(p)select(dd)})}
      else T[id]=9}
  }finally{gResBusy=false;try{localStorage.setItem(K,JSON.stringify(T))}catch(e){}}}
function findItem(id){for(const a of Object.values(plan))for(const it of (a||[]))if(it&&it.id===id)return it;return null}
addEventListener('online',()=>setTimeout(gResolveAll,3000));setTimeout(gResolveAll,9000);
const gmLink=l=>l.gurl||('https://www.google.com/maps/search/?api=1&query='+encodeURIComponent(l.addr?l.name+', '+l.addr:l.lat+','+l.lon));
/* Geteilter Google-Maps-Text: Name, Adresse, Link; Koordinaten nur aus langen Links */
function parseShare(title,text,url){const all=[title,text,url].filter(Boolean).join('\n');const m=all.match(/https?:\/\/\S*(maps\.app\.goo\.gl|goo\.gl\/maps|google\.[a-z.]+\/maps|maps\.google\.[a-z.]+)\S*/i);
  const link=m?m[0]:(url||'');const lines=String(text||'').replace(link,'').split(/\n+/).map(x=>x.trim()).filter(Boolean);
  let name=(title&&!/^https?:/.test(title)?title:lines[0])||'',addr=lines.filter(x=>x!==name).join(', ');
  let ll=null;const c=link.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/)||link.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/)||link.match(/[?&](?:q|query|ll)=(-?\d+\.\d+),(-?\d+\.\d+)/);if(c)ll={lat:+c[1],lon:+c[2]};
  if(!name&&link){const n=decodeURIComponent((link.match(/\/place\/([^/@]+)/)||[])[1]||'').replace(/\+/g,' ');name=n}
  return {name:name.slice(0,80),addr:addr.slice(0,160),gurl:link,...(ll||{})}}
function shareCheck(){const q=new URLSearchParams(location.search);if(!(q.get('text')||q.get('url')||q.get('title')))return;
  const sh=parseShare(q.get('title'),q.get('text'),q.get('url'));try{history.replaceState(null,'',location.pathname+location.hash)}catch(e){}
  const tp=D.ports.find(p=>p.date===TODAY),day=tp?tp.day:D.ports[0].day;
  setTimeout(()=>addPointDlg(day,{n:sh.name,pickDay:true,loc:{name:sh.name,addr:sh.addr,gurl:sh.gurl,lat:sh.lat,lon:sh.lon},autoFind:sh.lat==null}),300)}
function addPointDlg(day,pre,ed){pre=pre||{};
  const E=ed?(plan[ed.day]||[])[ed.pi]:null;if(ed&&!E)return;const V=E||{};if(E)day=ed.day;
  const opts=D.ports.map(p=>`<option value="${p.day}" ${p.day===day?'selected':''}>Tag ${p.day} · ${fmtDate(p.date)} · ${esc(p.name)}</option>`).join('');
  const dp=byDay(day);
  openSheet(`<div class="hd"><h3 style="margin:0">${E?'Eintrag bearbeiten':'Neuer Eintrag'}${!E&&dp&&!pre.pickDay?`<small class="hds">Tag ${dp.day} · ${esc(dp.name)}</small>`:''}</h3></div>
  <form class="sform" id="apf">${E||pre.pickDay?`<label>Tag<select name="day">${opts}</select></label>`:`<input type="hidden" name="day" value="${day||1}">`}
  ${(E?V.dk:pre.dk)?(()=>{const dk=E?V.dk:pre.dk,dv=E?V.dv:pre.dv,v=(deckOf(dk)||[0,0,[]])[2][dv];return v?`<p class="dkref">🛳 An Bord · Deck ${dk} ${esc(deckOf(dk)[1])} · ${posTxt(v[1])} · ${sideTxt(v[3]||0)} <button type="button" class="lnk" id="apdk">Deckplan ›</button></p>`:''})():''}
  <label>Was<input name="n" required maxlength="80" placeholder="z. B. Frühstück, Poolzeit, Strandbar" value="${esc(E?V.n:(pre.n||''))}"></label>
  ${(E?V.dk:pre.dk)?'':'<div id="apl"></div>'}
  <div class="two" id="apw"></div><label>Dauer (Min)<input name="s" type="number" min="5" max="720" value="${E?(+V.s||60):60}"></label>${E?'':'<label>Wiederholen<select name="rep"></select></label><div id="aprep"></div>'}
  <label>Notiz (optional)<textarea name="note" maxlength="1000" rows="2" class="autoh">${esc((E?V.note:pre.note)||'')}</textarea></label>
  <div class="btns"><button class="chip btn" type="submit">${E?'Speichern':'Hinzufügen'}</button><button class="chip" type="button" data-close>Abbrechen</button>${E?'<button class="chip del" type="button" id="apdel">Löschen</button>':''}</div></form>`,d=>{
    const f=d.querySelector('#apf'),sync=()=>{const p=byDay(+f.day.value),at=f.at?f.at.value:(E?V.at||'':''),tv=f.t?f.t.value:(E?(+V.t||0):0);
      d.querySelector('#apw').innerHTML=`<label>Uhrzeit (optional)<input name="at" type="time" value="${esc(at)}"></label>`+(p.kind==='port'?`<label>Weg (Min)<input name="t" type="number" min="0" max="240" value="${+tv||0}"></label>`:'');
      if(f.rep){const old=+f.rep.value||0;f.rep.innerHTML='<option value="">Nur an diesem Tag</option>'+D.ports.filter(q=>q.day>p.day).map(q=>`<option value="${q.day}"${q.day===old?' selected':''}>Täglich bis Tag ${q.day} · ${fmtDate(q.date)} · ${esc(q.name)}</option>`).join('');f._rep=null;const ar=d.querySelector('#aprep');if(ar)ar.innerHTML=''}};
    if(f.day.tagName==='SELECT')f.day.onchange=()=>{sync();plDraw()};sync();
    f.addEventListener('change',e=>{if(['at','s','rep'].includes(e.target.name)&&f._rep!==undefined){f._rep=null;const ar=d.querySelector('#aprep');if(ar)ar.innerHTML=''}});
    // Ort: gewählt (Pin auf der Karte, Weg) oder suchen
    let loc=E?(E.lat!=null?{name:E.n,lat:E.lat,lon:E.lon,addr:E.addr||'',gurl:E.gurl||'',osm:E.osm||'',o:E.o}:null):(pre.loc||(pre.lat!=null?{name:pre.n,lat:pre.lat,lon:pre.lon,osm:pre.osm||'',o:pre.o}:null));
    const pl=d.querySelector('#apl');let plT=0,plRes=[],ship=null;
    const plDraw=()=>{if(!pl)return;const p=byDay(+f.day.value);
      if(ship){const v=(deckOf(ship.dk)||[0,'',[]])[2][ship.dv];pl.innerHTML=`<div class="plsel"><span>🛳</span><div><b>${esc(v?v[0]:'An Bord')}</b><small>An Bord · Deck ${ship.dk} ${esc((deckOf(ship.dk)||[])[1]||'')}${v?' · '+posTxt(v[1]):''}</small><div class="acts"><button type="button" class="lnk" data-shipx>anderen Ort</button></div></div></div>`;pl.querySelector('[data-shipx]').onclick=()=>{ship=null;plDraw()};return}
      if(loc&&loc.lat!=null)pl.innerHTML=`<div class="plsel"><span>📍</span><div><b>${esc(loc.name||f.n.value||'Ort')}</b><small>${esc(loc.addr||'')}${loc.addr?' · ':''}auf der Karte</small><div class="acts"><a class="lnk" href="${esc(gmLink(loc))}" target="_blank" rel="noopener">Google Maps ›</a><button type="button" class="lnk" data-plx>anderen Ort</button><button type="button" class="lnk" data-pldel>Ort entfernen</button>${STAY_ON&&!E?'<button type="button" class="lnk" data-asstay>🛏 Als Unterkunft ›</button>':''}</div></div></div>`;
      else pl.innerHTML=`${loc&&loc.gurl?`<p class="src" style="margin:0 0 4px">🔗 Google-Maps-Link gespeichert${loc.addr?' · '+esc(loc.addr):''}</p>`:''}<div class="sfield" style="margin:0"><svg class="sfi" viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg><input id="plq" type="search" autocomplete="off" placeholder="📍 Ort suchen (optional)" value="${esc(pl._q||'')}"></div><div id="plr"></div>`;
      const q=pl.querySelector('#plq');if(q){q.oninput=()=>{pl._q=q.value;clearTimeout(plT);plT=setTimeout(plFind,450)};if(pl._q)plList()}
      const x=pl.querySelector('[data-plx]');if(x)x.onclick=()=>{const g=loc&&loc.gurl,a=loc&&loc.addr;pl._q=(loc&&loc.name)||f.n.value;loc=g?{gurl:g,addr:a,name:loc.name}:null;plDraw();plFind()};
      const as=pl.querySelector('[data-asstay]');if(as)as.onclick=()=>{const dd=+f.day.value;stayDlg(null,Math.min(dd,D.ports.length-1),{id:nid('s'),n:f.n.value.trim()||loc.name||'',lat:loc.lat,lon:loc.lon,addr:loc.addr||'',d1:Math.min(dd,D.ports.length-1),d2:Math.min(dd,D.ports.length-1)+1,ci:'15:00',co:'11:00',ref:'',note:''})};
      const dl=pl.querySelector('[data-pldel]');if(dl)dl.onclick=()=>{loc=loc&&loc.gurl?{gurl:loc.gurl,addr:loc.addr,name:loc.name}:null;pl._q='';plDraw()}};
    // Treffer als deutliche Auswahl: Frage, höchstens 3 Karten, „Weitere“, „Keiner davon“
    const plList=()=>{const r=pl.querySelector('#plr');if(!r)return;const all=plRes.length,L=plRes.more?plRes:plRes.slice(0,3);
      r.innerHTML=plRes.msg?`<p class="src" style="margin:6px 0 0">${esc(plRes.msg)}</p>`:!all?'':`<p class="plask">Welcher Ort ist gemeint? Bitte antippen:</p>`+L.map((x,i)=>`<button type="button" class="plres" data-pi="${i}"><span class="pli">${x.ship?'🛳':'📍'}</span><span class="plt"><b>${esc(x.name)}</b><small>${esc(x.addr)}</small></span><span class="plgo">Wählen ›</span></button>`).join('')
        +`<div class="acts" style="margin:4px 0 0">${all>L.length?`<button type="button" class="lnk" data-plmore>Weitere Treffer (${all-L.length}) ›</button>`:''}<button type="button" class="lnk" data-plnone>Keiner davon</button></div>`;
      const mo=r.querySelector('[data-plmore]');if(mo)mo.onclick=()=>{plRes.more=1;plList()};
      const no=r.querySelector('[data-plnone]');if(no)no.onclick=()=>{plRes=[];plRes.msg=loc&&loc.gurl?'Ohne Pin – der Google-Maps-Link bleibt gespeichert. Du kannst oben auch anders suchen.':'Dann ohne Ort speichern – oder oben anders suchen.';plList()};
      r.querySelectorAll('[data-pi]').forEach(b=>b.onclick=()=>{const x=plRes[+b.dataset.pi];if(x.ship){ship={dk:x.dk,dv:x.dv};loc=loc&&loc.gurl?{gurl:loc.gurl}:null;if(!f.n.value.trim())f.n.value=x.name.replace(/\s*\(.*\)$/,'');pl._q='';plRes=[];plDraw();return}ship=null;loc={...(loc&&loc.gurl?{gurl:loc.gurl}:{}),name:x.name,addr:x.addr,lat:x.lat,lon:x.lon};if(!f.n.value.trim())f.n.value=x.name;pl._q='';plRes=[];plDraw()})};
    const shipFind=q=>{if(!CRUISE||typeof SHIP==='undefined'||!SHIP.dk)return [];const t=nrm(q),o=[];SHIP.dk.forEach(([n,nm,V])=>V.forEach((v,i)=>{if(nrm(v[0]).includes(t))o.push({ship:1,dk:n,dv:i,name:v[0],addr:'An Bord · Deck '+n+' '+nm+' · '+posTxt(v[1])})}));return o.slice(0,5)};
    const plFind=async()=>{const q=(pl._q||'').trim();if(q.length<3){plRes=[];plList();return}const SH=shipFind(q);if(SH.length&&(navigator.onLine===false||(byDay(+f.day.value)||{}).kind==='sea')){plRes=SH;plList();return}if(navigator.onLine===false){plRes=[];plRes.msg=loc&&loc.gurl?'Offline: Einfach speichern – der Pin wird automatisch nachgetragen, sobald Internet da ist.':'Die Ortssuche braucht Internet.';plList();return}
      const p=byDay(+f.day.value);try{plRes=SH.concat(await placeSearch(q,p&&p.lat!=null?p:null));if(!plRes.length)plRes.msg=loc&&loc.gurl?(loc.later?'Einfach speichern – der Pin wird automatisch von Google Maps nachgetragen, sobald es geht.':'Im Reisegebiet nicht gefunden. Du kannst den Eintrag trotzdem speichern – der Google-Maps-Link bleibt erhalten (nur kein Pin auf unserer Karte).'):'Im Reisegebiet nichts gefunden – anders schreiben oder ohne Ort speichern.'}catch(e){plRes=SH.slice();if(!SH.length)plRes.msg='Suche gerade nicht erreichbar.'}plList()};
    plDraw();
    const nameFind=()=>{if(!(loc&&loc.name))return plDraw();pl._q=[loc.name,loc.addr].filter(Boolean).join(' ');plDraw();plFind().then(()=>{if(plRes.length===1||(plRes[0]&&loc.addr&&plRes[0].name&&plRes[0].name.toLowerCase()===String(loc.name).toLowerCase())){const x=plRes[0];loc={...loc,lat:x.lat,lon:x.lon,addr:loc.addr||x.addr};pl._q='';plRes=[];plDraw()}})};
    if(pre.autoFind&&loc&&loc.gurl){pl.innerHTML='<p class="src" style="margin:0">📍 Ort wird bei Google Maps nachgeschlagen …</p>';
      mapResolve(loc.gurl).then(async r=>{if(!d.isConnected)return;if(r&&r.found){loc={...loc,lat:r.lat,lon:r.lon,name:loc.name||r.name};if(!f.n.value.trim()&&r.name)f.n.value=r.name;plDraw();return}
        // Google nennt oft nur „Name, Straße, Ort, Land“ – dann gezielt nach der Anschrift suchen
        const parts=String(r&&r.name||'').split(',').map(x=>x.trim()).filter(Boolean);
        if(parts.length>=3){pl.innerHTML='<p class="src" style="margin:0">📍 Anschrift wird gesucht …</p>';
          // nacheinander: ganze Anschrift → ohne Bundesstaat/PLZ → Straße + Ort → Name + Ort
          const A=parts.slice(1,-1),clean=A.map(x=>x.replace(/\b[A-Z]{2}\s*\d{4,5}(-\d{4})?\b/,'').replace(/^\d{4,5}\s+/,'').trim()).filter(Boolean),tries=[...new Set([A.join(', '),clean.join(', '),clean.slice(0,2).join(', '),[parts[0],clean[clean.length-1]].join(', ')])];
          for(const q of tries){try{const R=await placeSearch(q,null,true);if(!d.isConnected)return;if(R.length){const x=R[0];loc={...loc,lat:x.lat,lon:x.lon,addr:parts.slice(1).join(', ')};if(!f.n.value.trim())f.n.value=parts[0];plDraw();return}}catch(e){break}}}
        if(r==null&&loc)loc.later=1;nameFind()})}
    else if(pre.autoFind&&loc&&loc.name)nameFind();
    const ah=f.note;const grow=()=>{ah.style.height='auto';ah.style.height=Math.min(240,ah.scrollHeight+2)+'px'};ah.addEventListener('input',grow);setTimeout(grow,0);
    const after=dd=>{savePlan();closeDlg();const p=byDay(dd);if(sel===dd&&pm(p))drawPort(p,true);else if(E&&sel===ed.day&&pm(byDay(ed.day)))drawPort(byDay(ed.day),true);renderPanel();renderDays();updatePills()};
    f.onsubmit=ev=>{ev.preventDefault();const dd=+f.day.value,p=byDay(dd),n=f.n.value.trim();if(!n)return;
      const dkk=ship?{dk:ship.dk,dv:ship.dv}:E?(E.dk?{dk:E.dk,dv:E.dv}:{}):(pre.dk?{dk:pre.dk,dv:pre.dv}:{});
      const keep={...(!ship&&loc&&loc.lat!=null?{lat:loc.lat,lon:loc.lon,osm:loc.osm||'',...(loc.o?{o:loc.o}:{})}:{}),...(loc&&loc.addr?{addr:loc.addr}:{}),...(loc&&loc.gurl?{gurl:loc.gurl}:{}),...dkk};
      const it={x:1,n,s:Math.max(5,+f.s.value||60),t:p.kind==='port'?Math.max(0,+(f.t&&f.t.value)||0):0,at:(f.at&&f.at.value)||'',note:f.note.value.trim(),...keep};
      if(E){const u1=planSnap(ed.day),u2=dd!==ed.day?planSnap(dd):null;if(dd===ed.day)plan[dd][ed.pi]=it;else{plan[ed.day].splice(ed.pi,1);(plan[dd]=plan[dd]||[]).push(it)}after(dd);
        if(dd!==ed.day)undoToast(`„${n}“ auf Tag ${dd} verschoben.`,()=>{u1();u2()},5000)}
      else if(f.rep&&+f.rep.value>dd){const to=+f.rep.value,days=D.ports.filter(q=>q.day>=dd&&q.day<=to).map(q=>q.day),a0=it.at?tm(it.at):null;
        // Überschneidungen nur bei fester Uhrzeit prüfen
        const conf=a0==null?[]:days.map(x=>{const r=calc(byDay(x)).rows.find(r=>r.a!=null&&!r.skip&&r.a<a0+it.s&&(r.b!=null?r.b:r.a+(r.st||60))>a0);return r?{day:x,n:r.dinner?'Abendessen':r.tour?OP+'-Ausflug '+r.e.c:r.q.n,a:r.a}:null}).filter(Boolean);
        if(conf.length&&!f._rep){const ar=d.querySelector('#aprep');ar.innerHTML=`<div class="repw"><b>⚠ Überschneidung an ${conf.length} ${conf.length>1?'Tagen':'Tag'}</b>${conf.map(c=>`<small>Tag ${c.day}: ${esc(c.n)} um ${hm(c.a)}</small>`).join('')}<div class="acts" style="margin-top:6px"><button type="button" class="lnk" data-rep="skip">Diese Tage auslassen ›</button><button type="button" class="lnk" data-rep="all">Trotzdem überall eintragen ›</button></div></div>`;
          ar.querySelectorAll('[data-rep]').forEach(b=>b.onclick=()=>{f._rep=b.dataset.rep;f.requestSubmit()});ar.scrollIntoView({block:'nearest',behavior:'smooth'});return}
        const skip=new Set(f._rep==='skip'?conf.map(c=>c.day):[]),use=days.filter(x=>!skip.has(x)),U=use.map(x=>planSnap(x)),rid=nid('r');
        use.forEach(x=>{const P2=byDay(x);(plan[x]=plan[x]||[]).push({...it,t:P2.kind==='port'?it.t:0,rep:rid})});after(dd);
        undoToast(`„${n}“ an ${use.length} Tagen eingetragen (Tag ${use[0]}–${use[use.length-1]})${skip.size?' · '+skip.size+' ausgelassen':''}.`,()=>U.forEach(u=>u()),6000)}
      else{(plan[dd]=plan[dd]||[]).push(it);after(dd);if(pre.dk)undoToast(`„${n}“ zu Tag ${dd} hinzugefügt.`,planSnapPre(dd,plan[dd].length-1),4000)}};
    const ak=d.querySelector('#apdk');if(ak)ak.onclick=()=>dkShow(E?V.dk:pre.dk,E?V.dv:pre.dv);
    const del=d.querySelector('#apdel');if(del)del.onclick=()=>{const u=planSnap(ed.day);plan[ed.day].splice(ed.pi,1);after(ed.day);undoToast(`„${V.n}“ aus Tag ${ed.day} entfernt.`,u)};
  });
}

/* ---------- Listen und Aufgaben ---------- */
/* Mitreisende: kommen aus den Anmeldungen (trips/<id>/members/<uid>); ohne Firebase aus TRIP.people */
var MEMBERS=[],PEOPLE=[],PN={},PNAMES='euch';
const MCOL=['var(--accent)','var(--t-factory)','#e8590c','#2f9e44','#c2255c','#1971c2','#7048e8','#868e96'];
try{MEMBERS=JSON.parse(localStorage.getItem('rp-'+TRIP_ID+'-members')||'[]')}catch(e){}
/* Aussehen je Reise (Felder in trips/<id>: look, arrival, vehicle, seasons, special) – Standard aus kind/flight */
const VEH={
 car:'<path d="M5 21v-4.5c0-1.6 1.1-2.7 2.7-3L15 12l6.5-6h17l7.5 6 6.3 1c1.8.3 2.7 1.5 2.7 3.2V21z" fill="#d6452a"/><path d="M23 7.6h7.2v4.6H18.2zM32.2 7.6h6.2l5.4 4.6H32.2z" fill="#bfe3ec"/><text x="34" y="18.6" text-anchor="middle" font-family="Arial,Helvetica,sans-serif" font-weight="800" font-size="4.4" fill="#fff">··</text><circle cx="16" cy="22" r="4.6" fill="#222"/><circle cx="16" cy="22" r="1.9" fill="#ccc"/><circle cx="45" cy="22" r="4.6" fill="#222"/><circle cx="45" cy="22" r="1.9" fill="#ccc"/>',
 camper:'<rect x="4" y="5" width="40" height="17" rx="3" fill="#fff" stroke="#9bb7c7" stroke-width=".8"/><path d="M44 9h6l6 7v6H44z" fill="#fff" stroke="#9bb7c7" stroke-width=".8"/><path d="M45.5 10.5h4l4.2 5h-8.2z" fill="#bfe3ec"/><rect x="4" y="15" width="52" height="2.4" fill="#2f9e44"/><rect x="9" y="8" width="8" height="5" rx="1" fill="#bfe3ec"/><rect x="21" y="8" width="8" height="5" rx="1" fill="#bfe3ec"/><text x="38" y="12.6" text-anchor="middle" font-family="Arial,Helvetica,sans-serif" font-weight="800" font-size="4" fill="#2f9e44">··</text><circle cx="14" cy="22.5" r="4.4" fill="#222"/><circle cx="14" cy="22.5" r="1.8" fill="#ccc"/><circle cx="47" cy="22.5" r="4.4" fill="#222"/><circle cx="47" cy="22.5" r="1.8" fill="#ccc"/>',
 train:'<path d="M3 8a3 3 0 0 1 3-3h40c5 0 10 5 11 13v3H3z" fill="#d6452a"/><g fill="#bfe3ec"><rect x="7" y="8" width="7" height="5" rx="1"/><rect x="17" y="8" width="7" height="5" rx="1"/><rect x="27" y="8" width="7" height="5" rx="1"/><path d="M45 8h2c3 0 6 3 7 6h-9z"/></g><rect x="3" y="15" width="54" height="1.6" fill="#fff"/><text x="40" y="12.4" text-anchor="middle" font-family="Arial,Helvetica,sans-serif" font-weight="800" font-size="4" fill="#fff">··</text><g fill="#222"><circle cx="11" cy="22.5" r="2.8"/><circle cx="19" cy="22.5" r="2.8"/><circle cx="41" cy="22.5" r="2.8"/><circle cx="49" cy="22.5" r="2.8"/></g><rect x="1" y="25.3" width="58" height="1.2" fill="#8a7a5a"/>',
 bus:'<rect x="3" y="5" width="54" height="17" rx="3.5" fill="#ffd25a"/><g fill="#bfe3ec"><rect x="7" y="8" width="7" height="6" rx="1"/><rect x="17" y="8" width="7" height="6" rx="1"/><rect x="27" y="8" width="7" height="6" rx="1"/><rect x="37" y="8" width="7" height="6" rx="1"/><path d="M47 8h5a2 2 0 0 1 2 2v4h-7z"/></g><rect x="3" y="16" width="54" height="1.6" fill="#d6452a"/><text x="22" y="20.6" text-anchor="middle" font-family="Arial,Helvetica,sans-serif" font-weight="800" font-size="3.6" fill="#7a5b00">··</text><circle cx="14" cy="22.5" r="4.2" fill="#222"/><circle cx="14" cy="22.5" r="1.7" fill="#ccc"/><circle cx="46" cy="22.5" r="4.2" fill="#222"/><circle cx="46" cy="22.5" r="1.7" fill="#ccc"/>',
 suitcase:'<path d="M24 6V3.5a1.5 1.5 0 0 1 1.5-1.5h9A1.5 1.5 0 0 1 36 3.5V6" fill="none" stroke="#5b4a2a" stroke-width="2"/><rect x="18" y="6" width="24" height="18" rx="3" fill="#d6452a"/><rect x="18" y="11" width="24" height="1.4" fill="#a8341f"/><rect x="18" y="18" width="24" height="1.4" fill="#a8341f"/><circle cx="30" cy="15" r="3.6" fill="#ffd25a"/><text x="30" y="16.4" text-anchor="middle" font-family="Arial,Helvetica,sans-serif" font-weight="800" font-size="3.4" fill="#7a2a14">··</text><circle cx="22" cy="25.5" r="1.8" fill="#222"/><circle cx="38" cy="25.5" r="1.8" fill="#222"/>'};
function applyLook(){const r=document.documentElement;r.setAttribute('data-look',TRIP.look||(TRIP.kind==='roadtrip'?'roadtrip':TRIP.kind==='staedtereise'?'stadt':'meer'));
  const V=TRIP.vehicle||(TRIP.kind==='kreuzfahrt'?'ship':TRIP.kind==='roadtrip'?'car':'suitcase'),A=TRIP.arrival||(TRIP.flight===false?'none':'plane');
  const sh=document.querySelector('.tl-ship'),pl=document.querySelector('.tl-plane');
  if(sh&&V!=='ship'&&VEH[V]&&!sh.dataset.v){sh.innerHTML=VEH[V];sh.dataset.v=V}
  if(pl&&A!=='plane'&&!pl.dataset.v){pl.dataset.v=A;if(VEH[A])pl.innerHTML=VEH[A]}
  r.setAttribute('data-arr',A);
  const I=Object.keys(PN).sort().join('').slice(0,3);document.querySelectorAll('.tl-ship text,.tl-plane text').forEach(t=>t.textContent=I);
  const ttl=document.querySelector('.ttl .sub');if(ttl&&TRIP.kind&&TRIP.kind!=='kreuzfahrt')ttl.textContent='Interaktive Planung. Station oder Tag anklicken.'}
function updatePeople(){const M=MEMBERS.length?MEMBERS:(TRIP.people||[]).map((x,i)=>({n:x.n,l:x.l,c:i}));
  PEOPLE=M.map(x=>x.n);PN=Object.fromEntries(M.map(x=>[x.l,x.n]));if(typeof applyLook==='function'&&document.querySelector('.tl-ship'))try{applyLook()}catch(e){}PNAMES=PEOPLE.length>1?PEOPLE.slice(0,-1).join(', ')+' und '+PEOPLE[PEOPLE.length-1]:(PEOPLE[0]||'euch')}
updatePeople();applyLook();
function pColor(w){const m=MEMBERS.find(x=>x.n===w);const i=m?(+m.c||0):Math.max(0,PEOPLE.indexOf(w));return MCOL[i%MCOL.length]}
/* Persönliche Daten je Google-Konto in Firebase (config/user_<uid>): Zuhause, Spider-Spielstand und -Statistik.
   Spielstand als Text (Firestore erlaubt keine verschachtelten Listen), ohne Rückgängig-Verlauf. */
const lsG=k=>{try{return localStorage.getItem(k)}catch(e){return null}},lsS=(k,v)=>{try{v==null?localStorage.removeItem(k):localStorage.setItem(k,v)}catch(e){}};
const UPK=()=>FBX.user&&FBX.real?FBX.real.collection('config').doc('user_'+FBX.user.uid):null;
function upPush(o){const r=UPK();if(r)r.set(o,{merge:true}).catch(()=>{})}
function homeGet(){try{return JSON.parse(lsG('rp-home')||'null')}catch(e){return null}}
function homeSet(x){x=x?JSON.parse(JSON.stringify(x)):null;lsS('rp-home',x?JSON.stringify(x):null);upPush({home:x})}
const spLite=t=>{if(!t||t==='null')return 'null';try{const g=JSON.parse(t);if(g)g.hist=[];return JSON.stringify(g)}catch(e){return 'null'}};
function spPushSoon(){clearTimeout(spPushSoon.t);spPushSoon.t=setTimeout(()=>upPush({spider:{g:spLite(lsG('rp-spider')),ts:+lsG('rp-spider-ts')||Date.now()},spst:{s:lsG('rp-spider-stats')||'{}',ts:+lsG('rp-spider-stats-ts')||0}}),2500)}
function upInit(){const r=UPK();if(!r)return;r.onSnapshot(d=>{const v=(d.exists&&d.data())||{};let push=false;
  if(v.home)lsS('rp-home',JSON.stringify(v.home));else if(homeGet())upPush({home:homeGet()});
  const lt=+lsG('rp-spider-ts')||0,rt=v.spider?+v.spider.ts||0:0;if(rt>lt){lsS('rp-spider',v.spider.g||'null');lsS('rp-spider-ts',String(rt))}else if(lt>rt)push=true;
  const ls=+lsG('rp-spider-stats-ts')||0,rs=v.spst?+v.spst.ts||0:0;if(rs>ls){lsS('rp-spider-stats',v.spst.s||'{}');lsS('rp-spider-stats-ts',String(rs))}else if(ls>rs||(!v.spst&&lsG('rp-spider-stats')))push=true;
  if(push){if(!lsG('rp-spider-stats-ts')&&lsG('rp-spider-stats'))lsS('rp-spider-stats-ts',String(Date.now()));spPushSoon()}},()=>{})}
function memInit(db,uid){
  let first=true;
  db.collection('members').onSnapshot({includeMetadataChanges:true},s=>{
    const L=s.docs.map(d=>({id:d.id,...d.data()})).filter(x=>x.n).sort((a,b)=>(a.ts||0)-(b.ts||0));
    if(!s.metadata.fromCache&&first){first=false;if(!L.some(x=>x.id===uid)){
      const u=FBX.user||{},n=String(u.displayName||u.email||'Ich').trim().split(/[\s@]+/)[0]||'Ich',used=new Set(L.map(x=>x.l)),usedC=new Set(L.map(x=>+x.c));
      let l=n[0].toUpperCase();if(used.has(l))l=n.slice(0,2);let c=0;while(usedC.has(c))c++;
      db.collection('members').doc(uid).set({n,l,c,ts:Date.now()}).catch(()=>{});return}}
    MEMBERS=L;try{localStorage.setItem('rp-'+TRIP_ID+'-members',JSON.stringify(L))}catch(e){}updatePeople();
    const me=L.find(x=>x.id===uid);if(me&&FAV.l!==me.l){FAV.l=me.l;favSave();favPush()}
    tdChanged();if(drkRb&&document.getElementById('drb'))drkRb()},()=>{})}
function memMe(){return FBX.user&&MEMBERS.find(x=>x.id===FBX.user.uid)}
const TS={lists:[],tasks:[],mode:'local',ready:false,err:''};
let tdList=(()=>{try{return localStorage.getItem('rp-'+TRIP_ID+'-td-list')}catch(e){return null}})(),tdWho='all',tdDone=false,tdSync=null;
const today=()=>nowD().toLocaleDateString('sv-SE');
const nid=p=>p+Date.now().toString(36)+Math.random().toString(36).slice(2,6);
const tdStore=()=>{try{localStorage.setItem('rp-'+TRIP_ID+'-todo-v1',JSON.stringify({lists:TS.lists,tasks:TS.tasks}))}catch(e){}};
let dbh=null;
function tdChanged(){renderBell();if(todoView)renderPanel()}
function tdFail(e){TS.err=e&&e.code==='permission-denied'?'Kein Schreibzugriff für dieses Google-Konto':'Speichern fehlgeschlagen'+(e&&(e.code==='quota_exceeded'||e.code==='resource-exhausted')?' (Speicher voll)':'');tdChanged()}
/* Firebase: Google-Anmeldung = geteilter Modus, abgemeldet = lokaler Modus */
const FBX={on:false,db:null,auth:null,user:null};
function fbReadErr(e){TS.err=e&&e.code==='permission-denied'?'Kein Zugriff für '+((FBX.user&&FBX.user.email)||'dieses Konto')+'. Bitte abmelden und mit dem richtigen Google-Konto anmelden.':'Lesefehler: '+(e&&e.code||'');tdChanged()}
async function fbInit(){
  if(window.__SEED||!window.firebase||!window.FIREBASE_CONFIG||!FIREBASE_CONFIG.apiKey)return null;
  try{
    const app=firebase.apps.length?firebase.app():firebase.initializeApp(FIREBASE_CONFIG);
    FBX.auth=firebase.auth();FBX.on=true;
    const u=await new Promise(r=>{const off=FBX.auth.onAuthStateChanged(x=>{off();r(x)})});
    FBX.user=u;FBX.auth.onAuthStateChanged(x=>{if((x&&x.uid)!==(FBX.user&&FBX.user.uid)){let n=0;try{const o=JSON.parse(sessionStorage.getItem('rp-rl')||'{}');n=Date.now()-(o.t||0)<20000?(o.n||0):0;sessionStorage.setItem('rp-rl',JSON.stringify({t:Date.now(),n:n+1}))}catch(e){}if(n<2)location.reload()}});
    if(!u){gateShow('in');return null}
    {const real=firebase.firestore(),base=real.collection('trips').doc(TRIP_ID);FBX.real=real;FBX.db={collection:n=>base.collection(n),settings:o=>real.settings(o),enablePersistence:o=>real.enablePersistence(o),enableNetwork:()=>real.enableNetwork(),disableNetwork:()=>real.disableNetwork()}}
    FBX.lp=(()=>{try{return localStorage.getItem('rp-fs-lp')==='1'}catch(e){return false}})();
    if(FBX.lp)try{FBX.db.settings({experimentalForceLongPolling:true,merge:true})}catch(e){}
    try{await FBX.db.enablePersistence({synchronizeTabs:true})}catch(e){}
    FBX.db.collection('lists').limit(1).get().catch(e=>{if(e&&e.code==='permission-denied')gateShow('deny')});
    gateHide();
    return u;
  }catch(e){gateHide();TS.err='Firebase nicht erreichbar';return null}
}
function gateShow(k,msg){
  let g=document.getElementById('gate');if(!g){g=document.createElement('div');g.id='gate';document.body.appendChild(g)}
  const mail=FBX.user&&FBX.user.email||'';
  g.innerHTML='<div class="gbox" role="dialog" aria-modal="true" aria-labelledby="gt"><h1 id="gt">'+esc(TRIP.title||'Reiseplaner')+'</h1>'+
   (k==='deny'?'<p class="bad">Kein Zugriff für '+esc(mail)+'.</p><p>Bitte mit einem freigegebenen Google-Konto anmelden.</p><button data-fbswitch>Anderes Konto wählen</button>'
     :'<p>Reiseplanung. Bitte mit Google anmelden.</p><button data-fbin>Mit Google anmelden</button>')+
   (navigator.onLine===false?'<p class="bad" style="margin:14px 0 0">Keine Internetverbindung. Anmelden geht nur online; unterwegs die Offline-Version nutzen.</p>':'')+
   (msg?'<p class="bad" style="margin:14px 0 0">'+esc(msg)+'</p>':'')+'</div>';
  document.documentElement.classList.add('gated');
}
function gateHide(){const g=document.getElementById('gate');if(g)g.remove();document.documentElement.classList.remove('gated')}
async function fbSignIn(){
  if(!FBX.auth)return;const p=new firebase.auth.GoogleAuthProvider();p.setCustomParameters({prompt:'select_account'});
  try{await FBX.auth.signInWithPopup(p)}catch(e){
    if(e&&/popup-blocked|operation-not-supported/.test(e.code||'')){try{sessionStorage.setItem('rp-redir','1')}catch(x){}return FBX.auth.signInWithRedirect(p)}
    if(e&&!/popup-closed|cancelled-popup/.test(e.code||'')){const m='Anmeldung fehlgeschlagen: '+(e.code||'');if(document.getElementById('gate'))gateShow('in',m);else{TS.err=m;tdChanged()}}}
}
/* Selbstdiagnose, wenn nach 10 s keine Serverdaten kommen */
let fbFix=null;
async function fbDiag(){
  if(!FBX.db||TS.ready)return;fbFix=null;
  if(navigator.onLine===false){TS.err='Offline: Es werden die zuletzt gespeicherten Daten gezeigt. Änderungen werden übertragen, sobald wieder Internet da ist.';tdChanged();return}
  TS.err='Gemeinsame Daten noch nicht erreichbar, prüfe Verbindung …';tdChanged();
  try{
    await Promise.race([FBX.db.collection('lists').limit(1).get({source:'server'}),new Promise((_,rej)=>setTimeout(()=>rej({code:'timeout'}),10000))]);
    if(TS.ready)return;
    // Server antwortet, aber die Live-Verbindung kommt nicht durch
    fbFix=FBX.lp?'retry':'lp';
    TS.err=FBX.lp?'Server erreichbar, Live-Aktualisierung hängt. Bitte „Neu verbinden“ tippen oder andere Fenster der App schließen.':'Server erreichbar, aber dieses Netz blockiert die Live-Verbindung. „Verbindung reparieren“ stellt auf eine robustere Verbindungsart um.';
  }catch(e){
    if(TS.ready)return;const c=e&&e.code||'';fbFix='retry';
    const rest=await fbRest();if(TS.ready)return;
    if(rest==='OK'){fbFix=FBX.lp?'retry':'lp';TS.err='Direkter Test OK, aber die Firestore-Bibliothek kommt nicht durch ('+(c||'?')+').'+(FBX.lp?' Bitte „Neu verbinden“.':' „Verbindung reparieren“ versuchen.');tdChanged();return}
    TS.err='Firestore nicht erreichbar (Projekt '+((window.FIREBASE_CONFIG&&FIREBASE_CONFIG.projectId)||'?')+'). Fehler: '+(c||'?')+' · Direkter Test: '+rest;tdChanged();return;
    TS.err=c==='permission-denied'?'Kein Zugriff für '+((FBX.user&&FBX.user.email)||'dieses Konto')+'.':c==='timeout'||c==='unavailable'?'Firestore-Server antwortet nicht ('+(c==='timeout'?'Zeitüberschreitung':'nicht erreichbar')+'). Es werden die gespeicherten Daten gezeigt.':'Gemeinsame Daten nicht erreichbar ('+(c||'unbekannter Fehler')+').';
  }
  tdChanged();
}
/* Direkter Test gegen die Firestore-REST-Schnittstelle: liefert die wörtliche Antwort des Servers */
async function fbRest(){
  const pid=window.FIREBASE_CONFIG&&FIREBASE_CONFIG.projectId;if(!pid)return 'projectId fehlt in firebase-config.js';
  let tok='';try{tok=await FBX.user.getIdToken()}catch(e){return 'Anmeldetoken nicht abrufbar ('+(e&&e.code||e)+')'}
  const ac=new AbortController(),tm=setTimeout(()=>ac.abort(),12000);
  try{const r=await fetch('https://firestore.googleapis.com/v1/projects/'+encodeURIComponent(pid)+'/databases/(default)/documents/lists?pageSize=1',{headers:{Authorization:'Bearer '+tok},signal:ac.signal,cache:'no-store'});
    if(r.ok)return 'OK';let m='';try{const j=await r.json();m=(j.error&&(j.error.status+': '+j.error.message))||''}catch(e){}
    return 'HTTP '+r.status+(m?' · '+m.slice(0,220):'');
  }catch(e){return e&&e.name==='AbortError'?'keine Antwort nach 12 s':'Netzwerkfehler: '+(e&&e.message||e)}finally{clearTimeout(tm)}
}
async function fbRetry(){TS.err='Verbinde neu …';tdChanged();try{await FBX.db.disableNetwork();await FBX.db.enableNetwork()}catch(e){}setTimeout(()=>{if(!TS.ready)fbDiag()},8000)}
function fbSignOut(){if(FBX.auth)FBX.auth.signOut()}
document.addEventListener('click',e=>{const a=e.target.closest&&e.target.closest('[data-fbin],[data-fbout],[data-fbswitch],[data-fbfix],[data-fbretry]');if(!a)return;e.preventDefault();
  if(a.hasAttribute('data-fbfix')){try{localStorage.setItem('rp-fs-lp','1')}catch(x){}location.reload();return}
  if(a.hasAttribute('data-fbretry')){fbRetry();return}
  if(a.hasAttribute('data-fbin'))fbSignIn();else if(a.hasAttribute('data-fbout'))fbSignOut();else fbSignOut()});
function fbBtns(){if(!FBX.on||!FBX.user)return '';return (fbFix==='lp'?` <button class="chip btn" data-fbfix style="padding:2px 8px">Verbindung reparieren</button>`:fbFix==='retry'?` <button class="chip btn" data-fbretry style="padding:2px 8px">Neu verbinden</button>`:'')+` <button class="chip" data-fbout style="padding:2px 8px">Abmelden</button>`}
const APP_VER='25.11. · R104';
function kontoHTML(){if(!FBX.on)return '';
  return '<b style="font-size:13px">Konto</b><p class="src" style="margin:2px 0 8px">'+(FBX.user?'Angemeldet als '+esc(FBX.user.email||'')+'. Auswahl, eigene Einträge, Listen und Favoriten werden gemeinsam gespeichert.':'Nicht angemeldet.')+'</p>'+
   (FBX.user?'<div class="osmrow" style="margin:0 0 10px"><span>🏠 Zuhause</span><div>'+(homeGet()?'<b>'+esc(homeGet().n||'')+'</b>'+(homeGet().a?'<br><small>'+esc(homeGet().a)+'</small>':'')+'<br>':'<span class="src">noch nicht festgelegt</span><br>')+'<button class="lnk" data-homeset>'+(homeGet()?'Ändern ›':'Festlegen ›')+'</button><small class="src" style="display:block">Wird bei An- und Abreise als Vorschlag angeboten. Gespeichert in deinem Konto.</small></div></div>':'')+
   '<p class="src" style="margin:0 0 6px">App-Version '+APP_VER+' · <span data-acst>🛡 App Check: wird geprüft …</span></p><div style="margin-bottom:14px">'+(FBX.user?'<button class="chip" data-fbout style="padding:7px 12px">Abmelden</button>':'<button class="chip btn" data-fbin style="padding:7px 12px">Mit Google anmelden</button>')+'</div>'}
document.addEventListener('click',e=>{const b=e.target.closest&&e.target.closest('[data-homeset]');if(!b)return;e.stopPropagation();closeDlg();setTimeout(()=>tvPick('Zuhause festlegen',false,null,x=>{homeSet({n:x.n,a:x.a,lat:x.lat,lon:x.lon,tz:x.tz});undoToast('Zuhause gespeichert: '+(x.n||''),null,2500)}),80)},true);
function kontoDlg(){openSheet('<div class="hd"><h3 style="margin:0">Konto</h3></div>'+kontoHTML())}
/* App-Check-Status für die Anzeige (Konto/Einstellungen) */
async function acToken(){const A=window.__AC;if(!A||!A.on)return null;try{return (await Promise.race([A.ac.getToken(false),new Promise((_,no)=>setTimeout(()=>no(new Error('Zeitüberschreitung')),8000))])).token}catch(e){A.err=String(e&&e.message||e);return null}}
async function acStatus(){const A=window.__AC;if(!A)return '';if(!A.on)return A.err?'🛡 App Check: Fehler ('+A.err+')':'🛡 App Check: aus';
  if(navigator.onLine===false)return '🛡 App Check: aktiv (offline – Prüfung beim nächsten Netz)';const t=await acToken();return t?'🛡 App Check: aktiv ✓':'🛡 App Check: kein Nachweis ✗ ('+(A.err||'unbekannt')+')'}
new MutationObserver(()=>{document.querySelectorAll('[data-acst]:not([data-done])').forEach(e=>{e.dataset.done=1;acStatus().then(t=>{e.textContent=t||''})})}).observe(document.body,{childList:true,subtree:true});
/* Private Listen: liegen unter users/<uid>/lists|tasks (nur für den Besitzer lesbar, per Firestore-Regel). */
const PRIV=new Set();
const isPrivList=id=>{const l=TS.lists.find(x=>x.id===id);return !!(l&&l.priv)};
const privPath=col=>'users/'+(FBX.user?FBX.user.uid:'x')+'/'+col;
function docPriv(col,o){return col==='lists'||col==='files'?!!o.priv:col==='tasks'?isPrivList(o.list):false}
/* Feldgenau speichern: nur geänderte Felder schreiben (+ Pflichtfelder), damit gleichzeitige Änderungen
   verschiedener Personen an verschiedenen Feldern beide erhalten bleiben. SYNC = zuletzt bekannter Serverstand. */
const SYNC={};const REQ={tasks:['list','text'],lists:['name'],files:['path','title'],planitems:['d'],stays:['d1','d2','n'],travel:['mode']};
const FV=()=>window.firebase&&firebase.firestore&&firebase.firestore.FieldValue;
function fsWrite(ref,key,col,next){const prev=SYNC[key],fv=FV();SYNC[key]=JSON.parse(JSON.stringify(next));
  if(!prev||!fv)return ref.set(next);const up={};let n=0;
  Object.keys(next).forEach(k=>{if(JSON.stringify(next[k])!==JSON.stringify(prev[k])){up[k]=next[k];n++}});
  Object.keys(prev).forEach(k=>{if(!(k in next)){up[k]=fv.delete();n++}});
  if(!n)return Promise.resolve();(REQ[col]||[]).forEach(k=>{if(k in next&&!(k in up))up[k]=next[k]});
  return ref.set(up,{merge:true})}
function putDoc(col,o){const {id,...r0}=o,rest=JSON.parse(JSON.stringify(r0)); // leere (undefined) Felder lehnt Firestore ab
  if(TS.mode==='db'&&dbh){const pv=docPriv(col,o);if(pv)PRIV.add(col+':'+id);fsWrite(dbh.collection(pv?privPath(col):col).doc(id),col+':'+id,col,rest).catch(tdFail);syncPoke()}else tdStore()}
function delDoc(col,id){if(TS.mode==='db'&&dbh){const pv=PRIV.has(col+':'+id);PRIV.delete(col+':'+id);delete SYNC[col+':'+id];dbh.collection(pv?privPath(col):col).doc(id).delete().catch(tdFail);syncPoke()}else tdStore()}
/* Liste zwischen gemeinsam und privat verschieben (mit allen Aufgaben) */
function tsMoveList(l,priv){const T=TS.tasks.filter(t=>t.list===l.id);T.forEach(t=>delDoc('tasks',t.id));delDoc('lists',l.id);
  const nl={...l};if(priv){nl.priv=true;nl.owner=FBX.user?FBX.user.uid:''}else{delete nl.priv;delete nl.owner}
  const i=TS.lists.findIndex(x=>x.id===l.id);if(i>=0)TS.lists[i]=nl;putDoc('lists',nl);T.forEach(t=>putDoc('tasks',t));tdChanged()}
function tsPutList(l){const i=TS.lists.findIndex(x=>x.id===l.id);if(i<0)TS.lists.push(l);else TS.lists[i]=l;putDoc('lists',l);tdChanged()}
function tsDelList(id){TS.lists=TS.lists.filter(l=>l.id!==id);TS.tasks.filter(t=>t.list===id).forEach(t=>delDoc('tasks',t.id));TS.tasks=TS.tasks.filter(t=>t.list!==id);delDoc('lists',id);tdChanged()}
function tsPutTask(t){const i=TS.tasks.findIndex(x=>x.id===t.id);if(i<0)TS.tasks.push(t);else TS.tasks[i]=t;putDoc('tasks',t);tdChanged()}
function tsDelTask(id){TS.tasks=TS.tasks.filter(t=>t.id!==id);delDoc('tasks',id);tdChanged()}
async function tdInit(){
  try{const r=JSON.parse(localStorage.getItem('rp-'+TRIP_ID+'-todo-v1')||'null');if(r){TS.lists=r.lists||[];TS.tasks=r.tasks||[]}}catch(e){}
  TS.ready=true;
  try{
    const fu=await fbInit();if(!fu)return tdChanged();
    const db=FBX.db;
    dbh=db;TS.mode='db';TS.lists=[];TS.tasks=[];TS.ready=false;tdChanged();
    const t=setTimeout(()=>{if(!TS.ready)fbDiag()},10000);
    const SRC={lists:[[],[]],tasks:[[],[]]};
    const sub=(col,key,pv)=>db.collection(pv?privPath(col):col).onSnapshot({includeMetadataChanges:true},s=>{
      if(!s.metadata.fromCache)syncSeen();s.docs.forEach(d=>{if(!d.metadata.hasPendingWrites)SYNC[col+':'+d.id]=d.data()});
      SRC[key][pv?1:0]=s.docs.map(d=>{if(pv)PRIV.add(col+':'+d.id);const x={id:d.id,...d.data()};if(pv&&col==='lists')x.priv=true;return x});
      TS[key]=SRC[key][0].concat(SRC[key][1]);
      if(!s.metadata.fromCache&&!pv){if(!TS.ready)setTimeout(bkAuto,4000);TS.ready=true;TS.err='';fbFix=null;clearTimeout(t)}tdChanged()},e=>{if(!pv)fbReadErr(e)});
    sub('lists','lists');sub('tasks','tasks');sub('lists','lists',1);sub('tasks','tasks',1);favInit(db,fu.uid);memInit(db,fu.uid);upInit();fInit(db);sInit(db);tvInit(db);
    const mig=k=>{try{return localStorage.getItem('rp-'+TRIP_ID+'-mig-'+k)}catch(e){return '1'}},setMig=k=>{try{localStorage.setItem('rp-'+TRIP_ID+'-mig-'+k,'1')}catch(e){}};
    const rerender=()=>{planTipFix();renderTotals();renderDays();updatePills();mapSoon();const a=document.activeElement;if(!(a&&a.closest&&a.closest('#panel input,#panel textarea,#panel select')))renderPanel()};
    db.collection('picks').onSnapshot({includeMetadataChanges:true},s=>{if(s.metadata.fromCache)return;
      if(!s.docs.length&&!mig('picks')){setMig('picks');picksSync={};persistPicks();return}
      setMig('picks');const np={};s.docs.forEach(d=>{const x=d.data();if(x&&x.k!=null)np[x.k]=x.v});picksSync={...np};
      if(JSON.stringify(np)===JSON.stringify(picks))return;picks=np;try{localStorage.setItem('rp-'+TRIP_ID+'-picks-v1',JSON.stringify(picks))}catch(e){}rerender()},e=>fbReadErr(e));
    db.collection('plandays').onSnapshot({includeMetadataChanges:true},s=>{if(s.metadata.fromCache)return;
      {const m=s.docs.find(x=>x.id==='meta'),dn=m&&m.data().dinner;if(dn)DSYNC=JSON.parse(JSON.stringify(dn));if(dn&&JSON.stringify(dn)!==JSON.stringify(DIN)){DIN={at:'',dk:null,dv:null,s:90,table:'',skip:[],ov:{},...dn};dinSave(false);rerender()}else if(!dn&&DIN.at)dinSave(true)}
      {const m=s.docs.find(x=>x.id==='meta'),f=m&&m.data().fx;if(f&&(f.usd!==FX.usd||f.dop!==FX.dop)){FX.usd=+f.usd||FX.usd;FX.dop=+f.dop||FX.dop;fxSave(false)}}
      {const m=s.docs.find(x=>x.id==='meta'),c=m&&m.data().cabin;if(m&&(c||null)!==myCab()){try{c?localStorage.setItem('rp-'+TRIP_ID+'-cabin',String(c)):localStorage.removeItem('rp-'+TRIP_ID+'-cabin')}catch(e){}}else if(!m&&myCab())setCab(myCab())}
      s.docs.forEach(x=>{if(x.id.startsWith('quiz_'))qzRemote(x.id,x.data())});
      syncSeen();const lg={};s.docs.forEach(d=>{const x=d.data();if(/^d\d+$/.test(d.id)&&x&&x.d!=null&&(x.items||[]).length)lg[x.d]=x.items});
      const m=s.docs.find(x=>x.id==='meta');PI.legacy=lg;PI.v2=!!(m&&m.data().planV2);PI.metaSeen=true;planMigrate()},e=>fbReadErr(e));
    const PI={};
    const BK='rp-'+TRIP_ID+'-planbase',v2L=()=>{try{return localStorage.getItem('rp-'+TRIP_ID+'-planv2')==='1'}catch(e){return false}};
    const planMigrate=()=>{if(!PI.items||(!PI.metaSeen&&!v2L()))return;
      if(!planReady){planReady=true;
        if(!PI.items.length&&!PI.v2&&!v2L()){const src=Object.keys(PI.legacy||{}).length?PI.legacy:plan;plan=JSON.parse(JSON.stringify(src));persistPlan();
          try{localStorage.setItem('rp-'+TRIP_ID+'-planv2','1')}catch(e){}db.collection('plandays').doc('meta').set({planV2:true},{merge:true}).catch(()=>{});rerender();return}
        // Änderungen, die offline vor dem ersten Abgleich gemacht wurden, auf den Serverstand legen
        // Ohne gespeicherten Abgleich-Stand (erster Start dieser Version auf dem Gerät) gilt der Server – sonst würden
        // lokale Einträge ohne Kennung doppelt hochgeladen
        let base=null;try{base=JSON.parse(localStorage.getItem(BK)||'null')}catch(e){}
        if(!base){PI.fix=0}else{
        planIds();const cur={};Object.entries(plan).forEach(([d,a])=>(a||[]).forEach((it,o)=>{const {id,...r}=it;cur[id]={...r,d:+d,o}}));
        const srv=new Map(PI.items);Object.entries(cur).forEach(([id,x])=>{if(JSON.stringify(base[id])!==JSON.stringify(x))srv.set(id,x)});
        Object.keys(base).forEach(id=>{if(!(id in cur))srv.delete(id)});PI.items=[...srv.entries()];PI.fix=1}}
      if(PI.v2)try{localStorage.setItem('rp-'+TRIP_ID+'-planv2','1')}catch(e){}
      try{const b={};Object.keys(SYNC).forEach(k=>{if(k.startsWith('planitems:'))b[k.slice(10)]=SYNC[k]});localStorage.setItem(BK,JSON.stringify(b))}catch(e){}
      const np={};PI.items.forEach(([id,x])=>{const {d,o,...r}=x;(np[d]=np[d]||[]).push({...r,id,_o:o})});
      Object.values(np).forEach(a=>{a.sort((p,q)=>(p._o||0)-(q._o||0)||String(p.id).localeCompare(q.id));a.forEach(x=>delete x._o)});
      if(PI.fix){PI.fix=0;plan=np;persistPlan();rerender();return}
      if(JSON.stringify(np)===JSON.stringify(plan))return;plan=np;try{localStorage.setItem('rp-'+TRIP_ID+'-plan-v1',JSON.stringify(plan))}catch(e){}rerender()};
    db.collection('planitems').onSnapshot({includeMetadataChanges:true},s=>{if(s.metadata.fromCache&&!v2L())return;if(!s.metadata.fromCache)syncSeen();
      s.docs.forEach(d=>{if(!d.metadata.hasPendingWrites)SYNC['planitems:'+d.id]=d.data()});PI.items=s.docs.map(d=>[d.id,d.data()]);planMigrate()},e=>fbReadErr(e));
  }catch(e){tdChanged()}
}
const tdOpen=t=>!t.done;
const tdDue=t=>tdOpen(t)&&t.due&&t.due<=today();
function dueLbl(d){const T=today();if(d<T)return{t:'überfällig · '+fmtDate(d),c:'bad'};if(d===T)return{t:'heute',c:'warnc'};
  const tm=nowD();tm.setDate(tm.getDate()+1);if(d===tm.toLocaleDateString('sv-SE'))return{t:'morgen',c:''};return{t:fmtDate(d),c:''}}
function renderBell(){
  const n=TS.tasks.filter(tdDue).length,b=$('#belln');if(!b)return;b.hidden=!n;b.textContent=n;
  const bb=$('#bellb');if(bb)bb.setAttribute('aria-label',n?`${n} fällige Aufgaben`:'Keine fälligen Aufgaben');
}
function dueTipHTML(){
  const L=TS.tasks.filter(tdDue).sort((a,b)=>a.due.localeCompare(b.due));
  if(!L.length)return `<b class="h">Fällige Aufgaben</b><div class="e">Nichts fällig.</div>`;
  const ln=id=>(TS.lists.find(l=>l.id===id)||{}).name||'';
  return `<b class="h">Fällig oder überfällig</b>`+L.slice(0,8).map(t=>`<div class="r"><span>${esc(t.text)}${t.who?' · '+esc(t.who):''}</span><span>${esc(dueLbl(t.due).t)}</span></div>`).join('')+(L.length>8?`<div class="e">und ${L.length-8} weitere</div>`:'');
}
function tip2Html(el,html){
  const t=$('#tip2');tip2Day=null;t.innerHTML=html;t.hidden=false;
  const r=el.getBoundingClientRect(),w=t.offsetWidth,h=t.offsetHeight;let y=r.bottom+8;if(y+h>innerHeight-8)y=Math.max(8,r.top-h-8);
  t.style.left=Math.max(8,Math.min(innerWidth-w-8,r.left+r.width/2-w/2))+'px';t.style.top=y+'px';
}
let todoView=false;bordView=false;
function showTodo(list,fromHash){
  if(fromHash!==true)saveScroll();if(!(todoView&&!bordView&&!mappeView))DAYFROM=sel!=null?DAYFROM:todayView?'today':tripView?'trip':mappeView?'mappe':bordView?'bord':DAYFROM;
  todoView=true;bordView=false;tripView=false;mappeView=false;sel=null;if(list)tdList=list;renderDays();renderBar();drawOverview();renderPanel();$('#panel').scrollTop=0;hideTip2();
  if(fromHash!==true)nav('#todos');
}
function tdBanner(){
  const m=TS.mode;
  if(TS.err)return `<p class="src bad">${esc(TS.err)}${fbBtns()}</p>`;
  if(m==='local')return `<p class="src">Gespeichert nur auf diesem Gerät. Ein gemeinsamer Speicher für ${esc(PNAMES)} ist hier nicht verfügbar.</p>`;
  if(m==='dbro')return `<p class="src">Nur Lesezugriff: Änderungen sind mit diesem Zugang nicht möglich.</p>`;
  return `<p class="src">${TS.ready?'Gemeinsam gespeichert: alle mit Zugriff sehen dieselben Listen.':'Lade gemeinsame Listen …'}</p>`;
}
function whoTag(w){if(!w)return '';const c=pColor(w);return `<span class="tag" style="background:color-mix(in srgb,${c} 16%,transparent);color:${c}">${esc(w)}</span>`}
const tdSubOpen=new Set();
function tdAvatar(w){return w?`<span class="tav" style="background:${pColor(w)}" title="${esc(w)}">${esc(w[0])}</span>`:''}
function todoPanel(){
  const L=TS.lists.slice().sort((a,b)=>(a.ord||0)-(b.ord||0)||String(a.name).localeCompare(b.name));
  if(tdList!=='due'&&!L.find(l=>l.id===tdList))tdList=L.length?L[0].id:'due';
  const ro=TS.mode==='dbro',nDue=TS.tasks.filter(tdDue).length;
  const cnt=id=>TS.tasks.filter(t=>t.list===id&&tdOpen(t)).length;
  const okSync=TS.mode==='db'&&TS.ready&&!TS.err;
  let h=`<div class="tdtop"><h2>ToDos</h2>${okSync?'<span class="tdsync" title="Gemeinsam gespeichert: ${esc(PNAMES)} sehen dieselben Listen">☁︎ gemeinsam</span>':''}</div>${okSync?'':tdBanner()}`;
  if(!L.length&&!ro){
    return h+`<div class="tdempty"><p><b>Noch keine Liste.</b> Leg eure erste an, zum Beispiel „Vor der Reise“ oder „Einpacken“.</p><form class="tdadd" id="tdfirst"><input name="q" maxlength="60" placeholder="Name der Liste" aria-label="Name der ersten Liste"><button type="submit" aria-label="Liste anlegen">+</button></form></div>`}
  h+=`<div class="tdtabs" role="tablist" aria-label="Listen"><button class="tdtab" role="tab" aria-selected="${tdList==='due'}" data-tdl="due">🔔 Fällig <span class="n${nDue?' hot':''}">${nDue}</span></button>${L.map(l=>`<button class="tdtab" role="tab" aria-selected="${tdList===l.id}" data-tdl="${l.id}">${l.priv?'🔒 ':''}${esc(l.name)} <span class="n">${cnt(l.id)}</span></button>`).join('')}${ro?'':'<button class="tdtab add" data-newlist aria-label="Neue Liste">+ Liste</button>'}</div>`;
  const cur=L.find(l=>l.id===tdList);
  const tasks=TS.tasks.filter(t=>(tdList==='due'?tdDue(t):t.list===tdList)&&(tdWho==='all'||t.who===tdWho));
  const sortT=(a,b)=>(a.due&&b.due?a.due.localeCompare(b.due):a.due?-1:b.due?1:0)||(a.ts||0)-(b.ts||0);
  const manual=tdList!=='due'&&tasks.some(t=>t.ord!=null),sortM=(a,b)=>(a.ord??(1e15+(a.ts||0)))-(b.ord??(1e15+(b.ts||0)));
  const open=tasks.filter(tdOpen).sort(manual?sortM:sortT),done=tasks.filter(t=>t.done).sort((a,b)=>(b.ts||0)-(a.ts||0));
  const all=cur?TS.tasks.filter(t=>t.list===cur.id):[],nd=all.filter(t=>t.done).length;
  h+=`<div class="tdtool">${cur?`<span class="tdprog">${all.length?`${nd}/${all.length} erledigt`:'leer'}</span>${all.length?`<span class="tdbar2"><i style="width:${Math.round(nd/all.length*100)}%"></i></span>`:''}`:'<span class="tdprog">aus allen Listen</span>'}
    <div class="tdseg" role="group" aria-label="Person filtern">${['all',...PEOPLE].map(w=>`<button aria-pressed="${tdWho===w}" data-tdw="${w}" title="${w==='all'?'Alle':w}">${w==='all'?'Alle':w[0]}</button>`).join('')}</div>
    ${cur&&!ro?`<button class="tdmore" data-editlist="${cur.id}" aria-label="Liste „${esc(cur.name)}“ umbenennen oder löschen" title="Liste umbenennen oder löschen">⋯</button>`:''}</div>`;
  if(cur&&!ro)h+=`<form class="tdadd" id="tdquick"><input name="q" maxlength="140" placeholder="Neue Aufgabe in „${esc(cur.name)}“ …" aria-label="Neue Aufgabe" autocomplete="off"><button type="submit" aria-label="Aufgabe hinzufügen">+</button></form>`;
  const row=t=>{const l=L.find(x=>x.id===t.list),dl=t.due?dueLbl(t.due):null,sb=t.subs||[],sd=sb.filter(x=>x.done).length,so=tdSubOpen.has(t.id);
    return `<div class="swr td" ${!ro&&!t.done&&tdList!=='due'&&tdWho==='all'?`data-sortk="task" data-sid="${t.id}"`:''}><div class="swbg" aria-hidden="true">Löschen 🗑</div><div class="tr2${t.done?' done':''}" ${ro?'':`data-swdel="task|${t.id}"`}><label class="tchk"><input type="checkbox" data-tdone="${t.id}" ${t.done?'checked':''} ${ro?'disabled':''} aria-label="Erledigt: ${esc(t.text)}"></label>
    <div class="tr2b" ${ro?'':`data-tedit="${t.id}" tabindex="0" role="button" aria-label="Aufgabe „${esc(t.text)}“ bearbeiten"`}><div class="ttx">${esc(t.text)}</div>
      ${(t.who||dl||sb.length||t.note||(tdList==='due'&&l))?`<div class="tr2m">${tdAvatar(t.who)}${dl?`<span class="tdue ${dl.c}">${esc(dl.t)}</span>`:''}${tdList==='due'&&l?`<span class="tlst">${esc(l.name)}</span>`:''}${t.note?`<span class="tnote1">${esc(t.note.split('\n')[0])}</span>`:''}</div>`:''}</div>
    ${sb.length?`<button class="tsubn${so?' on':''}" data-tsubt="${t.id}" aria-expanded="${so}" aria-label="Unteraufgaben ${sd} von ${sb.length}">☑ ${sd}/${sb.length}</button>`:''}
    ${ro?'':`<span class="tchev" aria-hidden="true">›</span>`}</div></div>
    ${sb.length&&so?`<div class="tsubs2">${sb.map(x=>`<label class="tsub ${x.done?'done':''}"><input type="checkbox" data-sdone="${t.id}|${x.id}" ${x.done?'checked':''} ${ro?'disabled':''}><span>${esc(x.text)}</span></label>`).join('')}${ro?'':`<button class="tsubadd" data-tsub="${t.id}">+ Unteraufgabe</button>`}</div>`:''}`};
  h+=`<div class="tdlist">${open.length?open.map(row).join(''):`<p class="empty">${tdList==='due'?'Nichts fällig. 🎉':tdWho!=='all'?'Keine offenen Aufgaben für '+esc(tdWho)+'.':'Keine offenen Aufgaben. Oben eintippen und Enter.'}</p>`}</div>`;
  if(done.length)h+=`<details class="sec" ${tdDone?'open':''} id="tddone"><summary><b>Erledigt</b><span>${done.length}</span></summary><div class="tdlist">${done.map(row).join('')}</div>${ro||!cur?'':`<p><button class="chip" data-clrdone>Erledigte löschen</button></p>`}</details>`;
  if(!ro)h+=tipHTML('todo')+`<p class="src" style="margin:14px 0 0">Mehrere Zeilen einfügen legt mehrere Aufgaben an.</p>`;
  return h;
}
let tdLastWho='';
function listDlg(id){
  const l=id?TS.lists.find(x=>x.id===id):null;
  openSheet(`<div class="hd"><h3 style="margin:0">${l?'Liste bearbeiten':'Neue Liste'}</h3></div>
  <form class="sform" id="lf"><label>Name<input name="n" required maxlength="60" value="${esc(l?l.name:'')}" placeholder="z. B. Einpacken"></label>
  ${TS.mode==='db'?`<label class="pick" style="flex-direction:row;align-items:center;gap:8px;font-size:14px;color:var(--ink)"><input type="checkbox" name="pv" ${l&&l.priv?'checked':''} style="width:auto"> 🔒 Nur für mich (die anderen sehen diese Liste nicht)</label>`:''}
  <div class="btns"><button class="chip btn" type="submit">Speichern</button><button class="chip" type="button" data-close>Abbrechen</button>${l?'<button class="chip del" type="button" id="ldel">Liste löschen</button>':''}</div></form>`,d=>{
    const f=d.querySelector('#lf');
    f.onsubmit=ev=>{ev.preventDefault();const n=f.n.value.trim();if(!n)return;
      const pv=!!(f.pv&&f.pv.checked);
      if(l){if(!!l.priv!==pv)tsMoveList({...l,name:n},pv);else tsPutList({...l,name:n})}else{const o={id:nid('l'),name:n,ord:Date.now()};if(pv){o.priv=true;o.owner=FBX.user?FBX.user.uid:''}tsPutList(o);tdList=o.id}closeDlg();renderPanel()};
    const dl=d.querySelector('#ldel');if(dl)dl.onclick=()=>{const L={...l},T=TS.tasks.filter(t=>t.list===l.id).map(t=>({...t}));tsDelList(l.id);tdList=null;closeDlg();renderPanel();
      undoToast(`Liste „${L.name}“ gelöscht${T.length?' (mit '+T.length+' Aufgaben)':''}.`,()=>{tsPutList(L);T.forEach(tsPutTask);tdList=L.id;renderPanel()})};
  });
}
function taskDlg(id,focusSub){
  const isNew=!id;
  const t=isNew?{id:nid('t'),list:tdList,text:'',who:tdLastWho,due:'',done:false,ts:Date.now(),note:'',subs:[]}:TS.tasks.find(x=>x.id===id);if(!t)return;
  let subs=(t.subs||[]).map(x=>({...x}));
  openSheet(`<div class="hd"><h3 style="margin:0">${isNew?'Neue Aufgabe':'Aufgabe bearbeiten'}</h3></div>
  <form class="sform" id="tf2"><label>Text<input name="text" required maxlength="140" value="${esc(t.text)}"></label>
  <div class="two"><label>Person<select name="who"><option value="">–</option>${PEOPLE.map(p=>`<option ${p===t.who?'selected':''}>${p}</option>`).join('')}</select></label>
  <label>Termin (optional)<input name="due" type="date" value="${esc(t.due||'')}"></label></div>
  <label>Notiz<textarea name="note" maxlength="1000" placeholder="Optional">${esc(t.note||'')}</textarea></label>
  <div><div style="font-size:12px;color:var(--muted);margin-bottom:4px">Unteraufgaben</div><div id="subs"></div>
  <div class="srow"><input type="text" id="subn" maxlength="100" placeholder="Neue Unteraufgabe" aria-label="Neue Unteraufgabe"><button type="button" id="suba" aria-label="Unteraufgabe hinzufügen">+</button></div></div>
  <label>Liste<select name="list">${TS.lists.map(l=>`<option value="${l.id}" ${l.id===t.list?'selected':''}>${esc(l.name)}</option>`).join('')}</select></label>
  <div class="btns">${isNew?'<button class="chip btn" type="submit">Hinzufügen</button><button class="chip" type="submit" data-fin="1">Fertig</button>':'<button class="chip btn" type="submit">Speichern</button>'}<button class="chip" type="button" data-close>${isNew?'Schließen':'Abbrechen'}</button>${isNew?'':'<button class="chip del" type="button" id="tdel">Löschen</button>'}</div>${isNew?'<p class="src" id="added"></p><p class="src">Tipp: Enter fügt die Aufgabe hinzu, das Fenster bleibt offen. Mehrere Zeilen einfügen legt jede Zeile als eigene Aufgabe an.</p>':''}</form>`,d=>{
    const f=d.querySelector('#tf2'),box=d.querySelector('#subs'),inp=d.querySelector('#subn');
    const draw=()=>{box.innerHTML=subs.map((x,i)=>`<div class="srow"><input type="checkbox" data-sc="${i}" ${x.done?'checked':''} aria-label="Erledigt"><input type="text" data-st2="${i}" value="${esc(x.text)}" maxlength="100"><button type="button" data-sr="${i}" aria-label="Entfernen">✕</button></div>`).join('');
      box.querySelectorAll('[data-sc]').forEach(c=>c.onchange=()=>{subs[+c.dataset.sc].done=c.checked});
      box.querySelectorAll('[data-st2]').forEach(c=>c.oninput=()=>{subs[+c.dataset.st2].text=c.value});
      box.querySelectorAll('[data-sr]').forEach(c=>c.onclick=()=>{subs.splice(+c.dataset.sr,1);draw()})};
    const add=()=>{const x=inp.value.trim();if(!x)return;subs.push({id:nid('s'),text:x,done:false});inp.value='';draw();inp.focus()};
    d.querySelector('#suba').onclick=add;inp.onkeydown=ev=>{if(ev.key==='Enter'){ev.preventDefault();add()}};draw();
    if(focusSub)setTimeout(()=>inp.focus(),30);
    if(isNew){
      const added=[],show=()=>{d.querySelector('#added').textContent=added.length?`Hinzugefügt (${added.length}): `+added.join(', '):''};
      const addOne=(text,full)=>{tdLastWho=f.who.value;tsPutTask({id:nid('t'),ts:Date.now()+added.length,done:false,text,who:f.who.value,due:f.due.value,list:f.list.value,note:full?f.note.value.trim():'',subs:full?subs.filter(y=>y.text.trim()):[]});added.push(text)};
      f.text.addEventListener('paste',ev=>{const tx=(ev.clipboardData||window.clipboardData).getData('text'),L=tx.split(/\r?\n/).map(l=>l.replace(/^[-*•\s]+/,'').trim()).filter(Boolean);if(L.length>1){ev.preventDefault();L.forEach(l=>addOne(l,false));show()}});
      f.onsubmit=ev=>{ev.preventDefault();add();const x=f.text.value.trim(),fin=ev.submitter&&ev.submitter.dataset.fin;
        if(x){addOne(x,true);f.text.value='';f.note.value='';subs=[];draw();show()}
        if(fin){closeDlg();return}f.text.focus()};
      return;
    }
    f.onsubmit=ev=>{ev.preventDefault();const x=f.text.value.trim();if(!x)return;add();
      tsPutTask({...t,text:x,who:f.who.value,due:f.due.value,list:f.list.value,note:f.note.value.trim(),subs:subs.filter(y=>y.text.trim())});closeDlg();renderPanel()};
    const dl=d.querySelector('#tdel');if(dl)dl.onclick=()=>{const T={...TS.tasks.find(x=>x.id===t.id)};tsDelTask(t.id);closeDlg();renderPanel();undoToast(`Aufgabe „${T.text}“ gelöscht.`,()=>{tsPutTask(T);renderPanel()})};
  });
}
function bindTodo(a){
  a.querySelectorAll('[data-tdl]').forEach(b=>b.onclick=()=>{tdList=b.dataset.tdl;try{localStorage.setItem('rp-'+TRIP_ID+'-td-list',tdList)}catch(e){}renderPanel()});
  {const s=a.querySelector('.tdtab[aria-selected="true"]');if(s&&s.scrollIntoView)s.scrollIntoView({block:'nearest',inline:'nearest'})}
  a.querySelectorAll('[data-tdw]').forEach(b=>b.onclick=()=>{tdWho=b.dataset.tdw;renderPanel()});
  a.querySelectorAll('[data-newlist]').forEach(b=>b.onclick=()=>listDlg(null));
  a.querySelectorAll('[data-editlist]').forEach(b=>b.onclick=()=>listDlg(b.dataset.editlist));
  a.querySelectorAll('[data-tdone]').forEach(c=>c.onchange=()=>{const t=TS.tasks.find(x=>x.id===c.dataset.tdone);if(t)tsPutTask({...t,done:c.checked})});
  a.querySelectorAll('[data-tedit]').forEach(b=>{const f=()=>taskDlg(b.dataset.tedit);b.onclick=f;b.onkeydown=ev=>{if(ev.key==='Enter'||ev.key===' '){ev.preventDefault();f()}}});
  a.querySelectorAll('[data-sdone]').forEach(c=>c.onchange=()=>{const [tid,sid]=c.dataset.sdone.split('|'),t=TS.tasks.find(x=>x.id===tid);if(t)tsPutTask({...t,subs:(t.subs||[]).map(x=>x.id===sid?{...x,done:c.checked}:x)})});
  a.querySelectorAll('[data-tsub]').forEach(b=>b.onclick=()=>taskDlg(b.dataset.tsub,true));
  a.querySelectorAll('[data-clrdone]').forEach(b=>b.onclick=()=>{const T=TS.tasks.filter(t=>t.done&&t.list===tdList).map(t=>({...t}));T.forEach(t=>tsDelTask(t.id));tdDone=true;undoToast(T.length+' erledigte Aufgabe'+(T.length>1?'n':'')+' gelöscht.',()=>{T.forEach(tsPutTask);renderPanel()})});
  const dd=a.querySelector('#tddone');if(dd)dd.addEventListener('toggle',()=>{tdDone=dd.open});
  a.querySelectorAll('[data-newtask]').forEach(b=>b.onclick=()=>taskDlg(null));
  a.querySelectorAll('[data-tsubt]').forEach(b=>b.onclick=ev=>{ev.stopPropagation();const id=b.dataset.tsubt;tdSubOpen.has(id)?tdSubOpen.delete(id):tdSubOpen.add(id);renderPanel()});
  const q=a.querySelector('#tdquick');
  if(q){const inp=q.q;
    const addLines=L=>{L.forEach((tx,k)=>tsPutTask({id:nid('t'),list:tdList,text:tx.slice(0,140),who:tdWho!=='all'?tdWho:'',due:'',done:false,ts:Date.now()+k,note:'',subs:[]}))};
    q.onsubmit=ev=>{ev.preventDefault();const tx=inp.value.trim();if(!tx)return;addLines([tx]);inp.value='';renderPanel();const n=$('#tdquick');if(n)n.q.focus()};
    inp.addEventListener('paste',ev=>{const t=(ev.clipboardData||window.clipboardData).getData('text'),L=t.split(/\r?\n/).map(l=>l.replace(/^[-*•\s]+/,'').trim()).filter(Boolean);if(L.length>1){ev.preventDefault();addLines(L);renderPanel();undoToast(L.length+' Aufgaben angelegt.',null,3000)}})}
  const f1=a.querySelector('#tdfirst');if(f1)f1.onsubmit=ev=>{ev.preventDefault();const n=f1.q.value.trim();if(!n)return;const o={id:nid('l'),name:n.slice(0,60),ord:Date.now()};tsPutList(o);tdList=o.id;renderPanel();const z=$('#tdquick');if(z)z.q.focus()};
}
let tripOnly=false;
function tripPanel(onlyP){
  const cs=D.ports.filter(p=>!onlyP||p===onlyP).map(p=>({p,c:calc(p)}));
  const nDays=cs.filter(x=>x.c.rows.length).length;
  const days=cs.filter(x=>!tripOnly||x.c.rows.length).map(({p,c})=>{
    const land=(p.land||'').split(',').pop().replace(/\s*\(Inselstaat\)/,'').trim();
    const col=p.kind==='port'?'var(--port)':p.kind==='sea'?'#6f8fa3':'var(--accent)';
    const T='';
    const head=`<div class="tdh" data-tipday="${p.day}"><button class="tdt" data-d="${p.day}" data-open><span class="tdk">Tag ${p.day} · ${fmtDate(p.date)}${land?' · '+esc(land):''}</span><span class="tdn">${esc(p.name)}${T}${wxChip(p)}</span></button><button class="lnk tdd" data-open data-d="${p.day}">Details ›</button></div>`;
    const addE='',addF='';
    const hd=onlyP?'':head;
    const fl=onlyP?'':fRowsHTML(p);
    const tt=travelTop(p,!onlyP),tb=travelBottom(p,1);
    if(!c.rows.length)return `<div class="tday empty" style="--c:${col}">${hd}${tt}${onlyP?`<div class="emptyc"><p>Noch nichts geplant.${p.kind==='port'&&(p.ex||[]).length?' '+OP+'-Ausflüge findest du in der Tagesansicht.':''}</p><button class="chip btn" data-addpt="${p.day}">+ Eintrag für Tag ${p.day}</button></div>`:''}${addE}${tb}${fl}${addF}</div>`;
    const rows=c.rows.map(r=>{if(r.dinner)return dinTripHTML(p,r);
      const lt=r.lg?legTxt(r.lg):'';
      const meta=[`${r.st} Min`,lt,r.q.g.o].filter(Boolean).join(' · ');
      const del=r.tour?`tcx|${p.day}|${esc(r.e.c)}`:`trm|${p.day}|${r.pi}`;
      const lv=rowLive(p,r);
      return `<div class="swr${lv?' '+lv:''}" ${r.tour?`data-sortfix="day${p.day}"`:`data-sortk="day${p.day}" data-sid="${r.pi}"`} data-a="${r.a??''}" data-b="${r.b??''}" data-st="${r.st||60}"><div class="swbg" aria-hidden="true">Löschen 🗑</div><div class="trw" data-tipday="${p.day}" data-swdel="${del}"><div class="tm">${r.a==null?'–':hm(r.a)}${r.b!=null?`<small>${hm(r.b)}</small>`:''}</div><div class="tb tpl" ${r.tour?`data-exinfo="${p.day}|${esc(r.e.c)}" role="button" tabindex="0"`:r.x&&r.s.lat!=null?`data-pinfo="${p.day}|${r.pi}" role="button" tabindex="0"`:r.x?`data-pedit="${p.day}|${r.pi}" role="button" tabindex="0" aria-label="Eintrag bearbeiten"`:`data-tipdlg="${p.day}|${r.s.i}" role="button" tabindex="0"`}><div class="tt">${r.tour?'<span class="tcos">'+esc(OP)+'</span> ':''}${r.x&&r.s.lat!=null?'<span class="tpin">★</span> ':''}${r.x&&r.s.dk?'🛳 ':''}${esc(r.q.n)}${r.x&&r.s.lat!=null?' <span class="tmore">Infos ›</span>':''}${r.x&&r.s.dk?` <span class="tmore" data-dkgo="${r.s.dk}|${r.s.dv}" role="link" tabindex="0">Deckplan ›</span>`:''}</div>${lv==='live'?liveBadge(p,r):''}<div class="tmeta">${esc(meta)}</div>${r.x&&r.q.g.n?`<div class="tmeta">${esc(r.q.g.n)}</div>`:''}</div></div></div>`}).join('');
    const foot=c.port&&CRUISE&&onlyP?`<div class="tmeta" style="margin-top:6px">Liegezeit ${esc(p.times)} · zurück am Schiff ca. ${hm(c.back)}</div>`:'';
    return `<div class="tday${onlyP?' only':''}" style="--c:${col}">${hd}${tt}${rows}${addE}${tb}${fl}${addF}${foot}</div>`;
  }).join('');
  if(onlyP)return days;
  const SM=summary();window._sumText=SM.text;
  const DL=DRIVE?drivePairs().map(x=>driveLeg(x.b)).filter(L=>L&&L.km!=null):[],dkm=DL.reduce((a,L)=>a+L.km,0),dmin=DL.reduce((a,L)=>a+L.min,0);
  return `<div class="eyebrow">Alle Tage</div><h2>Mein Reiseplan</h2>${DL.length?`<p class="src" style="margin:-4px 0 10px">🚗 Strecke gesamt ca. ${dkm.toLocaleString('de-DE')} km · ${hmDur(dmin)} Fahrt</p>`:''}${tipHTML('plan')}<p style="display:flex;gap:6px;flex-wrap:wrap;align-items:center"><span class="src" id="cpm2"></span></p><textarea id="cpt3" readonly hidden style="width:100%;height:160px"></textarea>${tvBlock('out')}${days}${tvBlock('back')}${HAS_EX?`<h2 style="margin-top:22px;font-size:18px">${esc(OP)}-Ausflüge und Kosten</h2>${SM.html}`:''}${onlyP?'':extraHTML()}`;
}
function planAdd(p,i){(plan[p.day]=plan[p.day]||[]).push({i,ti:(p.pois[i]||{}).id});savePlan();refreshPlan(p)}
function refreshPlan(p){renderPanel();updatePills();if(sel===p.day&&pm(p))drawPort(p,true);else drawPlanRoute(p);renderDays()}
function drawPlanRoute(p){
  const g=svg.querySelector('#prg');if(!g||sel!==p.day)return;g.innerHTML='';
  const L=(plan[p.day]||[]).filter(s=>s.x?s.lat!=null:(p.pois||[])[s.i]);if(!L.length)return;
  const pts=[[p.ox,p.oy],...L.map(s=>s.x?llxy(s.lat,s.lon):[(p.pois||[])[s.i].ox,p.pois[s.i].oy]),[p.ox,p.oy]];
  el('polyline',{class:'route',points:pts.map(q=>q.join(',')).join(' ')},g);
}
function renderTotals(){
  if(tip2Day!=null&&tip2El)showTip2(tip2El,tip2Day);
  let t=0;D.ports.forEach(p=>(p.ex||[]).forEach(e=>{if(e.p&&isPicked(p,e))t+=e.p}));
  {const tb=$('#totb');if(tb)tb.title='Meine Auswahl anzeigen: '+eur(t)+' p. P., '+eur(t*2)+' für zwei'}updateBadges();updatePills();
}

/* ---------- day strip ---------- */
function renderDays(){
  const n=$('#days');n.innerHTML='';
  D.ports.forEach(p=>{
    const b=document.createElement('button');b.className='day '+(p.kind==='port'?'port':p.kind);
    const ld=(p.land||'').split(',').pop().replace(/\s*\(Inselstaat\)/,'').trim();b.innerHTML=`<small><span>Tag ${p.day} · ${fmtDate(p.date)}</span></small><b>${esc(p.name)}</b><small>${esc(ld||'auf See')}</small>`;
    if(sel===p.day)b.setAttribute('aria-current','true');if(p.date===TODAY)b.classList.add('today');
    b.onclick=()=>{hideTip2();select(p.day)};n.appendChild(b);
    b.addEventListener('pointerenter',e=>{if(e.pointerType==='mouse')showTip2(b,p.day)});
    b.addEventListener('pointerleave',e=>{if(e.pointerType==='mouse')hideTip2()});
    b.addEventListener('focus',()=>showTip2(b,p.day));b.addEventListener('blur',hideTip2);
  });
  updateBadges();
  const cur=n.querySelector('[aria-current]');if(cur)cur.scrollIntoView({inline:'center',block:'nearest'});
}

/* ---------- map engine ---------- */
const svg=$('#map'),wrap=$('#mapwrap');
const MINZ=1800;let hiddenDraw=false,mapKey='ov',M=null,vb={x:0,y:0,w:1,h:1},cw=1,ch=1,mks=[];
function home(){
  const {W,H}=M;const a=cw/ch;
  if(M.focus){const f=M.focus;const w=Math.max(f.w,f.h*a),h=w/a;vb={x:f.cx-w/2,y:f.cy-h/2,w,h};return}
  let w=W,h=W/a;if(h<H){h=H;w=H*a}
  vb={x:W/2-w/2,y:H/2-h/2,w,h};
}
function clamp(){
  const {W,H}=M;vb.w=Math.max(W/MINZ,Math.min(vb.w,W*2));vb.h=vb.w*ch/cw;
  vb.x=Math.max(-W/2,Math.min(vb.x,W*1.5-vb.w));vb.y=Math.max(-H/2,Math.min(vb.y,H*1.5-vb.h));
}
const mpu=y=>{const m=(M.ty-y)/M.k,ph=2*Math.atan(Math.exp(m))-Math.PI/2;return 6371008*Math.cos(ph)/M.k};
function scaleBar(){let e=document.getElementById('scbar');const mc=document.querySelector('.mapcol');if(!mc)return;if(!e){e=document.createElement('div');e.id='scbar';mc.appendChild(e)}
  if(!M){e.style.display='none';return}
  const mpx=mpu(vb.y+vb.h/2)*vb.w/cw,nice=[10,20,50,100,200,500,1000,2000,5000,10000,20000,50000,100000,200000,500000],tgt=mpx*90;let L=nice[0];for(const n of nice)if(n<=tgt)L=n;
  e.style.display='flex';e.innerHTML='<span class="n">N ↑</span><span class="bar" style="width:'+Math.round(L/mpx)+'px"></span><span>'+(L>=1000?L/1000+' km':L+' m')+'</span>'}
function applyVB(){clamp();svg.style.setProperty('--u',vb.w/cw);svg.querySelectorAll('.wringl').forEach(e=>{e.style.display=(+e.dataset.r)/(vb.w/cw)<50?'none':''});svg.setAttribute('viewBox',`${vb.x} ${vb.y} ${vb.w} ${vb.h}`);updateDetail();layout();scaleBar();tilesUpdate();if(window.__osmReady)osmSched()}
function measure(){const r=wrap.getBoundingClientRect();cw=Math.max(200,r.width);ch=Math.max(160,r.height)}
const cv=document.createElement('canvas').getContext('2d');
const tw=(s,f)=>{cv.font=f;return cv.measureText(s).width};

function buildMarkers(items){
  // items: {x,y,kind,color,txt,label,prio,ca,id,onClick,w}
  const g=svg.querySelector('#mkl');g.innerHTML='';mks=[];cpool=[];
  items.forEach(it=>{
    const grp=el('g',{class:'mk'+(it.ca?' ca':'')+(it.on?' on':'')+(it.here?' here':'')},g);
    const r=it.kind==='port'?13:11;const wd=it.kind==='pill'?Math.max(24,tw(it.txt,'700 11px Space Grotesk')+14):0;
    if(it.kind==='pill'){
      el('rect',{x:-wd/2-3,y:-14,width:wd+6,height:28,rx:14,class:'ring'},grp);
      el('rect',{x:-wd/2,y:-11,width:wd,height:22,rx:11,class:'dot',fill:it.color},grp);
      const t=el('text',{class:'n'},grp);t.textContent=it.txt;
      it.hw=wd/2+3;it.hh=14;
    }else if(it.kind==='sea'){
      el('circle',{r:r+3,class:'ring'},grp);
      el('circle',{r,class:'dot',fill:it.color},grp);
      el('path',{d:'M0 -7.5a2.2 2.2 0 1 1 0 4.4a2.2 2.2 0 1 1 0 -4.4M0 -3.1V6.5M-4 -0.5H4M-6.5 2.5C-6 5.5 -3.5 7 0 7C3.5 7 6 5.5 6.5 2.5',fill:'none',stroke:'#fff','stroke-width':1.8,'stroke-linecap':'round','stroke-linejoin':'round'},grp);
      it.hw=it.hh=r+3;
    }else if(it.kind==='port'){
      el('circle',{r:r+3,class:'ring'},grp);
      el('circle',{r,class:'dot',fill:it.color},grp);
      el('path',CRUISE?{d:'M-7 -1H7L4.5 5.5H-4.5ZM-1 -2V-8L4.5 -3.5H-1',fill:'#fff'}:{d:'M0 -7L7 -1H4.5V6H-4.5V-1H-7Z',fill:'#fff'},grp);
      it.hw=it.hh=r+3;
    }else if(it.kind==='stay'){
      el('circle',{r:16,class:'ring'},grp);el('circle',{r:13.5,class:'dot',fill:'#7b5cc4'},grp);
      const t=el('text',{class:'ic',y:0.8},grp);t.textContent='🛏';it.hw=it.hh=16;
    }else if(it.kind==='tip'){
      if(it.oth){grp.classList.add('oth');el('circle',{r:10,class:'ring'},grp);el('circle',{r:8,class:'dot',fill:it.color},grp);const t=el('text',{class:'ic',y:0.6,style:'font-size:9px'},grp);t.textContent=it.txt;it.hw=it.hh=10}else{
      el('circle',{r:15,class:'ring'},grp);
      el('circle',{r:12.5,class:'dot',fill:it.color},grp);
      const t=el('text',{class:'ic',y:0.8},grp);t.textContent=it.txt;
      it.hw=it.hh=15}
    }else if(it.kind==='star'){
      grp.classList.add('star');
      el('circle',{r:17,class:'ring'},grp);
      el('circle',{r:14,class:'dot',fill:it.color},grp);
      const t=el('text',{class:'n stx',y:0.5},grp);t.textContent='★';
      it.hw=it.hh=17;
    }else{
      el('circle',{r:r+3,class:'ring'},grp);
      el('circle',{r,class:'dot',fill:it.color},grp);
      const t=el('text',{class:'n'},grp);t.textContent=it.txt;
      it.hw=it.hh=r+3;
    }
    if(false&&it.dayList){const tx=it.kind==='pill'?wd/2+3:r+2,ty=it.kind==='pill'?-12:-r;it.tm=el('g',{class:'tm',display:'none'},grp);el('circle',{cx:tx,cy:ty,r:8,fill:cssv('--plan'),stroke:'#fff','stroke-width':1.5},it.tm);const tt=el('text',{x:tx,y:ty+3.6,'text-anchor':'middle',fill:'#fff','font-size':10,'font-weight':700,'font-family':'Space Grotesk, sans-serif'},it.tm);tt.textContent='T'}
    el('circle',{r:Math.max(r+4,16),class:'hit'},grp);
    it.lb=el('text',{class:'lb'},grp);it.lb.textContent=it.label||'';
    it.g=grp;
    grp.addEventListener('click',ev=>{ev.stopPropagation();it.onClick&&it.onClick()});
    grp.addEventListener('pointerenter',e=>{if(it.onHover&&e.pointerType==='mouse')it.onHover(true)});
    grp.addEventListener('pointerleave',e=>{if(it.onHover&&e.pointerType==='mouse')it.onHover(false)});
    grp.addEventListener('focus',()=>it.onHover&&it.onHover(true));
    grp.addEventListener('blur',()=>it.onHover&&it.onHover(false));
    grp.setAttribute('tabindex','0');grp.setAttribute('role','button');grp.setAttribute('aria-label',it.aria||it.label||it.txt);
    grp.addEventListener('keydown',ev=>{if(ev.key==='Enter'||ev.key===' '){ev.preventDefault();it.onClick&&it.onClick()}});
    mks.push(it);
  });
  layout();
}
let cpool=[];
function getCluster(i){
  if(cpool[i])return cpool[i];
  const g=el('g',{class:'mk cl',role:'button',tabindex:'0'},svg.querySelector('#mkl'));
  el('circle',{r:17,class:'ring'},g);el('circle',{r:14,class:'dot',fill:cssv('--accent')},g);
  const t=el('text',{class:'n'},g);el('circle',{r:18,class:'hit'},g);
  g._t=t;cpool[i]=g;return g;
}
function layout(){
  if(!M)return;
  const u=vb.w/cw;const placed=[];const zm=u*mpu(vb.y+vb.h/2);
  const order=[...mks].sort((a,b)=>(b.prio||0)-(a.prio||0));
  order.forEach(it=>{
    const px=(it.x-vb.x)/u,py=(it.y-vb.y)/u;
    it.px=px;it.py=py;it.clustered=false;
    it.g.setAttribute('transform',`translate(${it.x} ${it.y}) scale(${u})`);
    it.vis=px>-30&&px<cw+30&&py>-30&&py<ch+30;
    if(it.lvl==='det'&&!(detDay&&it.pday===detDay))it.vis=false;
    if(it.hideDet&&detDay&&it.hideDet.includes(detDay))it.vis=false;
    if(it.lvl==='tip'&&zm>TIP_MPP)it.vis=false;
    if(it.lvl==='star'&&zm>STAR_MPP)it.vis=false;
  });
  // Pins, die sich überdecken, werden zu einer Gruppe zusammengefasst
  const cl=[];
  if(u*mpu(vb.y+vb.h/2)>6){
    order.filter(it=>it.kind==='tip'&&it.vis).forEach(it=>{
      const c=cl.find(c=>Math.hypot(c.px-it.px,c.py-it.py)<24);
      if(c){c.items.push(it);const n=c.items.length;c.px=c.items.reduce((a,q)=>a+q.px,0)/n;c.py=c.items.reduce((a,q)=>a+q.py,0)/n}
      else cl.push({px:it.px,py:it.py,items:[it]});
    });
  }
  const multi=cl.filter(c=>c.items.length>1);
  multi.forEach(c=>c.items.forEach(it=>{it.clustered=true;it.vis=false}));
  order.forEach(it=>{it.g.style.display=it.vis?'':'none';if(it.vis)placed.push([it.px-it.hw,it.py-it.hh,it.px+it.hw,it.py+it.hh])});
  cpool.forEach(g=>g.style.display='none');
  multi.forEach((c,i)=>{
    const g=getCluster(i);g.style.display='';
    const pt=order.find(q=>q.kind==='port'&&q.vis);
    if(pt){const dx=c.px-pt.px,dy=c.py-pt.py,dd=Math.hypot(dx,dy);if(dd<26){const k=dd<1?[0.7,0.7]:[dx/dd,dy/dd];c.px=pt.px+k[0]*28;c.py=pt.py+k[1]*28}}
    const x=vb.x+c.px*u,y=vb.y+c.py*u;g.setAttribute('transform',`translate(${x} ${y}) scale(${u})`);
    g._t.textContent=c.items.length;{const n={};c.items.forEach(q=>n[q.color]=(n[q.color]||0)+1);g.querySelector('.dot').setAttribute('fill',Object.keys(n).sort((a,b)=>n[b]-n[a])[0])}g.setAttribute('aria-label',c.items.length+' Orte, zum Auffächern vergrößern: '+c.items.map(q=>q.label).join(', '));
    g.onclick=ev=>{ev.stopPropagation();flyTo(x,y,M.W/vb.w*3)};
    g.onkeydown=ev=>{if(ev.key==='Enter'||ev.key===' '){ev.preventDefault();g.onclick(ev)}};
    placed.push([c.px-17,c.py-17,c.px+17,c.py+17]);
  });
  const lbls=[];
  order.forEach(it=>{
    if(!it.vis||!it.label){it.lb.style.display='none';return}
    const f=(it.kind==='port'||it.kind==='pill'?'700 ':'600 ')+'12px Inter';const w=tw(it.label,f)+6,h=16;
    const c=[[it.hw+4,0,'start',it.hw+4,-h/2],[-it.hw-4,0,'end',-it.hw-4-w,-h/2],[0,it.hh+h/2+2,'middle',-w/2,it.hh+2],[0,-it.hh-h/2-2,'middle',-w/2,-it.hh-h-2]];
    let ok=false;
    for(const k of c){
      const r=[it.px+k[3],it.py+k[4],it.px+k[3]+w,it.py+k[4]+h];
      const hit=[...placed,...lbls].some(q=>r[0]<q[2]&&r[2]>q[0]&&r[1]<q[3]&&r[3]>q[1]&&!(q[0]===it.px-it.hw&&q[1]===it.py-it.hh));
      if(!hit&&r[0]>0&&r[2]<cw){it.lb.style.display='';it.lb.setAttribute('text-anchor',k[2]);it.lb.setAttribute('x',k[0]);it.lb.setAttribute('y',k[1]);it.lb.setAttribute('dominant-baseline','central');lbls.push(r);ok=true;break}
    }
    if(!ok)it.lb.style.display='none';
  });
  svg.querySelectorAll('.sealbl').forEach(t=>{t.setAttribute('font-size',13*u);t.setAttribute('letter-spacing',u*1.2)});
}
let built=false,detDay=null,autoSel=false,skipHome=0;
function setMap(){
  hideTip();
  mapKey='ov';M=D.maps.ov;hiddenDraw=wrap.clientWidth<50;measure();
  if(!built||!svg.querySelector('#mkl')){
    svg.innerHTML='';built=true;
    el('path',{class:'land',d:M.land},svg);
    el('g',{id:'detg'},svg);
    const gl=el('g',{id:'lblg'},svg);
    M.labels.forEach(l=>{const t=el('text',{x:l[1],y:l[2],class:'sealbl','text-anchor':'middle'},gl);t.textContent=l[0]});
    el('g',{id:'tilg'},svg);el('g',{id:'ringg'},svg);el('g',{id:'rtg'},svg);el('g',{id:'prg'},svg);el('g',{id:'osmg'},svg);el('g',{id:'mkl'},svg);
    tiles.clear();
  }else{['ringg','rtg','prg','mkl'].forEach(i=>svg.querySelector('#'+i).innerHTML='')}
  M.focus=null;detDay=null;
}
function ensureDet(p){
  let g=svg.querySelector('#det-'+p.day);if(g)return g;
  const m=D.maps[p.map];
  g=el('g',{id:'det-'+p.day,class:'det',transform:`translate(${m.T[1]} ${m.T[2]}) scale(${m.T[0]})`,display:'none'},svg.querySelector('#detg'));
  el('rect',{x:-m.W/2,y:-m.H/2,width:m.W*2,height:m.H*2,fill:'var(--sea)'},g);
  if(m.reef)el('path',{class:'reef',d:m.reef},g);
  el('path',{class:'land',d:m.land},g);
  if(m.urb)el('path',{class:'urb',d:m.urb},g);
  if(m.riv)el('path',{class:'riv',d:m.riv},g);
  if(m.rdB)el('path',{class:'rd2',d:m.rdB},g);
  if(m.rdA){el('path',{class:'rd1c',d:m.rdA},g);el('path',{class:'rd1',d:m.rdA},g)}
  if(m.pl)m.pl.forEach(l=>{const q=el('g',{class:'plc'},g);el('circle',{cx:l[1],cy:l[2],r:3.2},q);const t=el('text',{x:l[1]+6,y:l[2]+4},q);t.textContent=l[0]});
  return g;
}
function updateDetail(){
  if(!M||!svg.querySelector('#detg'))return;
  const cx=vb.x+vb.w/2,cy=vb.y+vb.h/2;let best=null;const cand=[];
  for(const p of D.ports){
    if(!p.pois||!p.map)continue;const w=D.maps[p.map].win,f=detDay===p.day?1.15:0.9;
    if(cx>w[0]&&cx<w[2]&&cy>w[1]&&cy<w[3]&&Math.hypot(vb.w,vb.h)<=Math.hypot(w[2]-w[0],w[3]-w[1])*f)cand.push(p)
  }
  const dist=p=>Math.hypot(p.ox-cx,p.oy-cy);cand.sort((a,b)=>dist(a)-dist(b));
  best=cand.find(p=>p.day===sel)||cand[0]||null;
  const nd=best?best.day:null;
  if(nd!==detDay){
    detDay=nd;svg.querySelectorAll('.det').forEach(g=>g.setAttribute('display','none'));
    if(best)ensureDet(best).setAttribute('display','');
    svg.classList.toggle('isdet',!!best);
    const rg=svg.querySelector('#ringg');if(rg)rg.style.display=best?'':'none';
  }
  if(best){const g=svg.querySelector('#det-'+best.day);g.style.setProperty('--u',(vb.w/cw)/D.maps[best.map].T[0])}
}
/* Online-Kacheln mit automatischem Rückfall auf die eingebaute Karte */
const TP=[
 {u:(z,x,y)=>`https://tile.openstreetmap.org/${z}/${x}/${y}.png`,a:'© OpenStreetMap-Mitwirkende'},
 {u:(z,x,y)=>`https://${'abc'[(x+y)%3]}.tile.openstreetmap.fr/hot/${z}/${x}/${y}.png`,a:'© OpenStreetMap-Mitwirkende, Kacheln HOT/OSM France'}];
let tOn=true;try{tOn=localStorage.getItem('rp-map-online')!=='0'}catch(e){}
let tProv=0,tLoaded=0,tErr=0,tDead=false,tCur=-1,tMode='img',tCsp='',tStuck=null;document.addEventListener('securitypolicyviolation',e=>{if(/openstreetmap/.test(e.blockedURI||''))tCsp=e.violatedDirective});const tiles=new Map();let tTimer=null;
function tAttr(){
  const e=document.getElementById('mattr'),b=document.getElementById('onbtn');if(b)b.setAttribute('aria-pressed',tOn);
  if(!e)return;const g=svg.querySelector('#tilg');const n=g?g.querySelectorAll('image[data-ok]').length:0;
  svg.classList.toggle('tiles',n>0);
  e.textContent=!tOn?'Eingebaute Karte (Online aus) · Natural Earth, © OSM':n>0?(navigator.onLine===false?'Gespeicherte Karte · ':'Online-Karte · ')+TP[tProv].a:(tDead||navigator.onLine===false)?(tCsp&&navigator.onLine!==false?'Online-Karte hier blockiert ('+tCsp+') · eingebaute Karte':'Offline: eingebaute Karte')+' · Natural Earth, © OSM':'Karte lädt …';
}
function tilesUpdate(){
  const g=svg.querySelector('#tilg');if(!g||!M)return;
  if(!tOn||tDead){if(g.firstChild){g.innerHTML='';tiles.clear()}tAttr();return}
  const wr=vb.w/M.k;let z=Math.round(Math.log2(cw*2*Math.PI/(256*wr)));z=Math.max(3,Math.min(17,z));tCur=z;
  const n=2**z,P2=2*Math.PI;
  const i0=Math.floor(((vb.x-M.tx)/M.k+Math.PI)/P2*n),i1=Math.floor(((vb.x+vb.w-M.tx)/M.k+Math.PI)/P2*n);
  const j0=Math.floor((Math.PI-(M.ty-vb.y)/M.k)/P2*n),j1=Math.floor((Math.PI-(M.ty-vb.y-vb.h)/M.k)/P2*n);
  const a0=Math.max(0,i0),a1=Math.min(n-1,i1),b0=Math.max(0,j0),b1=Math.min(n-1,j1);
  if((a1-a0+1)*(b1-b0+1)>70)return;
  const want=new Set();
  for(let i=a0;i<=a1;i++)for(let j=b0;j<=b1;j++){
    const key=tProv+'/'+z+'/'+i+'/'+j;want.add(key);if(tiles.has(key))continue;
    const im=el('image',{x:M.tx+M.k*(i/n*P2-Math.PI),y:M.ty-M.k*(Math.PI-P2*j/n),width:M.k*P2/n*1.004,height:M.k*P2/n*1.004,preserveAspectRatio:'none','data-z':z},g);
    const url=TP[tProv].u(z,i,j);tiles.set(key,im);
    if(tMode==='img')im.setAttribute('href',url);else fetch(url).then(r=>{if(!r.ok)throw 0;return r.blob()}).then(b=>im.setAttribute('href',URL.createObjectURL(b))).catch(()=>im.dispatchEvent(new Event('error')));
    im.addEventListener('load',()=>{im.dataset.ok='1';tLoaded++;tErr=0;tAttr()});
    im.addEventListener('error',()=>{im.remove();tiles.delete(key);tErr++;
      if(tErr>=4&&tLoaded===0&&!tDead){tErr=0;if(tMode==='img'){tMode='fetch';g.innerHTML='';tiles.clear();setTimeout(tilesUpdate,50);tAttr();return}tProv++;if(tProv>=TP.length){tProv=0;tDead=true;g.innerHTML='';tiles.clear()}else{g.innerHTML='';tiles.clear();setTimeout(tilesUpdate,50)}}
      tAttr()});
  }
  for(const [k,im] of tiles){if(+im.dataset.z===z&&!want.has(k)){im.remove();tiles.delete(k)}}
  clearTimeout(tStuck);if(tLoaded===0)tStuck=setTimeout(()=>{if(tLoaded===0&&!tDead&&tiles.size){tErr=4;[...tiles.values()][0].dispatchEvent(new Event('error'))}},4000);
  clearTimeout(tTimer);tTimer=setTimeout(()=>{for(const [k,im] of tiles)if(+im.dataset.z!==tCur&&tiles.size>0){im.remove();tiles.delete(k)}tAttr()},700);
  tAttr();
}
addEventListener('online',()=>{tDead=false;tErr=0;tLoaded=0;tProv=0;tilesUpdate()});
addEventListener('offline',()=>{tDead=false;tErr=0;tLoaded=0;tProv=0;tMode='img';tilesUpdate()});
document.getElementById('onbtn').onclick=()=>{tOn=!tOn;try{localStorage.setItem('rp-map-online',tOn?'1':'0')}catch(e){}if(tOn){tDead=false;tErr=0;tLoaded=0;tProv=0;tMode='img'}tilesUpdate();tAttr()};
/* ---------- Orte aus OpenStreetMap (Overpass) ---------- */
/* Kategorien – gleiche Symbole für Tipps (gefüllter Kreis) und OpenStreetMap-Umgebung (weißer Kreis) */
const CAT={sight:{n:'Sehenswertes',i:'🏛',c:'#2a6fb8'},beach:{n:'Strände',i:'🏖',c:'#c98a00'},nature:{n:'Natur',i:'🌴',c:'#2f9e44'},food:{n:'Essen & Trinken',i:'🍽',c:'#d9480f'},
  shop:{n:'Einkaufen',i:'🛍',c:'#8a4bb5'},atm:{n:'Geld',i:'🏧',c:'#1f7a4d'},pharm:{n:'Apotheke',i:'💊',c:'#c2255c'}};
const TIPC={sight:['sight','🏛'],beach:['beach','🏖'],nature:['nature','🌴'],factory:['sight','🏭'],town:['sight','🏘']};
const tipCat=q=>(TIPC[q.t]||TIPC.sight)[0],tipIcon=q=>(TIPC[q.t]||TIPC.sight)[1];
const TIP_MPP=180,STAR_MPP=3000; // Tipps ab Hafen-Zoom, eigene Orte ab Länder-Zoom
const OSMG={
  food:{n:'Essen & Trinken',c:'#d9480f',i:'🍽',q:['nwr["amenity"~"^(restaurant|cafe|bar|pub|fast_food|ice_cream|biergarten)$"]["name"]']},
  sight:{n:'Sehenswertes & Museen',c:'#2a6fb8',i:'🏛',q:['nwr["tourism"~"^(attraction|museum|viewpoint|gallery|zoo|aquarium|theme_park)$"]["name"]','nwr["historic"~"^(castle|fort|ruins|monument|archaeological_site|building|church)$"]["name"]']},
  beach:{n:'Strände',c:'#c98a00',i:'🏖',q:['nwr["natural"="beach"]','nwr["leisure"="beach_resort"]']},
  shop:{n:'Läden',c:'#8a4bb5',i:'🛍',q:['nwr["shop"~"^(supermarket|convenience|gift|souvenir|mall|department_store|clothes|jewelry|beverages|alcohol|tobacco|art|craft)$"]["name"]']},
  atm:{n:'Geldautomaten',c:'#1f7a4d',i:'🏧',q:['nwr["amenity"="atm"]','nwr["amenity"="bank"]["atm"="yes"]']},
  pharm:{n:'Apotheken',c:'#c2255c',i:'💊',q:['nwr["amenity"="pharmacy"]']}
};
const OSM_ZOOM=30,OSM_R=6000,OSM_CELL=0.05,OSM_MAXAGE=30*864e5,OSM_EP=['https://overpass-api.de/api/interpreter','https://overpass.private.coffee/api/interpreter','https://maps.mail.ru/osm/tools/overpass/api/interpreter'];
const OSM={on:true,f:new Set(Object.keys(CAT)),data:new Map(),busy:new Set(),fail:new Set(),cells:new Map(),prog:null,err:'',els:new Map(),raf:0};
try{const r=JSON.parse(localStorage.getItem('rp-osm-ui')||'null');if(r){OSM.on=r.on!==false;if(Array.isArray(r.f)){OSM.f=new Set(r.f.filter(k=>CAT[k]));if(r.v!==2)OSM.f.add('nature')}}}catch(e){}
const osmSaveUi=()=>{try{localStorage.setItem('rp-osm-ui',JSON.stringify({v:2,on:OSM.on,f:[...OSM.f]}))}catch(e){}};
function llxy(lat,lon){const m=D.maps.ov;return[m.tx+m.k*lon*Math.PI/180,m.ty-m.k*Math.log(Math.tan(Math.PI/4+lat*Math.PI/360))]}
// Häfen mit gleicher Lage (z. B. Start- und Zielhafen) teilen sich einen Datensatz
D.ports.forEach(p=>(p.pois||[]).forEach((q,i)=>{if(!TYPES[q.t])q.t='sight';if(!q.id)q.id='t'+p.day+'_'+i})); // unbekannte Typen als Sehenswertes; feste Kennung je Tipp
/* Tipps im Tagesplan: Verweis über die feste Kennung ti; i (Position) wird daraus jedes Mal neu bestimmt.
   So verrutscht nichts, wenn Tipps später geändert, gelöscht oder umsortiert werden. Ältere App-Versionen lesen weiter i. */
function planTipFix(){Object.entries(plan).forEach(([d,a])=>{const P=byDay(+d);const L=(P&&P.pois)||[];(a||[]).forEach(s=>{if(!s||s.x)return;
  if(s.ti){const j=L.findIndex(q=>q.id===s.ti);if(j>=0)s.i=j}else if(L[s.i])s.ti=L[s.i].id})})}
const osmPorts=(()=>{const o=[];D.ports.forEach(p=>{if(p.lat==null||p.kind==='sea')return;const k=p.lat.toFixed(2)+','+p.lon.toFixed(2);let e=o.find(x=>x.k===k);if(!e){e={k,lat:p.lat,lon:p.lon,name:p.name,days:[]};o.push(e)}e.days.push(p.day)});return o})();
let osmDbP=null;
function osmDb(){if(osmDbP)return osmDbP;osmDbP=new Promise(res=>{try{const r=indexedDB.open('rp-osm',1);r.onupgradeneeded=()=>r.result.createObjectStore('ports');r.onsuccess=()=>res(r.result);r.onerror=()=>res(null)}catch(e){res(null)}});return osmDbP}
async function osmIdb(mode,key,val){const db=await osmDb();if(!db)return null;return new Promise(res=>{try{const t=db.transaction('ports',mode),s=t.objectStore('ports'),r=mode==='readonly'?s.get(key):s.put(val,key);r.onsuccess=()=>res(r.result);r.onerror=()=>res(null)}catch(e){res(null)}})}
/* Bereiche außerhalb der Hafen-Umkreise: Raster von 0,05° (~5 km), wird beim Hineinzoomen nachgeladen */
function osmCell(lat,lon){const i=Math.floor(lat/OSM_CELL),j=Math.floor(lon/OSM_CELL),k='c'+i+','+j;let c=OSM.cells.get(k);
  if(!c){c={k,lat:(i+.5)*OSM_CELL,lon:(j+.5)*OSM_CELL,name:'diesen Kartenausschnitt',bb:[i*OSM_CELL,j*OSM_CELL,(i+1)*OSM_CELL,(j+1)*OSM_CELL]};OSM.cells.set(k,c)}return c}
function xyll(x,y){const m=D.maps.ov;return[(2*Math.atan(Math.exp((m.ty-y)/m.k))-Math.PI/2)*180/Math.PI,(x-m.tx)/m.k*180/Math.PI]}
/* Beim Start alles Gespeicherte einlesen (Zählung im Menü, sofort sichtbare Punkte) */
async function osmLoadAll(){
  const db=await osmDb();if(!db)return;
  const all=await new Promise(res=>{try{const t=db.transaction('ports','readonly'),st=t.objectStore('ports'),out=[];const r=st.openCursor();r.onsuccess=()=>{const c=r.result;if(c){out.push([c.key,c.value]);c.continue()}else res(out)};r.onerror=()=>res(out)}catch(e){res([])}});
  for(const [k,v] of all){if(!v||!v.items||!v.items.length||OSM.data.has(k))continue;
    let pt=osmPorts.find(p=>p.k===k);if(!pt&&/^c-?\d+,-?\d+$/.test(k)){const [i,j]=k.slice(1).split(',').map(Number);pt=osmCell((i+.5)*OSM_CELL,(j+.5)*OSM_CELL)}
    if(pt)osmIndex(pt,v.items)}
  osmSched();osmPopRender();
}
function osmQuery(pt){
  const dLat=OSM_R/111320,dLon=OSM_R/(111320*Math.cos(pt.lat*Math.PI/180)),bb=(pt.bb||[pt.lat-dLat,pt.lon-dLon,pt.lat+dLat,pt.lon+dLon]).map(v=>v.toFixed(5)).join(',');
  return '[out:json][timeout:90][bbox:'+bb+'];('+Object.values(OSMG).flatMap(g=>g.q).map(q=>q+';').join('')+');out center tags qt 3000;';
}
function osmGroup(t){
  if(/^(restaurant|cafe|bar|pub|fast_food|ice_cream|biergarten)$/.test(t.amenity||''))return 'food';
  if(t.amenity==='pharmacy')return 'pharm';
  if(t.amenity==='atm'||t.amenity==='bank')return 'atm';
  if(t.natural==='beach'||t.leisure==='beach_resort')return 'beach';
  if(t.shop)return 'shop';
  if(t.tourism||t.historic)return 'sight';
  return null;
}
function osmParse(js){
  const out=[];(js.elements||[]).forEach(e=>{const t=e.tags||{},g=osmGroup(t);if(!g)return;const lat=e.lat!=null?e.lat:e.center&&e.center.lat,lon=e.lon!=null?e.lon:e.center&&e.center.lon;if(lat==null)return;
    const keep={};['name','name:de','name:en','amenity','tourism','historic','shop','cuisine','opening_hours','website','contact:website','phone','contact:phone','addr:street','addr:housenumber','addr:city','description','operator','brand','fee','wheelchair'].forEach(k=>{if(t[k])keep[k]=t[k]});
    out.push({id:e.type[0]+e.id,g,lat:+lat.toFixed(6),lon:+lon.toFixed(6),t:keep})});
  return out;
}
async function osmFetch(pt){
  const body='data='+encodeURIComponent(osmQuery(pt));let last;
  for(const ep of OSM_EP){const ac=new AbortController(),tm=setTimeout(()=>ac.abort(),45000);
    try{const r=await fetch(ep,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body,signal:ac.signal});if(!r.ok)throw new Error('HTTP '+r.status);
      const js=await r.json();if(js.remark&&/error|timed out|out of memory/i.test(js.remark))throw new Error('Server überlastet');
      const items=osmParse(js);if(!items.length)throw new Error('leeres Ergebnis');return items}
    catch(e){last=e}finally{clearTimeout(tm)}}
  throw last||new Error('Overpass');
}
function osmIndex(pt,items){items.forEach(q=>{const p=llxy(q.lat,q.lon);q.x=p[0];q.y=p[1];q.pk=pt.k});OSM.data.set(pt.k,items)}
async function osmEnsure(pt,force){
  if(OSM.busy.has(pt.k))return;if(OSM.data.has(pt.k)&&!force)return;if(OSM.fail.has(pt.k)&&!force)return;OSM.busy.add(pt.k);osmBusyUi();
  try{
    const c=await osmIdb('readonly',pt.k);
    if(c&&c.items&&c.items.length&&!force){osmIndex(pt,c.items);osmSched();if(Date.now()-c.ts<OSM_MAXAGE||navigator.onLine===false)return}
    if(navigator.onLine===false)return;
    const items=await osmFetch(pt);await osmIdb('readwrite',pt.k,{ts:Date.now(),items});osmIndex(pt,items);OSM.fail.delete(pt.k);OSM.err='';osmSched();
  }catch(e){if(!OSM.data.has(pt.k)){OSM.fail.add(pt.k);OSM.err='Orte für '+pt.name+' gerade nicht abrufbar ('+(e&&e.name==='AbortError'?'Zeitüberschreitung':(e&&e.message)||'Fehler')+').'}}
  finally{OSM.busy.delete(pt.k);osmBusyUi();osmPopRender()}
}
const osmMpp=()=>M?mpu(vb.y+vb.h/2)*vb.w/cw:1e9;
function osmSched(){if(OSM.raf)return;OSM.raf=requestAnimationFrame(()=>{OSM.raf=0;osmRender()})}
function osmRender(){
  const g=svg.querySelector('#osmg');if(!g||!M)return;
  const show=OSM.on&&OSM.f.size&&osmMpp()<=OSM_ZOOM;
  if(!show){if(g.firstChild){g.innerHTML='';OSM.els.clear()}osmHint();return}
  const cx=vb.x+vb.w/2,cy=vb.y+vb.h/2;
  {const [la,lo]=xyll(cx,cy);let inPort=false;
   osmPorts.forEach(pt=>{const d=osmKm(la,lo,pt.lat,pt.lon)*1000;if(d<OSM_R*1.3)osmEnsure(pt);if(d<OSM_R*0.85)inPort=true});
   clearTimeout(OSM.ct);if(!inPort)OSM.ct=setTimeout(()=>{const v=xyll(vb.x+vb.w/2,vb.y+vb.h/2);if(osmMpp()<=OSM_ZOOM&&Math.abs(v[0]-la)<.01&&Math.abs(v[1]-lo)<.01)osmEnsure(osmCell(la,lo))},800)}
  const u=vb.w/cw,x0=vb.x-20*u,x1=vb.x+vb.w+20*u,y0=vb.y-20*u,y1=vb.y+vb.h+20*u,cell=(osmMpp()>12?40:28)*u,used=new Set(),want=new Map();
  const ord=['sight','beach','food','pharm','atm','shop'];
  const cand=[];for(const arr of OSM.data.values())for(const q of arr)if(OSM.f.has(q.g)&&q.x>=x0&&q.x<=x1&&q.y>=y0&&q.y<=y1)cand.push(q);
  cand.sort((a,b)=>ord.indexOf(a.g)-ord.indexOf(b.g));
  for(const q of cand){const ck=Math.floor(q.x/cell)+'|'+Math.floor(q.y/cell);if(used.has(ck))continue;used.add(ck);want.set(q.id,q);if(want.size>=250)break}
  const PS=new Set();for(const d in plan)(plan[d]||[]).forEach(x=>{if(x&&x.osm)PS.add(x.osm)});
  for(const q of cand)if(PS.has(q.id)&&!want.has(q.id))want.set(q.id,q);
  for(const [id,e] of OSM.els)if(!want.has(id)){e.remove();OSM.els.delete(id)}
  for(const [id,q] of want){let e=OSM.els.get(id);
    if(!e){e=el('g',{class:'osm',role:'button',tabindex:'0','aria-label':osmName(q)+', '+OSMG[q.g].n},g);
      el('circle',{r:10.5,class:'osmr',stroke:OSMG[q.g].c},e);const t=el('text',{class:'osmi','text-anchor':'middle','dominant-baseline':'central',y:0.8},e);t.textContent=OSMG[q.g].i;el('circle',{r:15,class:'hit'},e);
      const open=ev=>{ev.stopPropagation();osmDlg(q)};e.addEventListener('click',open);e.addEventListener('keydown',ev=>{if(ev.key==='Enter'||ev.key===' '){ev.preventDefault();open(ev)}});
      OSM.els.set(id,e)}
    e.classList.toggle('pl',PS.has(id));e.setAttribute('transform',`translate(${q.x} ${q.y}) scale(${u})`)}
  osmHint();
}
function osmBusyUi(){const b=document.getElementById('osmbtn');if(!b)return;const on=OSM.busy.size>0;b.classList.toggle('busy',on);if(on)b.title='Orte werden geladen …';else osmHint()}
function osmHint(){const b=document.getElementById('osmbtn');if(!b)return;const far=OSM.on&&osmMpp()>OSM_ZOOM;b.classList.toggle('far',far);b.title=OSM.on?(far?'Orte: zum Anzeigen hineinzoomen':'Orte aus OpenStreetMap'):'Orte ausgeblendet'}
const osmName=q=>q.t['name:de']||q.t.name||q.t['name:en']||(q.g==='atm'?'Geldautomat'+(q.t.operator?' '+q.t.operator:''):q.g==='beach'?'Strand':q.g==='pharm'?'Apotheke':'Ohne Namen');
function osmKind(q){const t=q.t,m={restaurant:'Restaurant',cafe:'Café',bar:'Bar',pub:'Pub',fast_food:'Imbiss',ice_cream:'Eisdiele',biergarten:'Biergarten',atm:'Geldautomat',bank:'Bank mit Geldautomat',pharmacy:'Apotheke',
  attraction:'Sehenswürdigkeit',museum:'Museum',viewpoint:'Aussichtspunkt',gallery:'Galerie',zoo:'Zoo',aquarium:'Aquarium',theme_park:'Freizeitpark',castle:'Burg/Schloss',fort:'Festung',ruins:'Ruine',monument:'Denkmal',archaeological_site:'Ausgrabung',building:'Historisches Gebäude',church:'Historische Kirche',
  supermarket:'Supermarkt',convenience:'Laden',gift:'Geschenke',souvenir:'Souvenirs',mall:'Einkaufszentrum',department_store:'Kaufhaus',clothes:'Kleidung',jewelry:'Schmuck',beverages:'Getränke',alcohol:'Spirituosen',tobacco:'Tabak',art:'Kunst',craft:'Kunsthandwerk'};
  if(q.g==='beach')return 'Strand';return m[t.amenity]||m[t.tourism]||m[t.historic]||m[t.shop]||OSMG[q.g].n}
const osmKm=(a,b,c,d)=>{const R=6371,x=(d-b)*Math.PI/180*Math.cos((a+c)*Math.PI/360),y=(c-a)*Math.PI/180;return R*Math.hypot(x,y)};
function osmDayFor(q){
  const pt=osmPorts.find(p=>p.k===q.pk)||osmPorts.slice().sort((a,b)=>osmKm(q.lat,q.lon,a.lat,a.lon)-osmKm(q.lat,q.lon,b.lat,b.lon))[0];
  if(!pt)return sel||1;if(sel!=null&&pt.days.includes(sel))return sel;
  const p=pt.days.map(byDay).find(p=>p.kind==='port'&&p.date>=TODAY)||pt.days.map(byDay).find(p=>p.kind==='port')||byDay(pt.days[0]);return p.day}
function osmPlanned(id){if(!id)return null;if(sel!=null&&plan[sel]){const i=plan[sel].findIndex(s=>s&&s.osm===id);if(i>=0)return{day:sel,pi:i}}if(sel!=null&&byDay(sel))return null;for(const d in plan){const i=(plan[d]||[]).findIndex(s=>s&&s.osm===id);if(i>=0)return{day:+d,pi:i}}return null}
function placeShow(day,lat,lon){closeDlg();setTimeout(()=>{if(sel!==day)select(day);setTimeout(()=>{const xy=llxy(lat,lon);flyTo(xy[0],xy[1],Math.max(M.W/vb.w,M.W*byDay(day).ompp/900||1))},sel===day?60:350)},30)}
document.addEventListener('click',e=>{const b=e.target.closest&&e.target.closest('[data-dkgo]');if(!b)return;e.stopPropagation();e.preventDefault();const [n,i]=b.dataset.dkgo.split('|').map(Number);dkShow(n,i)},true);
document.addEventListener('keydown',e=>{if(e.key!=='Enter')return;const b=e.target.closest&&e.target.closest('[data-dkgo]');if(!b||e.target!==b)return;e.preventDefault();e.stopPropagation();const [n,i]=b.dataset.dkgo.split('|').map(Number);dkShow(n,i)},true);
document.addEventListener('click',e=>{const b=e.target.closest&&e.target.closest('[data-exinfo]');if(!b)return;e.stopPropagation();const [d,c]=b.dataset.exinfo.split('|');exDlg(+d,c)},true);
document.addEventListener('keydown',e=>{if(e.key!=='Enter'&&e.key!==' ')return;const b=e.target.closest&&e.target.closest('[data-exinfo]');if(!b||e.target!==b)return;e.preventDefault();const [d,c]=b.dataset.exinfo.split('|');exDlg(+d,c)});
document.addEventListener('click',e=>{const b=e.target.closest&&e.target.closest('[data-bopen]');if(!b)return;const [k,v]=b.dataset.bopen.split('|');const p=byDay(sel);if(!p)return;if(k==='ex'){setTab('ex');setTimeout(()=>{const i=p.ex.findIndex(x=>x.c===v);if(i>=0)focusCard('ex',i)},30)}else{setTab('poi');setTimeout(()=>focusCard('poi',+v),30)}});
document.addEventListener('click',e=>{const b=e.target.closest&&e.target.closest('[data-pedit]');if(!b||e.target.closest('button.tx'))return;e.stopPropagation();const [d,i]=b.dataset.pedit.split('|');addPointDlg(+d,null,{day:+d,pi:+i})},true);
document.addEventListener('keydown',e=>{if(e.key!=='Enter'&&e.key!==' ')return;const b=e.target.closest&&e.target.closest('[data-pedit]');if(!b||e.target!==b)return;e.preventDefault();const [d,i]=b.dataset.pedit.split('|');addPointDlg(+d,null,{day:+d,pi:+i})});
document.addEventListener('click',e=>{const b=e.target.closest&&e.target.closest('[data-tipdlg]');if(!b||e.target.closest('[data-dkgo]'))return;e.stopPropagation();const [d,i]=b.dataset.tipdlg.split('|');tipDlg(+d,+i)},true);
document.addEventListener('click',e=>{const b=e.target.closest&&e.target.closest('[data-pinfo]');if(!b)return;e.stopPropagation();const [d,i]=b.dataset.pinfo.split('|');placeDlg(+d,+i)},true);
document.addEventListener('keydown',e=>{if(e.key!=='Enter'&&e.key!==' ')return;const b=e.target.closest&&e.target.closest('[data-pinfo][role=button]');if(!b||e.target!==b)return;e.preventDefault();const [d,i]=b.dataset.pinfo.split('|');placeDlg(+d,+i)});
/* Infobox Veranstalter-Ausflug */
function exDlg(day,code){const p=byDay(day),e=p&&(p.ex||[]).find(x=>x.c===code);if(!e)return;
  const ph=D.photos[e.c],r=calc(p).rows.find(x=>x.tour&&x.e.c===code),pk=isPicked(p,e);
  openSheet(`<div class="hd"><h3 style="margin:0"><span class="tcos">${esc(OP)}</span> ${esc(e.c)} · ${esc(e.n)}<small class="hds">Tag ${p.day} · ${esc(fmtDate(p.date))} · ${esc(p.name)}</small></h3></div>
  ${ph?`<img src="${ph}" alt="Eindruck zum Ausflug ${esc(e.c)}" loading="lazy" style="margin:0 0 10px">`:''}
  <div class="tags" style="margin:0 0 10px">${e.p?`<span class="tag" style="font-weight:700">${eur(e.p)} p. P. · ${eur(e.p*2)} für zwei</span>`:''}${e.dur?`<span class="tag">⏱ ${esc(e.dur)}</span>`:''}${e.lv?`<span class="tag">${esc(e.lv)}</span>`:''}${e.rec?'<span class="tag g">Empfehlung</span>':''}${e.sold?'<span class="tag y">ausverkauft</span>':''}</div>
  ${r&&pk?`<p class="osmrow" style="display:block"><b>Im Tagesplan:</b> ${hm(r.a)}–${hm(r.b)} Uhr${p.kind==='port'?` · alle an Bord ${hm(portWin(p).off)} Uhr`:''}</p>`:''}
  ${e.prog?`<p style="margin:10px 0">${esc(e.prog)}</p>`:''}${e.note?`<p class="src" style="margin:0 0 10px">${esc(e.note)}</p>`:''}
  <p class="src" style="margin:0">Treffpunkt und genaue Zeiten stehen im Ticket bzw. Tagesprogramm an Bord.</p>
  <div class="acts" style="margin-top:10px"><button type="button" class="lnk" id="exday">Tag ${p.day} öffnen ›</button></div>
  ${e.p&&!e.sold?`<div class="btns bar"><button class="chip ${pk?'':'btn'}" id="expk">${pk?'Abwählen':'Einplanen'}</button></div>`:''}`,d=>{
    const k=d.querySelector('#expk');if(k)k.onclick=()=>{const u=picksSnap();setPick(p,e,!pk);closeDlg();renderPanel();renderDays();updatePills();if(sel===p.day&&pm(p))drawPort(p,true);undoToast(`Ausflug ${e.c} ${pk?'abgewählt':'eingeplant'}.`,u)};
    d.querySelector('#exday').onclick=()=>{closeDlg();setTimeout(()=>{select(p.day);setTab('ex');const i=p.ex.indexOf(e);setTimeout(()=>focusCard('ex',i),40)},60)}})}
function placeDlg(day,pi){const s=(plan[day]||[])[pi];if(!s||s.lat==null)return;
  let q=null;for(const arr of OSM.data.values()){q=arr.find(x=>x.id===s.osm);if(q)break}
  if(!q)q={id:s.osm||'',g:(s.o&&s.o.g)||'sight',lat:s.lat,lon:s.lon,t:Object.assign({name:s.n},(s.o&&s.o.t)||{}),pk:null};
  osmDlg(q,{name:s.n,note:s.note,day,pi,addr:s.addr,gurl:s.gurl})}
function osmDlg(q,opt){opt=opt||{};
  const t=q.t,nm=opt.name||osmName(q),web=t.website||t['contact:website'],ph=t.phone||t['contact:phone'],adr=opt.addr||[[t['addr:street'],t['addr:housenumber']].filter(Boolean).join(' '),t['addr:city']].filter(Boolean).join(', ');
  const pt=osmPorts.find(p=>p.k===q.pk)||osmPorts.slice().sort((a,b)=>osmKm(q.lat,q.lon,a.lat,a.lon)-osmKm(q.lat,q.lon,b.lat,b.lon))[0],km=pt?osmKm(q.lat,q.lon,pt.lat,pt.lon):null;
  const pl=opt.day!=null?{day:opt.day,pi:opt.pi}:osmPlanned(q.id);
  const gm=opt.gurl||'https://www.google.com/maps/search/'+encodeURIComponent(nm==='Ohne Namen'?q.lat+','+q.lon:nm)+'/@'+q.lat+','+q.lon+',17z';
  const row=(k,v)=>v?`<div class="osmrow"><span>${k}</span><div>${v}</div></div>`:'';
  const safeUrl=u=>/^https?:\/\//i.test(u)?u:'https://'+u;
  const fromE=opt.day!=null,tday=sel!=null&&byDay(sel)?sel:null,occ=[];if(q.id)D.ports.forEach(X=>(plan[X.day]||[]).forEach((s,k)=>{if(s&&s.osm===q.id)occ.push({day:X.day,pi:k})}));
  openSheet(`<div class="hd"><h3 style="margin:0">${esc(nm)}</h3></div>
  <p style="margin:0 0 10px;display:flex;gap:6px;flex-wrap:wrap;align-items:center"><span class="tag" style="background:${OSMG[q.g].c};color:#fff">${OSMG[q.g].i} ${esc(osmKind(q))}</span>${t.cuisine?`<span class="tag">${esc(t.cuisine.replace(/_/g,' ').replace(/;/g,', '))}</span>`:''}${km!=null?`<span class="tag">${km<1?Math.round(km*100)*10+' m':km.toFixed(1).replace('.',',')+' km'} vom Hafen ${esc(pt.name)}</span>`:''}</p>
  ${row('Öffnungszeiten',t.opening_hours?esc(t.opening_hours):'')}${row('Adresse',esc(adr))}${row('Website',web?`<a href="${esc(safeUrl(web))}" target="_blank" rel="noopener">${esc(web.replace(/^https?:\/\//,'').replace(/\/$/,''))}</a>`:'')}${row('Telefon',ph?`<a href="tel:${esc(ph.replace(/[^+\d]/g,''))}">${esc(ph)}</a>`:'')}${row('Info',esc(t.description||''))}${row('Betreiber',esc(t.operator||t.brand||''))}
  ${occ.length?`<p style="margin:10px 0 0;font-weight:600;color:var(--plan)">★ Schon im Tagesplan: ${occ.map(o=>'Tag '+o.day+((plan[o.day][o.pi]||{}).at?' ('+esc(plan[o.day][o.pi].at)+')':'')).join(', ')}</p>`:''}${pl?`${opt.note&&!opt.note.startsWith(osmKind(q))?`<p class="src" style="margin:2px 0 0">${esc(opt.note)}</p>`:''}`:''}
  <div class="btns" style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px">${fromE&&pl&&pl.pi>=0?`<button class="chip btn" id="osmedit" style="padding:8px 14px">Eintrag bearbeiten</button><button class="chip" id="osmoth" style="padding:8px 14px">+ Auch an anderem Tag …</button>`:tday!=null?`<button class="chip btn" id="osmadd" style="padding:8px 14px">${occ.some(o=>o.day===tday)?'+ Noch einmal zu Tag '+tday:'+ Zu Tag '+tday+' hinzufügen'}</button><button class="chip" id="osmoth" style="padding:8px 14px">Anderer Tag …</button>`:`<button class="chip btn" id="osmoth" style="padding:8px 14px">+ Zum Tagesplan …</button>`}</div><div class="acts" style="margin-top:8px">${!fromE&&pl&&pl.pi>=0?`<button class="lnk" id="osmedit">Eintrag an Tag ${pl.day} bearbeiten ›</button>`:''}<a class="lnk" href="${esc(gm)}" target="_blank" rel="noopener">In Karten-App öffnen ›</a></div>
  <p class="src" style="margin:12px 0 0">Daten: © OpenStreetMap-Mitwirkende. Angaben können veraltet sein.</p>`,d=>{
    const oe=d.querySelector('#osmedit');if(oe)oe.onclick=()=>{closeDlg();setTimeout(()=>addPointDlg(pl.day,null,{day:pl.day,pi:pl.pi}),30)};
    const oAdd=dd=>{closeDlg();setTimeout(()=>addPointDlg(dd,{n:nm,note:osmKind(q)+(t.opening_hours?' · '+t.opening_hours:''),lat:q.lat,lon:q.lon,osm:q.id,o:{g:q.g,t:q.t}}),30)};
    const oo=d.querySelector('#osmoth');if(oo)oo.onclick=()=>{oo.parentElement.outerHTML='<div class="tpdays">'+D.ports.map(X=>`<button class="chip" data-tpd="${X.day}"><b>Tag ${X.day}</b> ${esc(X.name.split(' / ')[0])}</button>`).join('')+'</div>';d.querySelectorAll('[data-tpd]').forEach(b=>b.onclick=()=>oAdd(+b.dataset.tpd))};
    const oa=d.querySelector('#osmadd');if(oa)oa.onclick=()=>{closeDlg();setTimeout(()=>addPointDlg(tday,{n:nm,note:osmKind(q)+(t.opening_hours?' · '+t.opening_hours:''),lat:q.lat,lon:q.lon,osm:q.id,o:{g:q.g,t:q.t}}),30)};
  });
}
/* Gerätespeicher dauerhaft halten (sonst darf der Browser bei Platzmangel löschen) */
const STORE={p:null,use:0};
async function storeCheck(ask){
  const st=navigator.storage;if(!st||!st.persisted||window.__SEED)return;
  try{STORE.p=await st.persisted();if(!STORE.p&&ask&&st.persist)STORE.p=await st.persist();if(st.estimate){const e=await st.estimate();STORE.use=e.usage||0}}catch(e){}
  osmPopRender();
}
function storeHTML(){
  if(STORE.p==null)return '';const mb=STORE.use?' · '+(STORE.use/1048576).toFixed(STORE.use<10485760?1:0).replace('.',',')+' MB belegt':'';
  return STORE.p?`<p class="src" style="margin:4px 0 0">🔒 Speicher geschützt: wird nicht automatisch gelöscht${mb}.</p>`
   :`<p class="src" style="margin:4px 0 0">⚠️ Speicher nicht geschützt: Das Handy darf ihn bei Platzmangel löschen${mb}.${navigator.storage&&navigator.storage.persist?' <button class="chip" id="storeask" style="margin-top:4px">Schutz anfragen</button>':''} Am sichersten als installierte App über Chrome.</p>`;
}
async function osmAll(){
  if(OSM.prog)return;OSM.fail.clear();OSM.err='';
  const todo=osmPorts.filter(p=>!OSM.data.has(p.k));
  OSM.prog={done:osmPorts.length-todo.length,total:osmPorts.length,act:new Set()};osmPopRender();
  let wl=null;try{if(navigator.wakeLock)wl=await navigator.wakeLock.request('screen')}catch(e){}
  const relock=async()=>{if(document.visibilityState==='visible'&&OSM.prog&&navigator.wakeLock&&(!wl||wl.released))try{wl=await navigator.wakeLock.request('screen')}catch(e){}};
  document.addEventListener('visibilitychange',relock);
  const q=todo.slice();
  const worker=async()=>{while(q.length){const pt=q.shift();OSM.prog.act.add(pt.name);osmPopRender();await osmEnsure(pt);OSM.prog.act.delete(pt.name);OSM.prog.done++;osmPopRender()}};
  try{await Promise.all([worker(),worker()])}finally{
    document.removeEventListener('visibilitychange',relock);try{wl&&wl.release()}catch(e){}
    const miss=osmPorts.filter(p=>!OSM.data.has(p.k)).length;OSM.prog=null;if(miss)OSM.err=miss+' Häfen konnten nicht geladen werden.';osmPopRender();osmSched()}
}
function osmPopRender(){
  const pop=document.getElementById('osmpop');if(!pop||pop.hidden)return;
  const cnt={};for(const arr of OSM.data.values())for(const q of arr)cnt[q.g]=(cnt[q.g]||0)+1;
  const loaded=osmPorts.filter(p=>OSM.data.has(p.k)).length;
  {const seen=new Set();D.ports.forEach(P=>(P.pois||[]).forEach(q=>{const k=q.n+'|'+q.lat;if(seen.has(k))return;seen.add(k);const g=tipCat(q);cnt[g]=(cnt[g]||0)+1}))}
  pop.innerHTML=V(`<b style="font-size:13px">Orte auf der Karte</b>
  <div class="lgd"><span><span class="lgi ls">★</span>Unsere Orte (Tagesplan)</span><span><span class="lgi lt">🏛</span>Tipp zum Hafen</span><span><span class="lgi lo">🍽</span>Umgebung (OpenStreetMap)</span></div>
  ${OSM.busy.size?`<p class="src" style="margin:0">⏳ Lade Orte für ${esc([...osmPorts,...OSM.cells.values()].filter(p=>OSM.busy.has(p.k)).map(p=>p.name).join(', '))} … das kann bis zu einer Minute dauern.</p>`:''}
  ${OSM.err?`<p class="src bad" style="margin:0">${esc(OSM.err)}</p><button class="chip btn" id="osmretry">Erneut versuchen</button>`:''}
  <div class="osmchips">${Object.entries(CAT).map(([k,g])=>`<button class="chip" data-og="${k}" aria-pressed="${OSM.f.has(k)}" style="--c:${g.c}"><i></i>${g.i} ${g.n}${cnt[k]?' <small>'+cnt[k]+'</small>':''}</button>`).join('')}</div>
  <label class="osmsw"><input type="checkbox" id="osmon" ${OSM.on?'checked':''}> Umgebung aus OpenStreetMap zeigen</label>
  <p class="src" style="margin:0">★ immer sichtbar · Tipps ab Hafen-Zoom · Umgebung ganz nah. Antippen zeigt Details und „+ Zum Tagesplan“.</p>
  <div style="border-top:1px solid var(--line);padding-top:8px;width:100%">${OSM.prog?`<p class="src" style="margin:0"><b>${OSM.prog.done} von ${OSM.prog.total}</b> · lädt: ${esc([...OSM.prog.act].join(', '))||'…'}<br>App bitte geöffnet lassen, der Bildschirm bleibt an.</p><div class="tdbar" style="width:100%;margin:6px 0 2px"><i style="width:${Math.round(OSM.prog.done/OSM.prog.total*100)}%"></i></div>`:`<button class="chip" id="osmall" ${OSM.busy.size?'disabled':''}>Alle Häfen offline speichern</button>`}
  <p class="src" style="margin:4px 0 0">${loaded} von ${osmPorts.length} Häfen gespeichert (je 6 km um den Hafen). Weiter draußen lädt die App beim Hineinzoomen nach, wenn Internet da ist.</p>${storeHTML()}</div>`);
  pop.querySelector('#osmon').onchange=e=>{OSM.on=e.target.checked;osmSaveUi();osmRender();osmPopRender()};
  pop.querySelectorAll('[data-og]').forEach(b=>b.onclick=()=>{const k=b.dataset.og;OSM.f.has(k)?OSM.f.delete(k):OSM.f.add(k);osmSaveUi();osmRender();osmPopRender();mapSoon();if(sel!=null)renderPanel()});
  const sa=pop.querySelector('#storeask');if(sa)sa.onclick=()=>storeCheck(true);
  const rt=pop.querySelector('#osmretry');if(rt)rt.onclick=()=>{const L=osmPorts.filter(p=>OSM.fail.has(p.k));OSM.fail.clear();OSM.err='';osmPopRender();L.forEach(p=>osmEnsure(p,true))};
  const ab=pop.querySelector('#osmall');if(ab)ab.onclick=osmAll;
}
(function(){
  const z=document.querySelector('.zoom');if(!z)return;
  const b=document.createElement('button');b.id='osmbtn';b.setAttribute('aria-label','Orte aus OpenStreetMap');b.setAttribute('aria-expanded','false');b.innerHTML='<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 21s-6-5.4-6-10a6 6 0 0 1 12 0c0 4.6-6 10-6 10z"/><circle cx="12" cy="11" r="2"/></svg>';
  z.insertBefore(b,z.firstChild);
  const pop=document.createElement('div');pop.id='osmpop';pop.hidden=true;$('#mapwrap').appendChild(pop);
  const tog=v=>{pop.hidden=v==null?!pop.hidden:!v;b.setAttribute('aria-expanded',!pop.hidden);b.setAttribute('aria-pressed',!pop.hidden);osmPopRender()};
  b.onclick=e=>{e.stopPropagation();tog();if(!pop.hidden)storeCheck(false)};
  ['pointerdown','click','wheel'].forEach(ev=>pop.addEventListener(ev,e=>e.stopPropagation()));b.addEventListener('pointerdown',e=>e.stopPropagation());
  document.addEventListener('pointerdown',e=>{if(!pop.hidden&&!pop.contains(e.target)&&e.target!==b&&!b.contains(e.target))tog(false)});
  addEventListener('online',()=>{OSM.fail.clear();OSM.err='';osmSched()});
  storeCheck(true);
  window.__osmReady=true;
  osmLoadAll();
})();
function flyTo(x,y,zoom){
  const start={...vb};const end={w:Math.max(M.W/MINZ,Math.min(start.w,M.W/zoom))};end.h=end.w*ch/cw;end.x=x-end.w/2;end.y=y-end.h/2;
  const t0=performance.now(),dur=matchMedia('(prefers-reduced-motion:reduce)').matches?0:450;
  const step=t=>{const k=dur?Math.min(1,(t-t0)/dur):1,e=1-Math.pow(1-k,3);
    vb={x:start.x+(end.x-start.x)*e,y:start.y+(end.y-start.y)*e,w:start.w+(end.w-start.w)*e,h:start.h+(end.h-start.h)*e};applyVB();if(k<1)requestAnimationFrame(step)};
  requestAnimationFrame(step);
}
/* pan / zoom */
const ptrs=new Map();let last=null;
wrap.addEventListener('pointerdown',e=>{if(e.target.closest('.zoom'))return;ptrs.set(e.pointerId,{x:e.clientX,y:e.clientY,sx:e.clientX,sy:e.clientY,cap:false})});
wrap.addEventListener('pointermove',e=>{
  if(!ptrs.has(e.pointerId))return;const p=ptrs.get(e.pointerId);const u=vb.w/cw;
  if(ptrs.size===1){
    if(!p.cap){if(Math.hypot(e.clientX-p.sx,e.clientY-p.sy)<5)return;p.cap=true;hideTip();try{wrap.setPointerCapture(e.pointerId)}catch(x){}wrap.classList.add('drag')}
    vb.x-=(e.clientX-p.x)*u;vb.y-=(e.clientY-p.y)*u;p.x=e.clientX;p.y=e.clientY;applyVB()}
  else if(ptrs.size===2){
    const o=[...ptrs.entries()].find(([id])=>id!==e.pointerId)[1];
    const d0=Math.hypot(p.x-o.x,p.y-o.y),d1=Math.hypot(e.clientX-o.x,e.clientY-o.y);
    p.x=e.clientX;p.y=e.clientY;
    if(d0>0&&d1>0)zoomAt((e.clientX+o.x)/2,(e.clientY+o.y)/2,d0/d1);
  }
});
const up=e=>{ptrs.delete(e.pointerId);if(!ptrs.size)wrap.classList.remove('drag')};
wrap.addEventListener('pointerup',up);wrap.addEventListener('pointercancel',up);
function zoomAt(cx,cy,f){
  const r=wrap.getBoundingClientRect();const fx=(cx-r.left)/cw,fy=(cy-r.top)/ch;
  const nw=Math.max(M.W/MINZ,Math.min(vb.w*f,M.W*2));const k=nw/vb.w;
  vb.x+=(vb.w-nw)*fx;vb.y+=(vb.h-nw*ch/cw)*fy;vb.w=nw;applyVB();
}
wrap.addEventListener('wheel',e=>{hideTip();e.preventDefault();zoomAt(e.clientX,e.clientY,Math.exp(e.deltaY*0.0016))},{passive:false});
$('#zin').onclick=()=>{const r=wrap.getBoundingClientRect();zoomAt(r.left+cw/2,r.top+ch/2,0.6)};
$('#zout').onclick=()=>{const r=wrap.getBoundingClientRect();zoomAt(r.left+cw/2,r.top+ch/2,1.6)};
$('#zhome').onclick=()=>{home();applyVB()};
new ResizeObserver(()=>{if(!M||wrap.clientWidth<50)return;const cx=vb.x+vb.w/2,cy=vb.y+vb.h/2,w=vb.w;measure();vb.w=w;vb.h=w*ch/cw;vb.x=cx-vb.w/2;vb.y=cy-vb.h/2;applyVB()}).observe(wrap);

/* ---------- map content ---------- */
function groups(){
  const g={};D.ports.forEach(p=>{if(p.lat==null)return;const k=p.lat+','+p.lon;(g[k]=g[k]||[]).push(p)});return Object.values(g);
}
/* Routenform nach Veranstalter-Karte: Koordinaten im Screenshot-Raster, je Etappe per Ähnlichkeitstransformation auf unsere Häfen gelegt */
/* Route auf der Karte. Reisedaten: route = { legs:[{a:Tag, b:Tag, c:[[lat,lon],…] (Bézier: je 3 Punkte ein Bogen) | p:[[lat,lon],…] (Linie, z. B. Straße)}],
   sea:{Tag:[lat,lon]} }. Fehlt ein Abschnitt, verbindet die App automatisch: Schiff = sanfter Bogen, sonst gerade Linie. */
function routeGeo(){
  const R=D.route&&D.route.legs?D.route:{legs:[]};
  const S=D.ports.filter(p=>p.kind!=='sea'&&p.ox!=null),ship=TRIP.kind==='kreuzfahrt'||!!TRIP.ship,xy=q=>llxy(q[0],q[1]).map(v=>v.toFixed(1)).join(',');
  let d='',sea={};
  S.forEach((b,i)=>{if(!i){d='M'+b.ox+','+b.oy;return}const a=S[i-1],L=R.legs.find(x=>x.a===a.day&&x.b===b.day);
    if(L&&L.c&&L.c.length>=3){for(let k=0;k+2<L.c.length;k+=3)d+='C'+[L.c[k],L.c[k+1],L.c[k+2]].map(xy).join(' ')}
    else if(L&&L.p&&L.p.length){d+=L.p.map(q=>'L'+xy(q)).join('')+'L'+b.ox+','+b.oy}
    else{const dx=b.ox-a.ox,dy=b.oy-a.oy;if(Math.hypot(dx,dy)<0.5)return;const k=ship?0.12:0,cx=(a.ox+b.ox)/2-dy*k,cy=(a.oy+b.oy)/2+dx*k;
      d+=ship?'Q'+cx.toFixed(1)+','+cy.toFixed(1)+' '+b.ox+','+b.oy:'L'+b.ox+','+b.oy;
      const mid=D.ports.filter(p=>p.kind==='sea'&&p.day>a.day&&p.day<b.day);
      mid.forEach((p,j)=>{const t=(j+1)/(mid.length+1),u=1-t;sea[p.day]=[u*u*a.ox+2*u*t*cx+t*t*b.ox,u*u*a.oy+2*u*t*cy+t*t*b.oy]})}});
  for(const k in (R.sea||{}))sea[k]=llxy(R.sea[k][0],R.sea[k][1]);
  return {d,sea}}
function drawOverview(keep){drawMain(null,keep)}
function drawMain(p,keep){
  const vs=keep?{...vb}:null;
  setMap();
  const seq=D.ports.filter(p=>p.lat!=null);
  const rt=svg.querySelector('#rtg');
  const RG=routeGeo();el('path',{class:'route rtmain',d:RG.d},rt);
  const items=groups().map(g=>{
    const main=g.find(p=>p.kind==='port')||g[0];
    const days=g.map(p=>p.day).join(' · ');
    const off=main.ovOff||[0,0];
    const it={x:main.ox+off[0]*0.9,y:main.oy+off[1]*0.9,kind:'pill',txt:days,color:cssPort(main),baseColor:cssPort(main),dayList:g.map(p=>p.day),hideDet:g.map(p=>p.day),pname:main.name,label:main.name,prio:main.kind==='port'?5:3,on:sel!=null&&g.some(p=>p.day===sel),
      here:g.some(p=>p.date===TODAY),aria:`${main.name}, Tag ${days}`,onClick:()=>{hideTip();select(main.day)}};
    it.onHover=v=>v?showTip(it):hideTip();
    return it;
  });
  D.ports.filter(p=>p.kind==='sea').forEach(p=>{
    const a=[...seq].reverse().find(q=>q.day<p.day),b=seq.find(q=>q.day>p.day);
    if(!a||!b)return;
    const sp=RG.sea[p.day];const it={here:p.date===TODAY,x:sp?sp[0]:(a.ox+b.ox)/2,y:sp?sp[1]:(a.oy+b.oy)/2,kind:'sea',color:'#2f7fd1',txt:'',label:'Seetag '+p.day,prio:4,dayList:[p.day],pname:'Tag '+p.day+' · Seetag',aria:`Tag ${p.day}, Seetag`,onClick:()=>{hideTip();select(p.day)}};
    it.onHover=v=>v?showTip(it):hideTip();items.push(it);
  });
  mapPins(items);
  if(pm(p)){
    if(!p.ompp){const q=D.ports.find(q=>q.ompp&&q.name===p.name)||D.ports.find(q=>q.ompp);if(q)p.ompp=q.ompp}
    drawRings(p);
    items.push({x:p.ox,y:p.oy,kind:'port',lvl:'det',pday:p.day,color:cssv('--port'),txt:'',label:p.name+(CRUISE?' (Hafen)':''),prio:10,aria:(CRUISE?'Hafen ':'Ort ')+p.name,onClick:()=>{mapFull(false);setTab('ov');flyTo(p.ox,p.oy,M.W*p.ompp/1500)}});
    if(!keep){const PO=p.pois||[],near=PO.filter(q=>q.km!=null&&q.km<=4).sort((u,v)=>u.km-v.km);const use=(near.length>=3?near:PO.slice().sort((u,v)=>u.km-v.km).slice(0,3)).map(q=>[q.ox,q.oy]);
      (plan[p.day]||[]).forEach(s=>{if(s.x&&s.lat!=null)use.push(llxy(s.lat,s.lon))});
      const xs=[p.ox,...use.map(q=>q[0])],ys=[p.oy,...use.map(q=>q[1])],x0=Math.min(...xs),x1=Math.max(...xs),y0=Math.min(...ys),y1=Math.max(...ys),mh=2300/p.ompp;
      const w=Math.max((x1-x0)*1.5,mh*2),h=Math.max((y1-y0)*1.5,mh*2);M.focus={cx:(x0+x1)/2,cy:(y0+y1)/2,w,h}}
  }
  if(keep)vb=vs;else home();
  buildMarkers(items);updatePills();
  if(p&&pm(p))drawPlanRoute(p);
  applyVB();
}
const cssPort=p=>p.kind==='port'?cssv('--port'):cssv('--accent');
function drawRings(p){const g=svg.querySelector('#ringg');if(!g||!p.ompp)return;
  [[5,400],[10,800],[20,1600]].forEach(([mn,m])=>{const r=m/p.ompp;el('circle',{class:'wring',cx:p.ox,cy:p.oy,r},g);const t=el('text',{class:'wringl','data-r':r,x:p.ox,y:p.oy-r-4,'text-anchor':'middle'},g);t.textContent=mn+' Min. zu Fuß'})}
function drawPort(p,keep){drawMain(p,keep)}
/* Tipps aller Häfen und unsere Orte (★) aller Tage – unabhängig vom gewählten Tag */
function mapPins(items){
  const seen=new Set();
  D.ports.forEach(P=>(P.pois||[]).forEach((q,i)=>{const k=q.n+'|'+q.lat+'|'+q.lon;if(seen.has(k))return;seen.add(k);
    if((plan[P.day]||[]).some(s=>!s.x&&s.i===i))return;if(!OSM.f.has(tipCat(q)))return;
    const oth=sel!=null&&P.day!==sel;items.push({x:q.ox,y:q.oy,kind:'tip',lvl:'tip',pday:P.day,oth,color:CAT[tipCat(q)].c,txt:tipIcon(q),label:oth?'':q.n,prio:oth?3:5,ca:q.ca,aria:q.n+' (Tipp, '+TYPES[q.t][0]+')',
      onClick:()=>tipDlg(P.day,i),onHover:v=>{if(sel===P.day){const c=$('#poi'+i);if(c)c.classList.toggle('hl',v)}}})}));
  Object.keys(plan).forEach(d=>{const P=byDay(+d);if(!P)return;(plan[d]||[]).forEach((s,k)=>{let xy,nm=s.n;
    if(s.x){if(s.lat==null)return;xy=llxy(s.lat,s.lon)}else{const q=(P.pois||[])[s.i];if(!q)return;xy=[q.ox,q.oy];nm=q.n}
    const on=+d===sel;items.push({x:xy[0],y:xy[1],kind:'star',lvl:'star',pday:+d,color:cssv('--plan'),label:nm,prio:on?9:8,on,aria:nm+' (unser Ort, Tag '+d+')',
      onClick:()=>s.x?placeDlg(+d,k):tipDlg(+d,s.i)})})});
  if(STAY_ON)STAYS.forEach(s=>{if(s.lat==null)return;const xy=llxy(s.lat,s.lon);items.push({x:xy[0],y:xy[1],kind:'stay',lvl:'star',color:'#7b5cc4',label:s.n,prio:8,aria:s.n+' (Unterkunft)',onClick:()=>stayDlg(s.id,s.d1)})});
}
var mapT=0;function mapSoon(){if(mapT)return;mapT=requestAnimationFrame(()=>{mapT=0;try{if(!M)return;const p=sel!=null?byDay(sel):null;drawMain(pm(p)?p:null,true)}catch(e){}})}
/* Infofenster für einen Tipp (gleicher Aufbau wie bei OpenStreetMap-Orten) */
function tipDlg(day,i){const P=byDay(day),q=P&&(P.pois||[])[i];if(!q)return;const c=CAT[tipCat(q)],w=WALK[q.w];
  const tgt=sel!=null&&byDay(sel)?sel:day,T=byDay(tgt),same=tgt===day;
  // schon im Plan? (am eigenen Tag als Tipp oder an einem anderen Tag als eigener Eintrag mit gleicher Lage)
  const where=[];D.ports.forEach(X=>(plan[X.day]||[]).forEach((s,k)=>{if((X.day===day&&!s.x&&s.i===i)||(s.x&&s.lat===q.lat&&s.lon===q.lon))where.push({d:X.day,k})}));
  const addTo=d=>{const X=byDay(d);if(!X)return;closeDlg();const u=planSnap(d);
    if(d===day&&!(plan[d]||[]).some(s=>!s.x&&s.i===i))planAdd(P,i);else{(plan[d]=plan[d]||[]).push({x:1,n:q.n,lat:q.lat,lon:q.lon,s:Math.max(5,(q.g&&q.g.s)||60),t:0,at:'',note:''});savePlan();refreshPlan(X)}
    undoToast(`„${q.n}“ zu Tag ${d} hinzugefügt.`,u)};
  openSheet(`<div class="hd"><h3 style="margin:0">${esc(q.n)}<small class="hds">${same?`Tipp · Tag ${P.day} · ${esc(fmtDate(P.date))} · ${esc(P.name)}`:`Tipp aus Tag ${P.day} · ${esc(P.name)}`}</small></h3></div>
  <p style="margin:0 0 10px;display:flex;gap:6px;flex-wrap:wrap"><span class="tag" style="background:${c.c};color:#fff">${tipIcon(q)} ${esc(TYPES[q.t][0])}</span>${w?`<span class="tag ${w[1]}">${w[0]}</span>`:''}<span class="tag">${q.km<0.1?'unter 0,1':String(q.km).replace('.',',')} km vom Hafen</span></p>
  <p style="margin:0 0 8px">${esc(q.d||'')}</p>${q.g?`<p class="src" style="margin:0">${esc(MODE[q.g.m])} ca. ${q.g.t} Min ab Pier${q.g.o?' · '+esc(q.g.o):''}</p>`:''}
  ${where.length?`<p style="margin:10px 0 0;font-weight:600;color:var(--plan)">★ Im Tagesplan von Tag ${[...new Set(where.map(x=>x.d))].join(', ')}</p>`:''}
  <div class="btns bar"><button class="chip btn" id="tpadd">${where.some(x=>x.d===tgt)?'+ Noch einmal zu Tag '+tgt:same?'+ Zum Tagesplan':'+ Zu Tag '+tgt+' hinzufügen'}</button><button class="chip" id="tpoth">Anderer Tag …</button>${where.some(x=>x.d===tgt)?`<button class="chip del" id="tprm" style="margin-left:auto">Aus Tag ${tgt} entfernen</button>`:''}</div>
  <div class="acts" style="margin-top:10px"><a class="lnk" href="https://www.google.com/maps/search/?api=1&query=${q.lat},${q.lon}" target="_blank" rel="noopener">Google Maps ›</a></div>`,d=>{
    const rm=d.querySelector('#tprm');if(rm)rm.onclick=()=>{const x=where.find(x=>x.d===tgt);if(!x)return;closeDlg();const u=planSnap(tgt),n=q.n;plan[tgt].splice(x.k,1);savePlan();refreshPlan(T);undoToast(`„${n}“ aus Tag ${tgt} entfernt.`,u)};
    const a=d.querySelector('#tpadd');if(a)a.onclick=()=>addTo(tgt);
    const o=d.querySelector('#tpoth');if(o)o.onclick=()=>{o.parentElement.outerHTML='<div class="tpdays">'+D.ports.map(X=>`<button class="chip${X.day===tgt?' on':''}" data-tpd="${X.day}"><b>Tag ${X.day}</b> ${esc(X.name.split(' / ')[0])}</button>`).join('')+'</div>';
      d.querySelectorAll('[data-tpd]').forEach(b=>b.onclick=()=>addTo(+b.dataset.tpd))}})}
function pm(p){return !!(p&&p.lat!=null&&p.ox!=null&&(p.pois||(plan[p.day]||[]).some(s=>s.x&&s.lat!=null)))}
let mapMin=false;
try{mapMin=localStorage.getItem('rp-map-min')==='1'}catch(e){}
function applyMin(){
  $('main').classList.toggle('mapmin',mapMin);
  const t=$('.mtog');if(t){t.textContent=mapMin?'Karte anzeigen ▸':'Karte ausblenden ▾';t.setAttribute('aria-expanded',!mapMin)}
  if(!mapMin&&M)setTimeout(()=>{measure();if(hiddenDraw){hiddenDraw=false;home()}applyVB()},30);
}
/* Ziehgriff unter der Karte (Handy, Tagesansicht): Karte größer/kleiner ziehen, rastet auf klein/mittel/groß ein */
const GRIP={k:'m'};try{GRIP.k=localStorage.getItem('rp-map-size')||'m'}catch(e){}
function gripSizes(){const vh=innerHeight,mc=$('.mapcol'),bn=$('#bnav'),top=mc?mc.getBoundingClientRect().top+scrollY:0,bh=bn&&getComputedStyle(bn).display!=='none'?bn.offsetHeight:0;
  const top0=Math.max(0,top-scrollY);return {s:Math.max(130,Math.round(vh*.22)),m:Math.round(vh*.4),l:Math.max(Math.round(vh*.45),Math.round(vh-top0-bh-70))}}
function gripSet(h,anim){const mc=$('.mapcol');if(!mc)return;const cy=M?vb.y+vb.h/2:0,cx=M?vb.x+vb.w/2:0;
  mc.style.transition=anim?'height .22s ease':'';mc.style.height=Math.round(h)+'px';mc.classList.toggle('sm',h<280);
  const fix=()=>{if(!M)return;measure();vb.h=vb.w*ch/cw;vb.x=cx-vb.w/2;vb.y=cy-vb.h/2;applyVB()};
  if(anim){setTimeout(fix,240)}else fix()}
function gripOn(){return matchMedia('(max-width:860px)').matches&&!document.body.classList.contains('v-map')&&!document.body.classList.contains('mapfull')}
function gripApply(){const mc=$('.mapcol');if(!mc)return;if(!gripOn()){mc.classList.remove('sm');if(mc.style.height){mc.style.height='';mc.style.transition='';if(M)setTimeout(()=>{measure();applyVB()},30)}return}
  const S=gripSizes(),h=S[GRIP.k]||S.m;if(Math.abs((parseFloat(mc.style.height)||0)-h)>2)gripSet(h,false)}
(function(){const mc=$('.mapcol');if(!mc)return;const g=document.createElement('div');g.id='mgrip';g.setAttribute('role','separator');g.setAttribute('aria-orientation','horizontal');
  g.setAttribute('aria-label','Kartengröße: ziehen oder antippen');g.tabIndex=0;g.innerHTML='<span></span>';mc.appendChild(g);
  let st=null,raf=0;
  const snap=(h,dy)=>{const S=gripSizes(),ks=['s','m','l'];let k=ks.reduce((b,x)=>Math.abs(S[x]-h)<Math.abs(S[b]-h)?x:b,'m');
    if(Math.abs(dy)>40){const i0=ks.indexOf(st.k);if(ks.indexOf(k)===i0)k=ks[Math.max(0,Math.min(2,i0+(dy>0?1:-1)))]}
    GRIP.k=k;try{localStorage.setItem('rp-map-size',k)}catch(e){}gripSet(S[k],true)};
  g.addEventListener('pointerdown',e=>{e.preventDefault();e.stopPropagation();g.setPointerCapture(e.pointerId);st={y:e.clientY,h:mc.getBoundingClientRect().height,k:GRIP.k,moved:false};g.classList.add('on')});
  g.addEventListener('pointermove',e=>{if(!st)return;const dy=e.clientY-st.y;if(Math.abs(dy)>5)st.moved=true;if(!st.moved)return;const S=gripSizes(),h=Math.max(S.s*.8,Math.min(S.l*1.04,st.h+dy));
    if(!raf)raf=requestAnimationFrame(()=>{raf=0;gripSet(h,false)})});
  const end=e=>{if(!st)return;g.classList.remove('on');const dy=e.clientY-st.y;
    if(!st.moved){const S=gripSizes();GRIP.k=GRIP.k==='l'?'m':'l';try{localStorage.setItem('rp-map-size',GRIP.k)}catch(x){}gripSet(S[GRIP.k],true)}
    else snap(mc.getBoundingClientRect().height,dy);st=null};
  g.addEventListener('pointerup',end);g.addEventListener('pointercancel',end);
  g.addEventListener('keydown',e=>{const ks=['s','m','l'];let i=ks.indexOf(GRIP.k);if(e.key==='ArrowDown')i++;else if(e.key==='ArrowUp')i--;else if(e.key==='Enter'||e.key===' ')i=GRIP.k==='l'?1:2;else return;
    e.preventDefault();GRIP.k=ks[Math.max(0,Math.min(2,i))];try{localStorage.setItem('rp-map-size',GRIP.k)}catch(x){}gripSet(gripSizes()[GRIP.k],true)});
  new MutationObserver(()=>setTimeout(gripApply,0)).observe(document.body,{attributes:true,attributeFilter:['class']});
  addEventListener('resize',()=>setTimeout(gripApply,80));setTimeout(gripApply,0)})();
/* ---------- Ein- und Ausschiffung (nur Kreuzfahrt): Station.emb am ersten bzw. letzten Tag ----------
   Start {ci1, ci2 (Check-in-Fenster), ab (alle an Bord), dep (Ablegen), pier} · Ende {arr, w1, w2 (Ausschiffungsfenster), grp, bag (Koffer raus am Vorabend)} */
const EMBF={start:[['ci1','Check-in ab'],['ci2','Check-in bis'],['ab','Alle an Bord'],['dep','Ablegen']],end:[['arr','Ankunft im Hafen'],['w1','Ausschiffung ab'],['w2','Ausschiffung bis'],['bag','Koffer raus (Vorabend)']]};
function embFormHTML(kind,o){const F=EMBF[kind];if(!F)return '';o=o||{};const inp=([k,l])=>`<label>${l}<input type="time" name="em_${k}" value="${esc(o[k]||'')}"></label>`;
  return `<label style="margin-top:4px">${kind==='start'?'🚢 Einschiffung':'🏁 Ausschiffung'} (optional, laut Veranstalter)</label><div class="two">${inp(F[0])}${inp(F[1])}</div><div class="two">${inp(F[2])}${inp(F[3])}</div>
    <label>${kind==='start'?'Terminal / Pier':'Gruppe / Kofferfarbe'}<input name="em_x" maxlength="40" value="${esc(o[kind==='start'?'pier':'grp']||'')}" placeholder="${kind==='start'?'z. B. Terminal 2':'z. B. Gruppe 7, Gelb'}"></label>`}
function embRead(f,kind){if(!f.em_x)return undefined;const o={};(EMBF[kind]||[]).forEach(([k])=>{const v=f['em_'+k]&&f['em_'+k].value;if(v)o[k]=v});const x=f.em_x.value.trim();if(x)o[kind==='start'?'pier':'grp']=x;return Object.keys(o).length?o:null}
const embOf=DP.embOf;
function embChips(p){const e=embOf(p);if(!e)return [];return p.kind==='start'?[e.ci1?`<span>🚢 Check-in ${e.ci1}${e.ci2?'–'+e.ci2:''}</span>`:'',e.ab?`<span>an Bord <b>${e.ab}</b></span>`:'',e.dep?`<span>Ablegen ${e.dep}</span>`:'']
  :[e.arr?`<span>Ankunft ${e.arr}</span>`:'',e.w1?`<span>🏁 Ausschiffung ${e.w1}${e.w2?'–'+e.w2:''}</span>`:'']}
function embMarks(p){return DP.embList(p).map(x=>({a:x.a,t:x.t,h:esc(x.txt)+(x.extra?' · '+esc(x.extra):'')}))}
/* Passt die An-/Abreise zur Ein-/Ausschiffung? */
function embWarn(k,s){if(!CRUISE||!s)return '';const P=k==='out'?D.ports[0]:D.ports[D.ports.length-1],e=embOf(P);if(!e)return '';
  if(k==='out'&&e.ci2&&s.z.ad&&s.z.at){if(s.z.ad>P.date||(s.z.ad===P.date&&tm(s.z.at)>tm(e.ci2)))return `<p class="tvw">⚠️ Ankunft ${s.z.ad===P.date?s.z.at+' Uhr':'erst am '+fmtDate(s.z.ad)} – der Check-in endet um ${e.ci2} Uhr</p>`}
  if(k==='back'&&(e.w2||e.w1)&&s.a.dd===P.date){const gap=tm(s.a.dt)-tm(e.w2||e.w1);if(gap<180)return `<p class="tvw">⚠️ ${gap<0?'Abfahrt vor dem Ende der Ausschiffung':'Nur '+durTxt(gap)+' zwischen Ausschiffung ('+(e.w2||e.w1)+') und Abfahrt'}</p>`}
  return ''}
/* ---------- An- und Abreise (alle Reisearten): trips/<id>/travel/out|back ----------
   {mode: plane|train|car|bus, segs:[{f:{n,c,lat,lon,tz}, t:{…}, dd,dt (Abfahrt, Ortszeit), ad,at (Ankunft, Ortszeit), no, al, km, min}], ref, note}
   Zeiten werden wie auf dem Ticket in Ortszeit eingegeben; Dauer und Zeitumstellung rechnet die App über die Zeitzonen. */
const TKEY='rp-'+TRIP_ID+'-travel';let TRV={};try{TRV=JSON.parse(localStorage.getItem(TKEY)||'{}')}catch(e){}
const TVM={plane:['✈️','Flug'],train:['🚆','Zug'],car:['🚗','Auto'],bus:['🚌','Bus']};
function tvStore(){try{localStorage.setItem(TKEY,JSON.stringify(TRV))}catch(e){}}
function tvInit(db){db.collection('travel').onSnapshot({includeMetadataChanges:true},s=>{s.docs.forEach(d=>{if(!d.metadata.hasPendingWrites)SYNC['travel:'+d.id]=d.data()});
  const o={};s.docs.forEach(d=>o[d.id]=d.data());TRV=o;tvFillA.d={};tvStore();sChanged()},()=>{})}
function tvPut(k,o){TRV[k]=o;tvStore();if(TS.mode==='db'&&dbh)putDoc('travel',{id:k,...o});sChanged()}
function tvDel(k){delete TRV[k];tvStore();if(TS.mode==='db'&&dbh)delDoc('travel',k);sChanged()}
const tzOffAt=RPDP.tzOffAt,utcOf=RPDP.utcOf,localOf=RPDP.localOf;
async function tzName(pl){if(pl.tz)return pl.tz;try{if(!window.tzlookup)await loadJs('tzlookup.js');return tzlookup(pl.lat,pl.lon)}catch(e){return null}}
const durTxt=RPDP.durTxt;
const plTxt=p=>p?(p.c?p.c+' '+p.n:p.n):'?';
/* Zusammenfassung: Dauer, Umstiege, Zeitumstellung, Ankunft in Heimatzeit */
function tvSum(o){return RPDP.tvSum(o)}
/* Kurzname eines Halts: Flughafen „FRA Frankfurt“, erste Adresse nur Ort, weitere Adressen „Ort · Straße“ */
function tvShort(p,first){if(!p)return '?';if(p.c)return p.c+' '+p.n;let n=p.n||'',a=p.a||'';const k=n.indexOf(',');if(!a&&k>0&&/\d/.test(n.slice(0,k))){a=n.slice(k+1).trim();n=n.slice(0,k).trim()}
  const city=a.replace(/^\d{4,5}\s+/,'').trim(),street=/\d/.test(n)?n.replace(/\s*\d+\s*[a-zA-Z]?\s*$/,''):'';
  return city?(first||!street?city:city+' · '+street):n}
async function tvFillA(k){const o=TRV[k];if(!o||navigator.onLine===false)return;
  if(FBX.on&&!(TS.mode==='db'&&dbh))return; // erst nach dem Laden vom Server ergänzen, sonst überschreibt der Server-Stand es wieder
  tvFillA.d[k]=1;let ch=0;
  for(const x of o.segs||[])for(const pl of [x.f,x.t]){if(!pl||pl.a||pl.c||pl.lat==null)continue;const n=pl.n||'',i=n.indexOf(',');if(i>0&&/\d/.test(n.slice(0,i))){pl.a=n.slice(i+1).trim();pl.n=n.slice(0,i).trim();ch=1;continue}
    try{const j=await (await fetch(PHOTON.replace(/api\/?$/,'reverse')+'?lat='+pl.lat+'&lon='+pl.lon+'&lang=de')).json(),r=((j.features||[])[0]||{}).properties||{},c=r.city||r.town||r.village||r.locality||r.county||'';if(c){pl.a=(r.postcode?r.postcode+' ':'')+c;ch=1}}catch(e){}}
  if(ch)tvPut(k,o)}
tvFillA.d={};
/* An-/Abreise als Zeitleiste: mode 'open' = aufgeklappt, sonst zugeklappt (außer an den Reisetagen selbst) */
/* Sitzplätze je Mitreisendem (Anmeldung) und Teilstrecke: seg.seat = {<uid>: '23A'} */
const tvPP=()=>MEMBERS.length?MEMBERS.map(m=>({id:m.id,n:m.n,l:m.l})):(TRIP.people||[]).map((x,i)=>({id:'p'+i,n:x.n,l:x.l}));
function seatTxt(x){const S=x.seat||{},P=tvPP(),L=Object.keys(S).filter(k=>S[k]);if(!L.length)return '';
  const nm=k=>{const m=P.find(p=>p.id===k);return m?(m.l||(m.n||'?')[0]):'?'};return (x.m==='plane'?'Sitz ':'Platz ')+L.map(k=>esc(S[k])+(L.length>1||P.length>1?' ('+esc(nm(k))+')':'')).join(' · ')}
function tvBlock(k,mode){const o=TRV[k],lbl=k==='out'?'Anreise':'Abreise';
  if(!o)return mode==='sum'?'':`<div class="tvb add"><button class="lnk" data-tv="${k}">+ ${lbl} eintragen</button><small>Flug, Zug oder Auto – mit Zeitumstellung</small></div>`;
  const sm=x=>x.m||o.mode,s=tvSum(o);
  if(!s)return `<div class="tvb"><div class="tvh"><b>${lbl}</b><button class="lnk" data-tv="${k}">Bearbeiten ›</button></div><small>noch unvollständig</small></div>`;
  const plus=x=>x.ad&&x.ad>x.dd?'<sup>+'+Math.round((new Date(x.ad)-new Date(x.dd))/864e5)+'</sup>':'';
  const row=(t,i,name,sub,cls)=>`<div class="tvr${cls?' '+cls:''}"><span class="tvt">${t}</span><span class="tvi">${i}</span><span class="tvn"><b>${name}</b>${sub?`<small>${sub}</small>`:''}</span></div>`;
  const adr=p=>{if(!p)return ['?',''];if(p.c)return [p.c+' '+p.n,''];let n=p.n||'',a=p.a||'';const k=n.indexOf(',');if(!a&&k>0&&/\d/.test(n.slice(0,k))){a=n.slice(k+1).trim();n=n.slice(0,k).trim()}return [n,a]};
  // Adresse: PLZ Ort fett (wohin geht es), Straße darunter, Zeit/km in eigener Zeile
  const R2=(t,i,pl,sub,cls)=>{const [n,a]=adr(pl);return row(t,i,esc(a||n),[a?esc(n):'',sub?'<span class="tvx">'+sub+'</span>':''].filter(Boolean).join('<br>'),cls)};
  if(!tvFillA.d[k])tvFillA(k);
  let h='',merged=false;const navL=x=>x.f.lat!=null&&x.t.lat!=null?`<a class="lnk tvnav" href="https://www.google.com/maps/dir/?api=1&origin=${x.f.lat},${x.f.lon}&destination=${x.t.lat},${x.t.lon}&travelmode=driving" target="_blank" rel="noopener">Navigation ›</a>`:'';
  const legSub=x=>[x.no?esc(x.no):'',seatTxt(x),sm(x)==='car'&&x.km?x.km.toLocaleString('de-DE')+' km · '+durTxt(x.min):''].filter(Boolean).join(' · ');
  s.S.forEach((x,j)=>{const m=sm(x),ico=(TVM[m]||TVM.plane)[0];
    if(!merged)h+=R2(x.dt,ico,x.f,legSub(x));merged=false;
    const nx=s.S[j+1],tA=x.at?(x.calc?'<i class="ap">~</i>':'')+x.at+plus(x):'?';
    const nv=m==='car'?navL(x):'';
    const dl=x.ad&&x.ad!==s.a.dd?'<b class="tvdt">'+fmtDate(x.ad)+'</b>':'';
    if(!nx){h+=R2(tA,m==='plane'?'🛬':'🏁',x.t,[dl,nv].filter(Boolean).join('<br>'),'end');return}
    const wait=x.ad&&x.at?(utcOf(nx.dd,nx.dt,nx.f.tz)-utcOf(x.ad,x.at,x.t.tz))/6e4:null,w=wait!=null&&wait>=0?durTxt(wait):'';
    if(tvShort(nx.f)===tvShort(x.t)){ // gleicher Ort: Umstieg in einer Zeile, weiter mit der nächsten Strecke
      h+=R2(tA,'🔁',x.t,[dl,nv,w?'Umstieg '+w:'','weiter '+(nx.dd&&nx.dd!==x.ad?fmtDate(nx.dd)+' ':'')+nx.dt+' '+(TVM[sm(nx)]||TVM.plane)[0],legSub(nx)].filter(Boolean).join(' · '),'mid');merged=true}
    else h+=R2(tA,'📍',x.t,[dl,nv,w?'⏱ '+w+' bis zur Weiterreise':''].filter(Boolean).join('<br>'),'mid')});
  const sh=Math.abs(s.shift),shT=sh+' Std.',cp=(c,t,hint)=>`<button type="button" class="tvq${c?' '+c:''}" data-hint="${esc(hint)}">${t}</button>`;
  const chips=[s.dur!=null?cp('',`⏱ ${durTxt(s.dur)}`,`Reisedauer: ${durTxt(s.dur)} von der Abfahrt in ${tvShort(s.a.f,1)} bis zur Ankunft in ${tvShort(s.z.t,1)} – mit allen Umstiegen und Wartezeiten, unabhängig von der Zeitumstellung.`):'',
    s.shift?cp('w',`🕒 Uhr ${s.shift>0?'+':'−'}${shT}`,`Zeitumstellung: In ${tvShort(s.z.t,1)} ist es ${shT} ${s.shift>0?'später':'früher'} als in ${tvShort(s.a.f,1)}. Die Uhr bei der Ankunft ${s.shift>0?'vorstellen':'zurückstellen'}. Alle Zeiten hier sind Ortszeit.`):'',
    s.shift&&s.home&&k==='out'?cp('',`🏠 ${s.home.t}${s.home.d!==s.z.ad?' ('+fmtDate(s.home.d)+')':''}`,`Zuhause-Zeit: Bei der Ankunft um ${s.z.at} Ortszeit ist es in ${tvShort(s.a.f,1)} ${s.home.t} Uhr${s.home.d!==s.z.ad?' am '+fmtDate(s.home.d):''}. Hilft beim Einschätzen von Müdigkeit und Jetlag.`):''].filter(Boolean).join('');
  const multi=s.z.ad&&s.z.ad!==s.a.dd,head=`${lbl} · ${fmtDate(s.a.dd)}${multi?' – '+fmtDate(s.z.ad):''}`,sumTxt=`${s.a.dt} → ${multi?'<b>'+fmtDate(s.z.ad)+'</b> ':''}${s.z.at||'?'} ${esc(tvShort(s.z.t))}${s.dur!=null?' · '+durTxt(s.dur):''}`;
  const body=`<div class="tvtl">${h}</div>${chips?`<div class="tvc">${chips}</div>`:''}${embWarn(k,s)}${o.ref||o.note?`<small>${esc([o.ref?'Buchung '+o.ref:'',o.note].filter(Boolean).join(' · '))}</small>`:''}${fChipsHTML(fOfKey(k),k)}<div class="acts tvacts"><button class="lnk" data-fadd="${k}">+ Datei</button><button class="lnk" data-tv="${k}" style="margin-left:auto">Bearbeiten ›</button></div>`;
  const now=TODAY>=s.a.dd&&TODAY<=(s.z.ad||s.a.dd),open=mode==='open'||(mode!=='sum'&&now);
  return `<details class="tvb"${open?' open':''}><summary><b>${head}</b><small class="tvs">${sumTxt}</small><i aria-hidden="true">›</i></summary>${body}</details>`}
/* Kleine Erklärung beim Antippen (data-hint): Blase am Element, schließt beim nächsten Tippen/Scrollen */
{let hb=null;const hide=()=>{if(hb){hb.remove();hb=null}};
  document.addEventListener('click',e=>{const t=e.target.closest&&e.target.closest('[data-hint]');const was=hb&&hb._for;hide();if(!t||was===t)return;e.stopPropagation();e.preventDefault();
    hb=document.createElement('div');hb.className='hintb';hb.setAttribute('role','tooltip');hb.textContent=t.dataset.hint;hb._for=t;document.body.appendChild(hb);
    const r=t.getBoundingClientRect(),w=Math.min(300,innerWidth-24);hb.style.width=w+'px';const x=Math.max(12,Math.min(innerWidth-w-12,r.left+r.width/2-w/2));
    const h=hb.offsetHeight,y=r.bottom+8+h<innerHeight?r.bottom+8:r.top-8-h;hb.style.left=x+'px';hb.style.top=Math.max(8,y)+'px';
    hb.style.setProperty('--ax',(r.left+r.width/2-x)+'px');hb.classList.toggle('up',y<r.top)},true);
  ['scroll','resize'].forEach(ev=>addEventListener(ev,hide,true))}
function tvDayHTML(p,only){let h='';(only?[only]:['out','back']).forEach(k=>{const o=TRV[k];if(o&&(o.segs||[]).some(x=>x.dd===p.date||x.ad===p.date))h+=tvBlock(k,'open')});return h}
document.addEventListener('click',e=>{const b=e.target.closest&&e.target.closest('[data-tv]');if(!b||e.target.closest('a'))return;e.stopPropagation();tvDlg(b.dataset.tv)},true);
/* Flughäfen (OpenFlights) offline */
let APC=null;async function airportsLoad(){if(APC)return APC;const t=await (await fetch('airports.txt')).text();if(!/\|/.test(t))throw new Error('fehlt');
  APC=t.split('\n').filter(l=>l&&l[0]!=='#').map(l=>{const a=l.split('|');return {c:a[0],n:a[1],city:a[2],cc:a[3],lat:+a[4],lon:+a[5],tz:a[6],k:nrmP(a[2]+' '+a[1])}});return APC}
async function airportFind(q){const L=await airportsLoad(),u=q.trim().toUpperCase(),k=nrmP(q.trim());if(k.length<2)return [];
  const ex=L.filter(x=>x.c===u),hit=L.filter(x=>x.c!==u&&(x.k.startsWith(k)||x.k.includes(' '+k))).sort((a,b)=>(/intl|international/i.test(b.n)?1:0)-(/intl|international/i.test(a.n)?1:0));
  return ex.concat(hit).slice(0,7).map(x=>({n:x.city,c:x.c,lat:x.lat,lon:x.lon,tz:x.tz,sub:x.n+' · '+landName(x.cc)}))}
/* Ort für Von/Nach wählen (Unterseite) */
function tvPick(title,plane,near,cb){let tmr=0,res=[];const home=(()=>{try{return JSON.parse(localStorage.getItem('rp-home')||'null')}catch(e){return null}})();
  openSheet(`<div class="hd"><h3 style="margin:0">${esc(title)}</h3><button class="x" data-close aria-label="Zurück">✕</button></div>
    <div class="sfield" style="margin:0"><svg class="sfi" viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg><input id="tvq" type="search" autocomplete="off" placeholder="${plane?'Flughafen, Stadt oder Code (z. B. FRA)':'Ort, Bahnhof oder Adresse'}"></div>
    <div id="tvr">${home&&!plane?`<button type="button" class="plres" data-home><span class="pli">🏠</span><span class="plt"><b>${esc(home.n)}</b><small>Zuhause (zuletzt benutzt)</small></span><span class="plgo">Wählen ›</span></button>`:''}</div>
    <div class="acts" style="margin:8px 0 0"><button type="button" class="lnk" id="tvmap">📍 Auf der Karte wählen</button></div>`,d=>{asPage();
    const q=d.querySelector('#tvq'),r=d.querySelector('#tvr'),done=x=>{cb(x);history.back()};
    const hb=d.querySelector('[data-home]');if(hb)hb.onclick=()=>done(home);
    q.oninput=()=>{clearTimeout(tmr);tmr=setTimeout(async()=>{const v=q.value.trim();if(v.length<2){r.innerHTML='';return}
      const A=await airportFind(v).catch(()=>[]),P=v.length>=3?await placeSearchAny(v,near):[],Pm=P.map(x=>{const a=(x.addr||'').split(', ').filter(t=>t&&t!==x.country&&!x.name.includes(t)).join(', ');if(x.hnx){const k=x.name.indexOf(',');return {n:k>0?x.name.slice(0,k).trim():x.name,lat:x.lat,lon:x.lon,sub:x.addr,hnx:1,a:k>0?x.name.slice(k+1).trim():''}}return {n:x.name,lat:x.lat,lon:x.lon,sub:x.addr,a}});
      res=plane||/^[A-Za-z]{3}$/.test(v)?A.concat(Pm):Pm.concat(A.slice(0,3));
      r.innerHTML=res.length?'<p class="plask">Bitte antippen:</p>'+res.slice(0,9).map((x,i)=>`<button type="button" class="plres" data-r="${i}"><span class="pli">${x.c?'✈️':x.hnx?'🏠':'📍'}</span><span class="plt"><b>${esc(x.c?x.c+' · '+x.n:x.n)}</b><small>${esc(x.sub||'')}</small></span><span class="plgo">Wählen ›</span></button>`).join(''):`<p class="src" style="margin:8px 0 0">${esc(P.msg||'Nichts gefunden.')}</p>`;
      r.querySelectorAll('[data-r]').forEach(b=>b.onclick=()=>done(res[+b.dataset.r]))},400)};setTimeout(()=>q.focus(),150);
    d.querySelector('#tvmap').onclick=()=>pickOnMap(near,x=>{cb({n:x.name,lat:x.lat,lon:x.lon})})})}
/* Eingabe An-/Abreise */
function tvDlg(k,draft){const lbl=k==='out'?'Anreise':'Abreise',D0=k==='out'?TRIP.start:TRIP.end;
  const o=draft||JSON.parse(JSON.stringify(TRV[k]||{mode:TRIP.arrival&&TVM[TRIP.arrival]?TRIP.arrival:'plane',segs:[{dd:D0,dt:'',ad:'',at:''}],ref:'',note:''}));
  const near=k==='out'?D.ports.find(p=>p.lat!=null):[...D.ports].reverse().find(p=>p.lat!=null);o.segs.forEach(x=>{if(!x.m)x.m=o.mode});o.mode=o.segs[0].m;
  const split=pl=>{if(pl&&!pl.a&&!pl.c){const k=pl.n.indexOf(',');if(k>0&&/\d/.test(pl.n.slice(0,k))){pl.a=pl.n.slice(k+1).trim();pl.n=pl.n.slice(0,k).trim()}}};o.segs.forEach(x=>{split(x.f);split(x.t)});
  // ältere Einträge ohne Ort: nächsten Ort aus der Offline-Ortsliste ergänzen
  {const miss=[];o.segs.forEach(x=>[x.f,x.t].forEach(pl=>{if(pl&&!pl.a&&!pl.c&&pl.lat!=null)miss.push(pl)}));
   // online genau (Rückwärtssuche: PLZ + Ort), offline nur wenn ein bekannter Ort sehr nah liegt
   const rev=async pl=>{if(navigator.onLine!==false){try{const j=await (await fetch(PHOTON.replace(/api\/?$/,'reverse')+'?lat='+pl.lat+'&lon='+pl.lon+'&lang=de')).json();const q=(j.features||[])[0];
       if(q){const r=q.properties||{},c=r.city||r.town||r.village||r.locality||'';if(c){pl.a=(r.postcode?r.postcode+' ':'')+c;return 1}}}catch(e){}}
     try{await placesLoad();const nb=placesNear(pl.lat,pl.lon);if(nb&&nb.km<4){pl.a=nb.name;return 1}}catch(e){}return 0};
   if(miss.length&&!o._fill){o._fill=1;Promise.all(miss.map(rev)).then(R=>{const ch=R.some(Boolean);
     if(ch)document.querySelectorAll('[data-pl]').forEach(b=>{const [i,w]=b.dataset.pl.split('|'),pl=o.segs[+i]&&o.segs[+i][w];if(pl&&pl.a&&!b.querySelector('small'))b.insertAdjacentHTML('beforeend','<small>'+esc(pl.a)+'</small>')})}).catch(()=>{})}}
  const box=(x,i)=>{const plane=x.m==='plane';return `<div class="tvseg">${o.segs.length>1?`<b class="tvsh">Teilstrecke ${i+1}${i?` <button type="button" class="lnk" data-segdel="${i}">entfernen</button>`:''}</b>`:''}
    <div class="wzch">${Object.entries(TVM).map(([m,v])=>`<button type="button" class="chip" data-sm="${i}|${m}" aria-pressed="${x.m===m}">${v[0]} ${v[1]}</button>`).join('')}</div>
    <div class="two"><label>Von<button type="button" class="tvpl" data-pl="${i}|f">${x.f?esc(plTxt(x.f))+(x.f.a?`<small>${esc(x.f.a)}</small>`:''):'<span>auswählen ›</span>'}</button></label><label>Nach<button type="button" class="tvpl" data-pl="${i}|t">${x.t?esc(plTxt(x.t))+(x.t.a?`<small>${esc(x.t.a)}</small>`:''):'<span>auswählen ›</span>'}</button></label></div>
    <div class="tvrow"><span class="tvlbl">${plane?'Abflug':'Abfahrt'}</span><div class="two"><input type="date" data-s="${i}|dd" aria-label="${plane?'Abflug':'Abfahrt'} Datum" value="${esc(x.dd||'')}"><input type="time" data-s="${i}|dt" aria-label="${plane?'Abflug':'Abfahrt'} Uhrzeit" value="${esc(x.dt||'')}"></div></div>
    <div class="tvrow"><span class="tvlbl">Ankunft${x.m==='car'?' <small>· leer lassen = wird berechnet</small>':''}</span><div class="two"><input type="date" data-s="${i}|ad" aria-label="Ankunft Datum" value="${esc(x.calc?'':x.ad||'')}"><input type="time" data-s="${i}|at" aria-label="Ankunft Uhrzeit" value="${esc(x.calc?'':x.at||'')}"></div></div>
    ${plane||x.m==='train'?`<div class="two"><label>${plane?'Flugnummer':'Zugnummer'}<input data-s="${i}|no" maxlength="12" value="${esc(x.no||'')}" placeholder="${plane?'z. B. LH 456':'z. B. ICE 123'}"></label>${plane?`<label>Airline<input data-s="${i}|al" maxlength="30" value="${esc(x.al||'')}"></label>`:'<label></label>'}</div>
    <div class="tvrow"><span class="tvlbl">${plane?'Sitzplätze':'Sitzplätze (Wagen/Platz)'}</span><div class="two">${tvPP().map(m=>`<label>${esc(m.n)}<input data-seat="${i}|${esc(m.id)}" maxlength="8" autocapitalize="characters" value="${esc((x.seat||{})[m.id]||'')}" placeholder="${plane?'z. B. 23A':'z. B. 7/45'}"></label>`).join('')}</div></div>`:''}</div>`};
  openSheet(`<div class="hd"><h3 style="margin:0">${TVM[o.mode][0]} ${lbl}</h3><button class="x" data-close aria-label="Schließen">✕</button></div>
    <p class="src" style="margin:0 0 8px">Zeiten wie auf dem Ticket eintragen, jeweils in <b>Ortszeit</b>. Jede Teilstrecke hat ihr eigenes Verkehrsmittel, z. B. ✈️ Flug und danach 🚗 Mietwagen.</p>
    ${k==='back'&&!TRV.back&&TRV.out&&!draft?'<div class="acts" style="margin:8px 0 0"><button type="button" class="lnk" id="tvrev">↩ Wie Anreise, nur umgekehrt</button></div>':''}
    <form class="sform" id="tvf" style="margin-top:10px">${o.segs.map(box).join('')}
    <div class="acts"><button type="button" class="lnk" id="tvadd">+ Teilstrecke / Umstieg</button></div>
    <label>Buchungsnummer (optional)<input name="ref" maxlength="40" value="${esc(o.ref||'')}"></label>
    <label>Notiz (optional)<input name="note" maxlength="160" value="${esc(o.note||'')}" placeholder="${o.segs.some(x=>x.m==='car')?'z. B. Parkhaus am Hafen gebucht':'z. B. Sitzplätze 23A/B'}"></label>
    <p class="src bad" id="tvm" style="margin:0"></p>
    <div class="btns bar"><button class="chip btn" type="submit">Speichern</button><button class="chip" type="button" id="tvx">Abbrechen</button>${TRV[k]?'<button class="chip del" type="button" id="tvdel">Löschen</button>':''}</div></form>`,d=>{asPage();
    const fin=()=>subDepth>0?history.back():closeDlg();d.querySelector('#tvx').onclick=fin;
    const f=d.querySelector('#tvf'),keep=()=>{f.querySelectorAll('[data-s]').forEach(e=>{const [i,key]=e.dataset.s.split('|');o.segs[+i][key]=e.value.trim()});f.querySelectorAll('[data-seat]').forEach(e=>{const [i,u]=e.dataset.seat.split('|'),sg=o.segs[+i];if(!sg)return;const v=e.value.trim().toUpperCase();sg.seat=Object.assign({},sg.seat);if(v)sg.seat[u]=v;else delete sg.seat[u];if(!Object.keys(sg.seat).length)delete sg.seat});o.ref=f.ref.value.trim();o.note=f.note.value.trim()};
    d.querySelectorAll('[data-sm]').forEach(b=>b.onclick=()=>{keep();const [i,m]=b.dataset.sm.split('|');o.segs[+i].m=m;o.mode=o.segs[0].m;tvDlg(k,o)});
    d.querySelectorAll('[data-pl]').forEach(b=>b.onclick=()=>{keep();const [i,w]=b.dataset.pl.split('|');subOpen(()=>tvDlg(k,o),()=>tvPick(w==='f'?'Von':'Nach',o.segs[+i].m==='plane',near,x=>{o.segs[+i][w]=x;
      if(w==='f'&&+i===0&&k==='out'&&!x.c&&!homeGet())homeSet(x)}))});
    d.querySelectorAll('[data-segdel]').forEach(b=>b.onclick=()=>{keep();o.segs.splice(+b.dataset.segdel,1);tvDlg(k,o)});
    d.querySelector('#tvadd').onclick=()=>{keep();const l=o.segs[o.segs.length-1];o.segs.push({m:l.m,f:l.t||null,dd:l.ad||l.dd,dt:'',ad:'',at:''});tvDlg(k,o)};
    const rv=d.querySelector('#tvrev');if(rv)rv.onclick=()=>{const O=TRV.out;const R=O.segs.slice().reverse().map(x=>({m:x.m||O.mode,f:x.t,t:x.f,dd:D0,dt:'',ad:'',at:'',no:'',al:x.al||''}));tvDlg(k,{mode:R[0].m,segs:R,ref:'',note:''})};
    const dl=d.querySelector('#tvdel');if(dl)dl.onclick=()=>{const was=TRV[k];tvDel(k);fin();undoToast(lbl+' gelöscht.',()=>tvPut(k,was))};
    let busy=false;f.onsubmit=async ev=>{ev.preventDefault();if(busy)return;keep();const m=d.querySelector('#tvm'),sb=f.querySelector('button[type=submit]');o.segs.forEach(x=>{if(x.calc&&(!x.ad||!x.at)){x.ad='';x.at=''}delete x.calc});
      for(const x of o.segs){if(!x.f||!x.t)return m.textContent='Bitte bei jeder Strecke „Von“ und „Nach“ wählen.';if(!x.dd||!x.dt)return m.textContent='Bitte Datum und Uhrzeit der Abfahrt eintragen.';
        if(x.m==='plane'&&(!x.ad||!x.at))return m.textContent='Bitte beim Flug auch die Ankunft (Ortszeit) eintragen.'}
      busy=true;sb.disabled=true;sb.textContent='Speichert …';m.className='src';m.textContent=o.segs.some(x=>x.m==='car')&&navigator.onLine!==false?'Fahrstrecke wird berechnet …':'Wird gespeichert …';
      const undo=t=>{busy=false;sb.disabled=false;sb.textContent='Speichern';m.className='src bad';m.textContent=t};
      for(const x of o.segs){x.f.tz=await tzName(x.f);x.t.tz=await tzName(x.t)}
      // Auto: Strecke berechnen (online), Ankunft vorschlagen
      if(navigator.onLine!==false)for(const x of o.segs.filter(x=>x.m==='car')){try{const r=await Promise.race([fetch((window.__TEST_OSRM||'https://router.project-osrm.org')+'/route/v1/driving/'+x.f.lon+','+x.f.lat+';'+x.t.lon+','+x.t.lat+'?overview=false').then(r=>r.json()),new Promise((_,no)=>setTimeout(()=>no(0),5000))]);
        const R=r&&r.routes&&r.routes[0];if(R){x.km=Math.round(R.distance/1000);x.min=Math.round(R.duration/60);if(!x.ad||!x.at){const L=localOf(utcOf(x.dd,x.dt,x.f.tz)+x.min*6e4,x.t.tz);x.ad=L.d;x.at=L.t;x.calc=1}}}catch(e){}}
      for(const x of o.segs)if(x.ad&&x.at&&utcOf(x.ad,x.at,x.t.tz)<utcOf(x.dd,x.dt,x.f.tz))return undo('Die Ankunft liegt vor der Abfahrt – bitte Datum/Uhrzeit (Ortszeit) prüfen.');
      delete o._fill;tvPut(k,o);fin()}})}
/* ---------- Unterkunft je Nacht (nicht bei Kreuzfahrt) – gemeinsam in trips/<id>/stays/<id> ----------
   {n, addr, lat, lon, d1: Anreisetag, d2: Abreisetag (> d1), ci, co, ref, note} – Nächte = d1 … d2-1 */
const STAY_ON=!CRUISE,SKEY='rp-'+TRIP_ID+'-stays';let STAYS=[];try{STAYS=JSON.parse(localStorage.getItem(SKEY)||'[]')}catch(e){}
function sStore(){try{localStorage.setItem(SKEY,JSON.stringify(STAYS))}catch(e){}}
function sChanged(){const a=document.activeElement;if(!(a&&a.closest&&a.closest('#panel input,#panel textarea,#panel select'))&&(todayView||tripView||sel!=null))renderPanel();mapSoon()}
function sInit(db){if(!STAY_ON)return;db.collection('stays').onSnapshot({includeMetadataChanges:true},s=>{s.docs.forEach(d=>{if(!d.metadata.hasPendingWrites)SYNC['stays:'+d.id]=d.data()});
  STAYS=s.docs.map(d=>({id:d.id,...d.data()}));sStore();sChanged()},()=>{})}
function sPut(o){const i=STAYS.findIndex(x=>x.id===o.id);if(i<0)STAYS.push(o);else STAYS[i]=o;sStore();if(TS.mode==='db'&&dbh)putDoc('stays',o);sChanged()}
function sDel(id){STAYS=STAYS.filter(x=>x.id!==id);sStore();if(TS.mode==='db'&&dbh)delDoc('stays',id);sChanged()}
const stayNight=d=>STAYS.find(s=>s.d1<=d&&d<s.d2),stayOut=d=>STAYS.find(s=>s.d2===d);
const gmDir=(o,mode)=>'https://www.google.com/maps/dir/?api=1&destination='+o.lat+','+o.lon+(mode?'&travelmode='+mode:'');
/* ---------- Fahrstrecken nach Straßen (Roadtrip bzw. mit Auto/Wohnmobil) ----------
   Berechnung online über OSRM (router.project-osrm.org, OpenStreetMap), gespeichert in route.legs[] {a,b,p,km,min,k} → danach offline */
const DRIVE=!CRUISE&&(TRIP.kind==='roadtrip'||['car','camper'].includes(TRIP.vehicle));
const driveKey=(a,b)=>[a.lat,a.lon,b.lat,b.lon].map(v=>(+v).toFixed(3)).join(',');
function drivePairs(){const S=D.ports.filter(p=>p.kind!=='sea'&&p.lat!=null),out=[];for(let i=1;i<S.length;i++){const a=S[i-1],b=S[i];if(osmKm(a.lat,a.lon,b.lat,b.lon)<2)continue;out.push({a,b})}return out}
function driveLeg(b){if(!DRIVE||!D.route||!D.route.legs)return null;const P=drivePairs().find(x=>x.b===b);if(!P)return null;const L=D.route.legs.find(l=>l.a===P.a.day&&l.b===b.day);return L&&L.k===driveKey(P.a,b)?{...L,from:P.a}:{from:P.a,air:osmKm(P.a.lat,P.a.lon,b.lat,b.lon)}}
const hmDur=m=>m>=60?Math.floor(m/60)+':'+String(Math.round(m%60)).padStart(2,'0')+' Std.':Math.round(m)+' Min';
let driveBusy=false;
async function driveCalc(){if(!DRIVE||driveBusy||navigator.onLine===false||(TS.mode!=='db'&&!window.__TEST_OSRM))return;
  const have=(D.route&&D.route.legs)||[],todo=drivePairs().filter(({a,b})=>{const L=have.find(l=>l.a===a.day&&l.b===b.day);return !(L&&L.k===driveKey(a,b)&&L.p)});if(!todo.length)return;
  driveBusy=true;const done=[];
  try{for(const {a,b} of todo){const u=(window.__TEST_OSRM||'https://router.project-osrm.org')+'/route/v1/driving/'+a.lon+','+a.lat+';'+b.lon+','+b.lat+'?overview=simplified&geometries=geojson';
      const r=await fetch(u).then(x=>x.ok?x.json():null).catch(()=>null);const R=r&&r.routes&&r.routes[0];if(!R)continue;
      let c=R.geometry.coordinates;const st=Math.max(1,Math.ceil(c.length/150));c=c.filter((q,i)=>i%st===0||i===c.length-1);
      done.push({a:a.day,b:b.day,k:driveKey(a,b),km:Math.round(R.distance/1000),min:Math.round(R.duration/60),p:c.slice(1,-1).map(q=>[+q[1].toFixed(4),+q[0].toFixed(4)])});await new Promise(r=>setTimeout(r,600))}
    if(!done.length)return;const merge=L=>{L=(L||[]).filter(l=>!done.some(n=>n.a===l.a&&n.b===l.b));return L.concat(done)};
    D.route=D.route||{};D.route.legs=merge(D.route.legs);mapSoon();if(sel!=null||tripView)renderPanel();
    await tripSave(j=>{j.route=j.route||{};j.route.legs=merge(j.route.legs)})}catch(e){}finally{driveBusy=false}}
setTimeout(driveCalc,12000);addEventListener('online',()=>setTimeout(driveCalc,6000));
/* Zeilen in Tagesansicht/Reiseplan: Fahrt am Morgen, Check-out, Unterkunft am Abend */
function travelTop(p,noTv){if(!p)return '';let h=noTv?'':tvDayHTML(p);if(CRUISE)return h;const o=STAY_ON&&stayOut(p.day),n=STAY_ON&&stayNight(p.day);
  if(o&&o!==n)h+=`<div class="trv"><span>🛏</span><span>Check-out${o.co?' '+esc(o.co):''} · ${esc(o.n)}</span></div>`;
  const L=driveLeg(p);if(L)h+=`<div class="trv"><span>🚗</span><span>Fahrt von ${esc(L.from.name)} · ${L.km!=null?`${L.km.toLocaleString('de-DE')} km · ca. ${hmDur(L.min)}`:`Luftlinie ${Math.round(L.air)} km${navigator.onLine===false?'':' · Strecke wird berechnet …'}`}</span><a class="lnk" href="https://www.google.com/maps/dir/?api=1&origin=${L.from.lat},${L.from.lon}&destination=${p.lat},${p.lon}&travelmode=driving" target="_blank" rel="noopener">Navigation ›</a></div>`;
  return h}
function travelBottom(p,short){if(!STAY_ON||!p||p.day>=D.ports.length)return '';const s=stayNight(p.day);
  if(!s)return short?'':`<div class="trv add"><span>🛏</span><button class="lnk" data-stay="new|${p.day}">+ Unterkunft für die Nacht</button></div>`;
  const nN=s.d2-s.d1,first=s.d1===p.day;
  return `<div class="stay" data-stay="${s.id}|${p.day}" role="button" tabindex="0"><span class="sti">🛏</span><span class="stx"><b>${esc(s.n)}</b><small>${esc([first&&s.ci?'Check-in '+s.ci:'',nN>1?(first?nN+' Nächte':'Nacht '+(p.day-s.d1+1)+' von '+nN):'1 Nacht',s.ref&&!short?'Buchung '+s.ref:''].filter(Boolean).join(' · '))}</small></span>${s.lat!=null?`<a class="lnk" href="${gmDir(s)}" target="_blank" rel="noopener">Weg ›</a>`:''}</div>`}
document.addEventListener('click',e=>{const b=e.target.closest&&e.target.closest('[data-stay]');if(!b||e.target.closest('a'))return;e.stopPropagation();const [id,d]=b.dataset.stay.split('|');stayDlg(id==='new'?null:id,+d)},true);
function stayDlg(id,day,draft){const o=draft||(id?{...STAYS.find(x=>x.id===id)}:{id:nid('s'),n:'',d1:day,d2:Math.min(D.ports.length,day+1),ci:'15:00',co:'11:00',ref:'',note:''});if(!o.d1)return;
  let res=[],tmr=0;const last=D.ports.length;
  openSheet(`<div class="hd"><h3 style="margin:0">🛏 ${id?'Unterkunft':'Neue Unterkunft'}<small class="hds">${esc(byDay(o.d1).name)}</small></h3></div>
  <form class="sform" id="stf" style="margin-top:0"><label>Name<input name="n" maxlength="80" value="${esc(o.n)}" placeholder="z. B. Hotel, Ferienwohnung, Campingplatz"></label>
  <label>Lage</label><div class="sfield" style="margin:4px 0 0"><svg class="sfi" viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg><input id="stq" type="search" autocomplete="off" placeholder="Hotel oder Adresse suchen"></div>
  <div id="stsel">${o.lat!=null?`<p class="src" style="margin:6px 0 0">📍 ${esc(o.addr||o.n||'gesetzt')} ✓</p>`:''}</div><div id="stres"></div>
  <div class="acts" style="margin:4px 0 0"><button type="button" class="lnk" id="stpick">📍 Auf der Karte wählen</button></div>
  <div class="two"><label>Anreise<select name="d1">${D.ports.slice(0,-1).map(p=>`<option value="${p.day}" ${p.day===o.d1?'selected':''}>Tag ${p.day} · ${esc(fmtDate(p.date))}</option>`).join('')}</select></label>
  <label>Nächte<select name="nn">${Array.from({length:last-o.d1},(_,k)=>k+1).map(k=>`<option ${o.d2-o.d1===k?'selected':''}>${k}</option>`).join('')}</select></label></div>
  <div class="two"><label>Check-in<input type="time" name="ci" value="${esc(o.ci||'')}"></label><label>Check-out<input type="time" name="co" value="${esc(o.co||'')}"></label></div>
  <label>Buchungsnummer (optional)<input name="ref" maxlength="40" value="${esc(o.ref||'')}"></label>
  <label>Notiz (optional)<input name="note" maxlength="160" value="${esc(o.note||'')}" placeholder="z. B. Parkplatz, Frühstück"></label>
  <p class="src bad" id="stm" style="margin:0"></p>
  <div class="btns bar"><button class="chip btn" type="submit">Speichern</button><button class="chip" type="button" data-close>Abbrechen</button>${id?'<button class="chip del" type="button" id="stdel">Löschen</button>':''}</div></form>`,d=>{
    const f=d.querySelector('#stf'),q=d.querySelector('#stq'),rs=d.querySelector('#stres');
    const keep=()=>{o.n=f.n.value.trim();o.d1=+f.d1.value;o.d2=Math.min(last,o.d1+(+f.nn.value||1));o.ci=f.ci.value;o.co=f.co.value;o.ref=f.ref.value.trim();o.note=f.note.value.trim()};
    f.d1.onchange=()=>{keep();stayDlg(id,day,o)};
    q.oninput=()=>{clearTimeout(tmr);tmr=setTimeout(async()=>{const v=q.value.trim();if(v.length<3){rs.innerHTML='';return}res=await placeSearchAny(v,byDay(o.d1));
      rs.innerHTML=res.length?'<p class="plask">Bitte antippen:</p>'+res.slice(0,4).map((x,i)=>`<button type="button" class="plres" data-r="${i}"><span class="pli">🛏</span><span class="plt"><b>${esc(x.name)}</b><small>${esc(x.addr)}</small></span><span class="plgo">Wählen ›</span></button>`).join(''):`<p class="src" style="margin:6px 0 0">${esc(res.msg||'Nichts gefunden.')}</p>`;
      rs.querySelectorAll('[data-r]').forEach(b=>b.onclick=()=>{const x=res[+b.dataset.r];keep();Object.assign(o,{lat:x.lat,lon:x.lon,addr:x.addr});if(!o.n)o.n=x.name;stayDlg(id,day,o)})},450)};
    d.querySelector('#stpick').onclick=()=>{keep();subOpen(()=>stayDlg(id,day,o),()=>pickOnMap(o.lat!=null?o:byDay(o.d1),r=>{Object.assign(o,{lat:r.lat,lon:r.lon});if(!o.n)o.n=r.name}))};
    const dl=d.querySelector('#stdel');if(dl)dl.onclick=()=>{const was=STAYS.find(x=>x.id===id);sDel(id);closeDlg();undoToast(`Unterkunft „${was.n}“ gelöscht.`,()=>sPut(was))};
    f.onsubmit=ev=>{ev.preventDefault();keep();if(!o.n)return d.querySelector('#stm').textContent='Bitte einen Namen eingeben.';
      const clash=STAYS.find(x=>x.id!==o.id&&x.d1<o.d2&&o.d1<x.d2);if(clash&&!confirm(`In diesen Nächten ist schon „${clash.n}“ eingetragen. Trotzdem speichern?`))return;
      const {id:_,...r}=o;sPut({id:o.id,...r});closeDlg()}})}
/* Reise bearbeiten (editor.js): eure Einträge wandern mit ihrer Station mit. M = {alter Tag: neuer Tag | null (gelöscht)} */
function dayRemap(M){const g=d=>M[d]||null;
  const np={};Object.entries(plan).forEach(([d,a])=>{const n=g(d);if(n&&(a||[]).length)np[n]=(np[n]||[]).concat(a)});plan=np;savePlan();
  const pk={};Object.entries(picks).forEach(([k,v])=>{const i=k.indexOf(':'),n=g(k.slice(0,i));if(n)pk[n+k.slice(i)]=v});picks=pk;persistPicks();
  DIN.skip=(DIN.skip||[]).map(g).filter(Boolean);const ov={};Object.entries(DIN.ov||{}).forEach(([d,v])=>{if(g(d))ov[g(d)]=v});DIN.ov=ov;dinSave(true);
  FILES.forEach(f=>{if(!(f.days||[]).length)return;const nd=f.days.map(g).filter(Boolean);if(JSON.stringify(nd)!==JSON.stringify(f.days))fPut({...f,days:nd})});
  STAYS.slice().forEach(s=>{const a=g(s.d1);if(!a)return sDel(s.id);const b=g(s.d2)||a+(s.d2-s.d1);if(b<=a)return sDel(s.id);if(a!==s.d1||b!==s.d2)sPut({...s,d1:a,d2:b})})}
/* Reisedaten (trips/<id>) ändern: mut(j, felder) bekommt den gespeicherten Inhalt und ändert ihn */
async function tripLoadJson(){if(window.__TEST_TRIP)return {j:JSON.parse(JSON.stringify(window.__TEST_TRIP.data)),t:{...window.__TEST_TRIP.trip}};
  const ref=FBX.real.collection('trips').doc(TRIP_ID);let d=null;if(navigator.onLine!==false)d=await Promise.race([ref.get({source:'server'}),new Promise(r=>setTimeout(()=>r(null),6000))]).catch(()=>null);
  if(!d)d=await ref.get({source:'cache'});const x=d.data();return {j:JSON.parse(x.json||'{}'),t:x}}
async function tripSave(mut){if(window.__TEST_TRIP){const o=window.__TEST_TRIP;mut(o.data,o.trip);window.__SAVED=o;return}
  const ref=FBX.real.collection('trips').doc(TRIP_ID);
  if(navigator.onLine!==false){try{await Promise.race([FBX.real.runTransaction(async tx=>{const d=await tx.get(ref);const j=JSON.parse(d.data().json||'{}'),u={};mut(j,u);u.json=JSON.stringify(j);u.updated=Date.now();tx.update(ref,u)}),
    new Promise((_,no)=>setTimeout(()=>no(new Error('offline')),8000))]);return 'ok'}catch(e){if(e.message!=='offline'&&navigator.onLine!==false&&e.code!=='unavailable')throw e}}
  // ohne Netz: auf den Stand im Gerät schreiben; Firestore lädt es hoch, sobald Internet da ist (letzte Änderung gilt)
  const d=await ref.get({source:'cache'});const j=JSON.parse(d.data().json||'{}'),u={};mut(j,u);u.json=JSON.stringify(j);u.updated=Date.now();ref.update(u).catch(()=>{});syncPoke();return 'offline'}
/* Reise löschen: Reise-Dokument und die gemeinsamen Einträge darunter (Dateien in Storage bleiben) */
async function tripDelete(next){const db=FBX.real,ref=db.collection('trips').doc(TRIP_ID);
  // fremde Einträge (z. B. Mitreisenden-Eintrag, Quizpunkte der anderen) dürfen die Regeln nicht löschen – die bleiben unsichtbar liegen
  for(const c of ['planitems','picks','lists','tasks','files','members','plandays','drinkfavs','photos','backups']){try{const q=await ref.collection(c).get();for(const d of q.docs)await d.ref.delete().catch(()=>{})}catch(e){}}
  await ref.delete();const cf=await db.collection('config').doc('app').get();if(cf.exists&&cf.data().activeTrip===TRIP_ID)await db.collection('config').doc('app').set({activeTrip:next||null},{merge:true})}
function editOpen(){
  const go=()=>window.EDIT&&EDIT.open();if(window.EDIT)return go();const s=document.createElement('script');s.src='editor.js';s.onload=go;s.onerror=()=>infoToast('Bearbeiten nicht ladbar – bitte mit Internet öffnen.','OK',()=>{});document.head.appendChild(s)}
/* ---------- Offline: Weltkarte, Ortsliste (GeoNames), Zeitzonen – für Assistent und Bearbeiten ---------- */
const loadJs=src=>new Promise((ok,no)=>{const s=document.createElement('script');s.src=src;s.onload=ok;s.onerror=no;document.head.appendChild(s)});
let WORLD=null;async function worldLoad(){if(WORLD)return WORLD;if(!window.RP_MAPGEN)await loadJs('mapgen.js');WORLD=await (await fetch('world.json')).json();return WORLD}
async function tzAt(lat,lon,date){try{if(!window.tzlookup)await loadJs('tzlookup.js');const z=tzlookup(lat,lon);const v=new Intl.DateTimeFormat('en-US',{timeZone:z,timeZoneName:'shortOffset'}).formatToParts(new Date((date||TODAY)+'T12:00:00Z')).find(x=>x.type==='timeZoneName').value;
  const m=/GMT([+-]\d+)(?::(\d+))?/.exec(v);return m?+m[1]+(m[2]?Math.sign(+m[1]||1)*m[2]/60:0):0}catch(e){return Math.round(lon/15)}}
let PLC=null;const nrmP=t=>String(t||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/ß/g,'ss');
let landDN=null;try{landDN=new Intl.DisplayNames(['de'],{type:'region'})}catch(e){}const landName=c=>{try{return landDN?landDN.of(c):c}catch(e){return c}};
async function placesLoad(){if(PLC)return PLC;const t=await (await fetch('places.txt')).text();if(!/\|/.test(t))throw new Error('Ortsliste fehlt');
  PLC=t.split('\n').filter(l=>l&&l[0]!=='#').map(l=>{const a=l.split('|');return {n:a[5]||a[0],c:a[1],lat:+a[2],lon:+a[3],p:+a[4],k:nrmP(a[5]?a[5]+' '+a[0]:a[0])}});return PLC}
/* Offline-Suche: Städte und Orte ab ca. 5.000 Einwohnern (sortiert nach Größe, Treffer in der Nähe zuerst) */
async function placesFind(q,near){const L=await placesLoad(),k=nrmP(q.trim());if(k.length<2)return [];const hit=[];
  for(const x of L){if(x.k.startsWith(k)||x.k.includes(' '+k)||x.k.includes('-'+k)||x.k.includes('/'+k)){hit.push(x);if(hit.length>=300)break}}
  const sc=x=>(x.k===k||x.k.startsWith(k+' ')?0:x.k.startsWith(k)?1:2)*1e6-Math.min(x.p,9e5)+(near&&near.lat!=null?Math.hypot(x.lat-near.lat,x.lon-near.lon)*500:0);
  return hit.sort((a,b)=>sc(a)-sc(b)).slice(0,7).map(x=>({name:x.n,addr:landName(x.c),lat:x.lat,lon:x.lon,country:landName(x.c),off:1}))}
function placesNear(lat,lon){if(!PLC)return null;let b=null,d=1e9;for(const x of PLC){const v=Math.hypot(x.lat-lat,(x.lon-lon)*Math.cos(lat*Math.PI/180));if(v<d){d=v;b=x}}return b?{name:b.n,country:landName(b.c),km:Math.round(d*111)}:null}
/* Ortssuche für Assistent/Bearbeiten: online wie bisher (alles), sonst oder bei Fehler die eingebaute Ortsliste */
/* Hausnummer fehlt in OpenStreetMap: die eigene Eingabe mit der Lage der Straße anbieten */
function hnOffer(q,R){const t=q.trim(),first=t.split(',')[0],m=/(\d+)\s*([a-zA-Z]?)\s*$/.exec(first);if(!R||!R.length||!m)return null;
  const num=+m[1],st=first.slice(0,m.index).trim().toLowerCase(),sk=st.slice(0,Math.max(4,st.length-3));
  if(R.some(x=>parseInt(x.hn,10)===num&&(x.addr+' '+x.name).toLowerCase().includes(sk)))return null; // genau diese Hausnummer ist schon dabei
  // Lage: nächste Hausnummer derselben Straße, sonst die Straße selbst
  const same=R.filter(x=>(x.addr+' '+x.name).toLowerCase().includes(sk)),nb=same.filter(x=>x.hn&&!isNaN(parseInt(x.hn,10))).sort((a,b)=>Math.abs(parseInt(a.hn,10)-num)-Math.abs(parseInt(b.hn,10)-num))[0];
  const x=nb||same.find(r=>!r.hn)||same[0]||R[0];
  return {name:t,addr:nb?'Lage nach Nr. '+nb.hn+' geschätzt (Nr. '+num+' fehlt in der Karte)':'Hausnummer nicht in der Karte – Lage der Straße',lat:x.lat,lon:x.lon,country:x.country,hnx:1}}
async function placeSearchAny(q,near){if(navigator.onLine!==false){try{const r=await Promise.race([placeSearch(q,near,true),new Promise((_,no)=>setTimeout(()=>no(new Error('Zeit')),7000))]);if(r.length){const o=hnOffer(q,r);return o?[o,...r]:r}}catch(e){}}
  try{const r=await placesFind(q,near);r.offline=true;return r}catch(e){const r=[];r.msg=navigator.onLine===false?'Offline-Ortsliste noch nicht geladen – einmal mit Internet öffnen.':'Suche gerade nicht erreichbar.';return r}}
// Ortsliste und Offline-Teile automatisch im Hintergrund holen (Service Worker speichert sie dauerhaft)
{const pre=()=>{if(navigator.onLine===false)return;['places.txt','wizard.js','editor.js','tzlookup.js','mapgen.js','world.json'].forEach(f=>fetch(f).catch(()=>{}))};setTimeout(pre,20000);addEventListener('online',()=>setTimeout(pre,8000))}
/* Ort auf der Karte antippen (geht offline): Ausschnitt um c, „Näher/Weiter“, nächster Ort aus der Ortsliste als Vorschlag */
async function pickOnMap(c,cb){let ctr=c&&c.lat!=null?{lat:c.lat,lon:c.lon}:{lat:30,lon:0},span=c&&c.lat!=null?3:90,pin=null;
  try{await worldLoad()}catch(e){return infoToast('Weltkarte nicht geladen – einmal mit Internet öffnen.','OK',()=>{})}try{await placesLoad()}catch(e){}
  const draw=()=>{const sl=Math.max(0.05,span/2),D={ports:[{lat:Math.max(-75,ctr.lat-sl/2),lon:ctr.lon-sl},{lat:Math.min(75,ctr.lat+sl/2),lon:ctr.lon+sl}]};RP_MAPGEN(D,WORLD);const m=D.maps.ov,r=m.W/90;
    const P2=(la,lo)=>[m.tx+m.k*lo*Math.PI/180,m.ty-m.k*Math.log(Math.tan(Math.PI/4+la*Math.PI/360))],xy=pin?P2(pin.lat,pin.lon):null,nb=pin?placesNear(pin.lat,pin.lon):null;
    // größte Orte im Ausschnitt als Orientierung (ohne Überlappung)
    const lab=[];if(PLC){for(const x of PLC){const q=P2(x.lat,x.lon);if(q[0]<20||q[0]>m.W-20||q[1]<20||q[1]>m.H-20)continue;if(lab.some(l=>Math.abs(l[0]-q[0])<m.W/6&&Math.abs(l[1]-q[1])<m.W/22))continue;lab.push([q[0],q[1],x.n]);if(lab.length>=14)break}}
    const fs=m.W/38;
    openSheet(`<div class="hd"><h3 style="margin:0">Ort auf der Karte wählen</h3><button class="x" data-close aria-label="Zurück">✕</button></div>
      <p class="src" style="margin:0 0 8px">Antippen setzt den Punkt. Mit „Näher“ genauer werden.</p>
      <div class="wzmap"><svg id="pkm" viewBox="0 0 ${m.W} ${m.H}" style="display:block;width:100%;max-height:52vh;background:var(--sea);touch-action:manipulation"><path d="${m.land}" class="land"/>${lab.map(l=>`<circle cx="${l[0]}" cy="${l[1]}" r="${fs/4}" fill="#555"/><text x="${l[0]+fs/2.5}" y="${l[1]}" dy="0.35em" font-size="${fs}" fill="#333" stroke="#fff" stroke-width="${fs/6}" paint-order="stroke" style="font-family:Inter,sans-serif">${esc(l[2])}</text>`).join('')}${xy?`<circle cx="${xy[0]}" cy="${xy[1]}" r="${r}" fill="var(--plan)" stroke="#fff" stroke-width="${r/3}"/>`:''}</svg></div>
      <div class="acts" style="margin:6px 0"><button class="lnk" id="pkin">＋ Näher</button><button class="lnk" id="pkout">－ Weiter</button></div>
      <form class="sform" id="pkf" style="margin-top:4px"><label>Name<input name="n" maxlength="80" value="${esc(pin&&pin.name||'')}" placeholder="${esc(nb&&nb.km<30?nb.name:'Name des Ortes')}"></label>
      ${nb?`<p class="src" style="margin:-4px 0 0">${nb.km<30?`In der Nähe: <b>${esc(nb.name)}</b> (${nb.km} km) · ${esc(nb.country)}`:`Nächster bekannter Ort: ${esc(nb.name)} (${nb.km} km)`}</p>`:''}
      <p class="src bad" id="pkm2" style="margin:0"></p>
      <div class="btns bar"><button class="chip btn" type="submit">Übernehmen</button><button class="chip" type="button" id="pkx">Abbrechen</button></div></form>`,d=>{asPage();
      const sv=d.querySelector('#pkm');sv.addEventListener('click',e=>{const pt=sv.createSVGPoint();pt.x=e.clientX;pt.y=e.clientY;const q=pt.matrixTransform(sv.getScreenCTM().inverse());
        const lon=(q.x-m.tx)/m.k*180/Math.PI,lat=(2*Math.atan(Math.exp((m.ty-q.y)/m.k))-Math.PI/2)*180/Math.PI;pin={lat:+lat.toFixed(5),lon:+lon.toFixed(5),name:d.querySelector('[name=n]').value.trim()};draw()});
      d.querySelector('#pkin').onclick=()=>{if(pin)ctr={lat:pin.lat,lon:pin.lon};span=Math.max(0.1,span/3);if(pin)pin.name=d.querySelector('[name=n]').value.trim();draw()};
      d.querySelector('#pkout').onclick=()=>{span=Math.min(180,span*3);if(pin)pin.name=d.querySelector('[name=n]').value.trim();draw()};
      d.querySelector('#pkx').onclick=()=>history.back();
      d.querySelector('#pkf').onsubmit=ev=>{ev.preventDefault();if(!pin)return d.querySelector('#pkm2').textContent='Bitte zuerst auf die Karte tippen.';
        const n=d.querySelector('[name=n]').value.trim()||(nb&&nb.km<30?nb.name:'');if(!n)return d.querySelector('#pkm2').textContent='Bitte einen Namen eingeben.';
        cb({name:n,lat:pin.lat,lon:pin.lon,country:nb?nb.country:''});history.back()}})};
  draw()}
/* Reise-Assistent (wizard.js, wird erst beim Öffnen geladen) */
function wizOpen(){const go=()=>window.WIZ&&WIZ.open();if(window.WIZ)return go();const s=document.createElement('script');s.src='wizard.js';s.onload=go;s.onerror=()=>infoToast('Assistent nicht ladbar – bitte mit Internet öffnen.','OK',()=>{});document.head.appendChild(s)}
function addToggle(b){
  const t=document.createElement('button');t.className='chip mtog';
  t.onclick=()=>{mapMin=!mapMin;try{localStorage.setItem('rp-map-min',mapMin?'1':'0')}catch(e){}applyMin()};
  b.appendChild(t);applyMin();
}
function renderBar(){const b=$('#mbar');b.innerHTML='';$('main').classList.remove('mapmin');renderFilter()}
function renderFilter(){
  const mw=$('#mapwrap');let btn=$('#fltbtn'),pop=$('#fltpop');
  if(!btn){btn=document.createElement('button');btn.id='fltbtn';btn.type='button';btn.className='chip btn';btn.onclick=()=>{pop.hidden=!pop.hidden};
    pop=document.createElement('div');pop.id='fltpop';pop.hidden=true;mw.appendChild(btn);mw.appendChild(pop);
    pop.addEventListener('pointerdown',e=>e.stopPropagation());btn.addEventListener('pointerdown',e=>e.stopPropagation())}
  btn.hidden=true;pop.hidden=true;return;
  const p=sel==null?null:byDay(sel);
  btn.hidden=false;pop.innerHTML='';
  const counts={};p.pois.forEach(q=>counts[q.t]=(counts[q.t]||0)+1);
  btn.textContent='Filter'+(filt.size<Object.keys(counts).length?' ●':'')+(pop.hidden?' ▾':' ▴');btn.setAttribute('aria-expanded',!pop.hidden);
  Object.keys(TYPES).filter(k=>counts[k]).forEach(k=>{
    const c=document.createElement('button');c.className='chip';c.style.setProperty('--c',`var(${TYPES[k][1]})`);
    c.setAttribute('aria-pressed',filt.has(k));c.innerHTML=`<i></i>${TYPES[k][0]} ${counts[k]}`;
    c.onclick=()=>{filt.has(k)?filt.delete(k):filt.add(k);drawPort(p,true);renderPanel();renderFilter();pop.hidden=false;renderFilter()};pop.appendChild(c);
  });
}

/* ---------- panel ---------- */
function setTab(t){tab=t;if(t!=='pl')openSec.add(t);renderPanel();const d=$('#sec-'+t);if(d&&sel!=null)d.scrollIntoView({block:'start'});else $('#panel').scrollTop=0}
function focusCard(kind,i){
  const c=$('#'+(kind==='poi'?'poi':'ex')+i);if(!c)return;c.scrollIntoView({block:'center',behavior:'smooth'});
  c.classList.add('hl');setTimeout(()=>c.classList.remove('hl'),1800);
}
function summary(){
  const L=[];let sum=0;
  D.ports.forEach(p=>(p.ex||[]).forEach(e=>{if(e.p&&isPicked(p,e)){L.push({p,e});sum+=e.p}}));
  const text=L.map(({p,e})=>`Tag ${p.day}, ${fmtDate(p.date)}, ${p.name} (${p.land||''}): ${e.c} ${e.n} (${e.dur||'-'}) ${eur(e.p)} p. P.`).join('\n')+`\nSumme: ${eur(sum)} p. P., ${eur(sum*2)} für zwei`;
  const rows=L.map(({p,e})=>`<tr class="clk" data-d="${p.day}" data-code="${esc(e.c)}"><td>${fmtDate(p.date)}</td><td><b>${esc(p.name)}</b><br><span class="src">Tag ${p.day} · ${esc(p.land||'')}</span></td><td>${esc(e.c)} · ${esc(e.n)}<br><span class="src">${esc(e.dur||'')}</span></td><td style="text-align:right;white-space:nowrap">${eur(e.p)}</td></tr>`).join('');
  const free=D.ports.filter(p=>p.kind==='port'&&!(p.ex||[]).some(e=>e.p&&isPicked(p,e))).map(p=>`Tag ${p.day}, ${fmtDate(p.date)} ${p.name} (${p.land||''})`);
  return {text,html:`<h3 id="sel">Meine Auswahl (${L.length} Ausflüge)</h3>${L.length?`<div class="tw"><table class="t"><tr><th>Datum</th><th>Hafen</th><th>Ausflug</th><th style="text-align:right">Preis p. P.</th></tr>${rows}<tr><td colspan="3"><b>Summe pro Person</b></td><td style="text-align:right"><b>${eur(sum)}</b></td></tr><tr><td colspan="3"><b>Für zwei Personen</b></td><td style="text-align:right"><b>${eur(sum*2)}</b></td></tr></table></div>`:'<p class="empty">Noch nichts angehakt.</p>'}
  ${free.length?`<p class="src">Ohne Ausflug (auf eigene Faust): ${esc(free.join(', '))}</p>`:''}
  <p style="display:flex;flex-wrap:wrap;gap:6px;align-items:center"><button class="chip btn" id="cpy">Liste kopieren</button><button class="chip" id="clr">Alle abwählen</button><button class="chip" id="rst">Auf Empfehlung zurücksetzen</button><span class="src" id="cpm"></span></p>
  <textarea id="cpt" readonly hidden style="width:100%;height:120px"></textarea>`,rawText:text};
}
let lastFocus=null;
/* Seite hinter offenem Dialog sperren */
(function(){const ov=$('#ov');let y=0;const set=()=>{const on=!ov.hidden,h=document.documentElement;if(on===h.classList.contains('dlgopen'))return;
  if(on){y=window.scrollY;h.classList.add('dlgopen');document.body.style.top=(-y)+'px'}else{h.classList.remove('dlgopen');document.body.style.top='';window.scrollTo({top:y,left:0,behavior:'instant'});h.style.overflow='hidden';requestAnimationFrame(()=>{window.scrollTo({top:y,left:0,behavior:'instant'});h.style.overflow=''})}};
  new MutationObserver(set).observe(ov,{attributes:true,attributeFilter:['hidden']});set()})();
/* Bottom Sheet am Handy: am Griff oder Kopf nach unten ziehen schließt */
(function(){let st=null;const dl=()=>$('#dlg');
  document.addEventListener('pointerdown',e=>{const d=dl();if(!d||$('#ov').hidden||!matchMedia('(max-width:600px)').matches)return;const top=d.getBoundingClientRect().top,inTop=e.clientY-top<48&&d.contains(e.target);const h=inTop||e.target.closest('.grab,.dlg .hd');if(!h||e.target.closest('button,input,select,a')||d.scrollTop>0)return;st={y:e.clientY,id:e.pointerId,dy:0}});
  document.addEventListener('pointermove',e=>{if(!st||e.pointerId!==st.id)return;st.dy=Math.max(0,e.clientY-st.y);if(st.dy>4){const d=dl();d.style.transition='none';d.style.transform=`translateY(${st.dy}px)`}});
  const end=e=>{if(!st||e.pointerId!==st.id)return;const d=dl(),dy=st.dy;st=null;d.style.transition='transform .2s ease';if(dy>90){d.style.transform='translateY(110%)';setTimeout(()=>{d.style.transform='';d.style.transition='';closeDlg()},180)}else{d.style.transform='';if(dy>20)swJust=Date.now()}};
  document.addEventListener('pointerup',end);document.addEventListener('pointercancel',end);
  document.addEventListener('touchmove',e=>{if(st&&st.dy>2)e.preventDefault()},{passive:false})})();
let popIgnore=0,dlgReturn=null;
/* Unterseiten in Vollbild-Fenstern (z. B. Quiz-Lobby → Spiel): eigener Verlaufseintrag, damit die Zurück-Taste eine Ebene zurück geht */
const SUBS=[];Object.defineProperty(window,'subDepth',{get:()=>SUBS.length});
function pushSub(fn){try{history.pushState({sub:1},'',location.href);SUBS.push(fn)}catch(e){}}
function popSub(){if(SUBS.length){SUBS.pop();try{popIgnore++;history.back()}catch(e){popIgnore=Math.max(0,popIgnore-1)}}}
/* Seite im offenen Fenster austauschen und Zurück-Schritt anlegen (kein Schließen/Neu-Öffnen → kein Flackern) */
function subOpen(back,open){pushSub(back);open()}
function closeDlg(){const was=!$('#ov').hidden;const ret=dlgReturn;dlgReturn=null;if(ret&&was)setTimeout(ret,90);$('#ov').hidden=true;
  const n=(dlgPushed?1:0)+SUBS.length;SUBS.length=0;if(dlgPushed||n){dlgPushed=false;if(was&&n)try{popIgnore++;history.go(-n)}catch(e){popIgnore=Math.max(0,popIgnore-1)}}if(lastFocus&&lastFocus.focus&&matchMedia('(pointer:fine)').matches)try{lastFocus.focus({preventScroll:true})}catch(e){}}
function openDlg(day,code){
  const p=byDay(day),e=(p.ex||[]).find(x=>x.c===code);if(!e)return;
  lastFocus=document.activeElement;
  const ph=D.photos[e.c];
  $('#dlg').innerHTML=`<div class="hd"><div style="min-width:0"><div class="eyebrow">Tag ${p.day} · ${fmtDate(p.date,1)}</div><div style="font-size:13px;color:var(--muted)">${esc(p.name)}, ${esc(p.land||'')}</div><h3 id="dt">${esc(e.c)} · ${esc(e.n)}</h3></div><button class="x" id="dx" aria-label="Schließen">✕</button></div>
  ${ph?`<img src="${ph}" alt="Eindruck zum Ausflug ${esc(e.c)}">`:''}
  <div class="tags" style="margin-top:10px">${e.dur?`<span class="tag">${esc(e.dur)}</span>`:''}${e.lv?`<span class="tag">${esc(e.lv)}</span>`:''}<span class="tag">${eur(e.p)} p. P. · ${eur(e.p*2)} für zwei</span><span class="tag">Liegezeit ${esc(p.times)}</span></div>
  <p>${esc(e.prog)}</p>${e.note?`<p class="src">${esc(e.note)}</p>`:''}
  <div class="btns"><button class="chip btn" id="dgo">Im Hafen öffnen</button><button class="chip" id="drm">Abwählen</button><button class="chip" id="dcl">Schließen</button></div>`;
  $('#ov').hidden=false;dlgOpened();
  $('#dx').onclick=$('#dcl').onclick=closeDlg;
  $('#dgo').onclick=()=>{closeDlg();select(day);setTab('ex');setTimeout(()=>{const i=p.ex.findIndex(x=>x.c===code);if(i>=0)focusCard('ex',i)},30)};
  $('#drm').onclick=()=>{setPick(p,e,false);closeDlg();renderPanel()};
  $('#dx').focus();
}
$('#ov').addEventListener('click',ev=>{if(ev.target.id==='ov')closeDlg()});
document.addEventListener('click',e=>{const b=e.target.closest&&e.target.closest('.sfx');if(!b)return;const i=b.parentNode.querySelector('input');i.value='';i.dispatchEvent(new Event('input',{bubbles:true}));i.focus()});
addEventListener('keydown',ev=>{if(ev.key==='Escape'&&!$('#ov').hidden){ev.stopPropagation();closeDlg()}},true);
function extraHTML(){
  const fx=D.ports.flatMap(p=>(p.fact||[]).map(f=>({p,f}))).map(({p,f})=>
    `<tr class="clk" data-d="${p.day}"><td>${fmtDate(p.date)}</td><td>${esc(p.name)}</td><td>${esc(f.n)}</td><td>${esc(f.how)}</td></tr>`).join('');
  return `${HAS_FA?`<h3>Fabriken, Plantagen, Manufakturen</h3><div class="tw"><table class="t"><tr><th>Datum</th><th>Hafen</th><th>Was</th><th>Wie</th></tr>${fx}</table></div>`:''}
  ${(window.__T.NOTES||[]).length?'<h3>Hinweise vor der Buchung</h3><ul class="tips">'+window.__T.NOTES.map(x=>'<li>'+esc(x)+'</li>').join('')+'</ul>':''}
  <p class="src">Karte: Küstenlinien © OpenStreetMap-Mitwirkende (ODbL) und Natural Earth, vereinfacht. Offline-Ortsliste: GeoNames (CC BY 4.0).${HAS_EX?' Gestrichelte Pins: Lage ungefähr.':''} Route schematisch.</p>
  ${HAS_SRC?`<p class="src">Quellen der Fabrik-Angaben: ${Object.values(D.src).map(s=>`<a href="${s[1]}" target="_blank" rel="noopener">${esc(s[0])}</a>`).join(' · ')}</p>`:''}`}
function homePanel(){
  const SM=summary();window._sumText=SM.text;
  const rows=D.ports.filter(p=>p.kind==='port').map(p=>{
    const rec=(p.ex||[]).filter(e=>isPicked(p,e)).map(e=>e.c).join(', ')||'–';
    return `<tr class="clk" data-d="${p.day}"><td>${p.day}</td><td>${fmtDate(p.date)}</td><td><b>${esc(p.name)}</b></td>${HAS_EX?`<td>${esc(rec)}</td><td>${esc(p.walk||'')}</td>`:''}</tr>`}).join('');
  const fx=D.ports.flatMap(p=>(p.fact||[]).map(f=>({p,f}))).map(({p,f})=>
    `<tr class="clk" data-d="${p.day}"><td>${fmtDate(p.date)}</td><td>${esc(p.name)}</td><td>${esc(f.n)}</td><td>${esc(f.how)}</td></tr>`).join('');
  return `<div class="eyebrow">Gesamtüberblick</div><h2>Route und Plan</h2>
  <p>Klicke einen Hafen auf der Karte oder einen Tag oben an. Dann siehst du ${HAS_EX?`die Sehenswürdigkeiten des Ortes, die ${esc(OP)}-Ausflüge und alle Fabriken und Plantagen`:'den Tagesplan und die Tipps des Ortes'}.</p>
  ${HAS_EX?SM.html:''}
  <div class="legend">${Object.entries(TYPES).map(([k,v])=>`<span><i style="--c:var(${v[1]})"></i>${v[0]}</span>`).join('')}<span><i style="--c:var(--port)"></i>Hafen</span></div>
  <p><button class="chip btn" data-trip>Alle Tagespläne ansehen</button></p>
  <h3>Reiseplan</h3><div class="tw"><table class="t"><tr><th>Tag</th><th>Datum</th><th>Hafen</th>${HAS_EX?'<th>Ausflug</th><th>Zu Fuß?</th>':''}</tr>${rows}</table></div>
  ${HAS_EX?'<p class="src">Die Summe oben ändert sich, wenn du in einem Hafen Ausflüge an- oder abwählst.</p>':''}
  ${HAS_FA?`<h3>Fabriken, Plantagen, Manufakturen</h3><div class="tw"><table class="t"><tr><th>Datum</th><th>Hafen</th><th>Was</th><th>Wie</th></tr>${fx}</table></div>`:''}
  ${(window.__T.NOTES||[]).length?'<h3>Hinweise vor der Buchung</h3><ul class="tips">'+window.__T.NOTES.map(x=>'<li>'+esc(x)+'</li>').join('')+'</ul>':''}
  <p class="src">Karte: Küstenlinien © OpenStreetMap-Mitwirkende (ODbL) und Natural Earth, vereinfacht. Offline-Ortsliste: GeoNames (CC BY 4.0).${HAS_EX?' Gestrichelte Pins: Lage ungefähr.':''} Route schematisch.</p>
  ${HAS_SRC?`<p class="src">Quellen der Fabrik-Angaben: ${Object.values(D.src).map(s=>`<a href="${s[1]}" target="_blank" rel="noopener">${esc(s[0])}</a>`).join(' · ')}</p>`:''}`;
}
function head(p){
  const land=(p.land||'').split(',').pop().replace(/\s*\(Inselstaat\)/,'').trim();
  return `<div class="dhd"><span class="tdk">Tag ${p.day} · ${fmtDate(p.date)}${land&&p.kind!=='sea'?' · '+esc(land):''}</span><h2>${esc(p.name)}</h2></div>`;
}
function portPanel(p){
  if(p.kind!=='port')return head(p)+(p.kind!=='sea'?aabHTML(p)+infoHTML(p):'')+(p.text?`<p>${esc(p.text)}</p>`:'')+plannerHTML(p);
  const ovTab=()=>{
    const picked=(p.ex||[]).filter(e=>isPicked(p,e));
    const F=[p.times&&/\d/.test(p.times)?['Liegezeit',p.times]:null,p.walk?['Zu Fuß möglich?',p.walk]:null,(p.ex||[]).length?['Eingeplant',picked.length?eur(picked.reduce((a,e)=>a+(e.p||0),0)):'0 €']:null].filter(Boolean);
    const h=(F.length?`<div class="facts">${F.map(f=>`<div class="fact"><small>${f[0]}</small><b>${esc(f[1])}</b></div>`).join('')}</div>`:'')+
    (p.ort?`<h3>Der Ort</h3><p>${esc(p.ort)}</p>`:p.text?`<p>${esc(p.text)}</p>`:'')+
    (p.verdikt?`<div class="call"><b>Selbst oder Ausflug?</b>${esc(p.verdikt)}</div>`:'')+
    (p.rec?`<div class="call rec"><b>Empfehlung</b>${esc(p.rec)}${p.recCodes&&p.recCodes.length?` <button class="lnk" data-go="ex">Ausflug ansehen ›</button>`:''}</div>`:'')+
    ((p.tips||[]).length?`<h3>Auf eigene Faust</h3><ul class="tips">${p.tips.map(t=>`<li>${esc(t)}</li>`).join('')}</ul>`:'')+kulHTML(p);
    return h||'<p class="empty">Noch keine Infos zu diesem Ort. Tipps kann man unter Einstellungen → Reisen → Bearbeiten ergänzen.</p>';
  };
  const poiTab=()=>{
    const list=p.pois.map((q,i)=>({q,i})).filter(({q})=>OSM.f.has(tipCat(q)));
    if(!list.length)return '<p class="empty">Alle Kategorien sind abgewählt. Über „Orte auf der Karte“ (📍 rechts an der Karte) wieder einschalten.</p>';
    return list.map(({q,i})=>{const w=WALK[q.w];
      return `<div class="card" id="poi${i}" data-i="${i}"><div class="row"><span class="badge ic" style="--c:${CAT[tipCat(q)].c}">${tipIcon(q)}</span><div style="min-width:0"><h4>${esc(q.n)}</h4><div class="tags"><span class="tag">${TYPES[q.t][0]}</span>${w?`<span class="tag ${w[1]}">${w[0]}</span>`:''}<span class="tag">Luftlinie ${q.km<0.1?'unter 0,1':String(q.km).replace('.',',')} km${q.ca?' (Lage ungefähr)':''}</span></div></div></div><p>${esc(q.d)}</p>${q.g?`<p class="src" style="margin:0 0 2px">${esc(MODE[q.g.m])} ca. ${q.g.t} Min ab Pier${q.g.o?' · '+esc(q.g.o):''}</p>`:''}<div class="acts">${q.g?`<button class="lnk" data-add="${i}">${(plan[p.day]||[]).some(s=>s.i===i)?'✓ Im Tagesplan':'+ Zum Tagesplan'}</button>`:''}<a class="lnk" href="https://www.google.com/maps/search/?api=1&query=${q.lat},${q.lon}" target="_blank" rel="noopener">In Karten-App öffnen ›</a>${q.ex?`<button class="lnk" data-ex="${esc(q.ex)}">Ausflug ${esc(q.ex)} ›</button>`:''}</div></div>`}).join('');
  };
  const exTab=()=>{
    if(!p.ex||!p.ex.length)return '<p class="empty">Keine '+esc(OP)+'-Ausflüge in den Unterlagen.</p>';
    return `<p class="src">Preise pro Person. Haken setzen, was ihr einplant.</p>`+p.ex.map((e,i)=>{
      const ph=D.photos[e.c];
      return `<div class="card" id="ex${i}" data-code="${esc(e.c)}">${ph?`<img src="${ph}" alt="Eindruck zum Ausflug ${esc(e.c)}" loading="lazy">`:''}
      <div class="row"><div style="min-width:0"><h4>${esc(e.c)} · ${esc(e.n)}</h4><div class="tags">${e.dur?`<span class="tag">${esc(e.dur)}</span>`:''}${e.lv?`<span class="tag">${esc(e.lv)}</span>`:''}${e.rec?'<span class="tag g">Empfehlung</span>':''}${e.sold?'<span class="tag y">ausverkauft</span>':''}</div></div><div class="price">${e.p?eur(e.p):(e.sold?'–':'')}</div></div>
      <p>${esc(e.prog)}</p>${e.note?`<p class="src">${esc(e.note)}</p>`:''}
      ${e.p&&!e.sold?`<label class="pick"><input type="checkbox" data-pick="${i}" ${isPicked(p,e)?'checked':''}> Einplanen (${eur(e.p)} p. P.)</label>`:''}</div>`}).join('');
  };
  const plTab=()=>plannerHTML(p);
  const faTab=()=>{
    if(!p.fact||!p.fact.length)return '<p class="empty">Hier gibt es nach meinem Wissen keine Fabrik- oder Plantagenbesuche.</p>';
    return p.fact.map(f=>`<div class="card"><div class="row"><span class="badge" style="--c:var(--t-factory)">F</span><div><h4>${esc(f.n)}</h4><p>${esc(f.what)}</p></div></div><div class="tags"><span class="tag">${esc(f.when)}</span><span class="tag">${esc(f.how)}</span><span class="tag ${/Unterlagen|Offizieller/.test(f.rel)?'g':'y'}">Quelle: ${esc(f.rel)}</span></div>${f.src?`<div class="acts"><a class="lnk" href="${D.src[f.src][1]}" target="_blank" rel="noopener">Quelle öffnen ›</a></div>`:''}</div>`).join('')
      +`<p class="src">Grün: Veranstalter-Unterlagen oder offizielle Quelle. Gelb: Anbieter, Forum oder nicht belegt, vor der Buchung prüfen.</p>`;
  };
  const nPoi=p.pois.length,nEx=(p.ex||[]).length,nFa=(p.fact||[]).length;
  const sec=(k,t,n,b)=>`<details class="sec" data-sec="${k}" id="sec-${k}" ${openSec.has(k)?'open':''}><summary><b>${t}</b>${n!=null?`<span>${n}</span>`:''}</summary>${b}</details>`;
  return head(p)+tipHTML('port')+aabHTML(p)+infoHTML(p)+dayView(p)+addArea(p)+sec('ov','Über den Ort und Tipps',null,ovTab())+(nPoi?sec('poi','Orte im Detail',nPoi,poiTab()):'')+(nEx?sec('ex',esc(OP)+'-Ausflüge im Detail',nEx,exTab()):'')+(nFa?sec('fa','Fabriken und Plantagen',nFa,faTab()):'');
}
function renderPanel(){
  const a=$('#panel');const keep=a.scrollTop;
  const p=sel==null?null:byDay(sel);
  a.innerHTML=V(p?portPanel(p):todoView&&bordView?bordPanel():todoView&&mappeView?mappePanel():todoView?todoPanel():tripView?(todayView?todayPanel():tripPanel()):homePanel());if(!p&&todoView&&mappeView)mappeBind(a);else if(!p&&todoView&&!bordView)bindTodo(a);if(!p&&bordView)bindBord(a);
  if(!p&&todayView&&!window.__SEED&&typeof duelCard==='function')try{const h=duelCard();if(h){a.insertAdjacentHTML('beforeend',h);const g=a.querySelector('#duelgo');if(g)g.onclick=()=>quizDlg(qzDay()&&qzDay().done||(QZ.daily&&QZ.daily[TODAY])?undefined:'daily')}}catch(e){}
  a.querySelectorAll('.tab').forEach(b=>b.onclick=()=>setTab(b.dataset.t));a.querySelectorAll('[data-tdn]').forEach(b=>b.onclick=()=>tdStep(+b.dataset.tdn));a.querySelectorAll('[data-dn]').forEach(b=>b.onclick=()=>stepDay(sel+ +b.dataset.dn));
  a.querySelectorAll('[data-go]').forEach(b=>b.onclick=()=>setTab('ex'));
  a.querySelectorAll('[data-ex]').forEach(b=>b.onclick=()=>{setTab('ex');setTimeout(()=>{const i=p.ex.findIndex(e=>e.c===b.dataset.ex);if(i>=0)focusCard('ex',i)},30)});
  hideTip2();
  a.querySelectorAll('tr.clk[data-d],[data-tipday]').forEach(e=>{const d=+(e.dataset.tipday||e.dataset.d);
    e.addEventListener('pointerenter',ev=>{if(ev.pointerType==='mouse')tip2At(ev,d)});
    e.addEventListener('pointermove',ev=>{if(ev.pointerType==='mouse')tip2At(ev,d)});
    e.addEventListener('pointerleave',ev=>{if(ev.pointerType==='mouse')hideTip2()})});
  a.querySelectorAll('details[data-sec]').forEach(d=>d.addEventListener('toggle',()=>{d.open?openSec.add(d.dataset.sec):openSec.delete(d.dataset.sec)}));
  if(p){
    a.querySelectorAll('[data-addmode]').forEach(b=>b.onclick=()=>{addMode=b.dataset.addmode||null;renderPanel()});
    a.querySelectorAll('[data-exp]').forEach(b=>{const f=()=>{expKey=expKey===b.dataset.exp?null:b.dataset.exp;renderPanel()};b.onclick=ev=>{if(ev.target.closest('button,input'))return;f()};b.onkeydown=ev=>{if((ev.key==='Enter'||ev.key===' ')&&ev.target===b){ev.preventDefault();f()}}});
    a.querySelectorAll('[data-add]').forEach(b=>b.onclick=()=>{const i=+b.dataset.add;if((plan[p.day]||[]).some(s=>s.i===i)){window.scrollTo(0,0);$('#panel').scrollTop=0;return}planAdd(p,i)});
    a.querySelectorAll('[data-rm]').forEach(b=>b.onclick=()=>{const u=planSnap(p.day),n=rmName(p.day,+b.dataset.rm);plan[p.day].splice(+b.dataset.rm,1);savePlan();refreshPlan(p);undoToast(`„${n}“ aus Tag ${p.day} entfernt.`,u)});
    a.querySelectorAll('[data-mv]').forEach(b=>b.onclick=()=>{const n=+b.dataset.mv,m=n+ +b.dataset.d,L=plan[p.day];if(m<0||m>=L.length)return;[L[n],L[m]]=[L[m],L[n]];savePlan();refreshPlan(p)});
    a.querySelectorAll('button[data-st]').forEach(b=>b.onclick=()=>{const s=plan[p.day][+b.dataset.st];s.s=Math.max(5,(s.s||(p.pois&&p.pois[s.i]?p.pois[s.i].g.s:60))+ +b.dataset.d);savePlan();refreshPlan(p)});
    a.querySelectorAll('[data-at]').forEach(b=>b.onchange=()=>{plan[p.day][+b.dataset.at].at=b.value;savePlan();refreshPlan(p)});
    a.querySelectorAll('[data-xdesel]').forEach(b=>b.onclick=()=>{const e=p.ex.find(x=>x.c===b.dataset.xdesel);if(e){const u=picksSnap();setPick(p,e,false);refreshPlan(p);undoToast(`Ausflug ${e.c} abgewählt.`,u)}});
    const cf=a.querySelector('#cf');if(cf)cf.onsubmit=ev=>{ev.preventDefault();const f=new FormData(cf),n=String(f.get('n')||'').trim();if(!n)return;
      (plan[p.day]=plan[p.day]||[]).push({x:1,n,s:Math.max(5,+f.get('s')||60),t:Math.max(0,+f.get('t')||0),at:f.get('at')||'',note:String(f.get('note')||'').trim()});savePlan();refreshPlan(p)};
    a.querySelectorAll('[data-clr]').forEach(b=>b.onclick=()=>{const u=planSnap(p.day),n=(plan[p.day]||[]).length;plan[p.day]=[];savePlan();refreshPlan(p);undoToast(`${n} eigene Einträge von Tag ${p.day} entfernt.`,u)});
  }
  a.querySelectorAll('[data-pick]').forEach(c=>c.onchange=()=>{const e=p.ex[+c.dataset.pick];setPick(p,e,c.checked);refreshPlan(p)});
  a.querySelectorAll('tr.clk').forEach(r=>{if(r.dataset.code)r.tabIndex=0;r.onclick=()=>{const c=r.dataset.code,d=+r.dataset.d;if(c)openDlg(d,c);else select(d)};r.onkeydown=ev=>{if((ev.key==='Enter'||ev.key===' ')&&r.dataset.code){ev.preventDefault();r.onclick()}}});
  const savePicks=()=>persistPicks();
  const clr=a.querySelector('#clr');if(clr)clr.onclick=()=>{D.ports.forEach(q=>(q.ex||[]).forEach(e=>{if(e.p)picks[pickKey(q.day,e.c)]=false}));savePicks();renderTotals();renderPanel();const m=$('#cpm');if(m)m.textContent='Alle Haken entfernt.'};
  const rst=a.querySelector('#rst');if(rst)rst.onclick=()=>{undoToast('Ausflugsauswahl auf Empfehlung zurückgesetzt.',picksSnap());picks={};persistPicks();renderTotals();renderPanel();const m=$('#cpm');if(m)m.textContent='Auf Empfehlung zurückgesetzt.'};
  a.querySelectorAll('[data-addpt]').forEach(b=>b.onclick=()=>addPointDlg(+b.dataset.addpt||null));
  a.querySelectorAll('[data-tonly]').forEach(b=>b.onclick=()=>{tripOnly=!tripOnly;renderPanel()});
  const tdone=()=>{savePlan();renderPanel();renderDays();updatePills()};
  a.querySelectorAll('[data-trm]').forEach(b=>b.onclick=ev=>{ev.stopPropagation();const [d,i]=b.dataset.trm.split('|'),u=planSnap(+d),n=rmName(+d,+i);plan[+d].splice(+i,1);tdone();undoToast(`„${n}“ aus Tag ${d} entfernt.`,u)});
  a.querySelectorAll('[data-tcx]').forEach(b=>b.onclick=ev=>{ev.stopPropagation();const [d,c]=b.dataset.tcx.split('|'),p=byDay(+d),e=p.ex.find(x=>x.c===c);if(e){const u=picksSnap();setPick(p,e,false);tdone();undoToast(`Ausflug ${e.c} abgewählt.`,u)}});
  a.querySelectorAll('[data-trip]').forEach(b=>b.onclick=()=>showTrip());
  a.querySelectorAll('[data-golist]').forEach(b=>b.onclick=()=>showTodo());
  a.querySelectorAll('[data-home]').forEach(b=>b.onclick=()=>select(null));
  a.querySelectorAll('[data-open]').forEach(b=>b.onclick=()=>{select(+b.dataset.d);setTab(byDay(+b.dataset.d).pois?'pl':'ov')});
  const c2=a.querySelector('#cpt2');if(c2)c2.onclick=async()=>{const m=a.querySelector('#cpm2'),tx=tripText();
    try{await navigator.clipboard.writeText(tx);m.textContent='Kopiert.'}catch(e){const t=a.querySelector('#cpt3');t.value=tx;t.hidden=false;t.select();m.textContent='Text markiert, bitte kopieren.'}};
  const cp=a.querySelector('#cpy');if(cp)cp.onclick=async()=>{
    const m=a.querySelector('#cpm');
    try{await navigator.clipboard.writeText(window._sumText);m.textContent='Kopiert.'}
    catch(e){const t=a.querySelector('#cpt');t.value=window._sumText;t.hidden=false;t.select();m.textContent='Text markiert, bitte kopieren.'}
  };
  a.querySelectorAll('#panel .card[data-i]').forEach(c=>{
    c.addEventListener('click',ev=>{if(ev.target.closest('button,a'))return;const q=p.pois[+c.dataset.i];flyTo(q.ox,q.oy,M.W*p.ompp/2500);if(ev.target.closest('.badge')){const mc=document.querySelector('.mapcol');if(mc)mc.scrollIntoView({behavior:'smooth',block:'start'})}});
    c.addEventListener('pointerenter',()=>{const m=mks.find(x=>x.id===+c.dataset.i&&x.kind==='poi');if(m)m.g.classList.add('on')});
    c.addEventListener('pointerleave',()=>{const m=mks.find(x=>x.id===+c.dataset.i&&x.kind==='poi');if(m)m.g.classList.remove('on')});
  });
  a.scrollTop=keep;
}
let tripView=false;

let todayView=false,todayOff=null;

let FX={usd:1.15,dop:70};try{Object.assign(FX,JSON.parse(localStorage.getItem('rp-'+TRIP_ID+'-fx')||'{}'))}catch(e){}
/* Abendessen: feste Tischzeit und Restaurant (Einstellungen), pro Tag auslassbar oder mit anderer Uhrzeit; gemeinsam in Firestore (plandays/meta) */
let DIN={at:'',dk:null,dv:null,s:90,table:'',skip:[],ov:{}};
try{Object.assign(DIN,JSON.parse(localStorage.getItem('rp-'+TRIP_ID+'-dinner')||'{}'))}catch(e){}
let DSYNC=null;
function dinSave(up){try{localStorage.setItem('rp-'+TRIP_ID+'-dinner',JSON.stringify(DIN))}catch(x){}
  if(!(up&&dbh&&TS.mode==='db'))return;const fv=FV(),prev=DSYNC||{},d={};let n=0;
  ['at','dk','dv','s','table'].forEach(k=>{if(JSON.stringify(DIN[k])!==JSON.stringify(prev[k])){d[k]=DIN[k]==null?null:DIN[k];n++}});
  const sk=DIN.skip||[],psk=prev.skip||[],add=sk.filter(x=>!psk.includes(x)),rem=psk.filter(x=>!sk.includes(x));
  if(fv&&DSYNC){if(add.length){d.skip=fv.arrayUnion(...add);n++}else if(rem.length){d.skip=fv.arrayRemove(...rem);n++}}else{d.skip=sk;n++}
  const ov=DIN.ov||{},pov=prev.ov||{},o={};Object.keys(ov).forEach(k=>{if(ov[k]!==pov[k])o[k]=ov[k]});if(fv)Object.keys(pov).forEach(k=>{if(!(k in ov))o[k]=fv.delete()});
  if(Object.keys(o).length){d.ov=o;n++}
  if(add.length&&rem.length&&fv)dbh.collection('plandays').doc('meta').set({dinner:{skip:fv.arrayRemove(...rem)}},{merge:true}).catch(tdFail);
  DSYNC=JSON.parse(JSON.stringify(DIN));if(n){dbh.collection('plandays').doc('meta').set({dinner:d},{merge:true}).catch(tdFail);syncPoke()}}
const dinVenue=DP.dinVenue,dinName=DP.dinName;
function dinRow(p){return DP.dinRow(p)}
function dinRefresh(){renderPanel();renderDays();updatePills();const p=sel!=null&&byDay(sel);if(p&&pm(p))drawPort(p,true)}
function dinSkip(day,on){const u=JSON.stringify(DIN);DIN.skip=(DIN.skip||[]).filter(d=>d!==day);if(on)DIN.skip.push(day);dinSave(true);dinRefresh();
  undoToast(on?`Abendessen an Tag ${day} ausgelassen.`:`Abendessen an Tag ${day} wieder aufgenommen.`,()=>{DIN=JSON.parse(u);dinSave(true);dinRefresh()})}
function dinLabel(p,r){const v=dinVenue();return `🍽 ${esc(r.q.n)}${v?` <span class="tmore" data-dkgo="${DIN.dk}|${DIN.dv}" role="link" tabindex="0">Deckplan ›</span>`:''}`}
function dinTripHTML(p,r){const lv=r.skip?'':rowLive(p,r);
  return `<div class="swr din${r.skip?' skip':''}${lv?' '+lv:''}" data-sortfix="day${p.day}" data-fixmsg="din" data-a="${r.skip?'':r.a}" data-b="${r.skip?'':r.b}" data-st="${r.st}"><div class="swbg" aria-hidden="true">${r.skip?'Wieder aufnehmen':'Heute nicht'}</div><div class="trw" data-swdel="din|${p.day}"><div class="tm">${hm(r.a)}<small>${hm(r.b)}</small></div><div class="tb tpl" data-dinner="${p.day}" role="button" tabindex="0"><div class="tt">${dinLabel(p,r)}</div>${lv==='live'?liveBadge(p,r):''}<div class="tmeta">${r.skip?'ausgelassen · <span class="tmore">wieder aufnehmen ›</span>':esc([`${r.st} Min`,r.q.g.n,r.ov?'andere Uhrzeit':''].filter(Boolean).join(' · '))}</div></div></div></div>`}
function dinBlkHTML(p,r){const lv=r.skip?'':rowLive(p,r);
  return `<div class="blk din${r.skip?' skip':''}${lv?' '+lv:''}" data-sortfix="day${p.day}" data-fixmsg="din" data-a="${r.skip?'':r.a}" data-b="${r.skip?'':r.b}" data-st="${r.st}"><div class="t">${hm(r.a)}</div><div class="swr blkw"><div class="swbg" aria-hidden="true">${r.skip?'Wieder aufnehmen':'Heute nicht'}</div><div class="c" style="--c:#e8590c" data-swdel="din|${p.day}" data-dinner="${p.day}" tabindex="0" role="button">${lv==='live'?liveBadge(p,r):''}<h4>${dinLabel(p,r)}</h4><div class="m">${r.skip?'ausgelassen · antippen zum Wiederaufnehmen':esc([`bis ${hm(r.b)}`,r.q.g.n,r.ov?'andere Uhrzeit':''].filter(Boolean).join(' · '))}</div></div></div></div>`}
document.addEventListener('click',e=>{const b=e.target.closest&&e.target.closest('[data-dinner]');if(!b||e.target.closest('[data-dkgo]'))return;e.stopPropagation();const d=+b.dataset.dinner,p=byDay(d),r=dinRow(p);if(r&&r.skip){dinSkip(d,false);return}dinnerDlg(d)},true);
function dinnerDlg(day){const p=byDay(day),r=dinRow(p);if(!r)return;const v=dinVenue();
  openSheet(`<div class="hd"><h3 style="margin:0">🍽 Abendessen<small class="hds">Tag ${p.day} · ${esc(fmtDate(p.date))} · ${esc(p.name)}</small></h3></div>
  <p style="margin:0 0 6px;font:700 22px var(--head)">${hm(r.a)}–${hm(r.b)} Uhr${r.ov?' <span class="tag">nur heute</span>':''}</p>
  ${v?`<p class="dkref" style="font-size:14px">🛳 ${esc(dinName())} · Deck ${DIN.dk} ${esc(deckOf(DIN.dk)[1])} · ${posTxt(v[1])} <button type="button" class="lnk" id="dndk">Deckplan ›</button></p>`:'<p class="src">Restaurant noch nicht eingetragen (Einstellungen).</p>'}
  ${DIN.table?`<p class="src" style="margin:4px 0 0">Tisch ${esc(DIN.table)}</p>`:''}
  ${r.skip?'<p class="src bad" style="margin:10px 0 0">An diesem Tag ausgelassen.</p>':''}
  ${r.skip?'':`<label class="dnovr"><span>Nur heute andere Uhrzeit</span><input type="time" id="dnov" value="${hm(r.a)}">${r.ov?'<button type="button" class="lnk" id="dnovx">zurücksetzen</button>':''}</label>`}
  <div class="acts" style="margin-top:12px">${v&&myCab()?'<button type="button" class="lnk" id="dnway">Weg von der Kabine ›</button>':''}<button type="button" class="lnk" id="dnset">Einstellungen ›</button></div>
  <div class="btns bar"><button class="chip ${r.skip?'btn':''}" id="dnsk">${r.skip?'Doch hingehen':'Heute nicht hingehen'}</button></div>`,d=>{
    const k=d.querySelector('#dndk');if(k)k.onclick=()=>dkShow(DIN.dk,DIN.dv);
    d.querySelector('#dnsk').onclick=()=>{closeDlg();dinSkip(day,!r.skip)};
    const w=d.querySelector('#dnway');if(w)w.onclick=()=>{closeDlg();setTimeout(()=>{dkFrom='Unsere Kabine ('+myCab()+')';dkTo=dinVenue()[0]+' (Deck '+DIN.dk+')';dkTab='weg';deckDlg()},60)};
    d.querySelector('#dnset').onclick=()=>{closeDlg();setTimeout(()=>offlineDlg('din'),60)};
    const ov=d.querySelector('#dnov');if(ov)ov.onchange=()=>{const t=ov.value;if(!t)return;DIN.ov=DIN.ov||{};if(t===DIN.at)delete DIN.ov[day];else DIN.ov[day]=t;dinSave(true);closeDlg();dinRefresh();undoToast(t===DIN.at?`Abendessen an Tag ${day} wieder zur normalen Zeit.`:`Abendessen an Tag ${day} um ${t} Uhr.`,null,2500)};
    const x=d.querySelector('#dnovx');if(x)x.onclick=()=>{delete DIN.ov[day];dinSave(true);closeDlg();dinRefresh()}})}
function fxSave(up){try{localStorage.setItem('rp-'+TRIP_ID+'-fx',JSON.stringify(FX))}catch(x){}if(up&&dbh&&TS.mode==='db')dbh.collection('plandays').doc('meta').set({fx:{usd:FX.usd,dop:FX.dop}},{merge:true}).catch(tdFail)}
/* Zeitzonen der Stationen kommen aus den Reisedaten (tz je Station, sonst TRIP.tz). Deutschland (MEZ) UTC+1. */
const tzOf=DP.tzOf;
/* Deutschland am jeweiligen Datum: Winterzeit +1, Sommerzeit +2 */
const deOff=d=>RPDP.deOff(d||TODAY);
const tzTxt=RPDP.tzTxt;
const portNow=DP.portNow;
function tzHTML(p){if(!p||p.kind==='sea')return '';const o=tzOf(p),i=D.ports.indexOf(p),prev=D.ports.slice(0,i).reverse().find(q=>q.kind!=='sea'),po=prev?tzOf(prev):o;
  const de=deOff(p.date)-o,diff=o-po;
  return `<p class="tz">🕒 Ortszeit ${tzTxt(o)} · Deutschland ${de>0?'+':''}${de} Std.${diff?` <b>· ${Math.abs(diff)} Std. ${diff<0?'früher':'später'} als am Vortag – Bordzeit im Tagesprogramm prüfen</b>`:''}</p>`}
/* Wetter je Hafentag (Open-Meteo, ohne Schlüssel); Vorhersage reicht 16 Tage voraus, Zwischenspeicher im Gerät */
const WX={d:{},ts:0,busy:false};
try{const r=JSON.parse(localStorage.getItem('rp-'+TRIP_ID+'-wx')||'null');if(r){WX.d=r.d||{};WX.ts=r.ts||0}}catch(e){}
const WXC=c=>c==null?'':c===0?['☀️','sonnig']:c<=2?['🌤','heiter']:c===3?['☁️','bewölkt']:c<=48?['🌫','Nebel']:c<=57?['🌦','Niesel']:c<=67?['🌧','Regen']:c<=77?['🌨','Schnee']:c<=82?['🌦','Schauer']:['⛈','Gewitter'];
function wxDays(){const t=new Date(TODAY+'T12:00:00'),lim=new Date(t.getTime()+15*864e5).toISOString().slice(0,10);return D.ports.filter(p=>p.lat!=null&&p.date>=TODAY&&p.date<=lim)}
async function wxLoad(force){
  if(WX.busy||navigator.onLine===false||window.__SEED)return;const P=wxDays();if(!P.length)return;
  if(!force&&Date.now()-WX.ts<3*36e5&&P.every(p=>WX.d[p.day]))return;
  WX.busy=true;
  try{const la=P.map(p=>p.lat).join(','),lo=P.map(p=>p.lon).join(',');
    const [f,m]=await Promise.all([fetch(`https://api.open-meteo.com/v1/forecast?latitude=${la}&longitude=${lo}&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,wind_speed_10m_max&timezone=auto&forecast_days=16`).then(r=>r.ok?r.json():null).catch(()=>null),
      fetch(`https://marine-api.open-meteo.com/v1/marine?latitude=${la}&longitude=${lo}&daily=wave_height_max&timezone=auto&forecast_days=16`).then(r=>r.ok?r.json():null).catch(()=>null)]);
    if(!f)return;const F=Array.isArray(f)?f:[f],M=m?(Array.isArray(m)?m:[m]):[];
    P.forEach((p,k)=>{const a=F[k]&&F[k].daily;if(!a)return;const i=a.time.indexOf(p.date);if(i<0)return;const mm=M[k]&&M[k].daily,j=mm?mm.time.indexOf(p.date):-1;
      WX.d[p.day]={c:a.weather_code[i],tx:Math.round(a.temperature_2m_max[i]),tn:Math.round(a.temperature_2m_min[i]),pp:a.precipitation_probability_max[i],w:Math.round(a.wind_speed_10m_max[i]),wv:j>=0&&mm.wave_height_max[j]!=null?+mm.wave_height_max[j].toFixed(1):null,at:Date.now()}});
    WX.ts=Date.now();try{localStorage.setItem('rp-'+TRIP_ID+'-wx',JSON.stringify({ts:WX.ts,d:WX.d}))}catch(e){}
    if(todayView||tripView||sel!=null)renderPanel();
  }finally{WX.busy=false}
}
function wxChip(p,big){const w=p&&WX.d[p.day];if(!w)return '';const c=WXC(w.c);const age=Math.round((Date.now()-w.at)/864e5);
  return big?`<div class="wx"><span class="wxi">${c[0]}</span><div><b>${w.tx}° / ${w.tn}° · ${c[1]}</b><small>💧 Regen ${w.pp??'–'} % · 💨 Wind ${w.w} km/h${w.wv!=null?' · 🌊 Wellen '+String(w.wv).replace('.',',')+' m':''}${age>=1?' · Stand vor '+age+' Tag'+(age>1?'en':''):''}</small></div></div>`
    :`<span class="wxs" title="${c[1]}, Regen ${w.pp??'–'} %">${c[0]} ${w.tx}°</span>`}
function wxHint(p){if(WX.d[p.day]||p.lat==null||window.__SEED)return '';const d=new Date(p.date+'T12:00:00').getTime()-15*864e5;if(d>Date.now())return `<p class="tz">🌤 Wettervorhersage ab ${new Date(d).toLocaleDateString('de-DE',{day:'numeric',month:'numeric'})}</p>`;return ''}
addEventListener('online',()=>wxLoad());setInterval(()=>{if(!document.hidden)wxLoad()},30*6e4);setTimeout(()=>wxLoad(),1500);
function aabInfo(p){return DP.aabInfo(p)}
/* Läuft gerade / vorbei – für Ausflüge und eigene Einträge am heutigen Tag (Ortszeit) */
function dayNow(p){return DP.dayNow(p)}
function rowLive(p,r){return DP.rowLive(p,r)}
function liveBadge(p,r){const n=dayNow(p),b=r.b!=null?r.b:r.a+(r.st||60),m=b-n;return `<span class="livebd">● läuft · noch ${m>=60?Math.floor(m/60)+' Std. '+(m%60?m%60+' Min':''):m+' Min'}</span>`}
let liveSig='';
setInterval(()=>{if(!(todayView||tripView||sel!=null)||!$('#ov').hidden||sortLift)return;const a=document.activeElement;if(a&&a.closest&&a.closest('#panel input,#panel textarea,#panel select'))return;
  const p=D.ports.find(q=>q.date===todayStr());if(!p){liveSig='';return}const sig=calc(p).rows.map(r=>rowLive(p,r)).join(',')+'|'+Math.floor((dayNow(p)||0)/5);
  if(sig!==liveSig){const first=!liveSig;liveSig=sig;if(!first&&(todayView||tripView||sel===p.day)){const y=window.scrollY,ps=$('#panel').scrollTop;renderPanel();window.scrollTo(0,y);$('#panel').scrollTop=ps}}},30000);
function nowNextHTML(p){const N=DP.nowNext(p);if(!N)return '';const {now,cur,nx}=N;if(!cur&&!nx)return `<div class="nown done"><small>Heute</small><b>Alles geplante ist erledigt.</b></div>`;
  const nm=r=>(r.tour?OP+'-Ausflug ':'')+r.q.n,inn=m=>m<60?m+' Min':Math.floor(m/60)+' Std. '+(m%60?m%60+' Min':'');
  return `<div class="nown">${cur?`<div><small>Jetzt · bis ${hm(cur.b)}</small><b>${esc(nm(cur))}</b></div>`:''}${nx?`<div class="nx"><small>Als Nächstes · ${hm(nx.a)} Uhr · in ${inn(nx.a-now)}</small><b>${esc(nm(nx))}</b></div>`:''}</div>`}
function aabHTML(p){const a=aabInfo(p);return a?`<div class="aab ${a.cls}" id="aab" data-day="${p.day}"><div class="aabt"><b>${esc(a.big)}</b><span>${esc(a.txt)}</span></div><i class="aabbar"><i style="width:${a.pc}%"></i></i><small>${esc(a.sub)}</small></div>`:''}
setInterval(()=>{const e=document.getElementById('aab');if(!e)return;const p=byDay(+e.dataset.day);const a=aabInfo(p);if(!a){e.remove();return}e.className='aab '+a.cls;e.innerHTML=`<div class="aabt"><b>${esc(a.big)}</b><span>${esc(a.txt)}</span></div><i class="aabbar"><i style="width:${a.pc}%"></i></i><small>${esc(a.sub)}</small>`},20000);
function infoHTML(p){if(!p||p.kind==='sea'&&!WX.d[p.day])return timesHTML(p)+tzHTML(p)+(wxChip(p,1)||wxHint(p));
  const m=/^(\d{1,2}:\d{2})\s*[–-]\s*(\d{1,2}:\d{2})/.exec(p.times||''),o=tzOf(p),de=deOff(p.date)-o,i=D.ports.indexOf(p),prev=D.ports.slice(0,i).reverse().find(q=>q.kind!=='sea'),diff=prev&&p.kind!=='sea'?o-tzOf(prev):0;
  const ob=m?hm(tm(m[2])-30):'',w=WX.d[p.day],wc=w?WXC(w.c):null,wd=new Date(p.date+'T12:00:00').getTime()-15*864e5;
  const chips=[...embChips(p),p.kind==='port'&&m?`<span>⚓ ${m[1]}–${m[2]}</span>`:'',p.kind==='port'&&m?`<span>an Bord <b>${ob}</b></span>`:'',
    p.kind!=='sea'?`<span${diff?' class="w"':''}>🕒 ${diff?(diff<0?'Uhr '+(-diff)+' Std. zurück':'Uhr '+diff+' Std. vor'):(de>0?'+':'')+de+' Std.'}</span>`:'',
    w?`<span>${wc[0]} ${w.tx}°</span>`:(p.lat!=null&&wd>Date.now()?`<span class="mut">🌤 ab ${new Date(wd).toLocaleDateString('de-DE',{day:'numeric',month:'numeric'})}</span>`:'')].filter(Boolean).join('');
  return `<details class="dinfo"><summary>${chips}<i aria-hidden="true">›</i></summary><div class="dinfob">${timesHTML(p)}${tzHTML(p)}${wxChip(p,1)||wxHint(p)}</div></details>`}
function timesHTML(p){if(p.kind!=='port')return '';const m=/^(\d{1,2}:\d{2})\s*[–-]\s*(\d{1,2}:\d{2})(?:\s*oder\s*(\d{1,2}:\d{2}))?/.exec(p.times||'');if(!m)return '';
 const ab=m[3]?m[2]+'<em>oder '+m[3]+'</em>':m[2];const ob=(h=>{const [a,b]=h.split(':').map(Number),x=a*60+b-30;return String(Math.floor(x/60)).padStart(2,'0')+':'+String(x%60).padStart(2,'0')})(m[3]?m[2]:m[2]);
 return `<div class="tms"><div><small>Ankunft</small><b>${m[1]}</b></div><div><small>Alle an Bord</small><b>${ob}</b></div><div><small>Ablegen</small><b>${ab}</b></div></div>`}
function dnavHTML(p,A){A=A||"dn";return `<div class="dnav"><button data-${A}="-1" ${p.day<=1&&!(A==='tdn'&&!D.ports.some(q=>q.date===TODAY))?'disabled':''} aria-label="Vorheriger Tag">${p.day<=1?'‹ Start':'‹ Tag '+(p.day-1)}</button><span>Tag ${p.day} von ${D.ports.length}</span><button data-${A}="1" ${p.day>=D.ports.length?'disabled':''} aria-label="Nächster Tag">Tag ${p.day+1} ›</button></div>`}
function todayPanel(){
  const dd=x=>new Date(x+'T12:00:00'),DAY=864e5,first=D.ports[0].date,last=D.ports[D.ports.length-1].date;
  const left=Math.round((dd(first)-dd(TODAY))/DAY);
  if((TODAY>=first&&TODAY<=last)||(todayOff&&byDay(todayOff))){
    const tp=D.ports.find(q=>q.date===TODAY);const p=todayOff&&byDay(todayOff)?byDay(todayOff):tp,isT=p===tp;
    const land=(p.land||'').split(',').pop().replace(/\s*\(Inselstaat\)/,'').trim();
    return `${dnavHTML(p,'tdn')}<div class="dhd"><span class="tdk">${isT?'Heute · ':''}Tag ${p.day} · ${esc(fmtDate(p.date))}${land?' · '+esc(land):''}</span><h2>${esc(p.name)}</h2></div>${(x=>x?`<div class="nowbox">${x}</div>`:'')(aabHTML(p)+(isT?nowNextHTML(p):''))}${tipHTML('today')}${infoHTML(p)}<div class="todayh"><h3>Tagesplan</h3><button class="lnk" data-open data-d="${p.day}">Details ›</button></div>${dayView(p,1)}`;
  }
  const ship=(document.querySelector('.tl-ship')||{}).outerHTML||'';
  if(TODAY>last)return `<div class="eyebrow">Mein Tag</div><div class="hero"><div class="hship">${ship}</div><h2>Willkommen zu Hause</h2><p>Die Reise ist vorbei. Schön war’s.</p></div><p><button class="chip btn" data-trip>Reiseplan ansehen</button></p>`;
  const open=TS.tasks.filter(tdOpen),due=open.filter(tdDue);
  const nx=open.filter(t=>t.due).sort((a,b)=>a.due<b.due?-1:1).slice(0,3);
  let sum=0,n=0;D.ports.forEach(p=>(p.ex||[]).forEach(e=>{if(e.p&&isPicked(p,e)){sum+=e.p;n++}}));
  const own=Object.values(plan).reduce((a,l)=>a+(l||[]).length,0);
  // Countdown bis zur eingetragenen Abreise (erste Teilstrecke), sonst bis zum ersten Reisetag
  const p1=D.ports[0],ts=TRV.out&&tvSum(TRV.out),dep=ts?Math.round((dd(ts.a.dd)-dd(TODAY))/DAY):left;
  const big=dep<=0?'Heute geht’s los!':dep===1?'Morgen geht’s los!':'Noch '+dep+' Tage';
  const until=ts?`bis zur Abreise am ${esc(fmtDate(ts.a.dd))} um ${esc(ts.a.dt)} ab ${esc(tvShort(ts.a.f,1))}.<br>${CRUISE?'Einschiffung':'Erster Tag'} am ${esc(fmtDate(first))}${p1?' in '+esc(p1.name):''}.`
    :CRUISE?`bis zur Einschiffung am ${esc(fmtDate(first))}${p1?' in '+esc(p1.name):''}.`:`bis zum Reisestart am ${esc(fmtDate(first))}${p1?' · erster Ort: '+esc(p1.name):''}.`;
  return `<div class="eyebrow">Mein Tag</div><div class="hero"><div class="hship">${ship}</div><div class="hbig">${big}</div><p>${until}<br>Danach ${TRIP_NIGHTS} Nächte${TRIP.region?' '+esc(TRIP.region):''}.</p></div>
  <div class="hcards">
  <div class="hc"><b>Aufgaben</b><span>${open.length?open.length+' offen'+(due.length?', '+due.length+' jetzt fällig':''):'alles erledigt'}</span>${nx.map(t=>`<small>${esc(fmtDate(t.due))} · ${esc(t.text)}</small>`).join('')}<button class="lnk" data-golist>ToDos öffnen ›</button></div>
  <div class="hc"><b>${HAS_EX?'Ausflüge':'Tagesplan'}</b><span>${HAS_EX?`${n} gewählt · ${eur(sum)} p. P.`:own+' '+(own===1?'Eintrag':'Einträge')}</span><small>${own?own+' eigene'+(own>1?' Einträge':'r Eintrag')+' im Plan':'Noch keine eigenen Einträge'}</small><button class="lnk" data-trip>Reiseplan öffnen ›</button></div>
  ${tvBlock('out','sum')}<div class="hc"><b>Tag 1</b><span>${esc(p1.name)}</span><small>${esc(p1.times||(CRUISE?'Einschiffung':'Start'))}</small><button class="lnk" data-tdn="1">Ansehen ›</button></div></div>
  <p class="src">Ab dem ${esc(fmtDate(first))} zeigt diese Seite jeden Tag den Plan für heute.</p>`;
}
function tdStep(v){const tp=D.ports.find(q=>q.date===TODAY),cur=todayOff||(tp?tp.day:0);let i=v===0?null:cur+v;
  if(i!==null){if(i>D.ports.length)return;if(i<1){if(tp)return;i=null}}
  todayOff=(i===null||(tp&&i===tp.day))?null:i;renderPanel();$('#panel').scrollTop=0;window.scrollTo(0,0)}
function showToday(fromHash){if(fromHash!==true){saveScroll();todayOff=null}mappeView=false;tripView=true;todoView=false;bordView=false;todayView=true;sel=null;renderDays();renderBar();drawOverview();renderPanel();$('#panel').scrollTop=0;if(fromHash!==true)nav('#heute');}
function showTrip(fromHash){if(fromHash!==true)saveScroll();mappeView=false;tripView=true;todoView=false;bordView=false;sel=null;renderDays();renderBar();drawOverview();renderPanel();$('#panel').scrollTop=0;if(fromHash!==true)nav('#plan');}
/* Tag wechseln per Wischen oder ‹ › : Leseposition halten statt nach oben zur Karte springen */
let daySwipe=false;
function stepDay(i){
  if(i<1||i>D.ports.length)return;
  const pnl=$('#panel'),mob=matchMedia('(max-width:860px)').matches,y=window.scrollY,top=pnl.getBoundingClientRect().top+y,inPanel=mob&&y>top-80;
  daySwipe=true;try{select(i)}finally{daySwipe=false}
  if(mob)window.scrollTo({top:inPanel?Math.max(0,pnl.getBoundingClientRect().top+window.scrollY-8):y,behavior:'instant'});
}
let DAYFROM='trip';
function select(day,fromHash,keep){const inPage=!todayView&&!tripView&&!todoView;if(todayView)DAYFROM='today';else if(tripView)DAYFROM='trip';else if(mappeView)DAYFROM='mappe';else if(bordView)DAYFROM='bord';else if(todoView)DAYFROM='todo';bordView=false;todayView=false;mappeView=false;
  if(!fromHash&&!keep)saveScroll();
  tripView=false;todoView=false;bordView=false;hideTip2();
  if(day!==sel){tab='ov';addMode=null;expKey=null;openSec=new Set();filt=new Set(Object.keys(TYPES))}
  sel=day;const p=day==null?null:byDay(day);
  renderDays();renderBar();
  if(p&&pm(p))drawPort(p,keep);else drawOverview(keep&&false);
  renderPanel();$('#panel').scrollTop=0;
  if(!fromHash&&!keep)nav(day==null?'':'#tag-'+day,inPage);
  if(matchMedia('(max-width:860px)').matches&&!fromHash&&!keep&&!daySwipe)window.scrollTo({top:0,behavior:'smooth'});
}
function fromHash(){const h=location.hash||'';if(h===lastHash)return;lastHash=h;noSave=true;if(h==='#plan')showTrip(true);else if(h==='#heute')showToday(true);else if(h==='#todos'||h==='#listen')showTodo(null,true);else if(h==='#bord')setTimeout(()=>showBord(true),0);else if(h==='#mappe')showMappe(true);else{const m=/^#tag-(\d+)$/.exec(h);select(m&&byDay(+m[1])?+m[1]:null,true)}restoreScroll(h)}
try{history.scrollRestoration='manual'}catch(e){}
addEventListener('popstate',()=>{
  // eigenes history.back() beim Schließen: kommt auf Android verzögert an und darf keinen neu geöffneten Dialog schließen
  if(popIgnore>0){popIgnore--;return}
  if(fv){fvClose();return}
  if(!$('#ov').hidden&&SUBS.length){const f=SUBS.pop();if(f)f();return}
  if(!$('#ov').hidden&&dlgReturn){const r=dlgReturn;dlgReturn=null;dlgPushed=false;$('#ov').hidden=true;setTimeout(r,90);return}
  if(!$('#ov').hidden){dlgPushed=false;$('#ov').hidden=true;if(lastFocus&&lastFocus.focus&&matchMedia('(pointer:fine)').matches)try{lastFocus.focus({preventScroll:true})}catch(e){}return}
  dlgPushed=false;fromHash();
});
addEventListener('hashchange',fromHash);
addEventListener('keydown',e=>{
  if(e.target.closest('input,textarea')||!$('#ov').hidden)return;
  if(e.key==='ArrowRight'||e.key==='ArrowLeft'){const i=sel==null?0:sel+(e.key==='ArrowRight'?1:-1);if(i>=1&&i<=15)select(i)}
});
matchMedia('(prefers-color-scheme: dark)').addEventListener('change',()=>select(sel,true));
$('#tripb').onclick=()=>showTrip();
$('#todob').onclick=()=>showTodo();
{const bb=$('#bellb');bb.onclick=()=>{hideTip2();showTodo('due')};
 bb.addEventListener('pointerenter',e=>{if(e.pointerType==='mouse')tip2Html(bb,dueTipHTML())});bb.addEventListener('pointerleave',e=>{if(e.pointerType==='mouse')hideTip2()});
 bb.addEventListener('focus',()=>tip2Html(bb,dueTipHTML()));bb.addEventListener('blur',hideTip2)}
tdInit();
$('#totb').onclick=()=>{showToday();goTop()};
$('#panel').addEventListener('scroll',hideTip2,{passive:true});
renderTotals();fromHash();

/* ---------- v26: Ansichten, Bottom-Nav, Suche, Heute ---------- */
function lv(on){const c=document.body.classList;const was=c.contains('v-list');c.toggle('v-list',on);return was&&!on}
/* Kartenstand merken, wenn man von der Karte in eine Liste wechselt */
let LASTMAP=null;const keepMap=()=>{if(!tripView&&!todoView&&M&&cw>200)LASTMAP={sel,u:vb.w/cw,cx:vb.x+vb.w/2,cy:vb.y+vb.h/2}};
{const a=showTrip,b=showTodo,c=select;
 showTrip=function(...x){keepMap();lv(true);todayView=false;const r=a.apply(this,x);navMark();return r};
 showTodo=function(...x){keepMap();lv(true);todayView=false;const r=b.apply(this,x);navMark();return r};
 select=function(...x){const re=lv(false);todayView=false;const r=c.apply(this,x);navMark();if(re)setTimeout(()=>{if(M){measure();home();applyVB()}},40);return r}}
{const t0=showToday;showToday=function(...x){keepMap();lv(true);const r=t0.apply(this,x);navMark();return r}}
{const t1=showBord;showBord=function(...x){keepMap();lv(true);const r=t1.apply(this,x);navMark();return r}}
/* Beim Laden mit #heute, #plan oder #todos lief fromHash() vor den Hüllen oben: Listenansicht hier nachziehen */
if(sel==null&&(tripView||todoView)){lv(true);navMark()}
function mapFull(on){const c=document.body.classList;if(on===undefined)on=!c.contains('mapfull');c.toggle('mapfull',on);
  const b=document.getElementById('mxbtn');if(b){b.setAttribute('aria-label',on?'Vollbild beenden':'Karte maximieren');b.innerHTML=on?MXI[1]:MXI[0]}
  try{if(on&&document.documentElement.requestFullscreen)document.documentElement.requestFullscreen().catch(()=>{});else if(!on&&document.fullscreenElement)document.exitFullscreen().catch(()=>{})}catch(e){}
  setTimeout(()=>{if(typeof M!=='undefined'&&M){measure();home();applyVB()}},80)}
const MXI=['<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>','<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/></svg>'];
(function(){const mc=document.querySelector('.mapcol');if(!mc)return;const b=document.createElement('button');b.id='mxbtn';b.type='button';b.setAttribute('aria-label','Karte maximieren');b.innerHTML=MXI[0];b.onclick=()=>mapFull();const z=mc.querySelector('.zoom');z?z.insertBefore(b,z.firstChild):mc.appendChild(b);
  addEventListener('keydown',e=>{if(e.key==='Escape'&&document.body.classList.contains('mapfull')&&$('#ov').hidden)mapFull(false)});
  document.addEventListener('fullscreenchange',()=>{if(!document.fullscreenElement&&document.body.classList.contains('mapfull'))mapFull(false)});
  let rt;const rs=()=>{if(!document.body.classList.contains('mapfull'))return;clearTimeout(rt);rt=setTimeout(()=>{if(typeof M!=='undefined'&&M){measure();home();applyVB()}},200)};
  addEventListener('resize',rs);addEventListener('orientationchange',rs)})();
function hereTag(vm){let e=document.getElementById('heretag');const mc=document.querySelector('.mapcol');if(!vm||!mc){if(e)e.remove();return}
  const p=D.ports.find(q=>q.date===TODAY);if(!p){if(e)e.remove();return}
  if(!e){e=document.createElement('div');e.id='heretag';mc.appendChild(e)}
  e.textContent='Heute: Tag '+p.day+' · '+(p.kind==='sea'?'Seetag':p.name)}
/* Übersichtskarte am Handy: genau bis zur unteren Leiste */
function fitMap(){const mc=document.querySelector('.mapcol'),bn=document.getElementById('bnav');if(!mc)return;
  if(!document.body.classList.contains('v-map')||!matchMedia('(max-width:860px)').matches){document.body.style.removeProperty('--fitmap');return}
  const top=mc.getBoundingClientRect().top+window.scrollY,bh=bn&&getComputedStyle(bn).display!=='none'?bn.offsetHeight:0;
  const h=Math.max(260,Math.floor(window.innerHeight-top-bh));if(document.body.style.getPropertyValue('--fitmap')!==h+'px'){document.body.style.setProperty('--fitmap',h+'px');if(typeof M!=='undefined'&&M){measure();applyVB()}}}
addEventListener('resize',()=>setTimeout(fitMap,60));addEventListener('orientationchange',()=>setTimeout(fitMap,250));
function navMark(){const k=todayView?'today':tripView?'trip':todoView?(bordView?'bord':mappeView?'mappe':'todo'):'map';const vm=k==='map'&&sel==null,was=document.body.classList.contains('v-map'),vt=(k==='todo'||k==='mappe')&&sel==null,wt=document.body.classList.contains('v-todo');document.body.classList.toggle('v-map',vm);document.body.classList.toggle('v-todo',vt);document.body.classList.toggle('v-today',k==='today'&&sel==null);document.body.classList.toggle('v-bord',k==='bord'&&sel==null);if((vm!==was||vt!==wt)&&typeof M!=='undefined'&&M)setTimeout(()=>{measure();if(Date.now()>skipHome)home();applyVB()},50);hereTag(vm);const hk=k==='map'&&matchMedia('(max-width:860px)').matches?DAYFROM:k;document.querySelectorAll('#bnav button,.hbtns [data-n]').forEach(b=>b.classList.toggle('on',b.dataset.n===hk));{const ph=(k==='map'||k==='todo')&&matchMedia('(max-width:860px)').matches;document.body.classList.toggle('dpage',ph);if(ph){const lb={trip:'Reiseplan',today:'Mein Tag',bord:'An Bord',todo:'ToDos',mappe:'Mappe'}[DAYFROM]||'Reiseplan',pp=sel!=null?byDay(sel):null;$('#pgback span').textContent=lb;$('#pgttl').textContent=k==='todo'?'ToDos':pp?'Tag '+pp.day+' · '+pp.name:'Übersichtskarte';$('#pgnav').hidden=!pp;if(pp){const B=document.querySelectorAll('#pgnav button');B[0].disabled=pp.day<=1;B[1].disabled=pp.day>=D.ports.length}}}{const mb=$('#mback');if(mb){mb.hidden=k!=='map';mb.setAttribute('aria-label','Zurück zu '+({trip:'Reiseplan',today:'Mein Tag',bord:'An Bord',todo:'ToDos'}[DAYFROM]||'Reiseplan'))}}setTimeout(fitMap,0)}
function goTop(){const w=$('#panel');if(w)w.scrollTop=0;window.scrollTo(0,0)}
/* Globale Suche über alles */
function nrm(t){return String(t||'').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'')}
let dkHl=null;
function searchDlg(){
  openSheet(`<div class="hd"><h3 style="margin:0">Suchen</h3><button class="x" data-close aria-label="Schließen">✕</button></div><div class="sfield"><svg class="sfi" viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg><input id="sq" type="search" placeholder="Orte, Ausflüge, ToDos, Bars an Bord, Getränke, Kabine …" autocomplete="off"><button type="button" class="sfx" aria-label="Eingabe löschen">✕</button></div><div id="sr" style="margin-top:10px"></div>`,d=>{asPage();
    const q=d.querySelector('#sq'),r=d.querySelector('#sr');setTimeout(()=>q.focus(),50);
    const go=f=>{closeDlg();setTimeout(f,90)};
    const run=()=>{const t=nrm(q.value.trim());r.innerHTML='';if(t.length<2){r.innerHTML='<p class="src">Mindestens 2 Buchstaben. Durchsucht Häfen, Sehenswürdigkeiten, Ausflüge, eigene Einträge, ToDos, Orte aus OpenStreetMap (gespeicherte Häfen), Deckplan, Getränkekarte und Kabinennummern.</p>';return}
      const H=[],add=(k,ic,n,sub,f,txt)=>{const x=nrm(txt||n);if(!x.includes(t))return;H.push({k,ic,n,sub,f,sc:x.startsWith(t)?0:x.split(/[\s(\/-]+/).some(w=>w.startsWith(t))?1:2})};
      D.ports.forEach(p=>{
        add('Tag','📅',p.name,`Tag ${p.day} · ${fmtDate(p.date)}${p.land?' · '+p.land:''}`,()=>select(p.day),p.name+' '+(p.land||''));
        (p.pois||[]).forEach((o,i)=>add('Sehenswert','📍',o.n,`Tag ${p.day} · ${p.name}`,()=>{select(p.day);setTab('poi');focusCard('poi',i)}));
        (p.ex||[]).forEach(e=>add(OP+'-Ausflug','🚌',e.c+' · '+e.n,`Tag ${p.day} · ${p.name}${e.p?' · '+eur(e.p)+' p. P.':''}`,()=>{select(p.day);setTab('ex')}));
        (plan[p.day]||[]).forEach((x,i)=>{if(x.x)add('Eigener Eintrag','★',x.n,`Tag ${p.day} · ${p.name}${x.at?' · '+x.at+' Uhr':''}`,()=>x.lat!=null?placeDlg(p.day,i):addPointDlg(p.day,null,{day:p.day,pi:i}),x.n+' '+(x.note||''))});
      });
      TS.lists.forEach(l=>add('Liste','🗂',l.name,'ToDo-Liste',()=>showTodo(l.id)));
      TS.tasks.forEach(a=>add('Aufgabe',a.done?'✅':'☐',a.text,((TS.lists.find(l=>l.id===a.list)||{}).name||'')+(a.due?' · '+fmtDate(a.due):''),()=>{showTodo(a.list);setTimeout(()=>taskDlg(a.id),60)},a.text+' '+(a.note||'')+' '+(a.subs||[]).map(x=>x.text).join(' ')));
      if(typeof SHIP!=='undefined')SHIP.dk.forEach(([n,nm,V])=>V.forEach((v,i)=>add('An Bord',DKIND[v[2]][0],v[0],`Deck ${n} ${nm} · ${posTxt(v[1])}`,()=>{deckSel=n;dkHl=i;deckDlg()},v[0]+' '+DKIND[v[2]][1])));
      if(/^\d{4}$/.test(t)&&typeof cabInfo==='function'){const c=cabInfo(+t);if(c)H.unshift({k:'Kabine',ic:'🛏',n:'Kabine '+t,sub:c.txt,f:()=>{deckSel=c.d;deckDlg()},sc:-1})}
      if(typeof DRINKS!=='undefined'&&DRINKS.groups)DRINKS.groups.forEach(g=>g.secs.forEach(sc=>sc.items.forEach(it=>add('Getränk','🍹',it.n,`${sc.n}${it.p?' · '+it.p:''}`,()=>{drkQ=it.n;drinksDlg()},it.n+' '+(it.d||'')))));
      if(typeof OSM!=='undefined'){const seen=new Set();for(const arr of OSM.data.values())for(const o of arr){if(seen.has(o.id))continue;const nm=osmName(o);if(nm==='Ohne Namen'||!nrm(nm).includes(t))continue;seen.add(o.id);const pt=osmPorts.find(x=>x.k===o.pk);
        add('Ort (OSM)',OSMG[o.g].i,nm,`${osmKind(o)}${pt?' · '+pt.name:''}`,()=>{const dd=osmDayFor(o);if(sel!==dd)select(dd);setTimeout(()=>{const xy=llxy(o.lat,o.lon);flyTo(xy[0],xy[1],Math.max(M.W/vb.w,M.W*byDay(dd).ompp/900||1));osmDlg(o)},350)})}}
      if(!H.length){r.innerHTML='<p class="empty">Nichts gefunden.</p>';return}
      H.sort((a,b)=>a.sc-b.sc);
      const shown=H.slice(0,60);
      r.innerHTML=shown.map((h,i)=>`<button class="sres" data-si="${i}"><span class="si">${h.ic}</span><span class="sb"><b>${esc(h.n)}</b><small>${esc(h.k)} · ${esc(h.sub)}</small></span></button>`).join('')+(H.length>60?`<p class="src">${H.length-60} weitere Treffer, bitte genauer suchen.</p>`:'');
      r.querySelectorAll('[data-si]').forEach(b=>b.onclick=()=>go(shown[+b.dataset.si].f));
    };
    q.addEventListener('input',run);run();
  });
}
$('#pgback').onclick=()=>$('#mback').click();
document.querySelectorAll('#pgnav [data-pgd]').forEach(b=>b.onclick=()=>{if(sel!=null)stepDay(sel+ +b.dataset.pgd)});
$('#mback').onclick=()=>{const f={today:showToday,bord:showBord,mappe:showMappe,todo:()=>showTodo()}[DAYFROM]||showTrip;if(history.state&&history.state.v&&history.length>1)history.back();else f()};
$('#srchb').onclick=searchDlg;$('#drkb').onclick=drinksDlg;$('#dkb').onclick=()=>deckDlg();
document.querySelectorAll('#bnav button,.hbtns [data-n]').forEach(b=>b.onclick=()=>{hideTip2();const k=b.dataset.n,HS={trip:'#plan',today:'#heute',bord:'#bord',mappe:'#mappe',todo:'#todos'},cur=sel==null?(todayView?'today':tripView?'trip':todoView?(bordView?'bord':mappeView?'mappe':'todo'):''):'',same=cur===k;if(HS[k])setTimeout(()=>same?goTop():restoreScroll(HS[k]),0);
  if(k==='mappe')showMappe();else if(k==='trip')showTrip();else if(k==='todo')showTodo();else if(k==='bord')showBord();else if(k==='today')showToday();else if(k==='srch')menuDlg();
  else if(k==='map'){mapMin=false;const L=(tripView||todoView)?LASTMAP:null;select(L?L.sel:null);applyMin();goTop();
    if(L)setTimeout(()=>{if(!M)return;measure();vb={x:L.cx-L.u*cw/2,y:L.cy-L.u*ch/2,w:L.u*cw,h:L.u*ch};applyVB()},90)}});
try{if(!window.__SEED){if(localStorage.getItem('rp-seen'))$('.sub').hidden=true;else localStorage.setItem('rp-seen','1')}}catch(e){}
/* ---------- v28: Offline-Export und Sicherung ---------- */
const OFFLINE=!!window.__SEED;
const ICON_URI='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAMAAAADACAYAAABS3GwHAAAQAElEQVR4Aex9CZwVxbX+V3eGTZR9ZkBcQARcoogC7jFq8jSJ/mLyEpM8zR4TE7O4RTCaiC9PjSYi/jVuWcymJiQuoKhxZxMFFQVFNgVF2UFmmGEZZm79v1PV1be7Z4CZuffO3DtTbd8+fepUV536znequvtexhQKYOs3dcaw8kenn1M+Zeb3yx+dcU3/R2feQflQxWOzZrFsWcWjM6v50eYzZYaVj840sjyhVyR0b4/j1Xr4zKiueGzmMsZxVv8pMx8sZ0z7Pzbzl4zn9yumzPqcxLwAqIc2S4D+U2aNJqGvr5gy8+2SeixWSD2soO9SUOO11j+g/DzS+gQFDIHW3SGb1oBiiUhwExVRXQqiOmiN6t6OVsNPdUcaQ5RWJ2joLzAKP9BpfS27vwtIP1KSVosl9vxcN2DyzFFoo631EmDSpJL+U6afUjF5xkQSf0Ua6TnQuJLgHAIoclwDlDyhcDpYxZYzKQBvJyDEgyyyeFAlQoKL1UkzmRyKx34I4//ztMJcrkwrmAy3lE2e9nGM163Gy7x31Ovh53txcDdUdB2wTkO9QA7/lCQ/UEE2lohgEJ1u1Ybl3i7IaDmA+BFGOdUNpJQWo51+H8iBXZxSqWkVI2euJmf+74DHZvRmeV73vCXAfpNe7MZBjOucKlnOEYzjDNWHkrHRIryUmZpIEBceGXqvZ3BQKCcuV9Wm8U7ZlBljhUvGmIdD7hPg+edLyx+Z9v2dXeqXkeU3cObuxcHYmYpBps5iXQA60fT+mDgUanzoV++U1r+u7VK3jC8zvgdyi1HL6Z67BNBa9Z8y89zyypK3lFJ3aZ3eVzzVGgHIMFtGp4ElGZ0K94zu7YSDkwU8fsC+fCFyd/+qkrfKJs/4EkGReRS52HKSAH0ef6kHb3empNP1/6RnwzRZrBg2I5Vd3inot2ap05XVaTD1OJq49HaDh8fH8oT8SGs9jCvCJOGacI5FWe9ZJ0C/yc8NL62tncNgnaVIbz7V80jymgdbyrSQntLpSentcbw8PnE8GuEHITqrtHb7nH0nzxyebQZklQAVDz1/VkqX8HWmHq7oiZCfIsxYo9PA5OCgOPPTc28nDmaFpBQ8PD5xvpAgMb7sEh81vE7Xz6l4aMZZvKTFe8sSQGtV/tAL1yKVmkLve6iIk9ThdZJby8rHuIgsNHzajz89tKqfUv7wtPHkHUdFvJu5NzsB5N6r4pFpU6DwS2aq6ZTSdOul9jgQgVbmATmorxFOCjfZfbP2ZiWA3O+XbN82h2E+K1i9OdWBuYCIpJWqtyOBi9M9PpCNMJC5Ed4gwIsGcKNojp0L7VmlO7bPEY7y6ibvTU+A8TqVSqtbFdRwLjemA3YaSHrLM6srDiqqixrVvd3jF+VD7vjBSXd4qj51C8hV0rFJe5MToPzIF66HVmcA4nyGxKIryV3Lfnbq7Ujg4fFRpInwAtxExnWVwAsJvZn2TxuuomlbkxKg4sHnv8vmxrqZy0jFkoD05p4vons7gxzBw+MTxyP//MBYcvbLZGiDPVmwxwQof/C5E+n+HUmnnW6CK61KMkSC7u1EjXh4fIhDG/CDvd5b9u9pI6Xr3X12mwB9Hpm2P6Ae5vrViZKCzUI2kSa6slixIKNT4Z7RWSumU+Hu7RDkOGl4fMAtwwcq3DN6y/FBN6j0ZMthNrmLfZcJIL/AK61LT+EMVibXUopgEgSCwZOzQHDCF6dZ4kRgCIS3h0AQI+4Oz7A4PKGRu7dbIoWwhCcEh3tT8FHQ+5fU1U0WLvOSRvddJkCt2jaWbD/KZCB9cdK0EtFduZPeTgQ8PrK+kT5oICFbq+KjRlouS8cNP40mQO9JT/ekjxdL9UymsYQFXvc4kAbhil4UfFDqp/IPs8Tv5KfRBOikUpcohZ4cpclgGSR1ZrQuYp1D5zIqK5UfD+Nogego8ezVuS59MRnQYG+QAGWTnu/PWhcLSSih+Z/FSotKTYegSYG3ezyKgh9Ao6tAgwQA6seR1D3NoEh3RbpT51FRk2A7yQWBJd7u8EhKj0/jvHE4tTY+aHQViCVAMPt/X3Fq592CJT1PrB6QP9Th7URAVkqPD8lseEFyGyl64fEDXAX6PfjkAMpwjyUAOPvT0pVjYGhlEJqqSHgdgoPHgzDIo2Gx8qGXqi/l200Zhf1kEmDSpM4M8bdkdJkZjZWYDV4nMgEORYmPCaM2pPX+628eZrhOULiHCVCGPqfxlr4Hy4iRFuElSS9AyG2Ol3YSiOJwdNd1+E7vt3HbgGmYftDDWHvIn7Du0HsbyGmDH2Kd6fh2r4WQa9oYz57rhesyEH7CBNA6fY7M9GQ9i+3udCNZZGRACqqxGSWqy7l8XH0jWWCkv55I2N3hYSSLjCxgfPZK7cS5PZbib/s9bYj+xKDHcEP/l3Buz3dwSJfNHEHju9i+3OsdU/fJwVPNtX/d/xmc22MZuqlayyNe2orjP5PdmT1MgJRWZ8pTu/EmCILVFXMiWBG4RHg7cetg+PQp2YpxZa9h3sGTcPvAmThjnw8IQnb7mXuvxO0DZ+D1of/CFf1eQ9/SbWQXeSZZkH984wnQ9/7/yN9oPBDCbvoA+dYrcILsp0qvjC4SYIGshzAby5WScnMhy1ka6jz3dsJVrPhofGGfZZh20BRc2u8N9C6pZUBzu0ubl5W9gWmDJ+OcHstbhz/AcOG8jMSsAKkUzoFsJKsIIb2V5khVyM1zbycI3EMceM5dh3oSJxq5F6O9O293/jjwBdy13wyUc3bmMPK6Sx/3DJyGe9jn3mqH7SuEMzwJyp3uVKcnJSA1GsPfcd4kgII6hyyXuszAeCONXWwqBkH39jheSRyLEZ/Bnavw7OApOLvHeybUrXk4p+cKPDX4MQzpZJ8p8oUf6Wsm/VS/vz05gJ2MMYNkaVIqKWikXIol2N5OJNoRPmP2WovHB03FQV22cGBtsx/cpQqPDn4CI7qsR774pZQa0++Bp/ZNqRKM4DAVk4CCezih2RNX7iRsMblvT1y5k95ODLk7PJKykPEZ2W09/nHAM+hbGtyCcBxttfejD5IER3Vdb1xwOOYMv3RaKZ0+MgWV6k82M9OYazKTURhd8YS6UoFkDSkXIVKpoNxJMbC+CG/XUKq48BnUuRoPkPx7l9QZwhXCoWsqjX8c+CwO7FQFxf+EVyJEKqXM7bpSgRRDc/mndP8UdH1/8OIGrzxNY+4VKKWkHjtzmWhkqHt7MePXTdXj/gOfQZ/S3L/lQZZbH64E9zMJuqqdQMg34b6O6C3kn04xAaD6S/CYR9IqRBrugxtPjE7yizSZZ4tNvVAvSLt1VPz249PxeGnE9AkDX8RQ3nejQDfx7ZaBs3PPT3AFIMf7G5LwRMYvMzsTjdwmSiwweiApTLm3SyzaBz6ndv8A/92L798luAX8ER9P2/vD3PJPo3+Ki0f/KMldMnhpSd6eceiEOly37ysFTPu4a7/qPxddeLuWM77aFUAPskGGWRYzjXvd4qIDXNofHv/dawXklSOKZBvatQqf77k8l/HgCqD4DMDbHxtsQYJrgugsoGBBoPMspns7l2OCwnBEJw04vcDxKVFpXFo2H8W2XVL+JlK6HvY2XLzPgp/gLRCD10WBjbgHWSOpk+1K2ne6kVIgM6K3EzeiFsGjkPChZ3vy77juazGoS7UMICeftzZ1wcQFfXHes/tj6APDzEfOb53fD2LLSSdsRL6gO27v9Zx8hIcsMLgrHhN6U/ir0TNlmmDlmGRzMd3bBQ4DupzIWyUjk7g4vQjw+0rvd2UIWX+21yn8Ym4Fjn/kYFw9ZwAmr+iJ1Vs7m4+cXzW3v7Fd80o5dtbbKTXbTuU2SNqQJG9UNgN/fg/AzBG/GDxZVhhlaVOeAOH0pDQVIvW9nYhE8KBW8PidyBXA+JnFYcHGrobct8wvQ1oLiRpvTGw3v1GOUx49CG9s6Np4pWaUnrbP6pzhG1kBuIwwiMYPIzO6zbSMbpMko3u7JmwZPAodn/07bcH+nWvoc8v3mp0p/A9vd5ZWdmlyI/M3dsP5z+2P2nSTL2m0ovguH8s7yYWW488VADC5a0gPtsaP7BHd2wlIBA9qxElA5xlFseEzaq8NdDy7/Vre0izf0nTyu97kml+9WuHUFstRe9nfCMndTjb4BytA4AeDac5CaU9c7KUzbycCFpYwCYoNH/lmlaNo8f7S2m648+2+Lb5+4oJ+mL12rxZfLxeaMQTAB4LxAMSW4akN1O7sKbeMhFfHakeWddeqtxuMLV7Fic+ATluDMbRM3LmwL+/yzLzbogY0nxfuXdS7Rde6i+wYssef3wSzSW0zhaOCuR+K6GaYEd3bQe5n8CpGfORfe3EULd4Xb27+rU+ysyXNeHZIXiu6GQN5mS3+qeQrPZcEbmXwdkt2h0d7wKdnyU7hUIs/71d3bvG17sJsE8CNIVt+cgWQHNJmYufURv+ou8zibY8yFm9XRKbd4GPG0vJD15IsX+Ow61y0IfFQWfIzfAYg5+lW5p7K64SD4LqZvz3hUVnfSQbX4s8Rfbe3+Fp3YbZtrKuT7xOy5ytXAOaRBkMNc6KM0AkdCb0Q7fD+M0ubEr91O7O7hz+yT/YJkG0b63YyAcLxosX8NCuAAw3cZMZTbE4kVd7yWrLH9WjmebsiUMWEz7q67F5Bfm3YR+icavltUCde+41hm4hay/fKOruKCe7Z4J+SnzFEG3GNhZIn3p5JcsIRmxSKEb8FNT1bzjxeOaxnLS4bsYFnLduvPnodDu6Z3YP4qzXyKpZxYUCy4WdKp9kIxyFP02yLj70J3du5HvLuisi0F3wWbO0DhpVRb/l++Yj1OKrvtmY3cCSvufiIliePdCi+v1Ldx8aFSqNxcfHagz0lrdgM4m0NL5IOYjpbj+msENO9PVgRige/9XwGeHfHPoxky/cuJRq3nbQKKaWb3IjUvfOkD1GSavIljVZ8h77v0J3IVvadJf/sb4HCRtiftMl13ZLc6ZwBgwcO9gqlGOyY7u1xvFoZnxbEb9aWcgY3u31kv23Y+I2FvB1at9tEEOJfcuR6U3dEv+3ZdcqrZ9P3ON4t55/JRXKZzUojRpgZTc4alkup1GOW8NTbCQL3hjgUPj5TPxpIz7PfO3EluHbUOsw+ZxmuG70GnxtUiQF71ZqPnP/fmNXG9qvRayF1s+8ReCzwvSHutnVJDjlrip0rgAYnEGF1KOViZkGoezsRIZoOB2oxvFy5k8Vgn1FVhi31pcbVXBwO77MDPz1yA+47fSWWfnWJ+cj5xUdshNhy0Ye0UU2fp2+pyBn+wQqgpW1y3kqexPRMRnl7AEwgLB7FiM9OXYKpH+1nxlFMh8foc13aTDWkafb4MwF0ONNbIHQgAsmbftMdZ8DAEAhvD4AoWvwe2DDIDqGIjg9sONB6G+FjNvxkAtgHNvDBlinFxtmcNB7RzQwX0U29iO7tnAwieBQLPrOq+mHRNvO/hWPcC39fsm0fmIf3CD+BIomo7wAAEABJREFU7PibMuQFt1ijGd3bSW7CESc1CwK8ihufFH6/dggHUxz7PeuG8t4/8DVH+Kc43wctUkijFOFO3dtDNAh+kAyuqB3gM4m3Qe5nBW5YhSjFx3+uD25/nIM5wD9cAWIzGTtwelKamdDbCYNNhmLHZ2t9Ce5ey5mVMS3k/e41Q7EtzbdWJL34mcTd6QyMmCmaFh+7ArBRM9NTBlfzzopn1F25kyw1M6HTk9LbiUAjuDmcaC04/O5afTBkhjW+FeBBfLtrzcEGN+NeDvGNrACm6UjmeF0QcDMLMRe1XeJTVd8ZMsOaARbgQXyrrLP/Ci3X8eAKYJ+i5SUG33hy5i8WnZHiKqfosYDi/c8OD5lhNwUkY0sFs4tPd64egnzF1/ybYEciGbX9VahNAq9z1eWs0BHwkduM61ceLiEvqM91Kw/jN9ZdMitvjuPBFcAF2Uub/B0Xh7+sHYx51dn9uZJcZs+86l7429qDSHkNxYbzER/zDGAa502ulyR/B8ZBaPazd48i1Qpjv3z50ajXsOTPU1z4TXA86OBm7qnZrUiqZvlxyZHRI7dJEee83eFZnPjMq+mNP69t+59I/Jmr0etcATJ8srhm9Nzgm+L6QqpL4zAyo+uE7u0yCRQEPpB45S8+16w4Eqt2dGUvbbOvZt+/XH5Eq/AvWAHsQDMzvtcFgY6Kh/zkeOzytrsVuoJ91/BLr9bAnytAMJNwalOSc7ydkeBzjqGmKLydKBASwYFnHQSfxzcNwKMb9uW4W3efwj4f3yT9ZvAm6nQio1PhntGzsafIcnOPzxaZAhqiswCyyVO36GEmsobo3k6cCFB7x+en74zEmtrs/oYQYWryvpZ9Xcw+W5NfdgWQFHIzm8iEbr+EsEE3znm7WRlNZIlXe8Wnkt8QX7T0GDPMfB/SpNeFS0fZn2S0Ir9SMjA3wxty2wI5hkH2dkZHECHZRSRxas/4vLC5HHeuGmKGnc/D7auGYvrmMttFAucovqZCDu38HsA0SbI3Ll1fcvdjagRccLq3G1TaNX7jVxyO16uz+2NaAUqNijfY9nUrDrW2VuaX+SY4M6NZH6K6rEZR3dRwrKez3k5EInhQYzIQGDmhaA/4yL/B/cbbx2Id79FlWLn8rK/tjK+9PQZ1mjcjxMu0HcEz3/hxBZBeM18qWLJndLv8ZHRvj+PVUfBZub0bLlg8yvAzl4fvLB6ND3d0J60EV7ZsyJ/hW77xTbkHuDDT5IROhOVOp2/0Eu4tkLfDzPQhDlTbOz4zN/fDTe8Pl5Hm5HPTe8Mxq7KfxVFaJO9am1/BCkAf5KaeZLcZRz1wJtS9HRKcEI8Ois+N7w3DulT2D8UzNvfFTSuHc86wM3+DV8qthG+KnCe1NWPLM3bKo3FKsYQnciwQu5KstP4YPyM6PVRiMeVSLTEebyc6SoChFNFyfMb055uaA36IdEnLH4rX8b7/gkWjhF7WnzaMD1cAM7HRGQ3ZyCHIsp6Z6QBC5+0CDIQ8QEfG55MHDCD5e+Gjih+QtiVo7rYzrfC1hWPCB2qBtS35ZVcAct86AXgZkBxeZsiJkBf/XLwC2+vqsLPbUFSVnY/mbpcsHYG5VcGfNi8A3nEF0MHgvLTJ73HYHQ7LPqrClx+djsff+QA3LSvDb99r+l+U+O37w3D/mv0Lim98+SozXSboktFy+xNf5r3dkcLjAyxlEvxs+iu48/XFuH7FIbh3VeLv9QhIiY/UuX65fYNUSPxiAgTk5h2dBJnpEMvQUPd2g0uIB+8PYnjlEx+SSd6SxPoroP4vX3okJq3d9Z9bF9tlS4Pf9wc4mSTguEI8g/JQb6XxMQHclw4RSWfAcIuTjUpvBzoIPof06Rm8ANk9Py5adBSmf9QXye0/G8tx0aIRLN799Yji2Yr8iv0aVCnOMcw8yEaplNVFEAUoZXUxR3UpjureTgSKHL+uqRT+8pmT8dDnTsVL538Wx/bvu9v412uFr781Gku3dufg7b6guge+t3Ak0uA8G8HDWCN6W/KHnnHR0cYlctidxHX6agrsisBTVy0wBMJfHwJBjLg7vMLi8IRG7oVsv/X0MRhN0tNN9OjcCTd8/Jg9xreqrhRfWTAG8vueDXzXf/6bo7ClvhOvk1aEZ444cT2EJTxpPbtdAaS/sHPnZEZy3hfvpVaj0tsJTTvC71De9py8XwUHldm31dVbpZFxRuO/fOteOHPeifjUqydi5fa9DF+i9kg2hO21pT1YATJkN14lBulmqsacl/re3r7wO7Rvw29575j3tiGzxDvJg2T8JQneC8gv9ZP2PV0ftef7evM9gHQSfhz5g4LQ+UAPnQt0bw/IH+DRHvB5aMl7WLyp0o0ID1Kfyvf+pqCd8YPfBHMBcoMSKU8kImW0jK2Cime+t0fwANFpn/h88/GZuPWVhbjk2Tn4xfRXYTbhRTuLv/nboGAY7UweBJODtDpjnXglZWY4bycMnB3QfvHZvH0H7uYXXU8u/4CjzLzC5MCBdhR/rgDgpkHqG8kDo5rRXbmT3k4EOBM6PJKSVo9fEeETPgOEMz6dlyB6XQsMnPDav+zXrQv6dE3+/f32P24JsFkBhOxmJiP5RRaGTve8P2Zlzmc8zjtsCKaf91nMPP8sXDb6Y3nvr9D4xRUAwaBhNnIu0N0MgECH2bwdAR7Fj8/Q3j1w9YlHwW3fGTEMx+1b3m7GJ+PK8FU0c3caG1+KzzNmmY9mpp1x7IOPtwtoOgQtg1Px4/PDow+1rIgeyZiOFP+UTktwGUy+7VEMs/3VYUT3dqISwSOJUxHjc/L+/aPUx/qt2zF71br4eIt4fIbPe/A/xdFmVgAGVxCxMwBnPtEVJWcFCmpazPH6NMTqs0ZM9/Y4XgWEz0sfrqM3mf2K5+YYpSPFz/4WKEJSRgvR2x6v69bHo5XicflzL+OfC9/BtPdX47tTp+Nlzv4dLd4pSXnJeC/tSteRcNi2sw7jZ7yGC5+YiVkfrCX3tQy/Q0muAAAnHEbfSQsC73cS5d5ucfL4QDbCYPFAgic0gBtFMdgTKwAdl+Hwnl/OAhGZEaSUwwoMgfD2AAgrPD4khBDFCUpmA0sKER8mgCblM0EzSwFL6DVdlt3bVQIPJPRisJ924ADcfsYJ+OrhBwFF6H+Uj7n0nwlAyktqKsgJD9wTunlG8Paixef4geX43adPwumDB+KXJx+Di/mNr+SAI1UhxZfsszhH+JZP/1Kmcek1QXoDDp3wdi3oNAhKseDTrbQEN55+rB1DcPz6kUPD8XT0+KbIccIiQeaZJAE1osOj1XnkubdDpswixOeEgRXot1f8f3k6c+UaIBhPR48vVwCYLTMTGJUTnJCeqWBFqMvbIanh6jtOON3bBR3BzQLX1vik5Esd61J4nPDS/DCebe1fW/efMjMAY+WkQSmiu3InvZ0IFBE+T7/7AR5ZtJxO2/0qftu7YvMWmf+ZpWggIVsRjc/x0klxXyZhpydl0s4VgKNlqZvBvWx/eFxJ0n/1wWdw4r2P4MG332W0yf1g6u3o8TYrgIBgVkqCIhnTNjrj4vs3M3I+8H997QZs2ro9b+0XK3/Mvwl2pCcFuXroEKRi0/fp3Amj9y2DvPkQEjXmf1n3rrj8+BGQ14EX8XXgfw3Zr2jH29j47K95IzM8I9pe4puP8XIF2NVPfQmiAa/w7eUk9Z2f+TjmfPcL+Os5p+PFb3/eJIIlQ9z/S48dge+OPARf/djB+NHow3HrGSdh4pknMAni9QxpimT8Ms5upaW4+uSj8fJ3voDffOo489fcpFxxZI3L4olvPv03zwCKqSUzphKwwtsQUCMpQl1WhqheOPaHzj0Tpw7aF6DHElZZAS485nBqUX+t/6O4QiDcFM80PlbWx7wVUbzC4sBWNKg1vL4Q7V1LSvDHsz+B844Yhp5dOuOsoQfigqMPKxr/FQRvnfAXCT0/9uCbYOnMOgFu5Dw7Lx69b7cu9Fp2LQfz2VmfNqQWJTqexRs3S1HwsfWlrguCGFz9I8p6Y/JXPo2pX/0sfvup43E2iRW1SzIUgn7hqMNx9IB+dMWOhyeQRC8U/xyehehPiiwJyS4kKEZ99gdrJebhZ+O2Hfj7/CVmXMnxXP3sy7jn1YVwibCBD4Z3vfIWq+kG9X/7XydgeN+eOKj3Pjhr2IG4ibcW404caepJMHOGFz3Ppr1PHCirHxuJ7H+et8j4yYEZmU37Ms72en2wAmgDnQxSTgpNfnLwQNxMMl4Q/BvWpH9jn56N62e8htvnLMCNs+bhs/c9hpnvr2bsG47ro+07MGH2G/jcA0/gkNsfwEl/ejh8T55styzxDapgM7xvr0bbFVvy+tbS//DaQuk+/Pxuzpv4zzsrC87P1sKjOf2EK4CgJ5lO1OTUfJxuJEuMlPWM57I73UgWGJlj+y1nnIDbPnMyPssZ+FK+vfk2H2DZldldf+trtuGvbyyGBP7e197G5u21MbupxxIjm+GfkIiXxfZKJpArcO2J7N6pFOcePgTHR/6qspQLnkbyIiOb0b+rb+Rurp+65D1c9dzLeJqk/8bDz+I2TgSsbmb+1uh/T/4Vsj0FvsANM4ZvPSDeBkGSp2+0of17xxyGTwf33RJQ+citiARVzvPt37hnZuOmWa/j/cpq6Q4rq6rxu7kL5OHI6NH+7z3nNPzvqWMgcjbfRp13xFCiyRUoB/j1794NP+Qr2zvP+ji+LatgI/F5cOG7+PETM/Dyh7wdbMQuDlt/eebtBIFhZITsCsAgWVKR/YyZkN7qrEewlJJyY5Cr0Fr2s4cPQnJbvIEPsaE/tObZvz/x9uKMvz2KQ267H5/666NYurESyfEfxrdIR1b0hdt6d+2CX5wyyryVERyVajl+PyLxn//WOfjJsUfgE4MG4go+g4weWME4SDzYY57Hn63/hX59ihDSxwyYorPACCaIkW6FyJS7+sbMYqcnZXb2x7m02xbs8d2PqnCd/KViBt2UhN2FJ6aYDgUyEGH9ZL3c2Ot12jaUOPZK/LlB55fcyr18wRcx94Iv4a6zT8Ep7iE24eehfXvjRyR+olkcY974sDQcTnjCQu5hOzzn3lbxawp/6B5haTv/zfcA4gS9MCIpdw2edTqf9nvnvY2nlq009/QT+eD6mb8/huod9v7e+ZnP/gWQprQvq9JvZs6T6rHPrPfX0E2LE0+M7eDePSC3dj2ZHPt06WRmdUmCE93f6AnJq7Gtrs5ckzxUCgZBvab4Z64P6js/nOzo1/ObYMKzC3AEJC7eseWWtWN6Pu3yVwt+8vh0HHfPv3DX3Ddj/To/8tl/c8b/R94qnfiHB/GrF+bitpfm49t8GH199Xok/evTLf7bfDMOHo6RL+gScVjBFW+2+e0+K3DfXlePCS++jgf4ipeqwSPZvit30tuJRAJXiStLDX7hCpCZCYyJdezM5cqdTC5rrtzJjmzfyO8U7ntjCX7HtzCz+BpWkHS4OLlgzQauaDvEFPs8w8wgPC4AAA4BSURBVDc4psDCHuJ/4ZTn8Uu+4bmED7hH3fEP3DP3LVstCKpr18mOjL8FxhxD/BwuTibxSSnFOYJgKpmrKEXwaiilTIYoFUhYKSIX9uH7bMU3D1iF6z/2Dp76+GK8dvYm/OH4Kpw1YD06oR5K2f6UCiSsFJGL/pWy7SkVSGm4Fca/rb4ep/zhIYx/fg4mv/2uucU7/99PYeG6jwze4kZ0fDv4jfakBUvxxJL3G7Ur1br+J/1Tqrj7D1YAxcTg1MPBuEwxMtRza//hQR9g1imvYOKIJbiI52N6rsYQtQBf7Pca/j76LTx50usY2HUbkKf+wS2f42Pz5HAUzzh+O5gEchsjX+D9eOo0vPLh+lbFf0/+dSR7ivlrwBfJqEGkmwhDnTWkPNQlthYlW7+J9l6ltbhv9Jtm1u+UYiPSRiOfY3pvwcxTXsUnyzY2q/1s/fPXa4u3hpEhHk2Mb1i/iK43K4CQ28yIkFVWgxMvx6KpBTrPcmG/5tDlvMXZyNb2vPfuXIe/jFqIQXttRWv5J17JOPM1ft9+wCcGVHAO8eBJTG9Fu10BOOWzT0P6fMnTyzfhW4NWc6hN37uX1uOukYuJWjpMgnz559slzK3Ag0LDObICIEGy3OqXDl2J5LaksjN+MbcC//3UAfjetIH4+9Je4DNfrNpxfatwUr9KJify6h9j79tHNAnQIfDgN8F8QGP0bWaCW6CzgMUZnWcxvRn2TqoOo/tUsYXMvnZrKT4xZQhumV+G/6zsgfuX9caF0/fD+FcrMpWCs5P6bg6CIQW590+WXw7HJBnYk9FZEBsvhBw8eDtx0rC3iRE8eBrDq0jwYwJwMCCp3IOOkdQ5Go5BhkUrdVNO1UjqzbAf26caXVJaLg4/9y3rharaklB3J39c1KfBKmBWANOv1NLWn2b0r3iFLqTrxR/vP1GIxLON4sMEkJlNiycms+VEyGIkg9SopLONlrv6CbvM4FI/+nljY+PfiEpSfFDTKVoVR/S0v8aUmVkMufYvbHcX/nt7fvnRlvgGvwYlrRh8WdaYBVS4R3RX7iStkjVwelIm7XM/2scURQ/Dega/6YkW8lwefPfrvpNnmX3plr1i/RlLDv3bk//eTsQjeFOLxaOY8YmsAPa2xg0OyOg2QzO6TZKMvif7/M0kMOLbl4ZsRudUOl5I7csHV6LEeEUl2OdXyvWZ/prb/57883aZ4TsmvlwBQKrDZDSPlOZIKaDwnEJRWNLxhDqPzbKv39EF63bEb2tkBXj27OU4trwGMusfsE8tLhuxDjcd2/BV6YLKvWP9Nbf/bP331xNxrgA8Mg7mSBkQgaKY8TFzrRtbcOvOwcUHmQv7hMX7BY1mxMh+2yBJsPYbb2PhuUtw7ah16FpKRDNVsHJrF/x7ZZktcaZQ2pNc+Gc6sM3lZfy+fSKgAR4LCl/zPYBxyrE/xqbIspil/c5l++KJ1b1tV008bq1L4X9mD0fVzlJeEbAzT/6FUfHtE2vZBe/cxb9Q8TXfBGdubzhoWc8cCShFzZX9+3OHYvGWboJukz6XvT4E8zfzAZp+mAtEikMipYBS1Fz5Z9qRBtmuNC+6qCKdbu4Xvd3AIbgUOz58O0/Sczj2QdCcQILs9OQrRxl0S+2VOzthzFMj8cVZh2H1tvgzASLbA++VYb8pY3D/e+Vcd1rPP+OCkJtRzcf4fftEoMDw5QrAaJNmcrTLFM/oJI/iLbkuZ5qSKutBzrK0P72mFz72xCic9vwRuGr+IEz5sA/uXtYf33x5GIZOHY0LXxmKLcFtj5L+2K+CbJoHnmXZvyQxW2Fbmq3LmUiq7Acs8fYMHkrwIC4KsmkeeNaO8A+fATgmM7hw5pOxcvD50nemFV7d1AO3LdkXX3vpEPzs9YPw8AdlWBusDK3tj++P4c9jvAsVX64AnPdJdua1OREppBfpZkJxPq5rQkXAaJByioTemD1a39sFN4+v5UFb8kdWgEoJhpCeFGVMxKnM07+Ue7vMDVrg8fiQrYrTnfBCABGpeCKSotjwqeQKoNaI824QDSQLvF0z5DYJCEcQ5EBngcenWPFJr+FboPQaxpCPOcEgeBbT07sod/W83SaHwyMpPT4Fi08Kak1KaQQrAG97GLzYMiY6s8HOcN4efSWsGFajq2AlcDoBjOHl7cGKWYD80XpNKg29Rn7NZ4Mm0QOUorPmXg+MLqhTxHRvj+O1B3zCJAArgnh6/AoBP0ZCVoAUVwCYjRwPpA6kEczgpPR2QSSDl2jktoWFeNkTb0/i4vTCwIeBWpHiYQ0nKBM9J42bjJ7Tk9LbiYDHB0leOJ3oxPjkyp0sFDtSvAVSPMhyJE45yaQQlcJlalzS4O1EwOGVlB6fOF8KFZ+0Tq9J1dWm5gN8FOaMBrNZ510QmcphphuzPBjLSaR+LLO9XdAhbAGOxMPjQ0gifKFWAPhAdy4teS219aYfr4JOzwEffGGcZLhERnSTwRHd1Ivo3k6yR/Dw+GTwAOwDPwoNH+g5m8b/pCoF2RQeiQcNNkPptCE3VW+PBpWABJOEx4e4EI7i4wceATebAOkSo5hBsDDcGWSuB6Hq7UGwHSIeHxQvPyznTQJsueHHizjlLzZxZVBFupktKV0SJMud7u02SRweSenxKQh8FlvOAyYBDOHTeNIFR6QyhdpmOJPC6VLs7Q1x8fiQGeQJj5xLCxwfpO0dD50NE4BfCDxJndzWIiiNoPS6IJGJrcej2PHQaWW4LuMIE6Cqa9VzZHul4pwvyzaff5nJoGaf4puvw1/PXPF4Fhh/lKqq7lr5Itlp9jABMH68/Km2u+QHXi5oUsPrOpwEPB4ypxU3Hpzk7wy4LuHMPAOIVqprb1BApSW9G6yXHg8hffHzgCOo6tS19HrhuvtkVgCWfHTjuEro9K+ZBDC3QSzzMgg+HwI8LqRQEePAL+Vv2MQvv0jrcI8lgJRu6VY9kaRfo7jwU0pRLBmkQMq93d7bZvCw5Mjo3i48yeDR5vis29KtaqL4E/00SADeH22HUteK80pqakAkE99IZpGR3q4NDhk8LE5Ghw224JbRkajvr29dfPQ1htuIbw0TgPbqd/b7Pd/6vCskp8oVQI42qHKmtRy97vGxRCh0PnASWlG9/IDfW9bGj40mAP51br1G+iolcxZHp8w1mhrPqBuVrSqWSHYoU+DtKsDDwOHxIRpKZklKQaTt+KGVulI4LV4kP40nAGtV3/izf5Dr94v34UzHoIoupGcVahqieztxAGNNRAQPj08cjzblB9T91Tde+g+Gp9F9lwkgtau7b7mAwVzE2yFG1w6KOqJBFt3b4fHhbEkULA6c+IUXTm8zfmgsMhw2jjR+2G0C8KFhq0qrzzODK83l0UFKQaDTLpodvJwF5Q4Eb49MHu0cHxmei7uTbRT/SpXG54XDxqddHHafALxoy82XL0ppnMfVPU2VJDfHUDqu024NQayd7u0WFodHUnp88oJPOk3OCneD1ncp9pgAcmXVb382lfJXmeAFLKeQ1c5lurcTJdkdqz0+aAt+8BuYq7Zazko0dvtpUgJIC9V71/wvBzPVkp1dBEG2y1tG93aynmG3uHChNDh5fBwe+eYH315O3fKbK34tnG3Kp8kJwHupdGlJ/XmAWiSDcA82oQQ3CTazxNs1QlwcHoRHcIHTk9LbZbZAlvgs6lyiyVE0eWt6ArBJ+a1Q59oux9LJZ0xGM4hG0qbl/ieqB8ng7ZroMLYeH5A3nAMCPHLODzzTubbrscJRNGNrVgJIu5tu+0lV9XuDzmQ8b+RoZEw81VAw7Lc6B6fkzEgb/JhuyhUNch0FW1DR+t5ONBSB8fgQBbJDcOCZ4YXAktCBm2reH3SmcFM42pxPsxPANM5vimsmjB2ngfPpUy1dYy5Qo5E6ZPkPZ34We7sNGuEhTvD4kBA54kct6XV+zc1XjN3VN73Yw9ayBAgarbl57H0p6FNJ+lUckw0ubdThdSE9PA7IDw5sdpXS+lThIM9bvGeVANLrlgnjXtSlGM1ngHmW9DoIupceDyF/Pnig5wnnhHvCwWw+WSeAdL71prGranpsP443axeR/as0l4D4bVAGBKnv7cSD2SE4hHjwJKZ7O+8oNFGJJdFq8upH1eSacM4YszzkJAGMD+PH11bfMvaOGt35YCbBZTqt1zOGNGmqHASzI6ZLktAqFinnCmLqhXox2TkO77+Nc57it4H4Xl6DzkOqJ4z7HV/Jy79fJ+rZ77lLAOfLLZduq5kwbsJetTsOSgPyk+rNdmZzXwZRMhlAujcoJ+lNubcDHh+uANisNK7utmP74JpbrrwZ5BZyvOU+AQIH198xvnrrLeOuL9XbB0OpX3M0G5TiXG9IzkqUSlldBO2sZnVaOZFwRhGDqccSI71dcCIa7RofBbUB6fSvO6HL4OqJV14nXDJjzsMhbwngfN08cfzmmlvGXVnTa0dFvVLHs/wGTvBvUTKWWgSlEZRWp90U2BXCxDqme7uBI8SLc4MpcHgVKT5vaZI+DX1Cdc/tFTW3/vzKzRMv2WwGlsdD3hMg9H38+PS2CWNfqpl45c/5+Vh9Sf0gUvsyfqaxTj2jScE9E00q3KkrCm/XggLhaiiLER8m607G9FnO9BcLF4QTQvptE38+m/f4vHu2w833sfUSIDGS7Tdf/V7NxJ9P4OcTNVv7dOPqMISBPBUKX2eIr+b53ZzJnuBlbxKsKspGgy/ltIvwdk4WBoiEzCc+0l9j7TN+VST4m4B6gvJurdTVSOuvK6VOLa2vO3jrtr7dSfhP1vy/q24VLqCNtv8PAAD//0qfj7QAAAAGSURBVAMAkP6UXi2G5/0AAAAASUVORK5CYII=';
function backupObj(){return{v:1,fav:{l:FAV.l,k:[...FAV.k],o:FAV.o},picks,plan,todo:{lists:TS.lists,tasks:TS.tasks},cab:myCab(),fx:{usd:FX.usd,dop:FX.dop},din:DIN}}
function applyBackup(o){
  if(!o||o.v!==1)throw new Error('format');
  if(o.fav){FAV.l=o.fav.l||FAV.l;FAV.k=new Set(o.fav.k||[]);FAV.o=o.fav.o||[];favSave();favPush()}
  picks=o.picks||{};plan=o.plan||{};if(o.cab)setCab(o.cab);if(o.fx){FX.usd=+o.fx.usd||FX.usd;FX.dop=+o.fx.dop||FX.dop;fxSave(true)}if(o.din){DIN={...DIN,...o.din};dinSave(true)}
  persistPicks();savePlan();
  if(TS.mode==='local'&&o.todo){TS.lists=o.todo.lists||[];TS.tasks=o.todo.tasks||[];tdStore()}
  else if(o.todo){(o.todo.lists||[]).forEach(l=>{if(!TS.lists.some(x=>x.id===l.id))TS.lists.push(l);putDoc('lists',l)});(o.todo.tasks||[]).forEach(t=>{if(!TS.tasks.some(x=>x.id===t.id))TS.tasks.push(t);putDoc('tasks',t)})}
  if(o.quiz&&(+o.quiz.n||0)>QZ.n){QZ.pts=+o.quiz.pts||0;QZ.n=+o.quiz.n||0;QZ.ok=+o.quiz.ok||0;QZ.best=Math.max(QZ.best,+o.quiz.best||0);qzSave(true)}
  renderTotals();renderDays();renderPanel();tdChanged();
}
/* Automatische Sicherungen: täglich, die letzten 10 bleiben. Firebase (Sammlung "backups") oder – falls nicht erlaubt/abgemeldet – auf dem Gerät. */
const BK={local:false,busy:false};
const bkDay=()=>new Date().toLocaleDateString('sv-SE');
let bkDbP=null;const bkDb=()=>bkDbP||(bkDbP=new Promise(res=>{try{const r=indexedDB.open('rp-bk-'+TRIP_ID,1);r.onupgradeneeded=()=>r.result.createObjectStore('b');r.onsuccess=()=>res(r.result);r.onerror=()=>res(null)}catch(e){res(null)}}));
async function bkLocal(op,key,val){const db=await bkDb();if(!db)return null;return new Promise(res=>{try{const t=db.transaction('b',op==='get'||op==='all'?'readonly':'readwrite'),st=t.objectStore('b');
  if(op==='all'){const o=[];const r=st.openCursor();r.onsuccess=()=>{const c=r.result;if(c){o.push({id:c.key,...c.value});c.continue()}else res(o)};r.onerror=()=>res(o);return}
  const r=op==='put'?st.put(val,key):op==='del'?st.delete(key):st.get(key);r.onsuccess=()=>res(r.result);r.onerror=()=>res(null)}catch(e){res(null)}})}
const bkRemote=()=>FBX.db&&TS.mode==='db'&&!BK.local;
async function bkList(){
  if(bkRemote()){try{const q=await FBX.db.collection('backups').get();return q.docs.map(d=>({id:d.id,...d.data(),where:'Firebase'})).sort((a,b)=>b.ts-a.ts)}catch(e){if(e&&e.code==='permission-denied')BK.local=true;else return []}}
  return ((await bkLocal('all'))||[]).map(x=>({...x,where:'Gerät'})).sort((a,b)=>b.ts-a.ts)}
async function bkWrite(reason){
  const data=JSON.stringify(backupObj()),doc={ts:Date.now(),by:(FBX.user&&FBX.user.email)||'dieses Gerät',reason:reason||'auto',size:data.length,data};
  const id=reason==='auto'?bkDay():'m'+Date.now();
  if(bkRemote()){try{await FBX.db.collection('backups').doc(id).set(doc)}catch(e){if(e&&e.code==='permission-denied'){BK.local=true;await bkLocal('put',id,doc)}else throw e}}else await bkLocal('put',id,doc);
  const L=await bkList();for(const x of L.slice(10)){if(x.where==='Firebase')FBX.db.collection('backups').doc(x.id).delete().catch(()=>{});else bkLocal('del',x.id)}
  try{localStorage.setItem('rp-'+TRIP_ID+'-bk-last',bkDay())}catch(e){}
}
async function bkAuto(){if(BK.busy||window.__SEED)return;if(FBX.on&&FBX.user&&TS.mode==='db'&&!TS.ready)return;
  let last='';try{last=localStorage.getItem('rp-'+TRIP_ID+'-bk-last')||''}catch(e){}if(last===bkDay())return;
  if(!TS.lists.length&&!TS.tasks.length&&!Object.keys(plan).length&&!Object.keys(picks).length)return;
  BK.busy=true;try{await bkWrite('auto')}catch(e){}finally{BK.busy=false}}
setTimeout(bkAuto,9000);
async function restoreAll(o){
  if(!o||o.v!==1)throw new Error('format');const cur=backupObj();
  if(o.fav){FAV.l=o.fav.l||FAV.l;FAV.k=new Set(o.fav.k||[]);favSave();favPush()}
  picks=o.picks||{};plan=o.plan||{};persistPicks();savePlan();setCab(o.cab||null);if(o.fx){FX.usd=+o.fx.usd||FX.usd;FX.dop=+o.fx.dop||FX.dop;fxSave(true)}
  const NL=(o.todo&&o.todo.lists)||[],NT=(o.todo&&o.todo.tasks)||[];
  if(TS.mode==='db'){TS.tasks.filter(t=>!NT.some(x=>x.id===t.id)).forEach(t=>delDoc('tasks',t.id));TS.lists.filter(l=>!NL.some(x=>x.id===l.id)).forEach(l=>delDoc('lists',l.id));
    TS.lists=NL.slice();TS.tasks=NT.slice();NL.forEach(l=>putDoc('lists',l));NT.forEach(t=>putDoc('tasks',t))}
  else{TS.lists=NL.slice();TS.tasks=NT.slice();tdStore()}
  renderTotals();renderDays();renderPanel();tdChanged();return cur}
function bkWhen(ts){const d=new Date(ts);return d.toLocaleDateString('de-DE',{weekday:'short',day:'numeric',month:'numeric'}).replace('.,','.')+' '+d.toLocaleTimeString('de-DE',{hour:'2-digit',minute:'2-digit'})}
async function bkRender(box){if(!box)return;box.innerHTML='<p class="src">Lade Sicherungen …</p>';const L=await bkList();
  box.innerHTML=`<p class="src" style="margin:2px 0 6px">Einmal täglich automatisch, die letzten 10 bleiben erhalten. ${bkRemote()?'Gespeichert in Firebase, für beide sichtbar.':BK.local&&FBX.user?'Gespeichert nur auf diesem Gerät (Firebase-Regel für „backups“ fehlt).':'Gespeichert auf diesem Gerät.'}</p>
  ${L.length?L.map(x=>{let n='';try{const o=JSON.parse(x.data);n=`${(o.todo&&o.todo.tasks||[]).length} Aufgaben · ${Object.values(o.plan||{}).reduce((a,l)=>a+(l||[]).length,0)} Einträge`}catch(e){}
    return `<div class="bkrow"><div><b>${esc(bkWhen(x.ts))}</b>${x.reason==='auto'?'':' <span class="tag">manuell</span>'}<small>${esc(n)} · ${esc(String(x.by).split('@')[0])}</small></div><button class="chip" data-bkr="${esc(x.id)}">Wiederherstellen</button></div>`}).join(''):'<p class="src">Noch keine Sicherung vorhanden.</p>'}
  <button class="chip" id="bknow" style="margin-top:6px">Jetzt sichern</button>`;
  box.querySelector('#bknow').onclick=async()=>{box.querySelector('#bknow').disabled=true;try{await bkWrite('manual');undoToast('Sicherung erstellt.',null,2500)}catch(e){undoToast('Sicherung fehlgeschlagen.',null,3000)}bkRender(box)};
  box.querySelectorAll('[data-bkr]').forEach(b=>b.onclick=async()=>{const x=L.find(z=>z.id===b.dataset.bkr);if(!x)return;
    if(b.dataset.s!=='1'){b.dataset.s='1';b.textContent='Wirklich? Ersetzt den aktuellen Stand';return}
    try{const cur=await restoreAll(JSON.parse(x.data));closeDlg();undoToast('Stand vom '+bkWhen(x.ts)+' wiederhergestellt.',()=>restoreAll(cur),10000)}catch(e){b.textContent='Fehler beim Wiederherstellen'}})}
/* Alles für die Reise offline speichern */
function tileRange(lat,lon,z,km){const n=2**z,X=lo=>Math.floor((lo+180)/360*n),Y=la=>{const r=la*Math.PI/180;return Math.floor((1-Math.log(Math.tan(r)+1/Math.cos(r))/Math.PI)/2*n)};
  const dLa=km/111,dLo=km/(111*Math.cos(lat*Math.PI/180)),o=[];for(let x=X(lon-dLo);x<=X(lon+dLo);x++)for(let y=Y(lat+dLa);y<=Y(lat-dLa);y++)o.push([z,x,y]);return o}
function readyTiles(){const T=new Map(),add=a=>a.forEach(t=>T.set(t.join('/'),t));
  for(let z=5;z<=8;z++){const n=2**z,X=lo=>Math.floor((lo+180)/360*n),Y=la=>{const r=la*Math.PI/180;return Math.floor((1-Math.log(Math.tan(r)+1/Math.cos(r))/Math.PI)/2*n)};for(let x=X(-72.5);x<=X(-58.5);x++)for(let y=Y(21.8);y<=Y(12.5);y++)T.set(z+'/'+x+'/'+y,[z,x,y])}
  osmPorts.forEach(p=>{add(tileRange(p.lat,p.lon,11,6));add(tileRange(p.lat,p.lon,12,4));add(tileRange(p.lat,p.lon,13,3));add(tileRange(p.lat,p.lon,14,2.5));add(tileRange(p.lat,p.lon,15,2));add(tileRange(p.lat,p.lon,16,1))});
  return [...T.values()]}
const RD={run:false,msg:'',pc:0};
function readyState(){try{return JSON.parse(localStorage.getItem('rp-'+TRIP_ID+'-ready')||'null')}catch(e){return null}}
function readyHTML(){const st=readyState(),sw=!!(navigator.serviceWorker&&navigator.serviceWorker.controller),nO=osmPorts.filter(p=>OSM.data.has(p.k)).length;
  const it=(ok,t)=>`<li class="${ok?'ok':''}">${ok?'✓':'○'} ${t}</li>`;
  return `<ul class="rdy">${it(sw,'App selbst'+(sw?'':' (App einmal schließen und neu öffnen)'))}${it(nO===osmPorts.length,`Orte aller Häfen (${nO} von ${osmPorts.length})`)}${it(st&&st.tiles,`Kartenkacheln der Häfen${st&&st.tiles?' ('+st.tiles+')':''}`)}${it(wxDays().length?wxDays().every(p=>WX.d[p.day]):false,wxDays().length?'Wetter der nächsten Tage':'Wetter (gibt es erst ab 16 Tage vorher)')}${it(true,'Deckplan, Getränkekarte, Ausflüge (in der App enthalten)')}${it(STORE.p===true,'Speicher geschützt')}</ul>
  ${RD.run?`<p class="src" style="margin:4px 0">${esc(RD.msg)}</p><div class="tdbar" style="margin:4px 0 10px"><i style="width:${RD.pc}%"></i></div><p class="src">App bitte geöffnet lassen, der Bildschirm bleibt an.</p>`
   :`<button class="chip btn" id="rdgo" style="padding:8px 14px">${st&&st.ok?'Erneut aktualisieren':'Alles offline speichern'}</button>${st&&st.ok?`<p class="src" style="margin:6px 0 0;color:var(--ok);font-weight:600">✓ Bereit für die Reise · Stand ${new Date(st.ts).toLocaleDateString('de-DE')}</p>`:''}`}`}
async function readyRun(upd){if(RD.run)return;if(navigator.onLine===false){RD.msg='Kein Internet.';upd();return}
  RD.run=true;RD.pc=0;let wl=null;try{if(navigator.wakeLock)wl=await navigator.wakeLock.request('screen')}catch(e){}
  try{
    RD.msg='Orte der Häfen werden geladen …';upd();
    const todo=osmPorts.filter(p=>!OSM.data.has(p.k));let k=0;const W=async()=>{while(todo.length){const pt=todo.shift();await osmEnsure(pt);k++;RD.pc=Math.round(k/osmPorts.length*30);RD.msg=`Orte: ${pt.name} (${k} von ${osmPorts.length}) …`;upd()}};await Promise.all([W(),W()]);
    RD.msg='Wetter wird aktualisiert …';RD.pc=32;upd();await wxLoad(true);
    const T=readyTiles(),sw=!!(navigator.serviceWorker&&navigator.serviceWorker.controller);let n=0,ok=0;
    if(sw){const q=T.slice();const W2=async()=>{while(q.length){const [z,x,y]=q.shift();try{const r=await fetch(TP[0].u(z,x,y),{mode:'cors',credentials:'omit'});if(r.ok)ok++}catch(e){}n++;if(n%10===0||!q.length){RD.pc=32+Math.round(n/T.length*63);RD.msg=`Kartenkacheln: ${n} von ${T.length} …`;upd()}}};await Promise.all([W2(),W2(),W2(),W2()])}
    RD.msg='Sicherung …';RD.pc=97;upd();try{await bkWrite('manual')}catch(e){}
    await storeCheck(true);
    const allO=osmPorts.every(p=>OSM.data.has(p.k));
    try{localStorage.setItem('rp-'+TRIP_ID+'-ready',JSON.stringify({ts:Date.now(),tiles:ok,ok:allO&&sw&&ok>T.length*.9}))}catch(e){}
  }finally{RD.run=false;try{wl&&wl.release()}catch(e){}upd()}}
async function buildOffline(){
  if(!SRC0||!SRC0.main)throw new Error('Quelltext nicht verfügbar');
  const seed={id:String(Date.now()),when:new Date().toLocaleDateString('de-DE'),d:backupObj()};
  const J=JSON.stringify(seed).replace(/</g,'\\u003c');
  const TJ=JSON.stringify(window.__T).replace(/</g,'\\u003c');
  const pre=`window.__T=${TJ};window.__SEED=${J};(function(){var S=window.__SEED;try{localStorage.setItem('__t','1');localStorage.removeItem('__t')}catch(e){var m={};try{Object.defineProperty(window,'localStorage',{value:{getItem:function(k){return k in m?m[k]:null},setItem:function(k,v){m[k]=String(v)},removeItem:function(k){delete m[k]}}})}catch(e2){}}try{var cur=localStorage.getItem('rp-seed-id');if(cur!==S.id){var has=localStorage.getItem('rp-'+TRIP_ID+'-plan-v1')||localStorage.getItem('rp-'+TRIP_ID+'-picks-v1')||localStorage.getItem('rp-'+TRIP_ID+'-todo-v1');var ok=!has||confirm('Neue Offline-Datei vom '+S.when+'. OK = Stand dieser Datei übernehmen. Abbrechen = bisherige Daten auf dem Handy behalten.');if(ok){localStorage.setItem('rp-'+TRIP_ID+'-picks-v1',JSON.stringify(S.d.picks||{}));localStorage.setItem('rp-'+TRIP_ID+'-fav-v1',JSON.stringify(S.d.fav||{}));localStorage.setItem('rp-'+TRIP_ID+'-plan-v1',JSON.stringify(S.d.plan||{}));localStorage.setItem('rp-'+TRIP_ID+'-todo-v1',JSON.stringify(S.d.todo||{lists:[],tasks:[]}));if(S.d.cab)localStorage.setItem('rp-'+TRIP_ID+'-cabin',String(S.d.cab));if(S.d.fx)localStorage.setItem('rp-'+TRIP_ID+'-fx',JSON.stringify(S.d.fx));if(S.d.din)localStorage.setItem('rp-'+TRIP_ID+'-dinner',JSON.stringify(S.d.din))}localStorage.setItem('rp-seed-id',S.id)}}catch(e){}})();`;
  return '<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>'+esc(TRIP.title||'Reiseplaner')+' (offline)</title><link rel="icon" type="image/png" href="'+ICON_URI+'"><link rel="apple-touch-icon" href="'+ICON_URI+'"><style>'+SRC0.css+'</style></head><body>'+SRC0.body+'<script>'+pre+'<\/script><script>'+SRC0.main+'<\/script></body></html>';
}
function applyTheme(){const r=document.documentElement,was=r.hasAttribute('data-nye');applySeasonAttrs();if(was!==r.hasAttribute('data-nye')){if(tripView||todoView)renderPanel();else select(sel,true)}}
const devOn=()=>{try{return localStorage.getItem('rp-dev')==='1'}catch(e){return false}};
const devSet=v=>{try{v?localStorage.setItem('rp-dev','1'):localStorage.removeItem('rp-dev')}catch(e){}if(!v){prevKey=null;if(SIM_OFF)simStop();applyTheme()}};
function offlineDlg(open){
  const online=!OFFLINE;
  openSheet(`<div class="hd"><h3 id="dt" style="margin:0">Einstellungen</h3><button class="x" data-close aria-label="Schließen">✕</button></div>
  <details class="kul setg" id="tripset" ${open==='trip'?'open':''}><summary><span class="sgt"><b>🧳 Reisen</b><small>${esc(TRIP.title||TRIP_ID)} · ${esc(fmtD(TRIP.start))}–${esc(fmtD(TRIP.end))}</small></span></summary><div class="sgb">
  <div id="triplist"><p class="src">Reisen werden geladen …</p></div>
  ${window.__createTrip?`<p style="margin:12px 0 4px"><button class="chip btn" id="wizgo">+ Neue Reise anlegen</button></p><p class="src" style="margin:0 0 4px">Mit dem Assistenten: Grunddaten → Stationen → fertig.</p>`:''}
  ${window.__importTrip?`<b style="font-size:13px;display:block;margin-top:10px">Oder Import-Datei</b><p class="src" style="margin:2px 0 6px">Import-Datei (….trip.json) wählen. Die Reise ist danach für alle Mitreisenden da und wird auf diesem Gerät geöffnet.</p><input type="file" id="tripimp" accept=".json,application/json" style="margin:0 0 4px;max-width:100%"><p class="src" id="tripmsg" style="margin:0"></p>`:''}</div></details>
  <details class="kul setg" id="dinset" ${open==='din'?'open':''}><summary><span class="sgt"><b>🍽 Abendessen &amp; Kabine</b><small>${esc([DIN.at?DIN.at+' Uhr'+(dinVenue()?' · '+dinName():''):'Tischzeit fehlt',myCab()?'Kabine '+myCab():'Kabine fehlt'].join(' · '))}</small></span></summary><div class="sgb">
  <p class="src" style="margin:2px 0 6px">Feste Tischzeit und Restaurant. Erscheint dann jeden Abend im Tagesplan, für euch beide. Auslassen oder andere Uhrzeit pro Tag durch Antippen des Eintrags.</p>
  <div class="dinf"><label>Uhrzeit<input type="time" id="dnat" value="${esc(DIN.at||'')}"></label><label>Dauer<select id="dns">${[60,75,90,105,120].map(m=>`<option value="${m}" ${+DIN.s===m?'selected':''}>${m} Min</option>`).join('')}</select></label></div>
  <div class="dinf"><label style="flex:2">Restaurant<select id="dnr"><option value="">noch unbekannt</option>${SHIP.dk.flatMap(([n,nm,V])=>V.map((v,i)=>v[2]==='food'?`<option value="${n}|${i}" ${DIN.dk===n&&DIN.dv===i?'selected':''}>${esc(v[0])} · Deck ${n}</option>`:'')).join('')}</select></label><label>Tisch<input id="dnt" maxlength="10" value="${esc(DIN.table||'')}" placeholder="optional"></label></div>
  <div class="dinf" style="margin-bottom:2px"><label>Unsere Kabine<input id="cabin" inputmode="numeric" maxlength="4" value="${myCab()||''}" placeholder="z. B. 8346"></label><label style="flex:2"></label></div><p id="cabmsg" class="src" style="margin:0 0 8px">${myCab()&&cabInfo(myCab())?esc(cabInfo(myCab()).txt):''}</p>
  ${DIN.at?`<p class="src" style="margin:4px 0 0">${(DIN.skip||[]).length?`An ${(DIN.skip||[]).length} Tag(en) ausgelassen. `:''}<button class="lnk" id="dnoff">Abendessen-Einträge ausblenden</button></p>`:''}</div></div></details>
  ${online?`<details class="kul setg" ${open==='off'?'open':''}><summary><span class="sgt"><b>📥 Offline für die Reise</b><small>${(()=>{const st=readyState();return st&&st.ok?'✓ bereit · Stand '+new Date(st.ts).toLocaleDateString('de-DE'):'noch nicht offline gespeichert'})()}</small></span></summary><div class="sgb">
  ${online?`<p class="src" style="margin:0 0 6px">Speichert App, Orte aller Häfen, Kartenkacheln rund um die Häfen und das Wetter auf diesem Gerät. Einmal im WLAN ausführen, dauert einige Minuten.</p><div id="rdbox" style="margin-bottom:16px"></div>`:''}
  <b style="font-size:13px;display:block;margin-top:4px">Offline-Datei</b>
  ${online?`<p style="margin:0 0 8px;color:var(--muted)">Erzeugt eine Datei mit der ganzen Seite und deinem aktuellen Stand (Auswahl, eigene Einträge, Listen). Sie funktioniert ohne Internet.</p><button class="chip btn" id="offsave" style="padding:8px 14px">Offline-Version speichern</button><p id="offmsg" class="src" style="margin:6px 0 14px"></p>`:`<p style="margin:0 0 12px;color:var(--muted)">Offline-Version vom ${esc(window.__SEED.when)}. Änderungen werden nur auf diesem Handy gespeichert.</p>`}</div></details>`:`<div class="sgb"><b style="font-size:13px;display:block;margin-top:4px">Offline-Datei</b>${online?`<p style="margin:0 0 8px;color:var(--muted)">Erzeugt eine Datei mit der ganzen Seite und deinem aktuellen Stand (Auswahl, eigene Einträge, Listen). Sie funktioniert ohne Internet.</p><button class="chip btn" id="offsave" style="padding:8px 14px">Offline-Version speichern</button><p id="offmsg" class="src" style="margin:6px 0 14px"></p>`:`<p style="margin:0 0 12px;color:var(--muted)">Offline-Version vom ${esc(window.__SEED.when)}. Änderungen werden nur auf diesem Handy gespeichert.</p>`}</div>`}
  ${FBX.on?`<details class="kul setg"><summary><span class="sgt"><b>👤 Konto</b><small>${FBX.user?esc(FBX.user.email||'angemeldet'):'nicht angemeldet'}</small></span></summary><div class="sgb">${kontoHTML().replace('<b style="font-size:13px">Konto</b>','')}${memMe()?`<b style="font-size:13px">So heißt du in der App</b><div class="dinf" style="margin-top:4px"><label style="flex:3">Name<input id="memn" maxlength="20" value="${esc(memMe().n)}"></label><label>Buchstabe<input id="meml" maxlength="2" value="${esc(memMe().l)}"></label></div><p class="src" id="memmsg" style="margin:0">Mitreisende: ${esc(PNAMES)}</p>`:''}</div></details>`:''}
  <details class="kul setg"><summary><span class="sgt"><b>💾 Sicherung</b><small>täglich automatisch · als Text kopieren</small></span></summary><div class="sgb">


  <b style="font-size:13px">Automatische Sicherungen</b>
  <div id="bklist" style="margin-bottom:14px"></div>
  <b style="font-size:13px">Sicherung als Text</b>
  <p class="src" style="margin:2px 0 8px">Kopiert den Stand als Text. Zum Beispiel in eine Notiz oder Nachricht, und später wieder einfügen.</p>
  <div style="display:flex;gap:8px;flex-wrap:wrap"><button class="chip" id="bcopy" style="padding:7px 12px">Sicherung kopieren</button></div>
  <textarea id="bpaste" rows="3" placeholder="Sicherung hier einfügen" style="width:100%;margin-top:10px;font:inherit;padding:8px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--ink)"></textarea>
  <div style="display:flex;gap:8px;margin-top:6px;align-items:center"><button class="chip" id="bload" style="padding:7px 12px">Sicherung einspielen</button><span id="bmsg" class="src"></span></div></div></details>
  ${devOn()?`<details class="kul setg" id="devset"><summary><span class="sgt"><b>🧪 Für Tests</b><small>Datum simulieren · Design-Vorschau</small></span></summary><div class="sgb">
  <b style="font-size:13px;display:block">Test: Datum und Uhrzeit simulieren</b>
  <p class="src" style="margin:2px 0 6px">Zum Ausprobieren: Unten erscheint ein lila Banner, mit dem du Tage und Uhrzeit vor- und zurückstellst. Eure Daten bleiben unverändert.</p>
  <div class="simrow"><button class="chip btn" id="simon">${SIM_OFF?'Simulation läuft':'Simulation starten'}</button></div>
  <b style="font-size:13px;display:block;margin-top:14px">Design</b>
  <p class="src" style="margin:2px 0 8px">Das Design wechselt automatisch nach Datum: Advent mit Kerzen, Weihnachten, Silvester.</p>
  <div style="margin-bottom:14px"><label class="src" style="display:flex;flex-direction:column;gap:4px">Vorschau<select id="prevsel"><option value="">Automatisch (heutiges Datum)</option><option value="std">Standard</option><option value="adv1">1. Advent</option><option value="adv2h">2. Advent und Nikolaus (6.12.)</option><option value="adv3">3. Advent</option><option value="adv4">4. Advent</option><option value="xmas">Weihnachten (24. bis 26.12.)</option><option value="nye">Silvester (31.12.)</option><option value="sp-party">Besonderer Tag: Party</option><option value="sp-herz">Besonderer Tag: Herzen</option><option value="sp-torte">Besonderer Tag: Torte</option></select></label></div></div></details>`:''}
  <p class="src" id="appver" style="margin:10px 0 0;text-align:center;user-select:none">App-Version ${APP_VER}${devOn()?' · Testmodus':''}</p>
`,d=>{asPage();
    bkRender(d.querySelector('#bklist'));
    const rb=d.querySelector('#rdbox'),upd=()=>{if(!rb.isConnected)return;rb.innerHTML=readyHTML();const g=rb.querySelector('#rdgo');if(g)g.onclick=()=>readyRun(upd)};if(rb)upd();
    {const g=id=>d.querySelector(id),sv=()=>{const r=g('#dnr').value;DIN.at=g('#dnat').value;DIN.s=+g('#dns').value||90;DIN.table=g('#dnt').value.trim();if(r){const [n,i]=r.split('|').map(Number);DIN.dk=n;DIN.dv=i}else{DIN.dk=null;DIN.dv=null}dinSave(true);renderPanel();renderDays()};
      ['#dnat','#dns','#dnr','#dnt'].forEach(id=>g(id).addEventListener('change',sv));const o=g('#dnoff');if(o)o.onclick=()=>{const u=JSON.stringify(DIN);DIN.at='';dinSave(true);closeDlg();renderPanel();undoToast('Abendessen ausgeblendet.',()=>{DIN=JSON.parse(u);dinSave(true);renderPanel()})}}
    {const ci=d.querySelector('#cabin'),cm=d.querySelector('#cabmsg');if(ci)ci.addEventListener('change',()=>{const v=ci.value.trim();if(!v){setCab(null);cm.textContent='';return}const c=cabInfo(+v);if(!c){cm.textContent='Kabine '+v+' nicht im Deckplan gefunden.';return}setCab(+v);cm.textContent=c.txt;renderPanel();const sm=d.querySelector('#dinset small');if(sm)sm.textContent=sm.textContent.replace(/Kabine (fehlt|\d+)/,'Kabine '+v)})}
    {let n=0,t=0;d.querySelector('#appver').onclick=()=>{const now=Date.now();n=now-t<900?n+1:1;t=now;
      if(n>=7){n=0;devSet(!devOn());closeDlg();setTimeout(()=>{offlineDlg();undoToast(devOn()?'Testmodus auf diesem Gerät aktiv.':'Testmodus ausgeschaltet.',null,2500)},80)}}}
    {const tl=d.querySelector('#triplist'),Ld=x=>x?x.split('-').reverse().join('.'):'';
      const draw=L=>{tl.innerHTML=L.map(t=>`<button class="dkr" data-trip="${esc(t.id)}" style="cursor:pointer"><span class="dkic">${t.id===TRIP_ID?'✓':'🧳'}</span><span class="dktx"><b>${esc(t.title)}</b><small>${esc(Ld(t.start))} – ${esc(Ld(t.end))}${t.id===TRIP_ID?' · geöffnet':''}</small></span>${t.id===TRIP_ID?'<span class="lnk" data-edit>Bearbeiten ›</span>':'<span class="lnk">Öffnen ›</span>'}</button>`).join('');
        tl.querySelectorAll('[data-trip]').forEach(b=>b.onclick=()=>{const id=b.dataset.trip;if(id===TRIP_ID)return editOpen();try{localStorage.setItem('rp-trip',id)}catch(e){}tl.innerHTML='<p class="src">Reise wird geöffnet …</p>';location.reload()})};
      if(window.__listTrips)window.__listTrips().then(draw).catch(()=>draw([{id:TRIP_ID,title:TRIP.title,start:TRIP.start,end:TRIP.end}]));else draw([{id:TRIP_ID,title:TRIP.title,start:TRIP.start,end:TRIP.end}])}
    {const wg=d.querySelector('#wizgo');if(wg)wg.onclick=()=>wizOpen()}
    {const ti=d.querySelector('#tripimp');if(ti)ti.onchange=async()=>{const f=ti.files[0],m=d.querySelector('#tripmsg');if(!f)return;try{m.textContent='Wird gelesen …';m.textContent='Wird geprüft …';const o=await window.__checkTrip(await f.text(),m);if(!o)return;m.textContent='Wird hochgeladen …';await window.__importTrip(o);m.textContent='Fertig, wird neu geladen …';setTimeout(()=>location.reload(),600)}catch(e){m.textContent='Fehler: '+(e.message||e.code||e)}}}
    {const mn=d.querySelector('#memn'),ml=d.querySelector('#meml');if(mn){const sv=()=>{const me=memMe();if(!me)return;const n=mn.value.trim(),l=ml.value.trim().toUpperCase().slice(0,2);if(!n||!l)return;
      if(MEMBERS.some(x=>x.id!==me.id&&(x.l===l||x.n===n))){d.querySelector('#memmsg').textContent='Name oder Buchstabe ist schon vergeben.';return}
      const old=me.n;dbh.collection('members').doc(me.id).set({n,l},{merge:true}).catch(tdFail);if(old!==n)TS.tasks.filter(t=>t.who===old).forEach(t=>tsPutTask({...t,who:n}));d.querySelector('#memmsg').textContent='Gespeichert.'};mn.addEventListener('change',sv);ml.addEventListener('change',sv)}}
    {const sb=d.querySelector('#simon');if(sb)sb.onclick=()=>{closeDlg();if(!SIM_OFF)simSet(simLocal());const b=document.getElementById('simbar');if(b&&!b.classList.contains('open')){b.classList.add('open');simApply()}}};
    const ps=d.querySelector('#prevsel');if(ps){ps.value=prevKey||'';ps.onchange=()=>{prevKey=ps.value||null;applyTheme()}}
    const msg=(id,t)=>{const e=d.querySelector(id);if(e)e.textContent=t};
    const sv=d.querySelector('#offsave');
    if(sv)sv.onclick=async()=>{
      msg('#offmsg','Wird erstellt …');
      try{
        const html=await buildOffline();const fn='Reiseplaner-offline-'+TODAY+'.html';
        let dl=null;try{dl=window.claude&&claude.use?await claude.use('downloads'):null}catch(e){}
        if(dl){await dl.save({filename:fn,data:new Blob([html],{type:'text/html'})});msg('#offmsg','Gespeichert.')}
        else{const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([html],{type:'text/html'}));a.download=fn;document.body.appendChild(a);a.click();a.remove();msg('#offmsg','Download gestartet.')}
      }catch(e){msg('#offmsg',e&&e.code==='declined'?'Abgebrochen.':'Speichern hier nicht möglich.')}
    };
    d.querySelector('#bcopy').onclick=async()=>{const t=JSON.stringify(backupObj());try{await navigator.clipboard.writeText(t);msg('#bmsg','Kopiert.')}catch(e){const ta=d.querySelector('#bpaste');ta.value=t;ta.select();msg('#bmsg','Text markiert, bitte kopieren.')}};
    d.querySelector('#bload').onclick=()=>{try{applyBackup(JSON.parse(d.querySelector('#bpaste').value.trim()));msg('#bmsg','Eingespielt.'+(TS.mode==='local'?'':' (Listen sind gemeinsam, nicht ersetzt.)'))}catch(e){msg('#bmsg','Ungültige Sicherung.')}};
  });
}
$('#offb').onclick=offlineDlg;
if(OFFLINE){const sb=$('.sub');if(sb){sb.hidden=false;sb.textContent='Offline-Version vom '+window.__SEED.when}}

  
/* ---------- v35: Countdown ---------- */
function nyeTxt(n){const p=D.ports.find(q=>q.date===TODAY),l=new Date(nowMs()+tzOf(p)*36e5),m=24*60-(l.getUTCHours()*60+l.getUTCMinutes());
  if(m<=360)return m<=1?'Gleich ist es '+(+TODAY.slice(0,4)+1)+' ✨':'noch '+(m>=60?Math.floor(m/60)+':'+String(m%60).padStart(2,'0')+' h':m+' Min')+' bis '+(+TODAY.slice(0,4)+1);return 'Silvester · Tag '+n+' von '+D.ports.length}
function updateTl(){
  const dd=x=>new Date(x+'T12:00:00'),DAY=864e5;
  const t0=dd(TODAY),s=dd(D.ports[0].date),e=dd(D.ports[D.ports.length-1].date),b=dd(addDays(TRIP.start,-100));
  let p,txt;const left=Math.round((s-t0)/DAY);
  if(left>0){p=(t0-b)/(s-b);txt=left===1?'morgen geht’s los '+({plane:'✈',car:'🚗',train:'🚆',bus:'🚌'}[TRIP.arrival||(TRIP.flight===false?'none':'plane')]||''):'noch '+left+' Tage · '+fmtD(TRIP.start)}
  else if(t0<=e){const n=Math.round((t0-s)/DAY)+1;p=(n-1)/(D.ports.length-1);const SZ=Object.assign({nye:true},TRIP.seasons||{});txt=TODAY.slice(5)==='12-31'&&SZ.nye?nyeTxt(n):TODAY.slice(5)==='01-01'&&SZ.nye?'Frohes neues Jahr '+TODAY.slice(0,4)+' ✨':n===1?'heute geht’s los':'Tag '+n+' von '+D.ports.length}
  else{p=1;txt='Willkommen zurück'}
  {const sp=specialToday();if(sp&&sp.title)txt=sp.title;else if(/^sp-/.test(prevKey||''))txt='Alles Gute! 🎉'}
  p=Math.max(0.02,Math.min(1,p));
  $('#tldone').style.width=(p*100)+'%';$('#tlboat').style.left=(p*100)+'%';$('#tltxt').textContent=txt;
  $('#tl').classList.toggle('fly',left>0);$('#tl').setAttribute('aria-label',txt);$('#tl').title=txt;
}
updateTl();
setInterval(()=>{if(document.documentElement.hasAttribute('data-nye')&&!document.hidden)updateTl()},20000);
/* Silvester: feines Feuerwerk im Header (Canvas, nur wenn sichtbar und Bewegung erlaubt) */
(function(){const top=document.querySelector('.top');if(!top)return;const cv=document.createElement('canvas');cv.id='fwc';cv.setAttribute('aria-hidden','true');top.prepend(cv);
  const ctx=cv.getContext('2d'),rm=matchMedia('(prefers-reduced-motion: reduce)');let P=[],R=[],run=false,last=0,next=0,W=0,H=0,dpr=1;
  const COL=['#f6dfa6','#e8c372','#fff6dd','#ffb4c1','#bfe3ff'];
  const size=()=>{dpr=Math.min(2,devicePixelRatio||1);W=top.clientWidth;H=top.clientHeight;cv.width=W*dpr;cv.height=H*dpr;ctx.setTransform(dpr,0,0,dpr,0,0)};
  const launch=()=>{const x=W*(.15+Math.random()*.75);R.push({x,y:H+4,vy:-(H*.018+Math.random()*H*.01),ty:H*(.18+Math.random()*.35),c:COL[Math.random()*COL.length|0]})};
  const burst=(x,y,c)=>{const n=26+(Math.random()*18|0),sp=.9+Math.random()*.8;for(let i=0;i<n;i++){const a=i/n*Math.PI*2+Math.random()*.2,v=sp*(.6+Math.random()*.6);P.push({x,y,vx:Math.cos(a)*v,vy:Math.sin(a)*v,l:1,c:Math.random()<.25?'#fff6dd':c})}};
  const frame=t=>{if(!run)return;const dt=Math.min(3,(t-last)/16.7||1);last=t;
    ctx.globalCompositeOperation='destination-out';ctx.fillStyle='rgba(0,0,0,.22)';ctx.fillRect(0,0,W,H);ctx.globalCompositeOperation='lighter';
    if(t>next){launch();next=t+900+Math.random()*1600}
    R=R.filter(r=>{r.y+=r.vy*dt;ctx.fillStyle=r.c;ctx.globalAlpha=.8;ctx.fillRect(r.x,r.y,1.4,4);if(r.y<=r.ty){burst(r.x,r.y,r.c);return false}return true});
    P=P.filter(p=>{p.x+=p.vx*dt;p.y+=p.vy*dt;p.vy+=.018*dt;p.vx*=.985;p.vy*=.985;p.l-=.011*dt;if(p.l<=0)return false;ctx.globalAlpha=Math.max(0,p.l);ctx.fillStyle=p.c;ctx.beginPath();ctx.arc(p.x,p.y,1.3,0,7);ctx.fill();return true});
    ctx.globalAlpha=1;requestAnimationFrame(frame)};
  const check=()=>{const on=document.documentElement.hasAttribute('data-nye')&&!document.hidden&&!rm.matches;if(on&&!run){run=true;size();last=performance.now();requestAnimationFrame(frame)}else if(!on&&run){run=false;P=[];R=[];ctx.clearRect(0,0,W,H)}};
  new MutationObserver(check).observe(document.documentElement,{attributes:true,attributeFilter:['data-nye']});
  document.addEventListener('visibilitychange',check);addEventListener('resize',()=>{if(run)size()});check()})();
(function(){
  let x0=null,y0=null,t0=0;const pn=document;
  const ok=el=>el&&el.closest&&!el.closest('input,textarea,select,.tw,[data-noswipe],.dinfo>summary,#dlg,#ov,#mapwrap,.mapcol,.days,.tdtabs,.dkscroll,#bnav,.top,#toast');let onRow=false;
  pn.addEventListener('touchstart',e=>{x0=null;if(e.touches.length!==1||!ok(e.target))return;onRow=!!e.target.closest('.swr');x0=e.touches[0].clientX;y0=e.touches[0].clientY;t0=Date.now()},{passive:true});
  pn.addEventListener('touchend',e=>{const tp=D.ports.find(q=>q.date===TODAY),inT=todayView;if(x0==null||(sel==null&&!inT))return;const dx=e.changedTouches[0].clientX-x0,dy=e.changedTouches[0].clientY-y0;x0=null;if(Date.now()-t0>900||sortLift||Date.now()-swJust<500)return;if(onRow&&dx<0)return;if(Math.abs(dx)<50||Math.abs(dx)<Math.abs(dy)*1.3)return;if(inT&&sel==null){tdStep(dx<0?1:-1);return}stepDay(sel+(dx<0?1:-1))},{passive:true});
  pn.addEventListener('touchcancel',()=>{x0=null},{passive:true});
})();
/* Getränkekarte: Daten hier eintragen. Format: {title,stand,note,cats:[{n,items:[{n,p,d}]}]} */
var DRINKS=window.__T.DRINKS;
let drkG=0,drkQ='',drkRb=null;const drkO=new Set();
const FAV={l:'',k:new Set(),o:[],id:null};
try{const r=JSON.parse(localStorage.getItem('rp-'+TRIP_ID+'-fav-v1')||'null');if(r){FAV.l=r.l||'';FAV.k=new Set(r.k||[]);FAV.o=r.o||[]}}catch(e){}
function favSave(){try{localStorage.setItem('rp-'+TRIP_ID+'-fav-v1',JSON.stringify({l:FAV.l,k:[...FAV.k],o:FAV.o}))}catch(e){}}
function favPush(){if(FAV.id&&dbh&&TS.mode==='db')dbh.collection('drinkfavs').doc(FAV.id).set({l:FAV.l,k:[...FAV.k]}).catch(()=>{})}
/* Buchstabe aus dem Google-Konto ableiten (erster Buchstabe des Vornamens); nur wenn das nicht klappt, wird gefragt */
function favLetterFromUser(){const m=memMe();return m?m.l:''}
async function favInit(db,uid){
  try{FAV.id=uid;if(!FAV.id)return;
    {const L=favLetterFromUser();if(L&&FAV.l!==L){FAV.l=L;favSave()}}
    db.collection('drinkfavs').onSnapshot({includeMetadataChanges:true},s=>{if(s.metadata.fromCache)return;
      FAV.o=s.docs.filter(d=>d.id!==FAV.id).map(d=>({id:d.id,...d.data()})).filter(x=>x.l&&(x.k||[]).length);
      const m=s.docs.find(d=>d.id===FAV.id);
      if(m){const x=m.data()||{},L=favLetterFromUser();FAV.l=L||x.l||FAV.l;FAV.k=new Set(x.k||[]);if(L&&x.l!==L)favPush()}else if(FAV.l&&FAV.k.size)favPush();
      favSave();if(drkRb&&document.getElementById('drb'))drkRb()},()=>{})
  }catch(e){}
}
const FSTAR=(l,me)=>'<svg class="fst'+(me?' me':'')+'" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 1.8l3.1 6.6 7.2.9-5.3 5 1.4 7.2L12 17.9l-6.4 3.6L7 14.3 1.7 9.3l7.2-.9z"/><text x="12" y="15.2" text-anchor="middle">'+esc(l)+'</text></svg>';
const FSTAR0='<svg class="fst off" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 1.8l3.1 6.6 7.2.9-5.3 5 1.4 7.2L12 17.9l-6.4 3.6L7 14.3 1.7 9.3l7.2-.9z"/></svg>';
const favAny=k=>FAV.k.has(k)||FAV.o.some(x=>(x.k||[]).includes(k));
function favHTML(k){const mine=FAV.k.has(k),ot=FAV.o.filter(x=>(x.k||[]).includes(k));
  const h=(mine?FSTAR(FAV.l||'?',true):'')+ot.map(x=>FSTAR(x.l)).join('');
  return '<button class="fav" data-fk="'+esc(k)+'" aria-label="'+(mine?'Favorit entfernen':'Als Favorit markieren')+'">'+(h||FSTAR0)+'</button>'}
function favLetter(cb){openSheet('<div class="hd"><h3 style="margin:0">Wer bist du?</h3></div><p>Dein Buchstabe steht im Stern, damit man eure Favoriten unterscheiden kann.</p><div class="btns">'+Object.entries(PN).map(([l,n])=>'<button class="chip btn" data-l="'+esc(l)+'">'+esc(l)+' ('+esc(n)+')</button>').join('')+'</div>',d=>{
  d.querySelectorAll('[data-l]').forEach(b=>b.onclick=()=>{FAV.l=b.dataset.l;favSave();favPush();cb&&cb()})})}
function favToggle(k){if(!FAV.l){favLetter(()=>{FAV.k.add(k);favSave();favPush();drinksDlg()});return}
  const re=()=>{favSave();favPush();if(drkRb&&document.getElementById('drb'))drkRb()};
  if(FAV.k.has(k)){FAV.k.delete(k);re();undoToast((k.split('|')[1]||k)+' aus Favoriten entfernt.',()=>{FAV.k.add(k);re()})}else{FAV.k.add(k);re()}}
const pk=i=>{const on=i.k&&i.k.includes('M');return i.m3?'<span class="pk3'+(on?'':' no')+'" title="Mit My Drinks nur 3 €">3 €</span>':'<i class="pkd'+(on?'':' no')+'" title="Im Paket My Drinks enthalten"></i>'}
let drkF='all';
function favPersons(){const p=[];if(FAV.l||FAV.k.size)p.push({l:FAV.l||'?',k:FAV.k,me:1});FAV.o.forEach(x=>{if((x.k||[]).length)p.push({l:x.l,k:new Set(x.k),me:0})});return p}
function drinksDlg(){
  const X='<div class="hd"><h3 style="margin:0">Getränkekarte</h3><button class="x" data-close aria-label="Schließen">✕</button></div>';
  if(!DRINKS||!DRINKS.groups||!DRINKS.groups.length){openSheet(X+'<p>Die aktuelle Getränkekarte ist noch nicht hinterlegt.</p>',()=>asPage());return}
  const row=(s,i)=>{const k=s.n+'|'+i.n,o=i.h&&drkO.has(k);return '<div class="drow'+(i.h?' dh':'')+(o?' open':'')+'"'+(i.h?' data-dk="'+esc(k)+'"':'')+'><div class="ddl"><span class="dslot">'+pk(i)+'</span><div class="dtx"><b>'+esc(i.n)+(i.h?' <span class="dib">ⓘ</span>':'')+'</b>'+(i.d?'<small>'+esc(i.d)+'</small>':'')+(o?'<span class="dkdesc">'+esc(i.h)+'</span>':'')+'</div></div><span class="pr">'+favHTML(s.n+'|'+i.n)+'<span class="pp">'+esc(i.p||'')+'</span></span></div>'};
  const secs=(gs,pred,q)=>gs.map(g=>g.secs.map(s=>{const it=s.items.filter(i=>pred(s.n+'|'+i.n,i,s,g));if(!it.length)return '';
    return '<h3 class="drh">'+esc(s.n)+(s.pr&&!q?' <span>'+esc(s.pr)+'</span>':'')+'</h3>'+(s.nt?'<p class="src" style="margin:0 0 4px">'+esc(s.nt)+'</p>':'')+'<div class="drk">'+it.map(i=>row(s,i)).join('')+'</div>'}).join('')).join('');
  const body=()=>{const q=drkQ.trim().toLowerCase();
    if(q)return secs(DRINKS.groups,(k,i,s,g)=>(i.n+' '+i.d+' '+(i.h||'')+' '+s.n+' '+g.n).toLowerCase().includes(q),1)||'<p class="empty">Nichts gefunden.</p>';
    if(drkG!==-1)return secs([DRINKS.groups[drkG]],()=>true);
    const P=favPersons();
    if(!P.length)return '<p class="empty">Noch keine Favoriten. Tippe bei einem Getränk auf den Stern.</p>';
    const nm=l=>PN[l]||l;
    const blocks=[];
    if(P.length>1){const keys=new Set();P.forEach(p=>p.k.forEach(k=>keys.add(k)));
      const both=k=>P.every(p=>p.k.has(k));
      blocks.push({id:'both',h:'★ Beide',pred:both});
      P.forEach(p=>blocks.push({id:p.l,h:'Nur '+nm(p.l)+(p.me?' (du)':''),l:p.l,pred:k=>p.k.has(k)&&!both(k)}))}
    else blocks.push({id:P[0].l,h:'Deine Favoriten',l:P[0].l,pred:k=>P[0].k.has(k)});
    const chips=P.length>1?'<div class="drtabs"><button class="chip'+(drkF==='all'?' on':'')+'" data-ff="all">Alle</button>'+blocks.map(x=>'<button class="chip'+(drkF===x.id?' on':'')+'" data-ff="'+esc(x.id)+'">'+esc(x.id==='both'?'Beide':nm(x.id))+'</button>').join('')+'</div>':'';
    const shown=blocks.filter(x=>drkF==='all'||drkF===x.id);
    return chips+shown.map(x=>{const h=secs(DRINKS.groups,k=>x.pred(k));return h?'<div class="fblk"><div class="fbh">'+(x.l?FSTAR(x.l,0):'')+'<span>'+esc(x.h)+'</span></div>'+h+'</div>':''}).join('')||'<p class="empty">Hier ist noch nichts markiert.</p>'};
  openSheet(X+'<div class="sfield"><svg class="sfi" viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg><input id="drq" type="search" placeholder="Getränk suchen" value="'+esc(drkQ)+'" autocomplete="off"><button type="button" class="sfx" aria-label="Eingabe löschen">✕</button></div><p class="src" style="margin:0 0 8px"><i class="pkd"></i> im Paket My Drinks enthalten · <span class="pk3">3 €</span> mit My Drinks nur 3 € · <b>ⓘ</b> antippen für Herkunft &amp; Geschichte (ohne Gewähr)</p><div class="drtabs" id="drt"><button class="chip'+(drkG===-1?' on':'')+'" data-g="-1">★ Favoriten</button>'+DRINKS.groups.map((g,i)=>'<button class="chip'+(i===drkG?' on':'')+'" data-g="'+i+'">'+esc(g.n)+'</button>').join('')+'</div><div id="drb">'+body()+'</div><p class="src">'+esc(DRINKS.stand)+'</p>',d=>{asPage();
    const rb=()=>{d.querySelector('#drb').innerHTML=body();d.querySelectorAll('#drt .chip').forEach(c=>c.classList.toggle('on',+c.dataset.g===drkG&&!drkQ.trim()))};
    d.querySelector('#drq').oninput=e=>{drkQ=e.target.value;rb()};
    d.querySelectorAll('#drt .chip').forEach(c=>c.onclick=()=>{drkG=+c.dataset.g;drkQ='';d.querySelector('#drq').value='';rb();d.scrollTop=0});
    drkRb=rb;d.querySelector('#drb').addEventListener('click',e=>{const f=e.target.closest('[data-ff]');if(f){drkF=f.dataset.ff;rb();return}const b=e.target.closest('.fav');if(b){favToggle(b.dataset.fk);return}const r=e.target.closest('[data-dk]');if(r){const k=r.dataset.dk,o=drkO.has(k);drkO.clear();if(!o)drkO.add(k);rb()}});rb()});
}
var SHIP=window.__T.SHIP;
/* ---------- Deckplan des Schiffs (eigene vereinfachte Darstellung nach Katalog-Deckplan) ---------- */
const DKIND={food:['🍽','Essen'],bar:['🍸','Bar'],pool:['🏊','Pool'],show:['🎭','Unterhaltung'],spa:['💆','Spa'],sport:['⛳','Sport'],kids:['🧸','Kinder'],shop:['🛍','Shops'],service:['ℹ️','Service'],sun:['☀️','Sonnendeck'],other:['📍','']};
let CABMAP=null,deckSel=null,deckQ='';
function cabMap(){if(CABMAP)return CABMAP;CABMAP=new Map();for(const d in SHIP.cab)SHIP.cab[d].split(';').forEach(e=>{const [n,p,s,l]=e.split(',').map(Number);CABMAP.set(n,{d:+d,p,s,l:l||0})});return CABMAP}
const deckOf=n=>SHIP.dk.find(x=>x[0]===n);
const posTxt=p=>p<20?'ganz vorne':p<40?'vorne':p<60?'Mitte':p<80?'hinten':'ganz hinten';
function liftTxt(d,p){const L=SHIP.lifts[d];if(!L||!L.length)return '';const l=L.reduce((a,b)=>Math.abs(b-p)<Math.abs(a-p)?b:a);const m=Math.round(Math.abs(l-p)*2.9/5)*5;return 'nächster Aufzug '+(l<40?'vorne':l<70?'Mitte':'hinten')+(m?', ca. '+m+' m':', direkt daneben')}
const myCab=()=>{try{return +localStorage.getItem('rp-'+TRIP_ID+'-cabin')||null}catch(e){return null}};
function setCab(n){try{n?localStorage.setItem('rp-'+TRIP_ID+'-cabin',String(n)):localStorage.removeItem('rp-'+TRIP_ID+'-cabin')}catch(e){}
  if(dbh&&TS.mode==='db')dbh.collection('plandays').doc('meta').set({cabin:n||null},{merge:true}).catch(tdFail)}
function cabInfo(n){const c=cabMap().get(n);if(!c)return null;const dk=deckOf(c.d);return {...c,name:dk?dk[1]:'',txt:`Deck ${c.d} ${dk?dk[1]:''} · ${posTxt(c.p)} · ${c.s?'Steuerbord (rechts)':'Backbord (links)'} · ${liftTxt(c.d,c.p)}`}}
function deckRange(d){const s=SHIP.cab[d];if(!s)return '';const a=s.split(';');return a[0].split(',')[0]+'–'+a[a.length-1].split(',')[0]}
function cabSegs(d){const o={0:[],1:[]};for(const [n,c] of cabMap()){if(c.d!==d)continue;const a=o[c.s];a.push([c.p,n])}
  const seg=s=>{s.sort((a,b)=>a[0]-b[0]);const r=[];s.forEach(([p,n])=>{const l=r[r.length-1];if(l&&p-l.b<=4){l.b=p;l.lo=Math.min(l.lo,n);l.hi=Math.max(l.hi,n)}else r.push({a:p,b:p,lo:n,hi:n})});return r};return {B:seg(o[0]),S:seg(o[1])}}
const sideTxt=v=>v<-.2?'Backbord (links)':v>.2?'Steuerbord (rechts)':'Schiffsmitte';
/* Deckzeichnung hochkant: Bug oben, Backbord links, Steuerbord rechts. opt: {hl, from, to, lift, mini} */
const dkSecTxt=p=>p<33?'Vorne':p<66?'Mitte':'Hinten';
function dkNums(d){const V=(deckOf(d)||[0,0,[]])[2];return V.map((v,i)=>({v,i})).sort((a,b)=>a.v[1]-b.v[1]||(a.v[3]||0)-(b.v[3]||0)).map((o,k)=>({...o,n:k+1}))}
function deckSvg(d,opt){opt=opt||{};
  const W=240,H=opt.mini?380:520,cx=W/2+(opt.mini?0:4),hw=opt.mini?100:86,top=46,bot=H-14,len=bot-top,Y=p=>top+p/100*len,X=s=>cx+Math.max(-1,Math.min(1,s||0))*hw*.62;
  let g=`<svg viewBox="0 0 ${W} ${H}" class="dksvg2${opt.mini?' mini':''}" role="img" aria-label="Deck ${d} von oben, Bug oben, Backbord links">`;
  g+=`<path d="M${cx} 6 C${cx+hw*.55} 14 ${cx+hw} ${top-4} ${cx+hw} ${top+30} L${cx+hw} ${bot-8} Q${cx+hw} ${bot} ${cx+hw-8} ${bot} L${cx-hw+8} ${bot} Q${cx-hw} ${bot} ${cx-hw} ${bot-8} L${cx-hw} ${top+30} C${cx-hw} ${top-4} ${cx-hw*.55} 14 ${cx} 6Z" class="dkhull"/>`;
  [33,66].forEach(p=>g+=`<line x1="${cx-hw+4}" x2="${cx+hw-4}" y1="${Y(p)}" y2="${Y(p)}" class="dksec"/>`);
  if(!opt.mini)[[16,'VORNE'],[50,'MITTE'],[83,'HINTEN']].forEach(([p,t])=>g+=`<text transform="translate(${cx-hw-5} ${Y(p)}) rotate(-90)" class="dksect" text-anchor="middle">${t}</text>`);
  {const C=[...cabMap()].filter(([n,c])=>c.d===d);if(C.length){const iw=hw*.94,cw=Math.max(8,iw*.2),chh=Math.max(2.6,len*.0125),mc0=myCab();
    const ps=C.map(([n,c])=>c.p),p0=Math.min(...ps),p1=Math.max(...ps);
    // Gänge zwischen Außen- und Innenreihen
    [-.6,.6].forEach(f=>g+=`<line x1="${cx+f*iw}" x2="${cx+f*iw}" y1="${Y(p0)-4}" y2="${Y(p1)+4}" class="dkcorr"/>`);
    g+=`<g class="dkcabg">`+C.map(([n,c])=>`<rect data-cab="${n}" x="${(cx+c.l/100*iw-cw/2).toFixed(1)}" y="${(Y(c.p)-chh/2).toFixed(1)}" width="${cw.toFixed(1)}" height="${chh.toFixed(1)}" rx="1" class="${n===mc0?'me':c.s?'s':'b'}"/>`).join('')+`</g>`;
}}
  (SHIP.lifts[d]||[]).forEach(l=>{const y=Y(l);g+=`<g class="dkl${opt.lift===l?' on':''}" transform="translate(${cx} ${y})"><rect x="-9" y="-9" width="18" height="18" rx="3"/><text y="4" text-anchor="middle">E</text></g>`});
  const placed=(SHIP.lifts[d]||[]).map(l=>[cx,Y(l),13]);
  const ZC={food:'#e8590c',bar:'#c2255c',pool:'#1c7ed6',show:'#7048e8',spa:'#0ca678',sport:'#2f9e44',kids:'#f08c00',shop:'#ae3ec9',service:'#868e96',sun:'#f2b705',other:'#868e96'};
  // eigene, vereinfachte Raumflächen: Größe nach Art des Bereichs (keine Kopie der Originalräume)
  const RS={show:[.62,.11],food:[.56,.085],pool:[.42,.065],spa:[.5,.08],sport:[.46,.07],sun:[.7,.09],kids:[.36,.05],bar:[.34,.045],shop:[.3,.04],service:[.26,.035],other:[.3,.04]};
  const roomSz=v=>/Buffet/.test(v[0])?[.78,.1]:/Teatro/.test(v[0])?[.7,.12]:/Casin|Ballsaal/.test(v[0])?[.5,.08]:RS[v[2]]||RS.other;
  const M=dkNums(d).map(o=>{let x=X(o.v[3]),y=Y(o.v[1]);const r=opt.mini?8:opt.big?6.5:11;
    for(let k=0;k<8&&placed.some(([px,py,pr])=>Math.hypot(px-x,py-y)<pr+r+2);k++){if(k%2===0)x+=(o.v[3]||0)<0?-(r*2+2):r*2+2;else{x=X(o.v[3]);y+=r*2+2}}
    x=Math.max(cx-hw+r+14,Math.min(cx+hw-r-14,x));placed.push([x,y,r]);return{...o,x,y,r}});
  const hasCab=!!SHIP.cab[d];
  const dense=M.length>9?.78:1;
  M.filter(o=>/^(show|food|pool|spa|sport|sun|kids)$/.test(o.v[2])).sort((a,b)=>roomSz(b.v)[0]*roomSz(b.v)[1]-roomSz(a.v)[0]*roomSz(a.v)[1]).forEach(o=>{const [fw,fh]=roomSz(o.v),w=fw*hw*2*(opt.mini?.9:1)*dense,h=Math.max(14,fh*len*dense);
    const rx=Math.max(cx-hw+6,Math.min(cx+hw-6-w,X(o.v[3])-w/2)),ry=Math.max(top+4,Math.min(bot-6-h,Y(o.v[1])-h/2));
    g+=`<rect x="${rx.toFixed(1)}" y="${ry.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" rx="5" fill="${ZC[o.v[2]]}" fill-opacity="${o.v[2]==='sun'?.16:.11}" stroke="${ZC[o.v[2]]}" stroke-opacity=".35" stroke-width="1"/>`});
  M.forEach(o=>{g+=`<g class="dkn${opt.hl===o.i?' on':''}" data-dv="${o.i}" transform="translate(${o.x} ${o.y})"><circle r="${o.r}" style="stroke:${ZC[o.v[2]]}"/><text y="${opt.mini?3:opt.big?2.6:4}" text-anchor="middle"${opt.big?' style="font-size:7.5px"':''}>${o.n}</text></g>`});
  // Namen neben die Nummern schreiben, Überlappungen vermeiden
  if(!opt.mini){const fs=opt.big?4.6:7.2,L=[];
    const short=v=>{let t=v[0].replace(/\s*\(.*\)$/,'').replace(/^(Restaurant|Buffet-Restaurant|Pool|Spa) /,'');const mx=opt.big?30:18;return t.length>mx?t.slice(0,mx-1).replace(/\s+\S*$/,'')+'…':t};
    M.forEach(o=>{const t=short(o.v),w=tw(t,`600 ${fs}px sans-serif`)*1.05+4,h=fs+3;const right=o.x<=cx;
      let best=null;for(const dy of [0,-h-1,h+1,-2*h-2,2*h+2]){const x0=right?o.x+o.r+3:o.x-o.r-3-w,y0=o.y+dy-h/2,rc=[x0,y0,x0+w,y0+h];
        if(x0<cx-hw+2||x0+w>cx+hw-2)continue;if(L.some(q=>rc[0]<q[2]&&rc[2]>q[0]&&rc[1]<q[3]&&rc[3]>q[1]))continue;if(M.some(m=>m!==o&&Math.abs(m.x-(x0+w/2))<w/2+m.r&&Math.abs(m.y-(y0+h/2))<h/2+m.r))continue;best=rc;break}
      if(!best){const x0=right?o.x-o.r-3-w:o.x+o.r+3,y0=o.y-h/2,rc=[x0,y0,x0+w,y0+h];if(x0>=cx-hw+2&&x0+w<=cx+hw-2&&!L.some(q=>rc[0]<q[2]&&rc[2]>q[0]&&rc[1]<q[3]&&rc[3]>q[1]))best=rc}
      if(best){L.push(best);g+=`<text x="${best[0]+2}" y="${best[1]+h-2.6}" class="dkname" style="font-size:${fs}px">${esc(t)}</text>`}})}
  const mc=myCab(),ci=mc&&cabMap().get(mc);
  if(ci&&ci.d===d)g+=`<g class="dkme" transform="translate(${cx+ci.l/100*hw*.94} ${Y(ci.p)})"><circle r="9"/><text y="4" text-anchor="middle">★</text></g>`;
  const pin=(o,c,t)=>o?`<g class="dkpin ${c}" transform="translate(${o.kind==='cab'?cx+((cabMap().get(o.n)||{}).l||0)/100*hw*.94:X(o.y)} ${Y(o.p)})"><circle r="12"/><text y="4" text-anchor="middle">${t}</text></g>`:'';
  g+=pin(opt.from,'from','A')+pin(opt.to,'to','B');
  g+=`<text x="${cx}" y="${top-10}" text-anchor="middle" class="dklab">BUG</text><text x="${cx-hw}" y="12" class="dklab">◀ links</text><text x="${cx+hw}" y="12" text-anchor="end" class="dklab">rechts ▶</text>`;
  return g+'</svg>';
}
/* Orte für Start/Ziel: Kabine (4 Ziffern), "unsere kabine", oder Bereich */
function dkPlace(q,ref){q=String(q||'').trim();if(!q)return null;
  const m=/\b(\d{4})\b/.exec(q),mc=myCab();
  if(m||/unsere\s*kabine/i.test(q)){const n=m?+m[1]:mc;const c=n&&cabMap().get(n);if(!c)return {err:'Kabine '+(n||'')+' nicht gefunden'};return {kind:'cab',n,d:c.d,p:c.p,y:c.s?.85:-.85,side:c.s,name:'Kabine '+n}}
  const norm=t=>t.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');
  const dm=/\(deck (\d+)\)\s*$/i.exec(q),wantD=dm?+dm[1]:null;
  let ql=norm(q.replace(/\s*\(deck \d+\)\s*$/i,''));
  const AL={theater:'teatro',theatre:'teatro',show:'teatro',kino:'kino',casino:'casino',buffet:'buffet',essen:'restaurant',fruhstuck:'buffet',rezeption:'rezeption',info:'customer service',kinder:'squok',kids:'squok',disko:'disco',fitness:'spa',wellness:'spa',sonne:'sonnendeck',joggen:'jogging',kapelle:'kapelle',fotos:'foto'};
  for(const k in AL)if(ql===k)ql=AL[k];
  const KW={pool:'pool',bar:'bar',restaurant:'food',spa:'spa',sport:'sport',shop:'shop',shops:'shop',laden:'shop'};
  const cand=[];SHIP.dk.forEach(([n,nm,V])=>V.forEach(v=>{if(wantD&&n!==wantD)return;const t=norm(v[0]);const sc=t===ql?0:t.startsWith(ql)?1:t.includes(ql)?2:KW[ql]===v[2]?3:9;if(sc<9)cand.push({n,v,sc})}));
  if(!cand.length)return {err:'„'+q+'“ nicht gefunden. Versuch z. B. Pool, Bar, Restaurant, Theater, Rezeption oder eine Kabinennummer.'};
  const bs=Math.min(...cand.map(c=>c.sc)),C=cand.filter(c=>c.sc===bs);
  const hit=ref&&C.length>1?C.reduce((a,b)=>(Math.abs(b.v[1]-ref.p)+Math.abs(b.n-ref.d)*15)<(Math.abs(a.v[1]-ref.p)+Math.abs(a.n-ref.d)*15)?b:a):C[0];
  return {kind:'v',d:hit.n,p:hit.v[1],y:hit.v[3]||0,name:hit.v[0],k:hit.v[2]};
}
const dkDir=(a,b)=>b>a?'Richtung Heck (nach hinten)':'Richtung Bug (nach vorne)';
const dkM=d=>Math.max(5,Math.round(Math.abs(d)*2.9/5)*5);
function dkRoute(A,B){
  const st=[];let lift=null,total=0;
  const arrive=()=>B.kind==='cab'?` Die Kabine liegt auf der ${B.side?'Steuerbordseite (rechts, ungerade Nummern)':'Backbordseite (links, gerade Nummern)'}.`:(Math.abs(B.y)>.2?` Liegt eher ${B.y<0?'links (Backbord)':'rechts (Steuerbord)'}, wenn man nach vorne schaut.`:'');
  if(A.d===B.d){const m=dkM(B.p-A.p);total=m;st.push(Math.abs(B.p-A.p)<3?`${B.name} ist gleich in der Nähe.`:`Auf Deck ${A.d} ca. ${m} m ${dkDir(A.p,B.p)} bis ${B.name}.`+arrive());return {st,total}}
  const up=d=>d>11,da=up(A.d)?11:A.d,db=up(B.d)?11:B.d;
  if(up(A.d))st.push(`Über die Treppe hinunter auf Deck 11.`);
  if(da!==db){const L1=SHIP.lifts[da]||[],L2=SHIP.lifts[db]||[],L=L1.filter(l=>L2.some(m=>Math.abs(m-l)<=4));
    lift=(L.length?L:L1).reduce((a,b)=>Math.abs(A.p-b)+Math.abs(B.p-b)<Math.abs(A.p-a)+Math.abs(B.p-a)?b:a);
    const bank=lift<40?'vorne':lift<70?'in der Mitte':'hinten',m1=Math.abs(lift-A.p)<3?0:dkM(lift-A.p);total+=m1;
    st.push(m1?`Von ${A.name} ca. ${m1} m ${dkDir(A.p,lift)} zu den Aufzügen ${bank}.`:`Die Aufzüge ${bank} sind gleich bei ${A.name}.`);
    const n=Math.abs(db-da);st.push(`Mit dem Aufzug (oder über die Treppe daneben) ${n} Deck${n>1?'s':''} ${db>da?'hoch':'runter'} auf Deck ${db} ${(deckOf(db)||[])[1]||''}.`);
    if(!up(B.d)){const m2=Math.abs(B.p-lift)<3?0:dkM(B.p-lift);total+=m2;st.push(m2?`Dort ca. ${m2} m ${dkDir(lift,B.p)} bis ${B.name}.`+arrive():`${B.name} liegt direkt bei den Aufzügen.`+arrive())}
  }
  if(up(B.d))st.push(`Über die Treppe weiter nach oben auf Deck ${B.d} ${(deckOf(B.d)||[])[1]} zu ${B.name}.`);
  return {st,total,lift};
}
let dkFrom='',dkTo='',dkCat=null;
/* Großansicht eines Decks mit Zwei-Finger-Zoom */
function dkBig(d,hl){let o=document.getElementById('dkbigov');if(o)o.remove();o=document.createElement('div');o.id='dkbigov';
  const dk=deckOf(d);o.innerHTML=`<div class="dkbh"><b>Deck ${dk[0]} · ${esc(dk[1])}</b><span><button data-z="-1" aria-label="Verkleinern">−</button><button data-z="1" aria-label="Vergrößern">+</button><button data-x aria-label="Schließen">✕</button></span></div><div class="dkbs"><div class="dkbw">${deckSvg(d,{hl,big:1})}</div></div><p class="dkbt">Mit zwei Fingern zoomen · Nummer antippen zeigt den Namen</p>`;
  document.body.appendChild(o);const sc=o.querySelector('.dkbs'),w=o.querySelector('.dkbw');let z=1;const base=()=>Math.min(sc.clientWidth-16,(sc.clientHeight-16)*240/520);
  const setZ=(nz,cxp,cyp)=>{nz=Math.max(1,Math.min(5,nz));const r=sc.getBoundingClientRect(),fx=cxp==null?.5:(cxp-r.left+sc.scrollLeft)/(w.offsetWidth||1),fy=cyp==null?.5:(cyp-r.top+sc.scrollTop)/(w.offsetHeight||1);
    z=nz;w.style.width=(base()*z)+'px';sc.scrollLeft=fx*w.offsetWidth-(cxp==null?sc.clientWidth/2:cxp-r.left);sc.scrollTop=fy*w.offsetHeight-(cyp==null?sc.clientHeight/2:cyp-r.top)};
  setZ(1);o.querySelectorAll('[data-z]').forEach(b=>b.onclick=()=>setZ(z*(+b.dataset.z>0?1.5:1/1.5)));
  const close=()=>o.remove();o.querySelector('[data-x]').onclick=close;
  const P=new Map();let d0=0,z0=1;
  sc.addEventListener('pointerdown',e=>{P.set(e.pointerId,{x:e.clientX,y:e.clientY});if(P.size===2){const [a,b]=[...P.values()];d0=Math.hypot(a.x-b.x,a.y-b.y);z0=z}});
  sc.addEventListener('pointermove',e=>{if(!P.has(e.pointerId))return;P.set(e.pointerId,{x:e.clientX,y:e.clientY});if(P.size===2&&d0){const [a,b]=[...P.values()];setZ(z0*Math.hypot(a.x-b.x,a.y-b.y)/d0,(a.x+b.x)/2,(a.y+b.y)/2)}});
  const up=e=>{P.delete(e.pointerId);if(P.size<2)d0=0};sc.addEventListener('pointerup',up);sc.addEventListener('pointercancel',up);
  sc.addEventListener('wheel',e=>{if(e.ctrlKey||e.metaKey){e.preventDefault();setZ(z*(e.deltaY<0?1.15:1/1.15),e.clientX,e.clientY)}},{passive:false});
  sc.addEventListener('click',e=>{const n=e.target.closest('[data-dv]');if(!n)return;const v=deckOf(d)[2][+n.dataset.dv];o.querySelector('.dkbt').textContent=`${DKIND[v[2]][0]} ${v[0]} · ${posTxt(v[1])} · ${sideTxt(v[3]||0)}${v[4]?' – '+v[4]:''}`});
  const onKey=e=>{if(e.key==='Escape'){close();removeEventListener('keydown',onKey,true);e.stopPropagation()}};addEventListener('keydown',onKey,true)}
/* Ort an Bord in den Tagesplan übernehmen */
function dkAddPlan(n,i){const v=deckOf(n)[2][i];if(!v)return;const tp=D.ports.find(q=>q.date===todayStr());const day=sel!=null?sel:tp?tp.day:(todayOff||1);
  const tab=dkTab,dsel=deckSel,y=($('#dlg')||{}).scrollTop||0;
  closeDlg();setTimeout(()=>{addPointDlg(day,{n:v[0].replace(/\s*\(.*\)$/,''),note:'',dk:n,dv:i,pickDay:1});
    dlgReturn=()=>{deckSel=dsel;dkTab=tab;dkHl=tab==='decks'&&dsel===n?i:null;deckDlg();setTimeout(()=>{const d=$('#dlg');if(d)d.scrollTop=y},30)}},60)}
function dkShow(n,i){dlgReturn=null;closeDlg();setTimeout(()=>{deckSel=n;dkHl=i;dkTab='decks';deckDlg()},60)}
let dkTab='decks';
function deckDlg(){
  const mc=myCab(),mci=mc&&cabInfo(mc);if(deckSel==null)deckSel=mci?mci.d:5;if(!dkFrom&&mc)dkFrom='Unsere Kabine ('+mc+')';
  if(dkHl!=null)dkTab='decks';
  const opts=(mc?`<option value="Unsere Kabine (${mc})">`:'')+SHIP.dk.flatMap(([n,nm,V])=>V.map(v=>`<option value="${esc(v[0])} (Deck ${n})">`)).join('');
  const inp='font:inherit;font-size:16px;padding:10px 12px;border:1px solid var(--line);border-radius:12px;background:var(--bg);color:var(--ink);width:100%';
  openSheet(`<div class="hd"><h3 style="margin:0">Deckplan ${esc(SHIPNAME)}</h3><button class="x" data-close aria-label="Schließen">✕</button></div>
  <div class="dkcabl" id="dkcabl"></div>
  <div class="dktabs" role="tablist">${[['decks','Decks'],['suche','Suchen'],['weg','Weg']].map(([k,t])=>`<button role="tab" data-dkt="${k}" aria-selected="${dkTab===k}">${t}</button>`).join('')}</div>
  <datalist id="dkopts">${opts}</datalist>
  <div id="dkbody"></div>`,d=>{asPage();
    d.classList.add('wide');let route=null,hl=dkHl;dkHl=null;
    const body=d.querySelector('#dkbody');
    const cabLine=()=>{const c=myCab(),ci=c&&cabInfo(c),box=d.querySelector('#dkcabl');
      box.innerHTML=c&&ci?`<span>★ Kabine <b>${c}</b> · Deck ${ci.d} ${esc(ci.name)} · ${posTxt(ci.p)} · ${ci.s?'rechts':'links'}</span><button class="lnk" id="dkced">ändern</button>`:`<span>Keine Kabine eingetragen</span><button class="lnk" id="dkced">Kabine eintragen</button>`;
      box.querySelector('#dkced').onclick=()=>{box.innerHTML=`<input id="dkc" inputmode="numeric" maxlength="4" placeholder="z. B. 8346" value="${c||''}" style="width:110px;${inp}"><button class="chip btn" id="dkcs">Merken</button>${c?'<button class="chip" id="dkcd">Entfernen</button>':''}<button class="lnk" id="dkcx">Abbrechen</button><p class="src bad" id="dkce" style="margin:4px 0 0;width:100%"></p>`;
        const i=box.querySelector('#dkc');i.focus();
        box.querySelector('#dkcs').onclick=()=>{const n=+i.value,x=cabInfo(n);if(!x){box.querySelector('#dkce').textContent='Kabine '+(i.value||'?')+' gibt es im Plan nicht.';return}setCab(n);dkFrom='Unsere Kabine ('+n+')';deckSel=x.d;cabLine();render()};
        const dd=box.querySelector('#dkcd');if(dd)dd.onclick=()=>{const old=myCab();setCab(null);if(/^Unsere Kabine/.test(dkFrom))dkFrom='';cabLine();render();undoToast('Kabine '+old+' entfernt.',()=>{setCab(old);cabLine();render()})};
        box.querySelector('#dkcx').onclick=cabLine;
        i.addEventListener('keydown',e=>{if(e.key==='Enter')box.querySelector('#dkcs').click()})}};
    const stack=()=>`<div class="dkprof" role="tablist" aria-label="Deck wählen">${SHIP.dk.map(([n,nm])=>{const w=n>=12?62:n>=9?82:n<=2?90:100;const c=myCab(),ci=c&&cabMap().get(c);
      return `<button class="dkpr${n===deckSel?' on':''}" data-dk="${n}" style="width:${w}%" aria-label="Deck ${n} ${nm}"><b>${n}</b>${ci&&ci.d===n?'<em>★</em>':''}</button>`}).join('')}</div>`;
    const deckList=(n,h)=>{const L=dkNums(n);if(!L.length)return `<p class="src" style="margin:8px 0">Nur Kabinen (${deckRange(n)}).</p>`;
      return ['Vorne','Mitte','Hinten'].map(sec=>{const G=L.filter(o=>dkSecTxt(o.v[1])===sec);return G.length?`<div class="dkgrp"><h5>${sec}</h5>${G.map(o=>`<button class="dkli${h===o.i?' on':''}" data-dv="${o.i}"><span class="dknb">${o.n}</span><span class="dkic">${DKIND[o.v[2]][0]}</span><span class="dktx"><b>${esc(o.v[0])}</b><small>${sideTxt(o.v[3]||0)}</small>${h===o.i&&o.v[4]?`<span class="dkdesc">${esc(o.v[4])}</span>`:''}</span><span class="dkgo" data-addv="${n}|${o.i}" role="button" aria-label="Zum Tagesplan">+ Tagesplan</span><span class="dkgo" data-way="${n}|${o.i}" role="button" aria-label="Weg dorthin">Weg ›</span></button>`).join('')}</div>`:''}).join('')};
    const summary=n=>{const V=deckOf(n)[2],k=[...new Set(V.map(v=>DKIND[v[2]][1]).filter(Boolean))];return k.length?k.slice(0,5).join(', '):(SHIP.cab[n]?'Kabinen':'')};
    const goWay=(n,i)=>{dkTo=deckOf(n)[2][i][0]+' (Deck '+n+')';dkTab='weg';render(true)};
    let dkSub=false;
    function render(autoRoute){
      d.querySelectorAll('[data-dkt]').forEach(b=>b.setAttribute('aria-selected',b.dataset.dkt===dkTab));
      if(dkTab==='decks'){const dk=deckOf(deckSel);
        body.innerHTML=`<div class="dkhead"><h4>Deck ${dk[0]} · ${dk[1]}</h4><p class="src">${esc(summary(deckSel))}</p></div>
        <div class="dkmain"><div class="dkdraw"><button class="dkbigb" id="dkbig" aria-label="Deck groß ansehen">⤢ Groß</button>${deckSvg(deckSel,{hl})}<div id="dkcinfo" class="dkcinfo">${SHIP.cab[deckSel]?`Kabinen ${deckRange(deckSel)} · zum Anzeigen antippen`:''}</div></div>${stack()}<div class="dklist2">${deckList(deckSel,hl)}</div></div>
        <p class="src" style="margin:12px 0 0">Ort antippen zeigt eine kurze Beschreibung (eigene Zusammenfassung öffentlicher Angaben, ohne Gewähr; Öffnungszeiten im Tagesprogramm). Eigene vereinfachte Darstellung nach dem Katalog-Deckplan. Lage ungefähr. Gerade Kabinennummern links (Backbord), ungerade rechts (Steuerbord). Kein Deck 13.</p>`;
        body.querySelectorAll('[data-dk]').forEach(b=>b.onclick=()=>{deckSel=+b.dataset.dk;hl=null;render()});
        body.querySelector('#dkbig').onclick=()=>dkBig(deckSel,hl);
        body.querySelector('.dkdraw svg').addEventListener('click',e=>{const r=e.target.closest('[data-cab]');if(!r)return;const n=+r.dataset.cab,c=cabInfo(n),box=body.querySelector('#dkcinfo');
          body.querySelectorAll('[data-cab].sel').forEach(x=>x.classList.remove('sel'));r.classList.add('sel');
          box.innerHTML=`<b>Kabine ${n}</b> · ${esc(c.txt.replace(/^Deck \d+ [^·]+· /,''))}<div class="dkcib">${myCab()===n?'<span class="src">★ eure Kabine</span>':`<button class="chip" id="dkcm">Als unsere Kabine merken</button>`}<button class="chip btn" id="dkcw">Weg hierher</button></div>`;
          const m=box.querySelector('#dkcm');if(m)m.onclick=()=>{setCab(n);dkFrom='Unsere Kabine ('+n+')';cabLine();render()};
          box.querySelector('#dkcw').onclick=()=>{dkTo=String(n);dkTab='weg';render(true)}});
        body.querySelectorAll('[data-dv]').forEach(b=>b.onclick=e=>{const ad=e.target.closest('[data-addv]');if(ad){const [n,i]=ad.dataset.addv.split('|').map(Number);dkAddPlan(n,i);return}const w=e.target.closest('[data-way]');if(w){const [n,i]=w.dataset.way.split('|').map(Number);goWay(n,i);return}hl=+b.dataset.dv;render();if(b.classList.contains('dkli'))d.querySelector('.dkdraw').scrollIntoView({block:'nearest',behavior:'smooth'})});
        if(hl!=null)setTimeout(()=>{const x=body.querySelector('.dkli.on');if(x)x.scrollIntoView({block:'nearest'})},40);
      }else if(dkTab==='suche'){
        body.innerHTML=`<div class="sfield"><svg class="sfi" viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg><input id="dkq" type="search" placeholder="Pool, Bar, Theater, Rezeption, Kabine …" value="${esc(deckQ)}" autocomplete="off"><button type="button" class="sfx" aria-label="Eingabe löschen">✕</button></div>
        <div class="dkcats" role="group" aria-label="Kategorien">${Object.entries(DKIND).filter(([k])=>k!=='other'&&SHIP.dk.some(x=>x[2].some(v=>v[2]===k))).map(([k,v])=>`<button class="chip" data-dkc="${k}" aria-pressed="${dkCat===k}">${v[0]} ${v[1]==='Essen'?'Restaurants':v[1]==='Bar'?'Bars':v[1]==='Pool'?'Pools':v[1]}</button>`).join('')}</div>
        <div id="dkres"></div>`;
        const res=()=>{const q=nrm(deckQ.trim()),box=body.querySelector('#dkres');const A=dkPlace(dkFrom),ref=A&&!A.err?A:null;
          if(!q&&!dkCat){box.innerHTML='<p class="src">Kategorie antippen oder Begriff eingeben.</p>';return}
          const L=[];SHIP.dk.forEach(([n,nm,V])=>V.forEach((v,i)=>{if(dkCat&&v[2]!==dkCat)return;if(q&&!nrm(v[0]+' '+DKIND[v[2]][1]+' '+(v[4]||'')).includes(q))return;L.push({n,nm,v,i,m:ref?Math.round((Math.abs(v[1]-ref.p)*2.9+Math.abs(n-ref.d)*10)/5)*5:null})}));
          const cn=/^\d{4}$/.test(deckQ.trim())&&cabInfo(+deckQ.trim());
          if(ref)L.sort((a,b)=>a.m-b.m);
          box.innerHTML=(cn?`<div class="dkr"><span class="dkic">🛏</span><span class="dktx"><b>Kabine ${esc(deckQ.trim())}</b><small>${esc(cn.txt)}</small></span><button class="lnk" data-cshow="${cn.d}">Zeigen ›</button></div>`:'')+(L.length?`<p class="src" style="margin:6px 0">${L.length} Treffer${ref?' · nach Nähe zu '+esc(ref.name):''}</p>`+L.map(o=>{const k=o.n+'|'+o.i,op=dkSrOpen===k;return `<div class="dkr dkr2${op?' open':''}"><div class="dkrh"${o.v[4]?` data-srt="${k}" role="button" tabindex="0" aria-expanded="${op}"`:''}><span class="dkic">${DKIND[o.v[2]][0]}</span><span class="dktx"><b>${esc(o.v[0])}${o.v[4]?' <span class="dib">ⓘ</span>':''}</b><small>Deck ${o.n} · ${posTxt(o.v[1])} · ${sideTxt(o.v[3]||0)}${o.m!=null?' · ca. '+o.m+' m':''}</small>${op?`<span class="dkdesc">${esc(o.v[4])}</span>`:''}</span></div><div class="dkact acts"><button class="lnk" data-show="${k}">Zeigen ›</button><button class="lnk" data-addv2="${k}" aria-label="Zum Tagesplan">+ Tagesplan</button><button class="lnk" data-way2="${k}">Weg ›</button></div></div>`}).join(''):(cn?'':'<p class="empty">Nichts gefunden.</p>'));
          box.querySelectorAll('[data-srt]').forEach(b=>b.onclick=()=>{dkSrOpen=dkSrOpen===b.dataset.srt?null:b.dataset.srt;res()});
          box.querySelectorAll('[data-show]').forEach(b=>b.onclick=()=>{const [n,i]=b.dataset.show.split('|').map(Number);deckSel=n;hl=i;dkTab='decks';render()});
          box.querySelectorAll('[data-cshow]').forEach(b=>b.onclick=()=>{deckSel=+b.dataset.cshow;hl=null;dkTab='decks';render()});
          box.querySelectorAll('[data-addv2]').forEach(b=>b.onclick=()=>{const [n,i]=b.dataset.addv2.split('|').map(Number);dkAddPlan(n,i)});
          box.querySelectorAll('[data-way2]').forEach(b=>b.onclick=()=>{const [n,i]=b.dataset.way2.split('|').map(Number);goWay(n,i)})};
        const qi=body.querySelector('#dkq');qi.oninput=()=>{deckQ=qi.value;res()};
        body.querySelectorAll('[data-dkc]').forEach(b=>b.onclick=()=>{dkCat=dkCat===b.dataset.dkc?null:b.dataset.dkc;body.querySelectorAll('[data-dkc]').forEach(x=>x.setAttribute('aria-pressed',x.dataset.dkc===dkCat));res()});
        res();
      }else{
        body.innerHTML=`<div class="dknav">
          <label>Ich bin hier<input id="dkfrom" list="dkopts" placeholder="Kabinennummer oder Ort" value="${esc(dkFrom)}" style="${inp}"></label>
          <label>Ziel<input id="dkto" list="dkopts" placeholder="z. B. Theater, Pool, Rezeption, 7334" value="${esc(dkTo)}" style="${inp}"></label>
          <div style="display:flex;gap:6px"><button class="chip btn" id="dkgo">Weg anzeigen</button><button class="chip" id="dkswap">⇅ Tauschen</button></div></div><div id="dkroute"></div>`;
        const show=()=>{dkFrom=body.querySelector('#dkfrom').value;dkTo=body.querySelector('#dkto').value;const out=body.querySelector('#dkroute');
          const A=dkPlace(dkFrom),B=dkPlace(dkTo,A&&!A.err?A:null);
          if(!A||!B||A.err||B.err){route=null;out.innerHTML=`<p class="src bad">${esc((A&&A.err)||(B&&B.err)||'Bitte Start und Ziel eingeben.')}</p>`;return}
          const r=dkRoute(A,B);
          out.innerHTML=`<ol class="dksteps">${r.st.map(t=>`<li>${esc(t)}</li>`).join('')}</ol><p class="src" style="margin:4px 0 10px">${r.total?`Gesamt ca. ${r.total} m zu Fuß · ca. ${Math.max(1,Math.round(r.total/60))} Min`:'Kaum Fußweg'}${A.d!==B.d?' plus Aufzug':''}.</p>
          <div class="dkmaps">${A.d===B.d?`<figure><figcaption>Deck ${B.d} · A → B</figcaption>${deckSvg(B.d,{from:A,to:B,lift:r.lift,mini:1})}</figure>`:`<figure><figcaption>Start · Deck ${A.d}</figcaption>${deckSvg(A.d,{from:A,lift:r.lift,mini:1})}</figure><figure><figcaption>Ziel · Deck ${B.d}</figcaption>${deckSvg(B.d,{to:B,lift:r.lift,mini:1})}</figure>`}</div>`};
        body.querySelector('#dkgo').onclick=show;
        ['#dkfrom','#dkto'].forEach(id=>body.querySelector(id).addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();show()}}));
        body.querySelector('#dkswap').onclick=()=>{const f=body.querySelector('#dkfrom'),t=body.querySelector('#dkto');[f.value,t.value]=[t.value,f.value];show()};
        if(dkFrom&&dkTo&&autoRoute!==false)show();
      }
    }
    d.querySelectorAll('[data-dkt]').forEach(b=>b.onclick=()=>{dkTab=b.dataset.dkt;render()});
    cabLine();render();
  });
}
const QZQ=window.__T.QUIZ;
/* ---------- Quiz: feste Fragen + aus den App-Daten erzeugte Fragen, zufällig gemischt ---------- */
const QZ_CAT={a:'🎲 Alles',l:'🌴 Länder',s:'⚓ Schiff',g:'🍹 Getränke',r:'🗺 Reise'};
let QZP=null,qzCat='a',qzCur=null,QZR={};
const qzRnd=a=>a[Math.floor(Math.random()*a.length)];
const qzShuf=a=>{a=a.slice();for(let i=a.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[a[i],a[j]]=[a[j],a[i]]}return a};
const qzLand=l=>String(l||'').replace(/\s*\(.*\)$/,'').replace(/^[^,]*, /,'');
let QZ=(()=>{try{return Object.assign({pts:0,n:0,ok:0,st:0,best:0,rec:[],cat:{},daily:{},day:null},JSON.parse(localStorage.getItem('rp-'+TRIP_ID+'-quiz')||'{}'))}catch(e){return {pts:0,n:0,ok:0,st:0,best:0,rec:[]}}})();
function qzSave(push){try{localStorage.setItem('rp-'+TRIP_ID+'-quiz',JSON.stringify(QZ))}catch(e){}
  if(push&&FBX.user&&dbh&&TS.mode==='db'){clearTimeout(qzSave.t);qzSave.t=setTimeout(()=>{const m=memMe();dbh.collection('plandays').doc('quiz_'+FBX.user.uid).set({quiz:1,uid:FBX.user.uid,name:qzName(),l:m?m.l:'',pts:QZ.pts,n:QZ.n,ok:QZ.ok,best:QZ.best,cat:QZ.cat||{},daily:QZ.daily||{},ts:Date.now()}).catch(()=>{})},1200)}}
function qzName(){const m=memMe();return m?m.n:((typeof FAV!=='undefined'&&FAV.l&&PN[FAV.l])||((FBX.user&&FBX.user.displayName)||'Ich').split(' ')[0])}
function qzRemote(id,x){QZR[id]=x;if(FBX.user&&id==='quiz_'+FBX.user.uid){if(x.n>QZ.n){QZ.pts=x.pts;QZ.n=x.n;QZ.ok=x.ok;QZ.best=Math.max(QZ.best,x.best||0);if(x.cat)QZ.cat=x.cat}QZ.daily=Object.assign({},x.daily||{},QZ.daily||{});qzSave(false)}
  if(document.getElementById('qzroot')&&qzView!=='game'){const r=document.querySelector('.qpod');if(r&&qzView==='lobby')try{quizDlg.refresh&&quizDlg.refresh()}catch(e){}}}
function qzPool(){if(QZP)return QZP;const P=[];
  QZQ.forEach((q,i)=>P.push({k:'m'+i,c:q[0],t:q[0]==='g'?'Getränke':q[0]==='r'?'Eure Reise':'Land & Leute',q:q[1],a:q[2],w:q[3],x:q[4]}));
  const ports=D.ports.filter(p=>p.kind==='port'),lands=[...new Set(ports.map(p=>qzLand(p.land)))],pnames=[...new Set(ports.map(p=>p.name))];
  ports.forEach(p=>{
    P.push({k:'pl'+p.day,c:'l',t:'Häfen',q:'In welchem Land bzw. Gebiet liegt '+p.name+'?',a:qzLand(p.land),w:()=>lands.filter(l=>l!==qzLand(p.land)),x:p.ort});
    P.push({k:'pd'+p.day,c:'r',t:'Eure Route',q:'Welchen '+(CRUISE?'Hafen':'Ort')+' besucht ihr am '+fmtDate(p.date)+'?',a:p.name,w:()=>pnames.filter(n=>n!==p.name),x:'Tag '+p.day+': '+p.name+' ('+qzLand(p.land)+'), Liegezeit '+p.times+'.'});
    if(p.walk)P.push({k:'pw'+p.day,c:'r',t:'Eure Route',q:'Liegezeit in '+p.name+' (Tag '+p.day+')?',a:p.times,w:()=>[...new Set(ports.map(x=>x.times))].filter(t=>t!==p.times),x:p.verdikt||''})});
  // Land & Leute: Land erraten, Namen ausgeblendet
  const MASK=KUL.maskRe?new RegExp(KUL.maskRe,'g'):(()=>{const esc2=x=>x.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');const W=new Set();D.ports.forEach(p=>{if(p.name)p.name.split(/\s*\/\s*/).forEach(x=>x.length>3&&W.add(x));(p.land||'').split(/,\s*/).forEach(x=>{x=x.replace(/\s*\(.*\)$/,'');if(x.length>3)W.add(x)})});Object.keys(KUL.L||{}).forEach(x=>{x=x.replace(/\s*\(.*\)$/,'').replace(/^.*?, /,'');if(x.length>3)W.add(x)});(KUL.mask||[]).forEach(x=>W.add(x));const a=[...W].sort((x,y)=>y.length-x.length).map(esc2);return new RegExp(a.join('|'),'g')})();
  const TOP={g:'Geschichte',p:'Politik & Alltag',k:'Kultur',e:'Essen & Trinken'};
  Object.entries(KUL.L).forEach(([L,o])=>Object.keys(TOP).forEach(t=>(o[t]||[]).forEach((txt,i)=>{const m=txt.replace(MASK,'…');if(m.split('…').length>3||/Turk|^Die … \(Kariben\)/.test(m))return;
    P.push({k:'ku'+L.slice(0,6)+t+i,c:'l',t:'Land & Leute · '+TOP[t],q:'Zu welchem Land passt das?',z:m,a:qzLand(L),w:()=>Object.keys(KUL.L).map(qzLand).filter(x=>x!==qzLand(L)),x:txt})})));
  // Schiff
  if(typeof SHIP!=='undefined'){const all=[];SHIP.dk.forEach(([n,nm,V])=>V.forEach((v,i)=>all.push({n,nm,v,i})));
    const cnt={};all.forEach(o=>{const b=o.v[0].replace(/\s*\(.*\)$/,'');cnt[b]=(cnt[b]||0)+1});
    const decks=SHIP.dk.filter(d=>d[2].length).map(d=>d[0]);
    all.forEach(o=>{const b=o.v[0].replace(/\s*\(.*\)$/,'');if(cnt[b]>1||o.v[2]==='other'&&!o.v[4])return;
      P.push({k:'dv'+o.n+'_'+o.i,c:'s',t:'Deckplan',q:'Auf welchem Deck liegt „'+o.v[0]+'“?',a:'Deck '+o.n,w:()=>decks.filter(d=>d!==o.n).map(d=>'Deck '+d),x:(o.v[4]||'')+' Deck '+o.n+' heißt „'+o.nm+'“, '+posTxt(o.v[1])+'.',dk:o.n+'|'+o.i});
      if(o.v[4])P.push({k:'dd'+o.n+'_'+o.i,c:'s',t:'An Bord',q:'Welcher Ort an Bord ist gemeint?',z:o.v[4].replace(new RegExp(b.split(' ').filter(w=>w.length>3).map(w=>w.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('|')||'^$','g'),'…'),a:o.v[0],w:()=>all.filter(x=>x.v[0]!==o.v[0]&&x.v[2]===o.v[2]).map(x=>x.v[0]).concat(all.filter(x=>x.v[0]!==o.v[0]).map(x=>x.v[0])).slice(0,12),x:'Deck '+o.n+' „'+o.nm+'“, '+posTxt(o.v[1])+'.',dk:o.n+'|'+o.i})});
    SHIP.dk.forEach(([n,nm])=>P.push({k:'dn'+n,c:'s',t:'Deckplan',q:'Welches Deck heißt „'+nm+'“?',a:'Deck '+n,w:()=>SHIP.dk.filter(d=>d[0]!==n).map(d=>'Deck '+d[0]),x:(SHIPNOTE?SHIPNOTE+', ':'')+'Deck '+n+' heißt „'+nm+'“.'}))}
  // Getränke
  if(typeof DRINKS!=='undefined'){const it=[];DRINKS.groups.forEach(g=>g.secs.forEach(s=>s.items.forEach(i=>it.push({g:g.n,s:s.n,i}))));
    const ck=it.filter(o=>o.i.d&&/Cocktail|Sunset/.test(o.g));
    ck.forEach(o=>P.push({k:'gd'+o.i.n,c:'g',t:'Getränkekarte',q:'Welcher Drink enthält: '+o.i.d+'?',a:o.i.n,w:()=>ck.filter(x=>x.i.d!==o.i.d&&x.i.n!==o.i.n).map(x=>x.i.n),x:(o.i.h||'')+(o.i.p?' Preis an Bord: '+o.i.p+'.':'')}));
    it.filter(o=>o.i.h&&o.i.h.length>60&&!(OP!=='Veranstalter'&&o.i.h.includes(OP))&&!/Kreation|Hauskreation/.test(o.i.h)).forEach(o=>{const ws=o.i.n.replace(/\(.*?\)/g,'').split(/[\s&,/]+/).filter(w=>w.length>3&&!/^(Brut|Years|Old|Special|Doc|Docg|Rosé|Extra|Gold)$/i.test(w));
      if(!ws.length)return;const m=o.i.h.replace(new RegExp(ws.map(w=>w.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('|'),'gi'),'…');
      const same=it.filter(x=>x.s===o.s&&x.i.n!==o.i.n).map(x=>x.i.n),grp=it.filter(x=>x.g===o.g&&x.i.n!==o.i.n).map(x=>x.i.n);
      const tw=n=>n.toLowerCase().split(/[^a-zà-ÿ]+/).filter(w=>w.length>4),aw=tw(o.i.n),far=L=>L.filter(n=>!tw(n).some(w=>aw.includes(w))),s2=far(same),g2=far(grp);
      P.push({k:'gh'+o.i.n,c:'g',t:'Getränke-Wissen',q:'Welches Getränk ist gemeint?',z:m,a:o.i.n,w:()=>s2.length>=3?s2:g2,x:o.i.h})})}
  return QZP=P}
function qzNext(){const P=qzPool();const W={l:4,g:3,s:2,r:1};let c=qzCat;
  if(c==='a'){let t=Math.random()*10;for(const k in W){t-=W[k];if(t<0){c=k;break}}}
  let L=P.filter(q=>q.c===c&&!QZ.rec.includes(q.k));if(!L.length){QZ.rec=QZ.rec.filter(k=>!P.some(q=>q.c===c&&q.k===k));L=P.filter(q=>q.c===c)}
  const q=qzRnd(L),wr=qzShuf([...new Set(typeof q.w==='function'?q.w():q.w)].filter(x=>x&&x!==q.a)).slice(0,3);
  QZ.rec.push(q.k);if(QZ.rec.length>150)QZ.rec=QZ.rec.slice(-150);qzSave(false);
  return qzCur={...q,o:qzShuf([q.a,...wr]),done:null}}
/* ---------- Tages-Duell: 5 Fragen, für alle gleich (aus Datum + Reise ausgelost) ---------- */
const qzHash=s=>{let h=2166136261;for(const c of s)h=Math.imul(h^c.charCodeAt(0),16777619);return h>>>0};
const qzRng=seed=>()=>{seed=seed+0x6D2B79F5|0;let t=Math.imul(seed^seed>>>15,1|seed);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296};
function qzDailyQs(){const P=qzPool(),R=qzRng(qzHash(TRIP_ID+'|'+TODAY)),sh=a=>{a=a.slice();for(let i=a.length-1;i>0;i--){const j=Math.floor(R()*(i+1));[a[i],a[j]]=[a[j],a[i]]}return a};
  const cats=sh(['l','l','g','s','r'].filter(c=>P.some(q=>q.c===c)));const used=new Set(),out=[];
  for(const c of cats){const L=P.filter(q=>q.c===c&&!used.has(q.k)).sort((a,b)=>a.k<b.k?-1:1);if(!L.length)continue;const q=L[Math.floor(R()*L.length)];used.add(q.k);
    const wr=sh([...new Set(typeof q.w==='function'?q.w():q.w)].filter(x=>x&&x!==q.a).sort()).slice(0,3);out.push({...q,o:sh([q.a,...wr]),done:null})}
  return out}
let qzMode='free',qzDQ=null;
function qzDay(){const d=QZ.day;return d&&d.date===TODAY?d:null}
/* ---------- Rangliste ---------- */
function qzPeople(){const me=FBX.user?'quiz_'+FBX.user.uid:'me',L=[];
  Object.entries(QZR).forEach(([id,x])=>{if(id!==me&&x&&x.n)L.push({id,uid:x.uid||id.slice(5),name:x.name||'?',l:x.l||'',pts:+x.pts||0,n:+x.n||0,ok:+x.ok||0,best:+x.best||0,cat:x.cat||{},daily:x.daily||{}})});
  const m=memMe();L.push({id:me,uid:FBX.user?FBX.user.uid:'me',me:1,name:qzName(),l:m?m.l:(FAV.l||''),pts:QZ.pts,n:QZ.n,ok:QZ.ok,best:QZ.best,cat:QZ.cat||{},daily:QZ.daily||{}});
  return L.sort((a,b)=>b.pts-a.pts||b.ok-a.ok)}
function qzWins(P){const W={},days=new Set();P.forEach(p=>Object.keys(p.daily||{}).forEach(d=>days.add(d)));const nMem=Math.max(2,MEMBERS.length||PEOPLE.length);
  days.forEach(d=>{const R=P.filter(p=>p.daily[d]&&p.daily[d].done);if(R.length<2||(d>=TODAY&&R.length<nMem))return;
    R.sort((a,b)=>b.daily[d].ok-a.daily[d].ok||a.daily[d].t-b.daily[d].t);W[R[0].id]=(W[R[0].id]||0)+1});return W}
const QZ_BADGES=[
  ['🌴','Länder-Profi','90 % bei Häfen & Ländern (ab 20 Fragen)',p=>{const c=(p.cat||{}).l||{};return [c.n>=20&&c.ok/c.n>=.9,Math.min(c.n||0,20)+'/20'+(c.n?' · '+Math.round(c.ok/c.n*100)+' %':'')]}],
  ['🍹','Barkeeper','90 % bei Getränken (ab 20 Fragen)',p=>{const c=(p.cat||{}).g||{};return [c.n>=20&&c.ok/c.n>=.9,Math.min(c.n||0,20)+'/20'+(c.n?' · '+Math.round(c.ok/c.n*100)+' %':'')]}],
  ['⚓','Schiffskenner','90 % bei Schiff (ab 15 Fragen)',p=>{const c=(p.cat||{}).s||{};return [c.n>=15&&c.ok/c.n>=.9,Math.min(c.n||0,15)+'/15'+(c.n?' · '+Math.round(c.ok/c.n*100)+' %':'')]}],
  ['🗺','Routenkenner','90 % bei Reise (ab 10 Fragen)',p=>{const c=(p.cat||{}).r||{};return [c.n>=10&&c.ok/c.n>=.9,Math.min(c.n||0,10)+'/10'+(c.n?' · '+Math.round(c.ok/c.n*100)+' %':'')]}],
  ['🔥','Serienkönig','10 richtige Antworten in Folge',p=>[p.best>=10,'beste Serie '+(p.best||0)+'/10']],
  ['💯','Perfekter Tag','Tages-Duell mit 5 von 5',p=>{const v=Object.values(p.daily||{}).filter(x=>x.done);return [v.some(x=>x.ok>=5),v.length?'bestes '+Math.max(...v.map(x=>x.ok))+'/5':'noch kein Duell']}],
  ['⚡','Blitzmerker','5 von 5 im Tages-Duell in unter 60 Sekunden',p=>{const v=Object.values(p.daily||{}).filter(x=>x.done&&x.ok>=5);return [v.some(x=>x.t<60000),v.length?'schnellste 5/5: '+Math.round(Math.min(...v.map(x=>x.t))/1000)+' s':'noch keine 5/5']}],
  ['🏆','Tagessieger','Ein Tages-Duell gewonnen',(p,w)=>[w>=1,(w||0)+'/1 Siege']],
  ['👑','Dauerchampion','5 Tages-Duelle gewonnen',(p,w)=>[w>=5,(w||0)+'/5 Siege']],
  ['🎓','Fleißig','100 Fragen beantwortet',p=>[p.n>=100,Math.min(p.n,100)+'/100']]];
function qzBadgesOf(p,w){return QZ_BADGES.map(([i,n,d,f])=>{const [ok,pr]=f(p,w);return {i,n,d,ok,pr}})}
function qzBoard(){const P=qzPeople(),W=qzWins(P),top=P[0]?P[0].pts:0,multi=P.length>1;
  return '<div class="qlb">'+P.map((p,i)=>{const pc=p.n?Math.round(p.ok/p.n*100):0,bd=qzBadgesOf(p,W[p.id]).filter(b=>b.ok).map(b=>b.i).join('');
    return '<div class="qlr'+(p.me?' me':'')+'"><span class="qlp">'+(multi?(i===0&&p.pts>0?'👑':(i+1)+'.'):'')+'</span><span class="tav" style="background:'+pColor(p.name)+'">'+esc(p.l||p.name[0]||'?')+'</span><div class="qlm"><b>'+esc(p.name)+(p.me?' <small>(du)</small>':'')+'</b><small>'+pc+' % richtig · beste Serie '+p.best+(W[p.id]?' · 🏆 '+W[p.id]:'')+(bd?' · '+bd:'')+'</small>'+(multi?'<i class="qlbar"><i style="width:'+(top?Math.round(p.pts/top*100):0)+'%;background:'+pColor(p.name)+'"></i></i>':'')+'</div><b class="qlpts">'+p.pts+'</b></div>'}).join('')+'</div>'}
function qzDuelHTML(short){const P=qzPeople(),me=P.find(p=>p.me),d=qzDay(),R=P.filter(p=>p.daily[TODAY]&&p.daily[TODAY].done).sort((a,b)=>b.daily[TODAY].ok-a.daily[TODAY].ok||a.daily[TODAY].t-b.daily[TODAY].t),W=qzWins(P);
  const done=!!(me.daily[TODAY]&&me.daily[TODAY].done),run=d&&!done&&d.i>0;
  const res=R.length?R.map((p,i)=>(i===0&&R.length>1?'🏆 ':'')+esc(p.name)+' <b>'+p.daily[TODAY].ok+'/5</b>'+(short?'':' · '+Math.round(p.daily[TODAY].t/1000)+' s')).join(' · '):'Noch niemand hat heute gespielt.';
  const open=PEOPLE.filter(n=>!R.some(p=>p.name===n));
  const wins=Object.keys(W).length?'Tagessiege: '+P.filter(p=>W[p.id]).sort((a,b)=>W[b.id]-W[a.id]).map(p=>esc(p.name)+' '+W[p.id]).join(' · '):'';
  return {done,run,res,open,wins}}
function qzAnswer(q,i){q.done=i;const r=q.o[i]===q.a;const before=qzPeople();
  QZ.n++;QZ.cat=QZ.cat||{};const c=QZ.cat[q.c]||(QZ.cat[q.c]={n:0,ok:0});c.n++;
  if(r){QZ.ok++;c.ok++;QZ.pts+=10;QZ.st++;QZ.best=Math.max(QZ.best,QZ.st)}else QZ.st=0;
  // Live-Momente: überholt / knapp dahinter
  const mb=before.find(p=>p.me),passed=before.filter(p=>!p.me&&p.pts>=mb.pts&&p.pts<QZ.pts);
  q.live='';if(passed.length){undoToast('🎉 Du hast '+passed.map(p=>p.name).join(' und ')+' überholt!',null,2800)}
  else{const lead=before.filter(p=>!p.me).sort((a,b)=>b.pts-a.pts)[0];if(lead&&lead.pts===QZ.pts)q.live='🤝 Gleichstand mit '+lead.name+'!';else if(lead&&lead.pts>QZ.pts&&lead.pts-QZ.pts<=30)q.live='👀 Nur noch '+(lead.pts-QZ.pts)+' Punkte hinter '+lead.name+'.'}
  return r}
let qzView='lobby';
/* Quiz als Vollbild: Start („Lobby“) → Spiel / Rangliste / Abzeichen */
function quizDlg(mode){
  if(mode==='daily'){qzMode='daily';qzCur=null;qzView='game'}else{qzView='lobby';if(!(qzMode==='daily'&&qzDay()&&!qzDay().done))qzMode='free'}
  openSheet('<div id="qzroot"></div>',d=>{
    $('#dlg').classList.add('full');const root=d.querySelector('#qzroot');let b=null;
    const toLobby=()=>{if(qzCur&&qzCur.done!=null)qzCur=null;qzView='lobby';render();d.scrollTop=0};
    const go=v=>{if(v==='lobby'){popSub();toLobby();return}if(qzView==='lobby')pushSub(toLobby);qzView=v;render();d.scrollTop=0};
    const sub=(t)=>'<div class="qgh"><button class="qbk" data-back aria-label="Zurück">‹</button><span class="qgm">'+t+'</span><span class="qgp">⭐ '+QZ.pts+'</span></div>';
    const lobby=()=>{const P=qzPeople(),W=qzWins(P),me=P.find(p=>p.me),i=P.indexOf(me),s=qzDuelHTML(),B=qzBadgesOf(me,W[me.id]);
      const ord=P.length>1?[P[1],P[0],...P.slice(2,5)]:[P[0]];
      const pod=ord.map(p=>{const lead=p===P[0]&&p.pts>0&&P.length>1;return '<div class="qpp'+(lead?' lead':'')+'"><span class="qpc">'+(lead?'👑':'')+'</span><span class="qpa" style="background:'+pColor(p.name)+'">'+esc(p.l||p.name[0]||'?')+'</span><small>'+esc(p.me?'Du':p.name)+'</small><b>'+p.pts+'</b></div>'}).join('');
      const duel=s.done?'<div class="qlc duel done"><span class="qli">🏆</span><div><b>Tages-Duell</b><small>'+s.res+'</small>'+(s.wins?'<small>'+s.wins+'</small>':'')+'<button class="lnk" data-v="duel" style="padding:6px 0 0">Ergebnisse ansehen ›</button></div></div>'
        :'<div class="qlc duel"><span class="qli">🏆</span><div><b>Tages-Duell <i class="qdot"></i></b><small>'+(s.res.indexOf('Noch niemand')<0?s.res+' · du bist noch offen':'5 Fragen, heute für alle gleich')+'</small></div><button class="chip btn" id="qzdgo">'+(s.run?'Weiter':'Spielen')+'</button></div>';
      root.innerHTML='<div class="qlh"><div class="qlht"><b>Quiz</b><button class="x" data-x aria-label="Schließen">✕</button></div><div class="qpod">'+pod+'</div></div>'+
        '<div class="qlw">'+duel+'<h4 class="qh">Freies Spiel</h4><div class="qgcats">'+Object.entries(QZ_CAT).map(([k,v])=>{const [ic,...t]=v.split(' ');return '<button class="qgc" data-c="'+k+'"><span>'+ic+'</span><small>'+t.join(' ')+'</small></button>'}).join('')+'</div>'+
        '<h4 class="qh">Dein Fortschritt</h4><div class="qrow"><button class="qmc" data-v="rank"><b>📊 Rangliste</b><small>'+(P.length>1?(i+1)+'. Platz · ':'')+(me.n?Math.round(me.ok/me.n*100):0)+' % richtig</small></button><button class="qmc" data-v="badge"><b>🏅 Abzeichen</b><small>'+B.filter(x=>x.ok).length+' von '+B.length+'</small></button></div></div>';
      root.querySelector('[data-x]').onclick=()=>{if(SUBS.length)history.back();else closeDlg()};
      const g=root.querySelector('#qzdgo');if(g)g.onclick=()=>{qzMode='daily';qzCur=null;go('game')};
      root.querySelectorAll('[data-c]').forEach(x=>x.onclick=()=>{qzMode='free';qzCat=x.dataset.c;qzCur=null;go('game')});
      root.querySelectorAll('[data-v]').forEach(x=>x.onclick=()=>go(x.dataset.v))};
    const drawQ=()=>{let q,head;
      if(qzMode==='daily'){qzDQ=qzDQ||qzDailyQs();let st=qzDay();if(!st){st=QZ.day={date:TODAY,i:0,ok:0,t0:Date.now(),t:0,res:[]};qzSave(false)}
        if(!(qzCur&&qzCur.daily)){if(st.done||st.i>=qzDQ.length){qzMode='free';qzCur=null;return go('lobby')}qzCur=Object.assign({},qzDQ[st.i],{daily:1,idx:st.i,done:null})}
        q=qzCur;head='Frage '+(q.idx+1)+' von '+qzDQ.length+' · '+esc(q.t)}
      else{if(qzCur&&qzCur.daily)qzCur=null;q=qzCur||qzNext();head=esc(q.t)}
      const st=qzDay(),prog=qzMode==='daily'&&qzDQ?'<div class="qprog">'+qzDQ.map((x,i)=>{const r=st&&st.res&&st.res[i];return '<i class="'+(r===true?'ok':r===false?'bad':i===q.idx?'cur':'')+'"></i>'}).join('')+'</div>':'';
      const long=q.o.some(x=>x.length>26),last=!!(q.daily&&q.idx>=qzDQ.length-1);
      root.querySelector('.qgp').textContent='⭐ '+QZ.pts;
      b.innerHTML=prog+'<div class="qqc"><small>'+head+'</small><h2>'+esc(q.q)+'</h2>'+(q.z?'<blockquote class="qzz">'+esc(q.z)+'</blockquote>':'')+'</div>'+
       '<div class="qzo'+(long?' one':'')+'">'+q.o.map((o,i)=>'<button data-o="'+i+'" class="'+(q.done!=null?(o===q.a?'ok':i===q.done?'bad':'dim'):'')+'"'+(q.done!=null?' disabled':'')+'>'+esc(o)+'</button>').join('')+'</div>'+
       (q.done!=null?'<div class="qzx '+(q.o[q.done]===q.a?'ok':'bad')+'"><b>'+(q.o[q.done]===q.a?'✓ Richtig! +10':'✗ Leider falsch. Richtig ist: '+esc(q.a))+'</b>'+(q.x?'<p>'+esc(q.x)+'</p>':'')+(q.live?'<p><b>'+esc(q.live)+'</b></p>':'')+(q.dk?'<span class="lnk" data-dkgo="'+q.dk+'" role="link" tabindex="0">Im Deckplan zeigen ›</span>':'')+'</div><div class="qznw"><button class="chip btn qzn" id="qzn">'+(q.daily?(last?'Ergebnis ansehen ›':'Nächste Duell-Frage ›'):'Nächste Frage ›')+'</button></div>':'')};
    const game=()=>{root.innerHTML=sub(qzMode==='daily'?'🏆 Tages-Duell':QZ_CAT[qzCat])+'<div id="qzb" class="qgw"></div>';b=root.querySelector('#qzb');
      b.addEventListener('click',e=>{const o=e.target.closest('[data-o]');if(o&&qzCur&&qzCur.done==null){const r=qzAnswer(qzCur,+o.dataset.o);
          if(qzCur.daily){const st=qzDay();st.res=st.res||[];st.res[qzCur.idx]=r;st.ans=st.ans||[];st.ans[qzCur.idx]=qzCur.o[qzCur.done];if(r)st.ok++;st.i++;if(st.i>=qzDQ.length){st.done=1;st.t=Date.now()-st.t0;QZ.daily=QZ.daily||{};QZ.daily[TODAY]={ok:st.ok,t:st.t,done:1,res:st.res.map(x=>x?1:0),ans:st.ans.slice()}}}
          qzSave(true);drawQ();const x=b.querySelector('.qzx');if(x)requestAnimationFrame(()=>x.scrollIntoView({block:'nearest',behavior:'smooth'}));return}
        if(e.target.closest('#qzn')){const wasDaily=qzCur&&qzCur.daily;qzCur=null;
          if(wasDaily&&qzDay()&&qzDay().done){qzMode='free';const s=qzDay();undoToast('Tages-Duell beendet: '+s.ok+' von 5 richtig in '+Math.round(s.t/1000)+' s.',null,3500);go('lobby')}else{drawQ();d.scrollTop=0}}});
      drawQ()};
    const render=()=>{
      if(qzView==='game')game();
      else if(qzView==='duel'){const P=qzPeople().filter(p=>p.daily[TODAY]&&p.daily[TODAY].done).sort((a,b)=>b.daily[TODAY].ok-a.daily[TODAY].ok||a.daily[TODAY].t-b.daily[TODAY].t),Q=qzDQ||(qzDQ=qzDailyQs());
        const me=P.find(p=>p.me),mine=me?me.daily[TODAY]:null;
        const head='<div class="qdr">'+P.map((p,i)=>'<div class="qdp"><span class="qpa" style="background:'+pColor(p.name)+'">'+esc(p.l||p.name[0]||'?')+'</span><b>'+(i===0&&P.length>1?'🏆 ':'')+esc(p.me?'Du':p.name)+'</b><small>'+p.daily[TODAY].ok+'/5 · '+Math.round(p.daily[TODAY].t/1000)+' s</small></div>').join('')+'</div>';
        const qs=!me?'<p class="src">Spiel zuerst selbst, dann siehst du die Antworten der anderen.</p>':Q.map((q,i)=>'<div class="qdq"><small>Frage '+(i+1)+' · '+esc(q.t)+'</small><b>'+esc(q.q)+'</b><p class="src" style="margin:2px 0 6px">Richtig: <b>'+esc(q.a)+'</b></p>'+P.map(p=>{const d=p.daily[TODAY],r=d.res?d.res[i]:null,a=d.ans?d.ans[i]:null;return '<div class="qda'+(r===1?' ok':r===0?' bad':'')+'"><span>'+(r===1?'✓':r===0?'✗':'·')+'</span>'+esc(p.me?'Du':p.name)+(a&&r===0?' <small>– '+esc(a)+'</small>':'')+(r==null?' <small>(alte Version, keine Einzelergebnisse)</small>':'')+'</div>'}).join('')+'</div>').join('');
        root.innerHTML=sub('🏆 Tages-Duell heute')+'<div class="qgw">'+(P.length?head+qs:'<p class="src">Heute hat noch niemand gespielt.</p>')+'</div>'}
      else if(qzView==='rank'){const s=qzDuelHTML();root.innerHTML=sub('📊 Rangliste')+'<div class="qgw">'+qzBoard()+(s.wins?'<p class="src" style="margin:4px 0 0">🏆 '+s.wins+'</p>':'')+'</div>'}
      else if(qzView==='badge'){const P=qzPeople(),W=qzWins(P),me=P.find(p=>p.me),B=qzBadgesOf(me,W[me.id]);
        root.innerHTML=sub('🏅 Abzeichen')+'<div class="qgw"><p class="src" style="margin:0 0 8px">'+B.filter(x=>x.ok).length+' von '+B.length+' erreicht</p><div class="qbg" style="padding:0">'+B.map(x=>'<div class="qbd'+(x.ok?' ok':'')+'"><span class="qbi">'+x.i+'</span><b>'+esc(x.n)+'</b><small>'+esc(x.d)+'</small><small class="qbp">'+(x.ok?'✓ erreicht':esc(x.pr))+'</small></div>').join('')+'</div></div>'}
      else lobby();
      const bk=root.querySelector('[data-back]');if(bk)bk.onclick=()=>{if(subDepth>0)history.back();else toLobby()}};
    if(qzView!=='lobby')pushSub(toLobby);
    render()})}
/* Karte „Tages-Duell“ in Mein Tag */
function duelCard(){if(!qzPool().length)return '';const s=qzDuelHTML(1);
  return '<div class="hc" id="duelc" style="margin:12px 0"><b>🏆 Tages-Duell</b><span>'+(s.done?'Du hast heute schon gespielt':'5 Quizfragen, für alle gleich')+'</span><small>'+s.res+'</small>'+(s.wins?'<small>'+s.wins+'</small>':'')+'<button class="lnk" id="duelgo">'+(s.done?'Quiz öffnen ›':'Mitspielen ›')+'</button></div>'}
/* ---------- Spiele-Lobby ---------- */
function gamesDlg(){
  const sp=spLoad(),st=spStats(),s=qzDuelHTML(),dl=!s.done;
  const won=[1,2,4].reduce((a,k)=>a+((st[k]||{}).won||0),0);
  openSheet('<div class="hd"><h3 style="margin:0">Spiele</h3><button class="x" data-close aria-label="Schließen">✕</button></div>'+
   '<div class="glob"><button class="gtile" data-g="quiz"><span class="gti">🎯</span><b>Quiz</b><small>'+QZ.pts+' Punkte'+(dl?' · <span class="gdot"></span> Tages-Duell offen':' · Duell gespielt')+'</small></button>'+
   '<button class="gtile" data-g="spider"><span class="gti">🕷</span><b>Spider Solitaire</b><small>'+(sp&&!sp.won?'Spiel fortsetzen · '+sp.done.length+'/8 Reihen':'Neues Spiel')+(won?' · '+won+' gewonnen':'')+'</small></button></div>'+
   '<p class="src" style="text-align:center;margin:14px 0 0">Alle Spiele funktionieren auch offline.</p>',d=>{asPage();
    d.querySelector('[data-g=quiz]').onclick=()=>subOpen(gamesDlg,()=>quizDlg());
    d.querySelector('[data-g=spider]').onclick=()=>subOpen(gamesDlg,()=>spiderDlg())})}
/* ---------- Spider Solitaire (eigene Umsetzung) ---------- */
const SP_SUIT=['♠','♥','♦','♣'],SP_RED=[0,1,1,0],SP_RANK=['','A','2','3','4','5','6','7','8','9','10','B','D','K'];
function spLoad(){try{return JSON.parse(localStorage.getItem('rp-spider')||'null')}catch(e){return null}}
function spSave(g){try{localStorage.setItem('rp-spider',JSON.stringify(g));localStorage.setItem('rp-spider-ts',String(Date.now()))}catch(e){}spPushSoon()}
function spStats(){try{return JSON.parse(localStorage.getItem('rp-spider-stats')||'{}')}catch(e){return {}}}
function spStatSet(f){const s=spStats();f(s);try{localStorage.setItem('rp-spider-stats',JSON.stringify(s));localStorage.setItem('rp-spider-stats-ts',String(Date.now()))}catch(e){}spPushSoon()}
function spNew(n){const suits=n===1?[0]:n===2?[0,1]:[0,1,2,3],deck=[];for(let k=0;k<8;k++){const su=suits[k%suits.length];for(let r=1;r<=13;r++)deck.push({s:su,r,u:0})}
  for(let i=deck.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[deck[i],deck[j]]=[deck[j],deck[i]]}
  const cols=[];for(let c=0;c<10;c++){const k=c<4?6:5,col=deck.splice(0,k);col[col.length-1].u=1;cols.push(col)}
  spStatSet(s=>{const x=s[n]=s[n]||{};x.played=(x.played||0)+1});
  return {n,cols,stock:deck,done:[],moves:0,score:500,ms:0,hist:[],won:0}}
const spRunOk=(col,i)=>{if(!col[i]||!col[i].u)return false;for(let k=i;k<col.length-1;k++){const a=col[k],b=col[k+1];if(!b.u||b.s!==a.s||b.r!==a.r-1)return false}return true};
const spCanDrop=(col,card)=>!col.length||(col[col.length-1].u&&col[col.length-1].r===card.r+1);
function spSnap(g){g.hist.push(JSON.stringify({cols:g.cols,stock:g.stock,done:g.done,moves:g.moves,score:g.score}));if(g.hist.length>150)g.hist.shift()}
function spAfter(g,c){const col=g.cols[c];
  if(col.length>=13){const t=col.slice(-13);if(t.every((x,i)=>x.u&&x.s===t[0].s&&x.r===13-i)){col.splice(-13);g.done.push(t[0].s);g.score+=100;g.lastDone=Date.now()}}
  if(col.length&&!col[col.length-1].u)col[col.length-1].u=1}
function spMove(g,from,i,to){const src=g.cols[from],run=src.slice(i);if(from===to||!spRunOk(src,i)||!spCanDrop(g.cols[to],run[0]))return false;
  spSnap(g);src.splice(i);g.cols[to].push(...run);g.moves++;g.score=Math.max(0,g.score-1);spAfter(g,from);spAfter(g,to);return true}
function spDeal(g){if(!g.stock.length)return 'Der Stapel ist leer.';if(g.cols.some(c=>!c.length))return 'Vor dem Austeilen müssen alle Spalten belegt sein.';
  spSnap(g);for(let c=0;c<10;c++){const x=g.stock.shift();x.u=1;g.cols[c].push(x)}g.moves++;g.score=Math.max(0,g.score-1);for(let c=0;c<10;c++)spAfter(g,c);return ''}
function spBest(g,from,i){const run=g.cols[from].slice(i),c0=run[0];const cand=[];
  g.cols.forEach((col,c)=>{if(c===from||!spCanDrop(col,c0))return;const t=col[col.length-1];cand.push({c,p:!col.length?(i===0?-1:1):t.s===c0.s?3:2})});
  cand.sort((a,b)=>b.p-a.p);return cand.length&&cand[0].p>=0?cand[0].c:-1}
function spHint(g){let best=null;
  g.cols.forEach((col,f)=>{for(let i=0;i<col.length;i++){if(!spRunOk(col,i))continue;const c0=col[i],below=col[i-1];
    g.cols.forEach((t,c)=>{if(c===f||!t.length||!spCanDrop(t,c0))return;const same=t[t.length-1].s===c0.s,free=!below||!below.u||below.r!==c0.r+1||below.s!==c0.s;
      if(!free&&!same)return;const sc=(same?4:1)+(below&&!below.u?3:0)+(i===0?2:0);if(!best||sc>best.sc)best={f,i,c,sc}});break}});
  if(!best){const e=g.cols.findIndex(c=>!c.length);if(e>=0){for(let f=0;f<10;f++){const col=g.cols[f];for(let i=1;i<col.length;i++)if(spRunOk(col,i)){best={f,i,c:e};break}if(best)break}}}
  return best}
function spiderDlg(){
  let g=spLoad();if(g&&g.won)g=null;let timer=0,sel=null;
  openSheet('<div id="sproot"></div>',d=>{
    $('#dlg').classList.add('full');const root=d.querySelector('#sproot');
    const fmtT=ms=>{const s=Math.floor(ms/1000);return Math.floor(s/60)+':'+String(s%60).padStart(2,'0')};
    const start=()=>{const st=spStats();clearInterval(timer);
      root.innerHTML='<div class="qgh"><button class="qbk" data-back aria-label="Zurück">‹</button><span class="qgm">🕷 Spider Solitaire</span></div><div class="qgw"><h4 class="qh" style="margin:6px 2px 10px">Neues Spiel – Schwierigkeit</h4>'+
        [[1,'1 Farbe','leicht · nur ♠'],[2,'2 Farben','mittel · ♠ ♥'],[4,'4 Farben','schwer · ♠ ♥ ♦ ♣']].map(([n,t,s])=>{const x=st[n]||{};return '<button class="qlc spdiff" data-n="'+n+'"><span class="qli">'+['','♠','♠♥','','♠♥♦♣'][n]+'</span><div><b>'+t+'</b><small>'+s+(x.played?' · '+(x.won||0)+' von '+x.played+' gewonnen'+(x.best?' · Bestzeit '+fmtT(x.best):''):'')+'</small></div></button>'}).join('')+
        '<p class="src" style="margin:14px 2px 0;line-height:1.5">Ziel: Karten in absteigender Reihe vom König bis zum Ass in derselben Farbe sammeln – vollständige Reihen verschwinden. Antippen schiebt eine Karte an die beste Stelle, mit dem Finger kannst du sie auch selbst ziehen.</p></div>';
      root.querySelector('[data-back]').onclick=()=>history.back();
      root.querySelectorAll('[data-n]').forEach(b=>b.onclick=()=>{g=spNew(+b.dataset.n);spSave(g);play()})};
    const play=()=>{
      root.innerHTML='<div class="sph"><button class="qbk" data-back aria-label="Zurück">‹</button><div class="spst"><span id="spm"></span><span id="sps"></span><span id="spt"></span></div><div class="spf" id="spf"></div></div><div class="spb" id="spb"></div>'+
        '<div class="spbar"><button data-a="new">🔄<small>Neu</small></button><button data-a="undo">↩<small>Zurück</small></button><button data-a="hint">💡<small>Tipp</small></button><button data-a="deal" class="spdeal"><span id="spk"></span><small>Austeilen</small></button></div>';
      const board=root.querySelector('#spb');
      root.querySelector('[data-back]').onclick=()=>history.back();
      const bar=k=>root.querySelector('[data-a='+k+']');
      bar('new').onclick=()=>{if(g.moves&&!g.won&&!confirm('Aktuelles Spiel aufgeben und neu starten?'))return;g=null;spSave(null);start()};
      bar('undo').onclick=()=>{if(!g.hist.length)return;const h=JSON.parse(g.hist.pop());Object.assign(g,h);g.moves++;spSave(g);draw()};
      bar('hint').onclick=()=>{const h=spHint(g);if(!h){undoToast(g.stock.length?'Kein Zug gefunden – Karten austeilen.':'Kein Zug mehr möglich.',null,2500);return}flash(h.f,h.i,h.c)};
      bar('deal').onclick=()=>{const m=spDeal(g);if(m){undoToast(m,null,2500);return}spSave(g);draw(true);check()};
      let L={};
      const draw=anim=>{const W=board.clientWidth,H=board.clientHeight,gap=Math.max(3,Math.round(W*.008)),cw=Math.floor((W-gap*9)/10),ch=Math.round(cw*1.42);
        L={W,cw,ch,gap};let h='';
        g.cols.forEach((col,c)=>{const x=c*(cw+gap),nd=col.filter(k=>!k.u).length,nu=col.length-nd;let dn=Math.round(cw*.2),up=Math.round(cw*.48);
          const need=ch+nd*dn+Math.max(0,nu-1)*up;if(need>H-4){const k=(H-4-ch-nd*dn)/Math.max(1,(nu-1)*up);up=Math.max(9,Math.floor(up*Math.min(1,k)));if(ch+nd*dn+(nu-1)*up>H-4)dn=Math.max(3,Math.floor((H-4-ch-(nu-1)*up)/Math.max(1,nd)))}
          L['c'+c]={x,dn,up};h+='<div class="spslot" style="left:'+x+'px;width:'+cw+'px;height:'+ch+'px" data-col="'+c+'"></div>';
          let y=0;col.forEach((k,i)=>{h+=k.u?'<div class="spc'+(SP_RED[k.s]?' red':'')+'" data-c="'+c+'" data-i="'+i+'" style="left:'+x+'px;top:'+y+'px;width:'+cw+'px;height:'+ch+'px;font-size:'+Math.round(cw*.34)+'px"><span class="spr">'+SP_RANK[k.r]+'<i>'+SP_SUIT[k.s]+'</i></span><span class="spbig">'+SP_SUIT[k.s]+'</span></div>':'<div class="spc back" style="left:'+x+'px;top:'+y+'px;width:'+cw+'px;height:'+ch+'px"></div>';y+=k.u?up:dn})});
        board.innerHTML=h;
        root.querySelector('#spm').textContent=g.moves+' Züge';root.querySelector('#sps').textContent=g.score+' Pkt.';
        root.querySelector('#spk').innerHTML=Array.from({length:Math.min(5,g.stock.length/10)},()=>'<i></i>').join('')||'–';
        bar('deal').disabled=!g.stock.length;bar('undo').disabled=!g.hist.length;
        root.querySelector('#spf').innerHTML=g.done.map(s=>'<span class="'+(SP_RED[s]?'red':'')+'">'+SP_SUIT[s]+'</span>').join('')+'<small>'+g.done.length+'/8</small>'};
      const flash=(f,i,c)=>{board.querySelectorAll('[data-c="'+f+'"]').forEach(e=>{if(+e.dataset.i>=i)e.classList.add('hint')});const s=board.querySelector('[data-col="'+c+'"]'),t=board.querySelectorAll('[data-c="'+c+'"]');(t.length?t[t.length-1]:s).classList.add('hint');setTimeout(()=>board.querySelectorAll('.hint').forEach(e=>e.classList.remove('hint')),1200)};
      const check=()=>{if(g.lastDone&&Date.now()-g.lastDone<1500&&g.done.length<8){if(navigator.vibrate)try{navigator.vibrate(30)}catch(e){}}
        if(g.done.length===8&&!g.won){g.won=1;spSave(g);clearInterval(timer);spStatSet(s=>{const x=s[g.n]=s[g.n]||{};x.won=(x.won||0)+1;if(!x.best||g.ms<x.best)x.best=g.ms});
          const o=document.createElement('div');o.className='spwin';o.innerHTML='<div><div style="font-size:52px">🏆</div><h3>Gewonnen!</h3><p>'+fmtT(g.ms)+' · '+g.moves+' Züge · '+g.score+' Punkte</p><button class="chip btn" data-w>Neues Spiel</button></div>';root.appendChild(o);
          o.querySelector('[data-w]').onclick=()=>{g=null;spSave(null);start()}}};
      // Antippen = automatisch bester Platz; Ziehen = selbst ablegen
      let drag=null;
      board.onpointerdown=e=>{const el=e.target.closest('.spc[data-c]');if(!el)return;const c=+el.dataset.c,i=+el.dataset.i;if(!spRunOk(g.cols[c],i)){el.classList.add('no');setTimeout(()=>el.classList.remove('no'),300);return}
        drag={c,i,x0:e.clientX,y0:e.clientY,els:[...board.querySelectorAll('[data-c="'+c+'"]')].filter(x=>+x.dataset.i>=i),moved:false,id:e.pointerId};board.setPointerCapture(e.pointerId)};
      board.onpointermove=e=>{if(!drag||e.pointerId!==drag.id)return;const dx=e.clientX-drag.x0,dy=e.clientY-drag.y0;if(!drag.moved&&Math.hypot(dx,dy)<8)return;drag.moved=true;
        drag.els.forEach(x=>{x.style.transform='translate('+dx+'px,'+dy+'px)';x.classList.add('drag')})};
      const end=e=>{if(!drag||e.pointerId!==drag.id)return;const dr=drag;drag=null;
        if(!dr.moved){const to=spBest(g,dr.c,dr.i);if(to>=0&&spMove(g,dr.c,dr.i,to)){spSave(g);draw();check()}else{dr.els.forEach(x=>{x.classList.add('no');setTimeout(()=>x.classList.remove('no'),300)})}return}
        const r=board.getBoundingClientRect(),to=Math.max(0,Math.min(9,Math.floor((e.clientX-r.left)/(L.cw+L.gap))));
        if(spMove(g,dr.c,dr.i,to)){spSave(g);draw();check()}else{dr.els.forEach(x=>{x.style.transition='transform .18s';x.style.transform=''});setTimeout(draw,200)}};
      board.onpointerup=end;board.onpointercancel=end;
      clearInterval(timer);let t0=Date.now();timer=setInterval(()=>{if(!document.getElementById('spt')){clearInterval(timer);return}if(document.hidden||g.won){t0=Date.now();return}g.ms+=Date.now()-t0;t0=Date.now();root.querySelector('#spt').textContent=fmtT(g.ms);if(g.ms%10000<1000)spSave(g)},1000);
      root.querySelector('#spt').textContent=fmtT(g.ms);
      requestAnimationFrame(()=>draw());addEventListener('resize',()=>{if(document.getElementById('spb'))draw()})};
    if(g)play();else start()})}
let dkSrOpen=null;

/* ---------- An Bord: Sammelseite für alles auf dem Schiff ---------- */
function showBord(fromHash){if(fromHash!==true)saveScroll();mappeView=false;todoView=true;bordView=true;tripView=false;todayView=false;sel=null;renderDays();renderBar();drawOverview();renderPanel();$('#panel').scrollTop=0;if(fromHash!==true)nav('#bord');navMark()}
function bordDay(){const t=D.ports.find(q=>q.date===TODAY);return t&&t.kind!=='end'?t:D.ports[0]}
function bordPanel(){const p=bordDay(),r=dinRow(p),v=dinVenue(),c=myCab(),ci=c&&cabInfo(c),isT=p.date===TODAY;
  const nFav=typeof FAV!=='undefined'?FAV.k.size:0;
  const din=DIN.at?`<div class="btile wide" data-bo="din"><div class="bti">🍽</div><div class="btx"><small>${isT?'Abendessen heute':'Abendessen · Tag '+p.day}</small><b>${r&&r.skip?'heute ausgelassen':hm(r.a)+'–'+hm(r.b)+' Uhr'}</b><span>${v?esc(dinName())+' · Deck '+DIN.dk:'Restaurant noch offen'}${DIN.table?' · Tisch '+esc(DIN.table):''}</span><div class="acts">${v?`<span class="lnk" data-dkgo="${DIN.dk}|${DIN.dv}">Deckplan ›</span>`:''}${v&&c?'<span class="lnk" data-bo="dinway">Weg ›</span>':''}</div></div></div>`
    :`<div class="btile wide" data-bo="dinset"><div class="bti">🍽</div><div class="btx"><small>Abendessen</small><b>Tischzeit eintragen</b><span>Uhrzeit und Restaurant aus den Reiseunterlagen</span></div></div>`;
  const cab=`<div class="btile wide" data-bo="cab"><div class="bti">🛏</div><div class="btx"><small>Unsere Kabine</small><b>${c?'Kabine '+c:'Noch nicht eingetragen'}</b><span>${ci?esc(ci.txt):'Antippen zum Eintragen'}</span></div></div>`;
  const t=(k,ic,h,sub)=>`<button class="btile" data-bo="${k}"><div class="bti">${ic}</div><div class="btx"><b>${h}</b><span>${sub}</span></div></button>`;
  const cats=['bar','food','pool','show','spa','sun','shop','service'];
  return `<div class="eyebrow">An Bord</div><h2 style="margin:2px 0 12px">${esc(SHIPNAME)}</h2>${din}${cab}
  <div class="bgrid">${t('deck','🗺','Deckplan','Decks, Suche, Weg')}${t('drk','🍹','Getränke',nFav?nFav+' Favoriten':'Karte & Preise')}${t('quiz','🎯','Quiz',QZ.n?QZ.pts+' Punkte':'Wissen testen')}${t('srch','🔍','Suche','Alles durchsuchen')}</div>
  <h3 class="bh">Schnell finden${c?' <small>· nach Nähe zur Kabine</small>':''}</h3><div class="bcats">${cats.map(k=>`<button class="chip" data-bc="${k}">${DKIND[k][0]} ${DKIND[k][1]}</button>`).join('')}</div>`}
function bindBord(a){a.querySelectorAll('[data-bo]').forEach(b=>b.onclick=e=>{if(e.target.closest('[data-dkgo]'))return;e.stopPropagation();const k=b.dataset.bo;
  if(k==='din')dinnerDlg(bordDay().day);else if(k==='dinset'||k==='cab'&&!myCab())offlineDlg('din');
  else if(k==='dinway'){dkFrom='Unsere Kabine ('+myCab()+')';dkTo=dinVenue()[0]+' (Deck '+DIN.dk+')';dkTab='weg';deckDlg()}
  else if(k==='cab'){const c=myCab(),ci=c&&cabInfo(c);if(ci){deckSel=ci.d;hl=null;dkTab='decks';deckDlg()}else{dkTab='decks';deckDlg()}}
  else if(k==='deck'){dkTab='decks';deckDlg()}else if(k==='drk')drinksDlg();else if(k==='quiz')quizDlg();else if(k==='srch')searchDlg()});
  a.querySelectorAll('[data-bc]').forEach(b=>b.onclick=()=>{dkTab='suche';dkCat=b.dataset.bc;deckQ='';const c=myCab();if(c)dkFrom='Unsere Kabine ('+c+')';deckDlg()})}
function menuDlg(){
  const ic=p=>'<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'+p+'</svg>';
  openSheet('<div class="hd"><h3 style="margin:0">Menü</h3><button class="x" data-close aria-label="Schließen">✕</button></div><div class="mnu">'+
   '<button data-m="s">'+ic('<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>')+'<span>Suche</span></button>'+
   '<button data-m="t">'+ic('<path d="M9 6h11M9 12h11M9 18h11M4 6l1 1 2-2M4 12l1 1 2-2M4 18l1 1 2-2"/>')+'<span>ToDos</span></button>'+
   '<button data-m="u">'+ic('<path d="M9 4L3 6v14l6-2 6 2 6-2V4l-6 2-6-2zM9 4v14M15 6v14"/>')+'<span>Übersichtskarte</span></button>'+
   '<button data-m="d">'+ic('<path d="M6 3h12l-1.5 17a1 1 0 0 1-1 .9h-7a1 1 0 0 1-1-.9zM6.5 9h11"/>')+'<span>Getränkekarte</span></button>'+
   '<button data-m="p">'+ic('<path d="M3 17l2 3h14l2-3zM5 17V11h14v6M8 11V7h8v4M11 7V4h2v3"/>')+'<span>Deckplan</span></button>'+
   '<button data-m="q">'+ic('<rect x="3" y="7" width="18" height="11" rx="4"/><path d="M7 11v3M5.5 12.5h3M15 11.5h.01M17.5 13.5h.01"/>')+'<span>Spiele</span></button>'+
   '<button data-m="o">'+ic('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>')+'<span>Einstellungen</span></button>'+(FBX.on?'<button data-m="k">'+ic('<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>')+'<span>Konto'+(FBX.user?' ('+esc(FBX.user.email||'')+')':'')+'</span></button>':'')+'</div>',d=>{
    const go=(f,swap)=>{if(swap){f();return}closeDlg();setTimeout(f,40)};
    d.querySelector('[data-m=s]').onclick=()=>go(searchDlg,1);d.querySelector('[data-m=t]').onclick=()=>go(()=>showTodo());d.querySelector('[data-m=d]').onclick=()=>go(drinksDlg,1);d.querySelector('[data-m=u]').onclick=()=>go(()=>{if(todayView)DAYFROM='today';else if(tripView)DAYFROM='trip';else if(mappeView)DAYFROM='mappe';else if(bordView)DAYFROM='bord';mapMin=false;select(null);applyMin();goTop()});d.querySelector('[data-m=p]').onclick=()=>go(deckDlg,1);d.querySelector('[data-m=q]').onclick=()=>go(gamesDlg,1);{const v=document.createElement('p');v.className='src';v.style.cssText='margin:10px 0 0;text-align:center';v.textContent=(TRIP.title||'Reise')+' · App-Version '+APP_VER;d.appendChild(v);if(TS.mode==='db'){const i=syncInfo(),w=document.createElement('button');w.className='lnk';w.style.cssText='display:block;margin:4px auto 0;font-size:13px';w.textContent=(i.off?'⚠ Offline':i.k==='busy'?'⟳ Wird synchronisiert':'☁︎ Alles synchron')+' ›';w.onclick=()=>{syncDlg()};d.appendChild(w)}}d.querySelector('[data-m=o]').onclick=()=>go(offlineDlg,1);const k=d.querySelector('[data-m=k]');if(k)k.onclick=()=>go(kontoDlg,1)});
}
function simLocal(){const p=D.ports.find(q=>q.date===todayStr())||D.ports[0];return new Date(nowMs()+tzOf(p)*36e5).toISOString().slice(0,16)}
function simSet(v){if(!v)return;const day=v.slice(0,10),p=D.ports.find(q=>q.date===day),tz=p?tzOf(p):-4,ms=Date.parse(v+':00Z')-tz*36e5;
  SIM_OFF=ms-Date.now()||1;try{localStorage.setItem('rp-sim',JSON.stringify({off:SIM_OFF}))}catch(e){}simApply()}
function simShift(min){const v=simLocal(),t=new Date(Date.parse(v+':00Z')+min*6e4).toISOString().slice(0,16);simSet(t)}
function simDay(n){const v=simLocal(),d=new Date(Date.parse(v.slice(0,10)+'T12:00:00Z')+n*864e5).toISOString().slice(0,10);simSet(d+v.slice(10))}
function simStop(){SIM_OFF=0;try{localStorage.removeItem('rp-sim')}catch(e){}simApply()}
const simTxt=()=>{const p=D.ports.find(q=>q.date===todayStr())||D.ports[0],x=new Date(nowMs()+tzOf(p)*36e5),d=new Date(x.toISOString().slice(0,10)+'T12:00:00');return `🧪 Test: ${d.toLocaleDateString('de-DE',{weekday:'short',day:'2-digit',month:'2-digit'}).replace('.,','.')} ${x.toISOString().slice(11,16)} Uhr `};
function simApply(){let b=document.getElementById('simbar');
  if(SIM_OFF){const open=b&&b.classList.contains('open');if(!b){b=document.createElement('div');b.id='simbar';document.body.appendChild(b)}
    const p=D.ports.find(q=>q.date===todayStr());
    b.innerHTML=`<div class="simp" ${open?'':'hidden'}>
      <div class="simr"><button data-sd="-1" aria-label="Tag zurück">◀ Tag</button><b>${p?'Tag '+p.day+' · '+esc(p.name):new Date(todayStr()+'T12:00:00').toLocaleDateString('de-DE',{weekday:'short',day:'2-digit',month:'2-digit',year:'numeric'}).replace('.,','.')}</b><button data-sd="1" aria-label="Tag vor">Tag ▶</button></div>
      <div class="simr"><button data-sm="-60">−1 Std.</button><button data-sm="-15">−15 Min</button><button data-sm="15">+15 Min</button><button data-sm="60">+1 Std.</button></div>
</div>
      <div class="simb"><button class="simt" id="simtog" aria-expanded="${open}">${simTxt()}${open?'▾':'▴'}</button><button id="simx">Beenden</button></div>`;
    if(open)b.classList.add('open');
    b.querySelector('#simx').onclick=simStop;
    b.querySelector('#simtog').onclick=()=>{b.classList.toggle('open');simApply()};
    b.querySelectorAll('[data-sd]').forEach(x=>x.onclick=()=>simDay(+x.dataset.sd));
    b.querySelectorAll('[data-sm]').forEach(x=>x.onclick=()=>simShift(+x.dataset.sm));
}
  else if(b)b.remove();
  document.body.classList.toggle('sim',!!SIM_OFF);
  todayOff=null;TODAY='';dayCheck();if(todayView)showToday(true);else renderPanel()}
setInterval(()=>{const b=document.getElementById('simbar'),t=b&&b.querySelector('#simtog');if(t&&SIM_OFF)t.firstChild.textContent=simTxt()},30000);
function dayCheck(){const n=todayStr();if(n===TODAY)return;TODAY=n;todayOff=null;applyTheme();updateTl();renderDays();if(todayView||!(tripView||todoView||sel!=null))renderPanel()}
document.addEventListener('visibilitychange',()=>{if(!document.hidden)dayCheck()});addEventListener('focus',dayCheck);addEventListener('pageshow',dayCheck);setInterval(()=>{if(!document.hidden)dayCheck()},60000);
{if(!location.hash){showToday(true);try{history.replaceState(null,'','#heute');lastHash='#heute'}catch(e){}}}
if(SIM_OFF)setTimeout(simApply,0);
if(DIN.dk!=null)try{renderPanel()}catch(e){}
shareCheck();
{const sb=document.getElementById('syncb');if(sb)sb.onclick=syncDlg;syncDraw()}
navMark();document.documentElement.classList.remove('boot');
(function(){const b=document.getElementById('fsb');if(!b)return;const de=document.documentElement;
  if(!de.requestFullscreen&&!de.webkitRequestFullscreen){b.hidden=true;return}
  b.onclick=()=>{try{if(document.fullscreenElement){document.exitFullscreen()}else{const r=(de.requestFullscreen||de.webkitRequestFullscreen).call(de);if(r&&r.catch)r.catch(()=>{b.title='Vollbild hier nicht erlaubt – Seite im Browser öffnen und „Zum Startbildschirm hinzufügen“ wählen'})}}catch(e){}}})();