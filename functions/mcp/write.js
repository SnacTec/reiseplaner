/* Stufe 2a: Claude trägt in die aktuelle Reise ein (Plan: docs/MCP-PLAN.md, Abschnitt 9).
 * Gleiches Datenformat wie die App (app.js: addPointDlg/persistPlan, tsPutTask, dinSave, persistPicks):
 *   trips/<id>/planitems/<eid>  {d, o, x:1, n, s, t, at, note, lat?, lon?, addr?, osm?, dk?, dv?, rep?, ki}
 *   trips/<id>/tasks/<tid>      {ts, done, text, who, due, list, note, subs, ki}   (nur gemeinsame Listen)
 *   trips/<id>/plandays/meta    {dinner:{… skip:[Tage], ov:{Tag: "HH:MM"}}}
 *   trips/<id>/picks/p_<d>_<c>  {k:"<d>:<c>", v:true|false}
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

async function recent(S, trip, uid) {
  const L = (await S.list('trips/' + trip + '/kilog')).filter(x => x.data && x.data.uid === uid).sort((a, b) => (b.data.at - a.data.at) || ((a.data.n || 0) - (b.data.n || 0))).slice(0, 15).map(x => x.data);
  if (!L.length) return 'Claude hat in dieser Reise noch nichts geändert.';
  const f = t => new Intl.DateTimeFormat('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(t));
  return 'Letzte Änderungen durch Claude (neueste zuerst; Rückgängig in der App unter Einstellungen → Konto):\n' + L.map(x => `- ${f(x.at)} ${clean(x.txt, 160)}${x.undone ? ' (rückgängig gemacht)' : ''}`).join('\n');
}

module.exports = { writer, recent };
