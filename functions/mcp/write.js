/* Stufe 2a: Claude trägt in eine Reise ein (gewählt per Feld „reise“ bzw. nach Datum) (Plan: docs/MCP-PLAN.md, Abschnitt 9).
 * Gleiches Datenformat wie die App (app.js: addPointDlg/persistPlan, tsPutTask, dinSave, persistPicks):
 *   trips/<id>/planitems/<eid>  {d, o, x:1, n, s, t, at, note, lat?, lon?, addr?, osm?, dk?, dv?, rep?, ki}
 *   trips/<id>/tasks/<tid>      {ts, done, text, who, due, list, note, subs, ki}   (nur gemeinsame Listen)
 *   trips/<id>/plandays/meta    {dinner:{… skip:[Tage], ov:{Tag: "HH:MM"}}}
 *   trips/<id>/picks/p_<d>_<c>  {k:"<d>:<c>", v:true|false}
 *   trips/<id>  json.ports[Tag].ex[]  {c, n, p, dur, lv, prog, note, rec, sold, orte:[{n,lat,lon}], ki}   Veranstalter-Ausflüge (Stammdaten, nur diese Liste)
 * Jede Änderung: Kennzeichen ki:{uid, at, neu} am Eintrag + Protokoll trips/<id>/kilog/<kid> {uid, at, tool, col, doc, before, after, txt}.
 * Die App zeigt 🤖 und bietet „Rückgängig“ (Einstellungen → Konto → Änderungen durch KI). */
'use strict';
const path = require('path');
const RPDP = require(path.join(__dirname, '..', 'dayplan.js'));
const { clean } = require('./util');

const HM = /^([01]\d|2[0-3]):[0-5]\d$/, ID = /^[A-Za-z0-9_-]{1,60}$/, DATE = /^\d{4}-\d{2}-\d{2}$/;
const fail = msg => { const e = new Error(msg); e.user = true; throw e; };
const nid = p => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
// Notizen: Zeilenumbrüche erlaubt, sonst wie clean (Steuer-/Unsichtbar-Zeichen raus)
const note = (s, n = 300) => { s = String(s == null ? '' : s).replace(/\r\n?/g, '\n').split('\n').map(x => clean(x, n)).join('\n').replace(/\n{3,}/g, '\n\n').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const nrm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();
const hm = RPDP.hm, tm = RPDP.tm;

function writer(W) {
  // W: { S, trip, uid, now(), geo(q, near) → [{name, addr, lat, lon}], X (Rechenkontext), v (frisch geladene Reise) }
  const { S, trip, uid, v, X } = W, base = 'trips/' + trip + '/', now = W.now();
  const dayOf = n => { const p = v.ports.find(q => q.day === +n); if (!p) fail(`Einen Tag ${n} gibt es nicht – die Reise hat ${v.ports.length} Tage.`); return p; };
  const ki = neu => ({ uid, at: now, neu: neu ? 1 : 0 });
  // Protokoll-Eintrag; immer in derselben Transaktion wie die Änderung (T.set), damit es keine Änderung ohne Rückgängig gibt
  let seq = 0;   // Reihenfolge innerhalb eines Aufrufs (gleiche Uhrzeit), z. B. Tag 10 vor Tag 11
  const logDoc = (tool, col, doc, before, after, txt) => [base + 'kilog/' + nid('k'), { uid, at: now, n: seq++, tool, col, doc, before: before == null ? null : before, after: after == null ? null : after, txt: clean(txt, 160), undone: false }];
  // Tagesplan nur im aktuellen Format (planitems); alte Reisen erst einmal in der App öffnen (sonst ginge der Altbestand verloren)
  const needV2 = () => { if (!v.planV2) fail('Diese Reise nutzt noch das alte Speicherformat. Bitte einmal in der Reise-App öffnen (mit Internet), dann geht das Eintragen.'); };
  const find = id => { if (!ID.test(String(id || ''))) fail('Unbekannte Kennung. Die Kennungen stehen in tag_plan in eckigen Klammern.');
    for (const [d, a] of Object.entries(v.plan)) { const k = (a || []).findIndex(x => x.id === id); if (k >= 0) return { day: +d, it: a[k] }; }
    fail('Diesen Eintrag gibt es nicht (mehr). Bitte tag_plan neu lesen.'); };
  const nextO = d => 1000 + (v.plan[d] || []).length;

  /* Ort: an Bord aus dem Deckplan, sonst Ortssuche (Photon) nahe der Station; Claude liefert nie Koordinaten */
  function shipFind(q) {   // wie shipFind in app.js: Name im Deckplan enthält den Suchtext; „Deck 9“ im Text wählt das Deck
    if (!X.cruise || !v.ship) return []; let t = nrm(q).replace(/^an bord\s*:?\s*/, '');
    const dm = /(?:^|[\s,(·-])deck\s*(\d{1,2})\b/.exec(t), dkw = dm ? +dm[1] : null;
    if (dm) t = (t.slice(0, dm.index) + ' ' + t.slice(dm.index + dm[0].length)).replace(/[()·,]/g, ' ').replace(/\s+/g, ' ').trim().replace(/[\s-]+$/, '');
    if (t.length < 3) return [];
    const o = []; for (const [dk, , V] of v.ship.dk) { if (dkw != null && +dk !== dkw) continue; (V || []).forEach((x, i) => { const n = nrm(x && x[0]); if (n.length >= 2 && n.includes(t)) o.push({ dk, dv: i, name: x[0] }); }); }
    const ex = o.filter(x => nrm(x.name) === t); return ex.length ? ex : o;
  }
  async function place(p, q) {
    q = clean(q, 100); if (q.length < 3) fail('Ort bitte mit mindestens 3 Zeichen angeben.');
    const onb = /^an bord\b/i.test(q);
    if (onb || p.kind === 'sea') {   // Orte an Bord nur mit „an Bord: …“ bzw. auf See – sonst würde „Spanische Treppe“ zur „Spa“
      const L = shipFind(q);
      if (L.length === 1) return { loc: { dk: L[0].dk, dv: L[0].dv }, txt: `an Bord: ${clean(L[0].name, 60)}, Deck ${L[0].dk}` };
      if (L.length > 1) fail(`Mehrere Orte an Bord passen: ${L.slice(0, 6).map(x => '„' + clean(x.name, 40) + '“ (Deck ' + x.dk + ')').join(', ')}. Bitte genauer angeben, z. B. ort = „an Bord: ${clean(L[0].name, 40)}, Deck ${L[0].dk}“.`);
      fail(`„${q}“ gibt es im Deckplan nicht.${p.kind === 'sea' ? ' Auf See gehen nur Orte an Bord.' : ''} Mit suchen findest du Orte an Bord.`);
    }
    if (p.lat == null) return { loc: {}, txt: 'Für diesen Tag ist keine Lage bekannt – ohne Ort gespeichert, in der App nachtragen' };
    let R = []; try { R = await W.geo(q, { lat: p.lat, lon: p.lon }); } catch (e) { return { loc: {}, txt: 'Ortssuche gerade nicht erreichbar – ohne Ort gespeichert, in der App nachtragen' }; }
    const near = R.filter(x => x && isFinite(x.lat) && isFinite(x.lon) && RPDP.hav(p, x) <= 200);
    if (!near.length) return { loc: {}, txt: `„${q}“ nahe ${clean(p.name, 40)} nicht gefunden – ohne Ort gespeichert, in der App nachtragen` };
    const x = near[0];
    return { loc: { lat: +(+x.lat).toFixed(6), lon: +(+x.lon).toFixed(6), osm: '', ...(x.addr ? { addr: clean(x.addr, 120) } : {}) }, txt: `Ort automatisch gesucht: ${clean(x.name, 60)}${x.addr ? ', ' + clean(x.addr, 80) : ''} – bitte in der App prüfen` };
  }
  // Überschneidungen wie in der App (nur bei fester Uhrzeit)
  function conflicts(days, a0, s, skipId) {
    return days.map(d => { const p = dayOf(d), r = X.dp.calc(p).rows.find(r => r.a != null && !r.skip && !(r.s && r.s.id === skipId) && r.a < a0 + s && (r.b != null ? r.b : r.a + (r.st || 60)) > a0);
      return r ? { day: d, n: r.dinner ? 'Abendessen' : r.tour ? X.op + '-Ausflug ' + r.e.c : r.q.n, a: r.a } : null; }).filter(Boolean);
  }
  const confTxt = c => c.map(x => `Tag ${x.day}: ${clean(x.n, 60)} um ${hm(x.a)}`).join('; ');
  const fields = a => {
    const o = {};
    if (a.name != null) { o.n = clean(a.name, 80); if (!o.n) fail('Der Name darf nicht leer sein.'); }
    if (a.uhrzeit != null) { if (a.uhrzeit !== '' && !HM.test(a.uhrzeit)) fail('Uhrzeit bitte als HH:MM (24 Std., Ortszeit).'); o.at = a.uhrzeit; }
    if (a.dauer_min != null) o.s = Math.max(5, Math.min(720, a.dauer_min | 0));
    if (a.weg_min != null) o.t = Math.max(0, Math.min(240, a.weg_min | 0));
    if (a.notiz != null) o.note = note(a.notiz);
    return o;
  };
  const line = (d, it) => `Tag ${d} · ${it.at ? it.at + '–' + hm(tm(it.at) + (+it.s || 60)) : 'ohne Uhrzeit'} „${it.n}“`;

  return {
    async eintrag_anlegen(a) {
      needV2(); const p = dayOf(a.tag), f = fields(a); if (!f.n) fail('Name fehlt.');
      const to = a.bis_tag != null ? a.bis_tag : p.day; if (to < p.day) fail('bis_tag muss nach dem Tag liegen.'); dayOf(to);
      if (to - p.day > 29) fail('Höchstens 30 Tage auf einmal.');
      const days = v.ports.filter(q => q.day >= p.day && q.day <= to).map(q => q.day);
      const it = { x: 1, n: f.n, s: f.s || 60, t: p.kind === 'port' ? (f.t || 0) : 0, at: f.at || '', note: f.note || '' };
      const conf = it.at ? conflicts(days, tm(it.at), it.s) : [];
      if (conf.length && !a.ueberschneidung) return `Nicht gespeichert – Überschneidung: ${confTxt(conf)}.\nBitte nachfragen und dann erneut aufrufen mit ueberschneidung = „auslassen“ (diese Tage überspringen) oder „trotzdem“.`;
      const skip = new Set(a.ueberschneidung === 'auslassen' ? conf.map(c => c.day) : []), use = days.filter(d => !skip.has(d));
      if (!use.length) return 'Nichts gespeichert – an allen Tagen gibt es eine Überschneidung.';
      const pl = a.ort ? await place(p, a.ort) : null, rid = use.length > 1 ? nid('r') : null, out = [], ops = [];
      for (const d of use) {
        const q = dayOf(d), id = nid('e'), doc = { ...it, t: q.kind === 'port' ? it.t : 0, ...(pl ? pl.loc : {}), ...(rid ? { rep: rid } : {}), ki: ki(true), d, o: nextO(d) };
        if (q.kind === 'sea' && doc.lat != null) { delete doc.lat; delete doc.lon; delete doc.addr; delete doc.osm; }
        ops.push([base + 'planitems/' + id, doc], logDoc('eintrag_anlegen', 'planitems', id, null, doc, `Eintrag „${it.n}“ an Tag ${d} angelegt`));
        (v.plan[d] = v.plan[d] || []).push({ ...doc, id }); out.push(`${line(d, doc)} [${id}]`);
      }
      if (!v.metaV2) ops.push([base + 'plandays/meta', { planV2: true }, true]);   // neue Reise: Format vermerken wie die App
      await S.txn(async T => { ops.forEach(([k, x, m]) => T.set(k, x, m)); });   // alles oder nichts
      return `Gespeichert (${out.length} ${out.length === 1 ? 'Eintrag' : 'Einträge'}):\n` + out.join('\n') + (pl ? '\n' + pl.txt : '') + (skip.size ? `\nAusgelassen wegen Überschneidung: ${confTxt(conf)}` : '');
    },

    async eintrag_aendern(a) {
      needV2(); const { day, it } = find(a.id); if (!it.x) fail('Das ist ein Tipp aus dem Reiseführer – bitte in der App ändern (dort „Aus dem Plan entfernen“ bzw. Uhrzeit setzen).');
      const key = base + 'planitems/' + a.id, f = fields(a), nd = a.tag != null ? dayOf(a.tag).day : day, p = dayOf(nd);
      const pl = a.ort != null && a.ort !== '' ? await place(p, a.ort) : null, LOC = ['lat', 'lon', 'addr', 'osm', 'gurl', 'dk', 'dv'];
      // feldgenau: nur geänderte Felder schreiben (gleichzeitige Änderungen in der App an anderen Feldern bleiben erhalten)
      const r = await S.txn(async T => {
        const cur = await T.get(key); if (!cur) return { e: 'Diesen Eintrag gibt es nicht (mehr).' };
        const nx = { ...cur, ...f, d: nd };
        if (nd !== day) { nx.o = nextO(nd); if (p.kind !== 'port') nx.t = 0; }
        if (a.ort != null) { LOC.forEach(k => delete nx[k]); if (pl) Object.assign(nx, pl.loc); }
        if (p.kind === 'sea' && nx.lat != null) return { e: 'Auf See gehen nur Orte an Bord.' };
        nx.ki = ki(cur.ki && cur.ki.neu);
        if (JSON.stringify({ ...cur, ki: 0 }) === JSON.stringify({ ...nx, ki: 0 })) return { same: true };
        const diff = {}; new Set([...Object.keys(cur), ...Object.keys(nx)]).forEach(k => { if (!(k in nx)) diff[k] = S.DEL; else if (JSON.stringify(cur[k]) !== JSON.stringify(nx[k])) diff[k] = nx[k]; });
        T.set(key, diff, true); const [lk, ld] = logDoc('eintrag_aendern', 'planitems', a.id, cur, nx, `Eintrag „${nx.n}“ geändert (Tag ${nd})`); T.set(lk, ld);
        return { nx };
      });
      if (r.e) fail(r.e); if (r.same) return 'Keine Änderung nötig – der Eintrag ist schon so.';
      const nx = r.nx;
      const conf = nx.at ? conflicts([nd], tm(nx.at), +nx.s || 60, a.id) : [];
      return `Geändert: ${line(nd, nx)} [${a.id}]` + (pl ? '\n' + pl.txt : '') + (conf.length ? `\nHinweis – Überschneidung: ${confTxt(conf)}` : '');
    },

    async eintrag_loeschen(a) {
      needV2(); const { day, it } = find(a.id), key = base + 'planitems/' + a.id;
      const e = await S.txn(async T => { const cur = await T.get(key); if (!cur) return 'Diesen Eintrag gibt es nicht (mehr).';
        if (!(cur.ki && cur.ki.neu)) return 'Löschen geht nur bei Einträgen, die Claude selbst angelegt hat. Diesen Eintrag bitte in der App löschen.';
        T.del(key); const [lk, ld] = logDoc('eintrag_loeschen', 'planitems', a.id, cur, null, `Eintrag „${cur.n}“ an Tag ${day} gelöscht`); T.set(lk, ld); return null; });
      if (e) fail(e);
      return `Gelöscht: ${line(day, it)}.`;
    },

    async aufgabe_anlegen(a) {
      const text = clean(a.text, 120); if (!text) fail('Text fehlt.');
      if (a.faellig != null && a.faellig !== '' && !DATE.test(a.faellig)) fail('Fällig bitte als JJJJ-MM-TT.');
      const L = v.lists.slice().sort((x, y) => (x.ord - y.ord) || x.name.localeCompare(y.name)); if (!L.length) fail('Es gibt noch keine gemeinsame ToDo-Liste. Bitte zuerst in der App eine Liste anlegen.');
      let l = L.length === 1 ? L[0] : null;
      if (a.liste) { const q = nrm(a.liste); l = L.find(x => nrm(x.name) === q) || L.find(x => nrm(x.name).includes(q) || q.includes(nrm(x.name))) || null; if (!l) fail(`Die Liste „${clean(a.liste, 40)}“ gibt es nicht. Listen: ${L.map(x => '„' + clean(x.name, 40) + '“').join(', ')}.`); }
      if (!l) return `In welche Liste? Es gibt: ${L.map(x => '„' + clean(x.name, 40) + '“').join(', ')}. Bitte nachfragen und mit liste erneut aufrufen.`;
      const id = nid('t'), doc = { ts: now, done: false, text, who: '', due: a.faellig || '', list: l.id, note: a.notiz ? note(a.notiz) : '', subs: [], ki: ki(true) };
      await S.txn(async T => { T.set(base + 'tasks/' + id, doc); const [lk, ld] = logDoc('aufgabe_anlegen', 'tasks', id, null, doc, `Aufgabe „${text}“ angelegt (${l.name})`); T.set(lk, ld); });
      return `Aufgabe angelegt in „${clean(l.name, 40)}“: ${text}${doc.due ? ' (fällig ' + doc.due + ')' : ''} [${id}]`;
    },

    async aufgabe_erledigt(a) {
      if (!ID.test(String(a.id || ''))) fail('Unbekannte Kennung. Die Kennungen stehen in aufgaben in eckigen Klammern.');
      const t = v.tasks.find(x => x.id === a.id); if (!t) fail('Diese Aufgabe gibt es nicht (oder sie ist privat).');
      const key = base + 'tasks/' + a.id, done = a.erledigt !== false;
      const r = await S.txn(async T => { const cur = await T.get(key); if (!cur) return { e: 'Diese Aufgabe gibt es nicht (mehr).' };
        if (!!cur.done === done) return { same: cur };
        const k2 = ki(cur.ki && cur.ki.neu); T.set(key, { done, ki: k2 }, true);
        const [lk, ld] = logDoc('aufgabe_erledigt', 'tasks', a.id, cur, { ...cur, done, ki: k2 }, `Aufgabe „${cur.text}“ ${done ? 'erledigt' : 'wieder offen'}`); T.set(lk, ld); return { cur }; });
      if (r.e) fail(r.e); if (r.same) return `Schon ${done ? 'erledigt' : 'offen'}: ${clean(r.same.text, 120)}`;
      const cur = r.cur;
      return `${done ? 'Erledigt' : 'Wieder offen'}: ${clean(cur.text, 120)}`;
    },

    async abendessen(a) {
      const p = dayOf(a.tag); if (p.kind === 'end') fail('Am letzten Tag gibt es kein Abendessen im Plan.');
      if (a.aktion === 'zeit' && !HM.test(a.uhrzeit || '')) fail('Für „zeit“ bitte uhrzeit als HH:MM angeben.');
      const key = base + 'plandays/meta';
      const r = await S.txn(async T => {
        const m = await T.get(key), dn = m && m.dinner; if (!dn || !dn.at) return { e: 'Es ist keine feste Abendessen-Zeit eingetragen (in der App unter Abendessen).' };
        const before = { skip: Array.isArray(dn.skip) ? dn.skip.slice() : [], ov: { ...(dn.ov || {}) } }, nx = { skip: before.skip.filter(d => d !== p.day), ov: { ...before.ov } };
        if (a.aktion === 'ausfallen') nx.skip.push(p.day);
        if (a.aktion === 'normal' || a.aktion === 'ausfallen') delete nx.ov[p.day];
        if (a.aktion === 'zeit') { if (a.uhrzeit === dn.at) delete nx.ov[p.day]; else nx.ov[p.day] = a.uhrzeit; }
        if (JSON.stringify(before) === JSON.stringify(nx)) return { same: true };
        T.upd(key, { dinner: { ...dn, skip: nx.skip, ov: nx.ov } });
        const txt = a.aktion === 'ausfallen' ? `Abendessen an Tag ${p.day} fällt aus` : a.aktion === 'zeit' ? `Abendessen an Tag ${p.day} um ${a.uhrzeit}` : `Abendessen an Tag ${p.day} wieder zur normalen Zeit (${dn.at})`;
        const [lk, ld] = logDoc('abendessen', 'dinner', String(p.day), before, nx, txt); T.set(lk, ld); return { txt };
      });
      if (r.e) fail(r.e); if (r.same) return 'Keine Änderung nötig – das Abendessen ist an diesem Tag schon so eingetragen.';
      return 'Gespeichert: ' + r.txt + '.';
    },

    async ausflug_waehlen(a) {
      const p = dayOf(a.tag), e = (p.ex || []).find(x => String(x.c) === String(a.code));
      if (!e) fail(`An Tag ${p.day} gibt es keinen Ausflug mit Code „${clean(a.code, 12)}“.${(p.ex || []).length ? ' Codes: ' + p.ex.slice(0, 12).map(x => clean(x.c, 12)).join(', ') : ''}`);
      if (a.gewaehlt && e.sold) fail(`Der Ausflug ${clean(e.c, 12)} ist ausverkauft.`);
      const k = X.dp.pickKey(p.day, e.c), pid = 'p_' + k.replace(/[^A-Za-z0-9]/g, '_'), key = base + 'picks/' + pid, nx = { k, v: !!a.gewaehlt };
      const same = await S.txn(async T => { const cur = await T.get(key); if (cur && cur.v === nx.v) return true;
        T.set(key, nx); const [lk, ld] = logDoc('ausflug_waehlen', 'picks', pid, cur, nx, `Ausflug ${e.c} an Tag ${p.day} ${nx.v ? 'gewählt' : 'abgewählt'}`); T.set(lk, ld); return false; });
      if (same) return `Schon ${nx.v ? 'gewählt' : 'abgewählt'}: ${clean(e.c, 12)} „${clean(e.n, 60)}“.`;
      return `${nx.v ? 'Gewählt' : 'Abgewählt'}: Tag ${p.day} · ${X.op}-Ausflug ${clean(e.c, 12)} „${clean(e.n, 60)}“.`;
    },
  };
}

// Dauer in Stunden → Text wie in der Import-Datei („4,5 Std.“), daraus rechnet die App die Zeit im Tagesplan
const durTxt = h => (Math.round(h * 4) / 4).toString().replace('.', ',') + ' Std.';
const CODE = /^[A-Za-z0-9][A-Za-z0-9._\/-]{0,11}$/;

function exWriter(W) {
  const { S, trip, uid, v, X } = W, key = 'trips/' + trip, now = W.now(), op = X.op;
  let seq = 0;
  const logDoc = (tool, doc, before, after, txt, col = 'ex') => [key + '/kilog/' + nid('k'), { uid, at: now, n: seq++, tool, col, doc, before: before == null ? null : before, after: after == null ? null : after, txt: clean(txt, 160), undone: false }];
  const dayOf = (n, sea) => { const p = v.ports.find(q => q.day === +n); if (!p) fail(`Einen Tag ${n} gibt es nicht – die Reise hat ${v.ports.length} Tage.`); if (p.kind === 'sea' && !sea) fail(`Tag ${p.day} ist ein Seetag – dort gibt es keine ${op}-Ausflüge.`); return p; };
  // Stammdaten der Reise in einer Transaktion ändern (nur ports[Tag]: ex, pois, Ortstexte), wie tripSave in der App
  async function mutate(day, fn) {
    return S.txn(async T => {
      const t = await T.get(key); if (!t) return { e: 'Die Reise gibt es nicht (mehr).' };
      let j; try { j = JSON.parse(t.json || '{}'); } catch (e) { return { e: 'Die Reisedaten sind beschädigt – bitte in der App prüfen.' }; }
      const p = (j.ports || []).find(q => q && q.day === day); if (!p) return { e: `Tag ${day} fehlt in den Reisedaten.` };
      const r = fn(p, T); if (r && (r.e || r.skip)) return r;
      const json = JSON.stringify(j); if (Buffer.byteLength(json) > 950 * 1024) return { e: 'Die Reisedaten würden zu groß (Firestore-Grenze) – bitte Texte kürzen.' };
      T.set(key, { json, updated: now }, true); return r || {};
    });
  }
  return {
    async ausfluege_anlegen(a) {
      const p = dayOf(a.tag), seen = new Set(), L = [];
      for (const x of a.ausfluege) {
        const c = clean(x.code, 12); if (!CODE.test(c)) fail(`Ungültiger Code „${clean(x.code, 12)}“ – nur Buchstaben, Ziffern, . _ - /.`);
        if (seen.has(c)) fail(`Code ${c} steht doppelt in der Liste.`); seen.add(c);
        const f = {};
        if (x.name != null) { f.n = clean(x.name, 80); if (!f.n) fail(`${c}: Name darf nicht leer sein.`); }
        if (x.preis != null) f.p = Math.round(x.preis * 100) / 100;
        if (x.dauer_std != null) f.dur = durTxt(x.dauer_std);
        if (x.stufe != null) f.lv = clean(x.stufe, 30);
        if (x.programm != null) f.prog = note(x.programm, 1000);
        if (x.hinweis != null) f.note = note(x.hinweis, 800);
        if (x.empfohlen != null) f.rec = x.empfohlen ? 1 : 0;
        if (x.ausverkauft != null) f.sold = x.ausverkauft ? 1 : 0;
        L.push({ c, f });
      }
      // Orte: Server sucht selbst (Photon) nahe dem Hafen, ≤ 200 km; Claude liefert keine Koordinaten
      const miss = []; let down = false;   // down: Ortssuche nicht erreichbar → Ausflüge trotzdem speichern, Orte melden
      if (p.lat == null && a.ausfluege.some(x => x.orte && x.orte.length)) fail(`Für Tag ${p.day} ist keine Lage bekannt – Orte können nicht gesucht werden.`);
      for (let k = 0; k < L.length; k++) { const o = a.ausfluege[k].orte; if (o == null) continue; const res = [];
        for (const q0 of o) { const q = clean(q0, 100); let R = []; if (down) { miss.push(`${L[k].c}: „${q}“`); continue; }
          try { R = await W.geo(q, { lat: p.lat, lon: p.lon }); } catch (e) { down = true; miss.push(`${L[k].c}: „${q}“`); continue; }
          const x = (R || []).find(r => r && isFinite(r.lat) && isFinite(r.lon) && RPDP.hav(p, r) <= 200);
          if (x) res.push({ n: clean(q.split(',')[0], 60), lat: +(+x.lat).toFixed(6), lon: +(+x.lon).toFixed(6) }); else miss.push(`${L[k].c}: „${q}“`); }
        if (res.length || !down) L[k].f.orte = res; }   // bei Ausfall bisherige Orte nicht löschen
      const ops = [], out = [];
      const r = await mutate(p.day, (port, T) => {
        const ex = port.ex = Array.isArray(port.ex) ? port.ex : [];
        for (const { c, f } of L) {
          const i = ex.findIndex(e => e && String(e.c) === c), cur = i >= 0 ? ex[i] : null;
          if (!cur && !f.n) return { e: `${c}: Name fehlt (neuer Ausflug).` };
          const nx = { ...(cur || { c }), ...f }; ['rec', 'sold'].forEach(k => { if (nx[k] === 0) delete nx[k]; }); if (Array.isArray(nx.orte) && !nx.orte.length) delete nx.orte;
          const { ki: k0, ...a0 } = cur || {}, { ki: k1, ...a1 } = nx;
          if (cur && JSON.stringify(a0) === JSON.stringify(a1)) { out.push(`${c} „${clean(nx.n, 60)}“ unverändert`); continue; }
          nx.ki = { uid, at: now, neu: cur ? (cur.ki && cur.ki.neu ? 1 : 0) : 1 };
          if (cur) ex[i] = nx; else ex.push(nx);
          ops.push(logDoc('ausfluege_anlegen', p.day + ':' + c, cur, nx, `${op}-Ausflug ${c} „${nx.n}“ an Tag ${p.day} ${cur ? 'geändert' : 'angelegt'}`));
          out.push(`${c} „${clean(nx.n, 60)}“ ${cur ? 'aktualisiert' : 'neu'}${nx.p != null ? ' · ' + nx.p + ' € p. P.' : ''}${nx.dur ? ' · ' + nx.dur : ''}${nx.rec ? ' · empfohlen' : ''}${nx.sold ? ' · ausverkauft' : ''}${f.orte ? ' · Orte: ' + (f.orte.map(o => o.n).join(', ') || 'keine') : ''}`);
        }
        if (!ops.length) return { skip: true };
        ops.forEach(([k, d]) => T.set(k, d));
      });
      if (r.e) fail('Nicht gespeichert – ' + r.e);
      return `${op}-Ausflüge an Tag ${p.day} (${clean(p.name, 60)}) gespeichert:\n` + out.map(s => '- ' + s).join('\n') + (miss.length ? (down ? `\nOrtssuche gerade nicht erreichbar – diese Orte fehlen noch: ${miss.join(', ')}. Die Ausflüge selbst sind gespeichert; Orte später erneut eintragen oder in der App hinzufügen („📍 Orte ›“).` : `\nNicht gefunden (nahe ${clean(p.name, 40)}), daher weggelassen: ${miss.join(', ')} – genauer benennen und erneut aufrufen, oder in der App hinzufügen.`) : '') + (ops.length ? '\nIn der App erscheinen sie nach „Neu laden“ (Hinweis kommt automatisch).' : '');
    },
    /* „Über den Ort und Tipps“: Texte eines Tages (nur angegebene Felder; '' bzw. [] entfernt das Feld) */
    async ort_info_setzen(a) {
      const p = dayOf(a.tag, true), f = {}, S1 = (k, n, x) => { if (x == null) return; f[k] = note(x, n); }, LI = (k, n, m, x) => { if (x == null) return; f[k] = x.map(t => note(t, m)).filter(Boolean).slice(0, n); };
      if (a.waehrung != null) { const c = String(a.waehrung).trim().toUpperCase(); if (c && !/^[A-Z]{3}$/.test(c)) fail('Währung bitte als ISO-Code mit 3 Buchstaben, z. B. USD.'); f.cur = c; }
      S1('curNote', 200, a.waehrung_hinweis);
      S1('ort', 800, a.ort); S1('walk', 200, a.zu_fuss); S1('verdikt', 400, a.selbst_oder_ausflug); S1('rec', 400, a.empfehlung); S1('text', 300, a.kurztext);
      LI('tips', 12, 300, a.auf_eigene_faust); LI('tr', 8, 300, a.anreise);
      if (!Object.keys(f).length) fail('Keine Angabe zum Ändern.');
      const K = ['cur', 'curNote', 'ort', 'walk', 'verdikt', 'rec', 'text', 'tips', 'tr'], pick = o => { const x = {}; K.forEach(k => { if (o[k] != null && !(Array.isArray(o[k]) && !o[k].length) && o[k] !== '') x[k] = o[k]; }); return x; };
      let txt = '';
      const r = await mutate(p.day, (port, T) => {
        const before = pick(port); Object.entries(f).forEach(([k, x]) => { if (x === '' || (Array.isArray(x) && !x.length)) delete port[k]; else port[k] = x; });
        const after = pick(port); if (JSON.stringify(before) === JSON.stringify(after)) return { skip: true };
        port.kiInfo = { uid, at: now };
        txt = `Ortsinfos an Tag ${p.day} (${p.name}) geändert: ${Object.keys(f).map(k => ({ cur: 'Währung', curNote: 'Bezahl-Hinweis', ort: 'Der Ort', walk: 'Zu Fuß', verdikt: 'Selbst oder Ausflug', rec: 'Empfehlung', text: 'Kurztext', tips: 'Auf eigene Faust', tr: 'Anreise' })[k]).join(', ')}`;
        const [lk, ld] = logDoc('ort_info_setzen', String(p.day), before, after, txt, 'portinfo'); T.set(lk, ld);
      });
      if (r.e) fail(r.e); if (r.skip) return 'Keine Änderung nötig – die Angaben sind schon so.';
      return 'Gespeichert: ' + clean(txt, 200) + '.\nIn der App erscheint es nach „Neu laden“ (Hinweis kommt automatisch).';
    },

    /* „Orte im Detail“ (Tipps, pois): anlegen oder aktualisieren (per id oder gleichem Namen); Lage sucht der Server selbst */
    async tipps_anlegen(a) {
      const p = dayOf(a.tag); if (p.lat == null) fail(`Für Tag ${p.day} ist keine Lage bekannt – Tipps bitte in der App anlegen.`);
      const cur0 = p.pois || [], seen = new Set(), L = [], miss = []; let down = false;
      for (const x of a.tipps) {
        const ex = x.id != null ? cur0.find(q => q && q.id === x.id) : x.name ? cur0.find(q => q && nrm(q.n) === nrm(x.name)) : null;
        if (x.id != null && !ex) fail(`Einen Tipp mit der Kennung ${clean(x.id, 40)} gibt es an Tag ${p.day} nicht (Kennungen stehen in tipps).`);
        if (!ex && !x.name) fail('Name fehlt (neuer Tipp).'); if (!ex && !x.ort) fail(`„${clean(x.name, 60)}“: Ort (Suchtext) fehlt – ohne Lage kann der Tipp nicht auf die Karte.`);
        const k = ex ? ex.id : null; if (k && seen.has(k)) fail(`Tipp ${clean(k, 40)} steht doppelt in der Liste.`); if (k) seen.add(k);
        let loc = null;
        if (x.ort) { const q = clean(x.ort, 100); let R = [];
          if (!down) { try { R = await W.geo(q, { lat: p.lat, lon: p.lon }); } catch (e) { down = true; } }
          const h = (R || []).find(r => r && isFinite(r.lat) && isFinite(r.lon) && RPDP.hav(p, r) <= 200);
          if (h) loc = { lat: +(+h.lat).toFixed(6), lon: +(+h.lon).toFixed(6) }; else { miss.push(`„${q}“`); if (!ex) continue; } }
        L.push({ ex, x, loc });
      }
      const out = [], ops = [];
      const r = await mutate(p.day, (port, T) => {
        const P = port.pois = Array.isArray(port.pois) ? port.pois : [];
        for (const { ex, x, loc } of L) {
          const i = ex ? P.findIndex(q => q && q.id === ex.id) : -1, cur = i >= 0 ? P[i] : null; if (ex && !cur) return { e: 'Die Tipps wurden inzwischen geändert – bitte tipps neu lesen.' };
          const nx = cur ? JSON.parse(JSON.stringify(cur)) : { id: 'k-' + nrm(x.name).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) + '-' + Math.random().toString(36).slice(2, 6) };
          if (x.name != null) nx.n = clean(x.name, 80); if (x.art) nx.t = x.art; if (!nx.t) nx.t = 'sight';
          if (x.beschreibung != null) nx.d = note(x.beschreibung, 400);
          if (loc) { nx.lat = loc.lat; nx.lon = loc.lon; delete nx.ox; delete nx.oy; delete nx.ca; nx.km = +RPDP.hav(p, loc).toFixed(1); }
          if (x.erreichbar) nx.w = x.erreichbar; if (!nx.w) nx.w = nx.km != null && nx.km <= 1.5 ? 'walk' : 'taxi';
          const g = { ...(nx.g || {}) }, km = nx.km || 0;
          g.m = nx.w; if (x.weg_min != null) g.t = x.weg_min; else if (g.t == null || loc) g.t = Math.max(5, Math.round(nx.w === 'walk' ? km * 13 : km * 2.5 + 8));
          if (x.aufenthalt_min != null) g.s = x.aufenthalt_min; else if (g.s == null) g.s = 60;
          if (x.eintritt != null) g.f = x.eintritt; else if (!('f' in g)) g.f = null;
          if (x.oeffnung != null) g.o = clean(x.oeffnung, 80); if (x.notiz != null) g.n = clean(x.notiz, 200);
          if (g.c == null) g.c = 0; if (!g.u) g.u = '€'; g.v = 0; nx.g = g;
          const { ki: k0, ...a0 } = cur || {}, { ki: k1, ...a1 } = nx;
          if (cur && JSON.stringify(a0) === JSON.stringify(a1)) { out.push(`„${clean(nx.n, 60)}“ unverändert [${nx.id}]`); continue; }
          nx.ki = { uid, at: now, neu: cur ? (cur.ki && cur.ki.neu ? 1 : 0) : 1 };
          if (cur) P[i] = nx; else P.push(nx);
          ops.push(logDoc('tipps_anlegen', p.day + ':' + nx.id, cur, nx, `Tipp „${nx.n}“ an Tag ${p.day} ${cur ? 'geändert' : 'angelegt'}`, 'poi'));
          out.push(`„${clean(nx.n, 60)}“ ${cur ? 'aktualisiert' : 'neu'} · ${nx.km != null ? String(nx.km).replace('.', ',') + ' km' : ''} [${nx.id}]`);
        }
        if (!ops.length) return { skip: true };
        ops.forEach(([k, d]) => T.set(k, d));
      });
      if (r.e) fail('Nicht gespeichert – ' + r.e);
      return `Tipps an Tag ${p.day} (${clean(p.name, 60)}):\n` + (out.length ? out.map(s => '- ' + s).join('\n') : '- nichts gespeichert') +
        (miss.length ? (down ? `\nOrtssuche gerade nicht erreichbar: ${miss.join(', ')} – neue Tipps ohne Lage wurden nicht angelegt, bitte später erneut.` : `\nNicht gefunden (nahe ${clean(p.name, 40)}): ${miss.join(', ')} – genauer benennen und erneut aufrufen.`) : '') +
        (ops.length ? '\nIn der App erscheinen sie nach „Neu laden“ (Hinweis kommt automatisch).' : '');
    },

    async tipp_loeschen(a) {
      const p = dayOf(a.tag), id = clean(a.id, 60); let txt = '';
      if ((v.plan[p.day] || []).some(s => s && !s.x && s.ti === id)) fail('Dieser Tipp ist im Tagesplan eingeplant – bitte erst dort entfernen.');
      const r = await mutate(p.day, (port, T) => {
        const P = Array.isArray(port.pois) ? port.pois : [], i = P.findIndex(q => q && q.id === id); if (i < 0) return { e: `An Tag ${p.day} gibt es keinen Tipp mit der Kennung ${id}.` };
        const cur = P[i]; if (!(cur.ki && cur.ki.neu)) return { e: 'Löschen geht nur bei Tipps, die Claude selbst angelegt hat. Andere bitte in der App bearbeiten.' };
        P.splice(i, 1); txt = `Tipp „${cur.n}“ an Tag ${p.day} gelöscht`;
        const [k, d] = logDoc('tipp_loeschen', p.day + ':' + id, cur, null, txt, 'poi'); T.set(k, d);
      });
      if (r.e) fail(r.e);
      return 'Gelöscht: ' + clean(txt, 160) + '.';
    },

    async ausflug_loeschen(a) {
      const p = dayOf(a.tag), c = clean(a.code, 12); let txt = '';
      const r = await mutate(p.day, (port, T) => {
        const ex = Array.isArray(port.ex) ? port.ex : [];
        const i = ex.findIndex(e => e && String(e.c) === c); if (i < 0) return { e: `An Tag ${p.day} gibt es keinen Ausflug ${c}.` };
        const cur = ex[i]; if (!(cur.ki && cur.ki.neu)) return { e: `Löschen geht nur bei Ausflügen, die Claude selbst angelegt hat. ${c} bitte in der App bearbeiten.` };
        ex.splice(i, 1); txt = `${op}-Ausflug ${c} „${cur.n}“ an Tag ${p.day} gelöscht`;
        const [k, d] = logDoc('ausflug_loeschen', p.day + ':' + c, cur, null, txt); T.set(k, d);
      });
      if (r.e) fail(r.e);
      const pk = v.picks[X.dp.pickKey(p.day, c)];
      return 'Gelöscht: ' + clean(txt, 160) + '.' + (pk ? ' Er war als gewählt markiert – die Wahl bleibt gespeichert, falls er wiederkommt.' : '');
    },
  };
}

async function recent(S, trip, uid) {
  const L = (await S.list('trips/' + trip + '/kilog')).filter(x => x.data && x.data.uid === uid).sort((a, b) => (b.data.at - a.data.at) || ((a.data.n || 0) - (b.data.n || 0))).slice(0, 15).map(x => x.data);
  if (!L.length) return 'Claude hat in dieser Reise noch nichts geändert.';
  const f = t => new Intl.DateTimeFormat('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(t));
  return 'Letzte Änderungen durch Claude (neueste zuerst; Rückgängig in der App unter Einstellungen → Konto):\n' + L.map(x => `- ${f(x.at)} ${clean(x.txt, 160)}${x.undone ? ' (rückgängig gemacht)' : ''}`).join('\n');
}

module.exports = { writer, recent, exWriter };
