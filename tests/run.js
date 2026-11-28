/* Reiseplaner – automatische Tests (ohne Firebase, nur mit erfundenen Beispielreisen).
 *   node tests/run.js            alle Tests
 *   node tests/run.js karte      nur Tests, deren Name „karte“ enthält
 * Ergebnis: PASS/FAIL je Test, Exit-Code 0 = alles grün. */
'use strict';
const H = require('./helpers');
const fs = require('fs'), path = require('path');
const only = (process.argv[2] || '').toLowerCase();
const T = [];
const test = (name, fn) => T.push({ name, fn });
const ok = (c, msg) => { if (!c) throw new Error(msg); };

/* ---------- Import-Prüfung ---------- */
test('import: Beispielreisen bestehen die Prüfung', async () => {
  for (const n of ['kreuzfahrt', 'roadtrip']) { const r = H.tripCheck(fs.readFileSync(path.join(H.ROOT, 'docs/beispiel/BEISPIEL-' + n + '.json'), 'utf8')); ok(r.ok, n + ': ' + r.errors.join('; ')); }
});
test('import: Fehler werden erkannt', async () => {
  const o = H.trip('kreuzfahrt'); o.id = 'Falsche ID'; o.data.ports[1].lat = null; o.data.ports.pop(); o.data.quiz[0][3] = ['x'];
  const r = H.tripCheck(o); ok(!r.ok && r.errors.length >= 4, 'erwartet ≥ 4 Fehler, bekommen: ' + r.errors.length);
});

/* ---------- Alle Ansichten ohne Fehler (Handy und PC, Kreuzfahrt und Roadtrip) ---------- */
for (const [label, opt] of [['Handy', { device: 'Pixel 7' }], ['PC', { viewport: { width: 1440, height: 900 } }], ['Handy dunkel', { device: 'Pixel 7', dark: true }]])
  for (const name of ['kreuzfahrt', 'roadtrip'])
    test(`ansichten: ${name} · ${label}`, async ({ browser, base }) => {
      const c = await H.context(browser, opt), t = H.trip(name), p = await H.open(c, base, t);
      for (const h of ['', '#heute', '#plan', '#tag-1', '#tag-2', '#tag-' + t.data.ports.length, '#todos', '#bord']) await H.go(p, base, h);
      for (const f of ['menuDlg', 'searchDlg', 'mappeDlg', 'gamesDlg', 'quizDlg', 'spiderDlg', 'offlineDlg'].concat(name === 'kreuzfahrt' ? ['deckDlg', 'drinksDlg'] : [])) {
        await H.go(p, base, '#tag-2'); await p.evaluate(f => window[f](), f); await p.waitForTimeout(300);
      }
      await c.close(); ok(!p.errs.length, p.errs.join(' | '));
    });

/* ---------- Karte ---------- */
test('karte: Tipps und eigene Orte als Pins', async ({ browser, base }) => {
  const c = await H.context(browser), t = H.trip('kreuzfahrt');
  const p = await H.open(c, base, t, '#tag-2', `localStorage.setItem('rp-${t.id}-plan-v1',JSON.stringify({2:[{id:'e1',x:1,n:'Testort',s:60,t:0,at:'',note:'',lat:39.88,lon:4.26,osm:''}]}))`);
  const n = await p.evaluate(() => ({ star: mks.filter(m => m.kind === 'star').length, tip: mks.filter(m => m.kind === 'tip').length }));
  await c.close(); ok(n.star === 1 && n.tip >= 3, JSON.stringify(n)); ok(!p.errs.length, p.errs.join(' | '));
});

/* ---------- Start auf jeder Seite (die App öffnet die zuletzt besuchte Seite) ---------- */
test('start: jede Seite als Startseite ohne Fehler', async ({ browser, base }) => {
  const t = H.trip('kreuzfahrt'), bad = [];
  for (const h of ['#plan', '#heute', '#mappe', '#todos', '#bord', '#tag-2', '']) {
    const c = await H.context(browser), p = await H.open(c, base, t, h);
    if (p.errs.length) bad.push((h || 'ohne') + ': ' + p.errs.join(' | '));
    await c.close();
  }
  ok(!bad.length, bad.join(' ; '));
});

test('konto: verbundene KI anzeigen und trennen', async ({ browser, base }) => {
  const c = await H.context(browser), t = H.trip('kreuzfahrt'), posts = [];
  let L = [{ id: 'f_a', created: Date.UTC(2026, 10, 20, 9), lastUsed: Date.UTC(2026, 10, 25, 14) }, { id: 'f_b', created: Date.UTC(2026, 10, 21, 9), lastUsed: Date.UTC(2026, 10, 22, 9) }];
  let fail = false;
  await c.route(/fake-mcp\/connections/, r => { const q = r.request();
    if (fail) return r.fulfill({ status: 500, body: '{}' });
    if (q.method() === 'POST') { const b = JSON.parse(q.postData() || '{}'); posts.push(b); L = b.all ? [] : L.filter(x => x.id !== b.id); return r.fulfill({ contentType: 'application/json', body: '{"ok":true}' }); }
    r.fulfill({ contentType: 'application/json', body: JSON.stringify({ connections: L }) }); });
  const p = await H.open(c, base, t, '#plan', `window.__TEST_MCP='${base}/fake-mcp';`);
  await p.evaluate(() => { window.confirm = () => true; document.body.insertAdjacentHTML('beforeend', '<div id="aitest" data-aic></div>'); }); await p.waitForTimeout(600);
  let txt = await p.innerText('#aitest');
  ok(/Claude[\s\S]*25\.11\.26[\s\S]*Claude/.test(txt) && /Alle trennen/.test(txt), 'Liste falsch: ' + txt);
  ok((await p.$$('#aitest [data-aicx]:not([data-aicx="*"])')).length === 2, 'zwei Trennen-Knöpfe erwartet');
  await p.click('#aitest [data-aicx="f_b"]'); await p.waitForTimeout(600);
  ok(posts.length === 1 && posts[0].id === 'f_b', 'POST falsch: ' + JSON.stringify(posts));
  txt = await p.innerText('#aitest'); ok(!/Alle trennen/.test(txt) && (await p.$$('#aitest [data-aicx]')).length === 1, 'nach Trennen: ' + txt);
  await p.click('#aitest [data-aicx="f_a"]'); await p.waitForTimeout(600);
  ok(/Keine KI verbunden/.test(await p.innerText('#aitest')), 'leer erwartet');
  fail = true; await p.evaluate(() => aiLoad(document.getElementById('aitest'))); await p.waitForTimeout(400);
  ok(/Gerade nicht abrufbar/.test(await p.innerText('#aitest')), 'Fehleranzeige fehlt');
  await c.close(); ok(!p.errs.length, p.errs.join(' | '));
});

test('konto: Änderungen durch KI – Kennzeichen 🤖 und Rückgängig (Plan, Abendessen, Ausflug, geändert)', async ({ browser, base }) => {
  const c = await H.context(browser), t = H.trip('kreuzfahrt'), p = await H.open(c, base, t, '#tag-2');
  const r = await p.evaluate(() => {
    const now = Date.now(), out = {};
    // vom Server angelegter und von Claude geänderter Eintrag (wie functions/mcp/write.js)
    const neu = { x: 1, n: 'KI-Schnorcheln', s: 60, t: 0, at: '10:00', note: '', ki: { uid: 'u1', at: now, neu: 1 } };
    (plan[2] = plan[2] || []).push({ ...neu, id: 'ek1' });
    (plan[4] = plan[4] || []).push({ x: 1, n: 'Spaziergang', s: 30, t: 0, at: '15:00', note: '', id: 'eu1', ki: { uid: 'u1', at: now, neu: 0 } });
    savePlan(); renderPanel();
    out.mark = document.querySelectorAll('.kim').length;
    DIN.at = '18:30'; DIN.skip = [2]; DIN.ov = {}; dinSave(false);
    const pk = '2:' + D.ports[1].ex[1].c; picks[pk] = false; persistPicks();
    window.confirm = () => true;
    window.__TEST_KILOG = [
      { id: 'k1', uid: 'u1', at: now - 4000, col: 'planitems', doc: 'ek1', before: null, after: { ...neu, d: 2, o: 1000 }, txt: 'Eintrag „KI-Schnorcheln“ an Tag 2 angelegt' },
      { id: 'k2', uid: 'u1', at: now - 3000, col: 'planitems', doc: 'eu1', before: { x: 1, n: 'Spaziergang', s: 30, t: 0, at: '14:00', note: '', d: 4, o: 0 }, after: { x: 1, n: 'Spaziergang', s: 30, t: 0, at: '15:00', note: '', d: 4, o: 0, ki: { neu: 0 } }, txt: 'Eintrag „Spaziergang“ geändert (Tag 4)' },
      { id: 'k3', uid: 'u1', at: now - 2000, col: 'dinner', doc: '2', before: { skip: [], ov: {} }, after: { skip: [2], ov: {} }, txt: 'Abendessen an Tag 2 fällt aus' },
      { id: 'k4', uid: 'u1', at: now - 1000, col: 'picks', doc: 'p_x', before: null, after: { k: pk, v: false }, txt: 'Ausflug abgewählt' },
    ];
    out.pk = pk; return out;
  });
  ok(r.mark >= 1, 'Kennzeichen 🤖 fehlt im Tagesplan');
  await p.evaluate(() => kiLogDlg()); await p.waitForTimeout(500);
  const txt = await p.innerText('#kil'); ok(/KI-Schnorcheln[\s\S]*Rückgängig/.test(txt) && /fällt aus/.test(txt), 'Liste falsch: ' + txt);
  for (const k of ['k1', 'k2', 'k3', 'k4']) { const i = await p.evaluate(k => window.__TEST_KILOG.slice().sort((a, b) => b.at - a.at).findIndex(x => x.id === k), k); await p.click(`#kil [data-kiu="${i}"]`); await p.waitForTimeout(150); }
  const s = await p.evaluate(pk => ({ ek1: Object.values(plan).flat().some(x => x && x.id === 'ek1'), eu1: (plan[4] || []).find(x => x.id === 'eu1'), skip: DIN.skip.slice(), pk: pk in picks, undone: window.__TEST_KILOG.every(x => x.undone), txt: document.getElementById('kil').innerText }), r.pk);
  ok(!s.ek1, 'angelegter Eintrag nicht entfernt'); ok(s.eu1 && s.eu1.at === '14:00' && !s.eu1.ki, 'Änderung nicht zurückgesetzt: ' + JSON.stringify(s.eu1));
  ok(!s.skip.includes(2), 'Abendessen nicht zurückgesetzt'); ok(!s.pk, 'Ausflugswahl nicht zurückgesetzt'); ok(s.undone && /rückgängig gemacht/.test(s.txt), 'nicht als rückgängig markiert');
  // gelöschten Eintrag wiederherstellen (Reihenfolge), Aufgabe, nach App-Bearbeitung kein Doppel, „Nein“ bei Rückfrage, Texte maskiert
  const s2 = await p.evaluate(() => {
    const out = {}, now = Date.now(), bad = '<img src=x onerror="window.__xss=1">';
    closeDlg(); let asked = 0; window.alert = () => { asked++ };
    const del = { x: 1, n: 'Gelöscht ' + bad, s: 30, t: 0, at: '', note: bad, d: 2, o: 0, ki: { uid: 'u1', at: now, neu: 1 } };
    out.ok1 = kiUndo({ id: 'k5', col: 'planitems', doc: 'ed1', before: del, after: null });
    out.restored = (plan[2] || [])[0] && plan[2][0].id === 'ed1';
    renderPanel(); out.esc = !document.querySelector('#panel img[src="x"]');
    // Aufgabe: angelegt → rückgängig = gelöscht
    tsPutTask({ id: 'tk1', ts: now, done: false, text: 'KI-Aufgabe', who: '', due: '', list: 'l', note: '', subs: [], ki: { neu: 1 } });
    out.ok2 = kiUndo({ id: 'k6', col: 'tasks', doc: 'tk1', before: null, after: { text: 'KI-Aufgabe', done: false, due: '', list: 'l', note: '' } });
    out.task = TS.tasks.some(t => t.id === 'tk1');
    // geändert, danach in der App neu gespeichert (Kennung weg) → abgelehnt, kein Doppel
    const n0 = Object.values(plan).flat().length;
    out.ok3 = kiUndo({ id: 'k7', col: 'planitems', doc: 'weg1', before: { x: 1, n: 'Alt', s: 30, at: '09:00', d: 2, o: 0 }, after: { x: 1, n: 'Neu', s: 30, at: '10:00', d: 2, o: 0 } });
    out.n = Object.values(plan).flat().length - n0; out.asked = asked;
    // Rückfrage mit „Nein“ → nichts geändert
    (plan[4] = plan[4] || []).push({ x: 1, n: 'Lauf', s: 30, t: 0, at: '07:00', note: '', id: 'eu2' }); window.confirm = () => false;
    out.ok4 = kiUndo({ id: 'k8', col: 'planitems', doc: 'eu2', before: { x: 1, n: 'Lauf', s: 30, t: 0, at: '06:00', note: '', d: 4, o: 0 }, after: { x: 1, n: 'Lauf', s: 30, t: 0, at: '06:30', note: '', d: 4, o: 0 } });
    out.at = plan[4].find(x => x.id === 'eu2').at;
    window.__TEST_KILOG = [{ id: 'k9', uid: 'u1', at: now, col: 'planitems', doc: 'z', before: null, after: null, txt: 'Eintrag „' + bad + '“ angelegt' }];
    return out;
  });
  ok(s2.ok1 && s2.restored, 'gelöschter Eintrag nicht wiederhergestellt'); ok(s2.esc, 'Name nicht maskiert (XSS)');
  ok(s2.ok2 && !s2.task, 'Aufgabe nicht entfernt'); ok(!s2.ok3 && s2.n === 0 && s2.asked === 1, 'nach App-Bearbeitung darf kein Doppel entstehen'); ok(!s2.ok4 && s2.at === '07:00', '„Nein“ bei Rückfrage nicht beachtet');
  await p.evaluate(() => kiLogDlg()); await p.waitForTimeout(400);
  ok(!(await p.evaluate(() => window.__xss)) && !(await p.$('#kil img')), 'Protokoll-Text nicht maskiert (XSS)');
  await c.close(); ok(!p.errs.length, p.errs.join(' | '));
});

test('reisen: Entwurf von Claude – Vorschau, Übernehmen (wie Import, nie überschreiben), Verwerfen mit Rückgängig', async ({ browser, base }) => {
  const c = await H.context(browser), t = H.trip('kreuzfahrt'), bad = '<img src=x onerror="window.__xss=1">';
  const d = H.trip('roadtrip'); d.id = 'entwurf-test'; d.trip.title = 'Testentwurf ' + bad; d.data.ports[0].name = 'Ort ' + bad;
  const d2 = H.trip('roadtrip'); d2.id = 'entwurf-zwei'; d2.trip.title = 'Zweiter Entwurf';
  const docOf = (o, k) => ({ id: o.id, k, title: o.trip.title, kind: o.trip.kind, start: o.trip.start, end: o.trip.end, by: 'u1', at: Date.now(), json: JSON.stringify(o), warn: ['Hinweis ' + bad] });
  // Firestore nachgebildet (wie window.__kiDrafts im Lader); Import wird nur aufgezeichnet
  const pre = `(function(){var S=JSON.parse(localStorage.getItem('rp-test-kd')||'null')||${JSON.stringify({ 'kientwurf_entwurf-test': docOf(d, 'kientwurf_entwurf-test'), 'kientwurf_entwurf-zwei': docOf(d2, 'kientwurf_entwurf-zwei') })};
    var sv=function(){localStorage.setItem('rp-test-kd',JSON.stringify(S))};
    window.__kiDrafts={list:async function(){return Object.keys(S).map(function(k){var x=S[k];return {k:k,id:x.id,title:x.title,kind:x.kind,start:x.start,end:x.end,by:x.by,at:x.at}})},get:async function(k){return S[k]||null},
      drop:async function(k){var o=S[k]||null;delete S[k];sv();return o},restore:async function(k,o){S[k]=o;sv()}};
    window.__importTrip=async function(o,neu){localStorage.setItem('rp-test-imp',JSON.stringify({id:o.id,neu:neu,ports:o.data.ports.length}))};})();`;
  const p = await H.open(c, base, t, '#plan', pre);
  await p.evaluate(() => { window.confirm = () => true; offlineDlg('trip'); }); await p.waitForTimeout(600);
  let txt = await p.innerText('#kidr');
  ok(/Entwurf von Claude/.test(txt) && /Testentwurf/.test(txt) && /Zweiter Entwurf/.test(txt) && /Übernehmen/.test(txt) && /Verwerfen/.test(txt), 'Liste falsch: ' + txt);
  // Vorschau als Seite: Tage, Hinweise, maskiert
  await p.click('[data-kdv="kientwurf_entwurf-test"]'); await p.waitForTimeout(500);
  const pv = await p.evaluate(() => ({ page: document.getElementById('dlg').classList.contains('page'), txt: document.getElementById('dlg').innerText, rows: document.querySelectorAll('#dlg .kdd').length }));
  ok(pv.page && pv.rows === d.data.ports.length, 'Vorschau: ' + JSON.stringify({ page: pv.page, rows: pv.rows }));
  ok(/Tag 1/.test(pv.txt) && /noch nicht angelegt/.test(pv.txt) && /Hinweis/.test(pv.txt), 'Vorschau-Text: ' + pv.txt.slice(0, 300));
  ok(!(await p.evaluate(() => window.__xss)) && !(await p.$('#dlg img')), 'Vorschau nicht maskiert (XSS)');
  ok(await p.evaluate(() => kulHTML({ land: 'constructor', name: '__proto__' }) === ''), 'Land & Leute: Sonderschlüssel führen zu Fehler');
  // Verwerfen aus der Vorschau → Rückgängig stellt wieder her
  await p.click('#kddel'); await p.waitForTimeout(500);
  ok(!(await p.evaluate(() => 'kientwurf_entwurf-test' in JSON.parse(localStorage.getItem('rp-test-kd')))), 'nicht verworfen');
  await p.click('#toast .tundo'); await p.waitForTimeout(400);
  ok(await p.evaluate(() => 'kientwurf_entwurf-test' in JSON.parse(localStorage.getItem('rp-test-kd'))), 'Rückgängig ging nicht');
  // Übernehmen: echte Prüfung (__checkTrip mit tripcheck.js), Import mit neu=true, Entwurf danach weg
  await p.evaluate(() => { closeDlg(); setTimeout(() => offlineDlg('trip'), 100); }); await p.waitForTimeout(800);
  await p.click('[data-kda="kientwurf_entwurf-test"]'); await p.waitForTimeout(2500);
  const r = await p.evaluate(() => ({ imp: JSON.parse(localStorage.getItem('rp-test-imp') || 'null'), kd: Object.keys(JSON.parse(localStorage.getItem('rp-test-kd'))) }));
  ok(r.imp && r.imp.id === 'entwurf-test' && r.imp.neu === true && r.imp.ports === d.data.ports.length, 'Import falsch: ' + JSON.stringify(r.imp));
  ok(r.kd.length === 1 && r.kd[0] === 'kientwurf_entwurf-zwei', 'Entwurf nach Übernehmen nicht entfernt: ' + r.kd);
  // fehlerhafter Entwurf: Prüfung lehnt ab, kein Import
  await p.evaluate(() => { localStorage.removeItem('rp-test-imp'); const S = JSON.parse(localStorage.getItem('rp-test-kd')); const o = JSON.parse(S['kientwurf_entwurf-zwei'].json); o.data.ports.pop(); S['kientwurf_entwurf-zwei'].json = JSON.stringify(o); localStorage.setItem('rp-test-kd', JSON.stringify(S)); });
  await p.reload(); await p.waitForTimeout(1500); await p.evaluate(() => offlineDlg('trip')); await p.waitForTimeout(600);
  await p.click('[data-kda="kientwurf_entwurf-zwei"]'); await p.waitForTimeout(1200);
  ok(/kann so nicht importiert werden/.test(await p.innerText('#kidr')) && !(await p.evaluate(() => localStorage.getItem('rp-test-imp'))), 'fehlerhafter Entwurf wurde nicht abgelehnt');
  await c.close(); ok(!p.errs.length, p.errs.join(' | '));
});
test('entwurf: functions/format/ enthält aktuelle Kopien (sonst: node tools/dayplan-sync.js)', async () => {
  const { FORMAT } = require(path.join(H.ROOT, 'tools/dayplan-sync.js'));
  for (const [a, b] of FORMAT) ok(fs.existsSync(b) && fs.readFileSync(a).equals(fs.readFileSync(b)), path.relative(H.ROOT, b) + ' veraltet – node tools/dayplan-sync.js');
});

test('reisen: Auswahl beim ersten Start, Öffnen und Bearbeiten bei jeder Reise', async ({ browser, base }) => {
  const c = await H.context(browser), t = H.trip('kreuzfahrt'), y = new Date().getFullYear();
  const L = [{ id: 'alt-1', title: 'Alte Reise', start: (y - 1) + '-03-01', end: (y - 1) + '-03-05' }, { id: 'neu-1', title: 'Spätere Reise', start: (y + 2) + '-05-01', end: (y + 2) + '-05-03' },
    { id: 'bald-1', title: 'Nächste Reise', start: (y + 1) + '-01-01', end: (y + 1) + '-01-03' }, { id: t.id, title: t.trip.title, start: t.trip.start, end: t.trip.end }];
  const p = await H.open(c, base, t, '#plan', `window.__listTrips=async()=>${JSON.stringify(L)};`);
  // Auswahl (Lader): geplante zuerst nach Datum, vergangene zuletzt; Antippen merkt die Reise auf dem Gerät
  const g = await p.evaluate(L => { window.__showPick(L.slice(0, 3), 'Die zuletzt geöffnete Reise gibt es nicht mehr.'); const G = document.getElementById('gate'); return { txt: G.innerText, ids: [...G.querySelectorAll('[data-tid]')].map(b => b.dataset.tid) }; }, L);
  ok(g.ids.join() === 'bald-1,neu-1,alt-1', 'Reihenfolge: ' + g.ids); ok(/gibt es nicht mehr/.test(g.txt) && /vorbei/.test(g.txt) && /geplant/.test(g.txt), 'Auswahl-Text: ' + g.txt);
  await Promise.all([p.waitForNavigation(), p.click('#gate [data-tid="neu-1"]')]); await p.waitForTimeout(1500);
  ok(await p.evaluate(() => localStorage.getItem('rp-trip')) === 'neu-1', 'Auswahl nicht gemerkt');
  // Einstellungen → Reisen: jede Reise hat „Bearbeiten ›“; bei einer anderen Reise: öffnen und Bearbeiten vormerken
  await p.evaluate(() => offlineDlg('trip')); await p.waitForTimeout(600);
  const n = await p.evaluate(() => ({ ed: document.querySelectorAll('#triplist [data-edit]').length, op: document.querySelectorAll('#triplist [data-open]').length }));
  ok(n.ed === 4 && n.op === 3, 'Links: ' + JSON.stringify(n));
  await Promise.all([p.waitForNavigation(), p.click('#triplist [data-trip="bald-1"] [data-edit]')]); await p.waitForTimeout(1500);
  ok(await p.evaluate(() => localStorage.getItem('rp-trip') === 'bald-1' && sessionStorage.getItem('rp-edit-next') === 'bald-1'), 'Bearbeiten nicht vorgemerkt');
  // nach dem Öffnen (hier: geöffnete Reise vorgemerkt) startet das Bearbeiten von selbst
  await p.evaluate(id => sessionStorage.setItem('rp-edit-next', id), t.id); await p.reload(); await p.waitForTimeout(2500);
  ok(await p.evaluate(() => !document.getElementById('ov').hidden && !sessionStorage.getItem('rp-edit-next')), 'Bearbeiten startet nicht');
  await c.close(); ok(!p.errs.length, p.errs.join(' | '));
});

test('ausflüge: 🤖 von Claude, Rückgängig, Foto hinzufügen/entfernen, nur echte Bilddaten', async ({ browser, base }) => {
  const c = await H.context(browser), t = H.trip('kreuzfahrt');
  const ex2 = t.data.ports[1].ex; ex2[0] = { ...ex2[0], p: 45, ki: { uid: 'u1', at: 1, neu: 0 } };   // von Claude geändert
  t.data.ports[3].ex = [{ c: 'C40', n: 'Inselrundfahrt (erfunden)', p: 49, dur: '4,5 Std.', ki: { uid: 'u1', at: 1, neu: 1 } }];   // von Claude angelegt
  t.photos = { B20: 'data:image/png;base64,AAAA" onerror="window.__xss=1' };   // manipuliert → nicht anzeigen
  const p = await H.open(c, base, t, '#tag-2');
  await p.evaluate(() => { select(2); setTab('ex'); }); await p.waitForTimeout(400);
  const a = await p.evaluate(() => ({ kim: document.querySelectorAll('#ex0 .kim').length, kim1: document.querySelectorAll('#ex1 .kim').length, img: document.querySelectorAll('#ex1 img').length, ph: document.querySelectorAll('[data-exph]').length }));
  ok(a.kim === 1 && a.kim1 === 0, '🤖 falsch: ' + JSON.stringify(a)); ok(a.img === 0 && !(await p.evaluate(() => window.__xss)), 'manipuliertes Foto angezeigt'); ok(a.ph === 2, 'Foto-Links fehlen');
  // Rückgängig: geänderter Ausflug → alter Preis, angelegter → weg; gespeichert über tripSave
  const o = t.data.ports[1].ex[0];
  const r = await p.evaluate(o => { window.confirm = () => true; const b = { ...o }; delete b.ki; b.p = 39;
    const u1 = kiUndo({ id: 'k1', col: 'ex', doc: '2:' + o.c, before: b, after: { ...o } }), u2 = kiUndo({ id: 'k2', col: 'ex', doc: '4:C40', before: null, after: { c: 'C40', n: 'Inselrundfahrt (erfunden)', p: 49, dur: '4,5 Std.' } });
    return { u1, u2 }; }, o); await p.waitForTimeout(400);
  const s = await p.evaluate(c => ({ p: byDay(2).ex.find(x => x.c === c).p, ki: !!byDay(2).ex.find(x => x.c === c).ki, c40: (byDay(4).ex || []).length, saved: window.__SAVED && window.__SAVED.data.ports[1].ex.find(x => x.c === c).p, saved4: (window.__SAVED.data.ports[3].ex || []).length }), o.c);
  ok(r.u1 && r.u2 && s.p === 39 && !s.ki && s.c40 === 0 && s.saved === 39 && s.saved4 === 0, 'Rückgängig: ' + JSON.stringify(s));
  // Foto hinzufügen (Datei wählen → verkleinert als JPEG), dann entfernen mit Rückgängig
  await p.evaluate(() => { select(2); setTab('ex'); }); await p.waitForTimeout(300);
  await p.click('#ex1 [data-exph]'); await p.waitForTimeout(300);
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP8z8DAwMDAxMDAwMDAAAANHQEDasKb6QAAAABJRU5ErkJggg==', 'base64');
  await p.setInputFiles('#exphf', { name: 'bild.png', mimeType: 'image/png', buffer: png }); await p.waitForTimeout(800);
  const f = await p.evaluate(c => ({ d: (D.photos[c] || '').slice(0, 23), img: document.querySelectorAll('#ex1 img').length, lnk: document.querySelector('#ex1 [data-exph]').textContent }), ex2[1].c);
  ok(f.d === 'data:image/jpeg;base64,' && f.img === 1 && /ändern/.test(f.lnk), 'Foto nicht gespeichert: ' + JSON.stringify(f));
  await p.click('#ex1 [data-exph]'); await p.waitForTimeout(300); await p.click('#exphd'); await p.waitForTimeout(300);
  ok(!(await p.evaluate(c => c in D.photos, ex2[1].c)), 'Foto nicht entfernt');
  await p.click('#toast .tundo'); await p.waitForTimeout(300); ok(await p.evaluate(c => /^data:image\/jpeg/.test(D.photos[c] || ''), ex2[1].c), 'Rückgängig Foto');
  // auch im Ausflugs-Fenster: 🤖 und Foto-Link
  await p.evaluate(c => { closeDlg(); exDlg(2, c); }, o.c); await p.waitForTimeout(300);
  ok(await p.evaluate(() => !!document.querySelector('#dlg [data-exph]')), 'Foto-Link im Fenster fehlt');
  await c.close(); ok(!p.errs.length, p.errs.join(' | '));
});

test('ausflüge: Orte als Links (Liste und im Programm), Google Maps online, eigene Karte offline, Orte bearbeiten', async ({ browser, base }) => {
  const c = await H.context(browser), t = H.trip('kreuzfahrt'), bad = '<img src=x onerror="window.__xss=1">';
  t.data.ports[1].ex[1].orte = [{ n: 'Hafenbucht ' + bad, lat: 39.88, lon: 4.3 }];
  const p = await H.open(c, base, t, '#tag-2');
  await p.evaluate(() => { window.open = u => { window.__opened = u; return {}; }; select(2); setTab('ex'); }); await p.waitForTimeout(400);
  const a = await p.evaluate(() => ({ list: document.querySelectorAll('#ex0 .exol [data-exo]').length, inText: document.querySelectorAll('#ex0 p [data-exo]').length, txt: document.querySelector('#ex0').innerText }));
  ok(a.list === 1 && a.inText === 2, 'Links: ' + JSON.stringify(a)); ok(/📍 Leuchtturm/.test(a.txt), 'Ortszeile fehlt');
  ok(!(await p.evaluate(() => window.__xss)) && !(await p.$('#ex1 img[src="x"]')), 'Ortsname nicht maskiert (XSS)');
  await p.click('#ex0 .exol [data-exo]'); await p.waitForTimeout(200);
  ok(/google\.com\/maps\/search\/\?api=1&query=39\.861,4\.322/.test(await p.evaluate(() => window.__opened || '')), 'Google Maps nicht geöffnet');
  // ohne Internet: eigene Karte mit Pin und Hinweis
  await c.setOffline(true); await p.evaluate(() => { window.__opened = null; select(2); setTab('ex'); }); await p.waitForTimeout(300);
  await p.click('#ex0 .exol [data-exo]'); await p.waitForTimeout(900);
  const o = await p.evaluate(() => ({ opened: window.__opened, mark: MAPMARK && MAPMARK.n, toast: (document.getElementById('toast') || {}).innerText || '', sel }));
  ok(!o.opened && o.mark === 'Leuchtturm' && /Kein Internet/.test(o.toast) && o.sel === 2, 'offline: ' + JSON.stringify(o));
  await c.setOffline(false);
  // Orte bearbeiten: suchen, hinzufügen, entfernen, Rückgängig
  await p.evaluate(() => { closeDlg(); exOrteDlg(2, 'B12'); }); await p.waitForTimeout(300);
  await p.fill('#exoq', 'Strandbar'); await p.click('#exos'); await p.waitForTimeout(800);
  await p.click('#exor [data-exr="0"]'); await p.waitForTimeout(400);
  const n = await p.evaluate(() => ({ local: byDay(2).ex[0].orte.map(o => o.n), saved: window.__SAVED.data.ports[1].ex[0].orte.length, rows: document.querySelectorAll('#exol [data-exod]').length }));
  ok(n.local.length === 2 && n.saved === 2 && n.rows === 2, 'hinzufügen: ' + JSON.stringify(n));
  await p.click('#exol [data-exod="0"]'); await p.waitForTimeout(300);
  ok(await p.evaluate(() => byDay(2).ex[0].orte.length === 1 && window.__SAVED.data.ports[1].ex[0].orte.length === 1), 'entfernen');
  await p.click('#toast .tundo'); await p.waitForTimeout(300);
  ok(await p.evaluate(() => byDay(2).ex[0].orte[0].n === 'Leuchtturm' && byDay(2).ex[0].orte.length === 2), 'Rückgängig');
  await c.close(); ok(!p.errs.length, p.errs.join(' | '));
});

test('ortsinfos und tipps von Claude: 🤖, Position für neue Tipps, Rückgängig', async ({ browser, base }) => {
  const c = await H.context(browser), t = H.trip('kreuzfahrt'), P = t.data.ports[1];
  const neu = { id: 'k-strand-ab12', n: 'Strand Neu (erfunden)', t: 'beach', w: 'walk', lat: P.lat + 0.004, lon: P.lon + 0.004, d: 'Neu.', ki: { uid: 'u1', at: 1, neu: 1 } };
  P.pois.push(neu); P.ort = 'Von Claude geändert (erfunden).'; P.kiInfo = { uid: 'u1', at: 1 };
  const p = await H.open(c, base, t, '#tag-2');
  await p.evaluate(() => { select(2); }); await p.waitForTimeout(400);
  const a = await p.evaluate(() => { const q = byDay(2).pois.find(x => x.id === 'k-strand-ab12'); return { ox: q.ox, km: q.km, txt: document.getElementById('panel').innerText }; });
  ok(isFinite(a.ox) && a.km > 0 && a.km < 2, 'Position/Entfernung fehlt: ' + JSON.stringify({ ox: a.ox, km: a.km }));
  const m = await p.evaluate(() => { setTab('pois'); return new Promise(r => setTimeout(() => r(document.querySelectorAll('#panel .card .kim').length), 300)); });
  ok(m >= 1, '🤖 am Tipp fehlt');
  // Rückgängig: neuer Tipp weg, Ortstext zurück
  const r = await p.evaluate(o => { window.confirm = () => true;
    const u1 = kiUndo({ id: 'k1', col: 'poi', doc: '2:k-strand-ab12', before: null, after: o });
    const u2 = kiUndo({ id: 'k2', col: 'portinfo', doc: '2', before: { ort: 'Alter Ortstext (erfunden).', tips: ['A'] }, after: { ort: 'Von Claude geändert (erfunden).', tips: byDay(2).tips } });
    return { u1, u2 }; }, neu); await p.waitForTimeout(400);
  const s = await p.evaluate(() => ({ has: byDay(2).pois.some(x => x.id === 'k-strand-ab12'), ort: byDay(2).ort, tips: byDay(2).tips, ki: !!byDay(2).kiInfo, sv: window.__SAVED.data.ports[1].ort, svp: window.__SAVED.data.ports[1].pois.some(x => x.id === 'k-strand-ab12') }));
  ok(r.u1 && r.u2 && !s.has && !s.svp && s.ort === 'Alter Ortstext (erfunden).' && s.sv === s.ort && s.tips.join() === 'A' && !s.ki, 'Rückgängig: ' + JSON.stringify(s));
  await c.close(); ok(!p.errs.length, p.errs.join(' | '));
});

test('fabriken entfernt: alte Felder fact/src werden beim Import ignoriert, kein Bereich mehr', async ({ browser, base }) => {
  const o = H.trip('kreuzfahrt'); o.data.ports[1].fact = [{ n: 'Alte Fabrik (erfunden)', how: 'Taxi' }]; o.data.src = { a: ['Quelle', 'https://example.com/'] };
  const r = H.tripCheck(o); ok(r.ok && !('fact' in r.trip.data.ports[1]) && !('src' in r.trip.data) && r.warnings.some(w => /fact/.test(w)), 'Prüfung: ' + JSON.stringify(r.warnings));
  const c = await H.context(browser), p = await H.open(c, base, o, '#tag-2');
  const t = await p.evaluate(() => { select(2); return document.getElementById('panel').innerText; });
  ok(!/Fabriken/.test(t), 'Bereich noch da');
  ok(!(await p.$('#sec-fa')), 'Abschnitt Fabriken noch da');
  await c.close(); ok(!p.errs.length, p.errs.join(' | '));
});

test('währung: aus dem Land (dayplan.js), Anzeige unter „Über den Ort“, keine Summe der Ausflüge mehr', async ({ browser, base }) => {
  const R = require(path.join(H.ROOT, 'dayplan.js'));
  const W = l => (R.curOf({ kind: 'port', land: l }) || {}).c;
  ok(W('Dominikanische Republik') === 'DOP' && W('St. Lucia') === 'XCD' && W('Vereinigte Staaten von Amerika') === 'USD' && W('Frankreich, Guadeloupe') === 'EUR' && W('Norwegen') === 'NOK' && !W('Musterland'), 'Zuordnung');
  ok(R.curOf({ kind: 'sea', land: 'Spanien' }) === null && R.curOf({ kind: 'port', land: 'Spanien', cur: 'USD' }).c === 'USD', 'Seetag/Übersteuern');
  const c = await H.context(browser), t = H.trip('kreuzfahrt'); t.data.ports[3].land = 'Dominikanische Republik';
  const p = await H.open(c, base, t, '#tag-2');
  const a = await p.evaluate(() => { select(2); const s = document.getElementById('sec-ov'); s.open = true; return s.innerText; });
  ok(/Währung\s*Euro \(EUR\)/.test(a) && /💱 Beispiel: Karten/.test(a) && !/Eingeplant/.test(a), 'Tag 2: ' + a.slice(0, 300));
  const b = await p.evaluate(() => { select(4); const s = document.getElementById('sec-ov'); s.open = true; return s.innerText; });
  ok(/Dominikanischer Peso \(DOP\)/.test(b), 'Tag 4: ' + b.slice(0, 200));
  await c.close(); ok(!p.errs.length, p.errs.join(' | '));
});

/* ---------- Tagesplan ---------- */
test('tagesplan: Eintrag hinzufügen und Reihenfolge Ab Schiff → … → Zurück an Bord', async ({ browser, base }) => {
  const c = await H.context(browser), t = H.trip('kreuzfahrt'), p = await H.open(c, base, t, '#tag-2');
  await p.evaluate(() => addPointDlg(2)); await p.fill('#apf [name=n]', 'Kaffee'); await p.fill('#apf [name=at]', '10:00'); await p.click('#apf button[type=submit]'); await p.waitForTimeout(500);
  const txt = await p.evaluate(() => document.querySelector('.tl').innerText);
  await c.close(); ok(/Ab Schiff[\s\S]*Kaffee[\s\S]*Zurück an Bord/.test(txt), 'Reihenfolge falsch: ' + txt.slice(0, 200)); ok(!p.errs.length, p.errs.join(' | '));
});
test('tagesplan: Mehrfacheintrag über mehrere Tage, Überschneidung auslassen', async ({ browser, base }) => {
  const c = await H.context(browser), t = H.trip('kreuzfahrt');
  const p = await H.open(c, base, t, '#tag-2', `localStorage.setItem('rp-${t.id}-plan-v1',JSON.stringify({4:[{x:1,n:'Yoga',s:60,at:'07:30'}]}))`);
  await p.evaluate(() => addPointDlg(2)); await p.fill('#apf [name=n]', 'Frühstück'); await p.fill('#apf [name=at]', '07:00');
  await p.selectOption('#apf [name=rep]', '5'); await p.click('#apf button[type=submit]'); await p.waitForTimeout(400);
  const warn = await p.evaluate(() => !!document.querySelector('#aprep .repw')); await p.click('[data-rep="skip"]'); await p.waitForTimeout(500);
  const r = await p.evaluate(() => [2, 3, 4, 5].map(d => (plan[d] || []).filter(x => x.n === 'Frühstück').length).join(''));
  await c.close(); ok(warn, 'keine Warnung'); ok(r === '1101', 'Tage: ' + r); ok(!p.errs.length, p.errs.join(' | '));
});

/* ---------- Reise bearbeiten ---------- */
test('bearbeiten: Station verschieben – Einträge und Ausflüge wandern mit', async ({ browser, base }) => {
  const c = await H.context(browser), t = H.trip('kreuzfahrt');
  const p = await H.open(c, base, t, '#tag-2', `localStorage.setItem('rp-${t.id}-plan-v1',JSON.stringify({2:[{id:'e1',x:1,n:'Testeintrag',s:60,t:0,at:'',note:''}]}));localStorage.setItem('rp-${t.id}-picks-v1',JSON.stringify({'2:B12':true}))`);
  p.on('dialog', d => d.accept());
  await p.evaluate(() => editOpen()); await p.waitForTimeout(700);
  await p.click('[data-st="1"]'); await p.waitForTimeout(300); await p.selectOption('[name=pos]', '3'); await p.click('#edok'); await p.waitForTimeout(300);
  await p.click('#edsave'); await p.waitForTimeout(1500);
  const r = await p.evaluate(() => ({ name: window.__SAVED.data.ports[3].name, plan: Object.keys(plan), picks: Object.keys(picks) }));
  await c.close(); ok(r.name === 'Inselort Beta' && r.plan.includes('4') && r.picks.includes('4:B12'), JSON.stringify(r)); ok(!p.errs.length, p.errs.join(' | '));
});

/* ---------- Assistent ---------- */
test('assistent: neue Reise anlegen (Ortssuche, Wie Vortag)', async ({ browser, base }) => {
  const c = await H.context(browser), t = H.trip('kreuzfahrt');
  const p = await H.open(c, base, t, '#tag-2', `window.__createTrip=async o=>{window.__CREATED=o;return 'ok'};window.__listTrips=async()=>[];`);
  await p.evaluate(() => wizOpen()); await p.waitForTimeout(600);
  await p.fill('[name=title]', 'Testreise'); await p.click('[data-k=roadtrip]'); await p.fill('[name=start]', '2099-01-01'); await p.fill('[name=end]', '2099-01-02');
  await p.click('#wz1 button[type=submit]'); await p.waitForTimeout(400);
  await p.click('[data-d="0"]'); await p.waitForTimeout(300); await p.fill('#wzq', 'Testort'); await p.waitForTimeout(1200); await p.click('[data-r="0"]'); await p.click('#wzd button[type=submit]'); await p.waitForTimeout(300);
  await p.click('[data-d="1"]'); await p.waitForTimeout(300); await p.click('[data-kk=same]'); await p.click('#wzd button[type=submit]'); await p.waitForTimeout(300);
  await p.click('#wznx'); await p.waitForTimeout(1200); await p.click('#wzopen'); await p.click('#wzgo'); await p.waitForTimeout(1500);
  const o = await p.evaluate(() => window.__CREATED);
  await c.close(); ok(o && o.data.ports.length === 2 && o.data.ports[1].name === o.data.ports[0].name && H_ok(o), 'Reise nicht korrekt angelegt'); ok(!p.errs.length, p.errs.join(' | '));
});
global.H_ok = o => H.tripCheck(o).ok;

/* ---------- An- und Abreise ---------- */
test('anreise: Flug + Mietwagen, Zeitumstellung', async ({ browser, base }) => {
  const c = await H.context(browser), t = H.trip('roadtrip'), p = await H.open(c, base, t, '#plan');
  await p.click('[data-tv=out]'); await p.waitForTimeout(400);
  const pick = async (sel, q, i = 0) => { await p.click(sel); await p.waitForTimeout(300); await p.fill('#tvq', q); await p.waitForTimeout(1200); await p.click(`#tvr [data-r="${i}"]`); await p.waitForTimeout(300); };
  await pick('[data-pl="0|f"]', 'FRA'); await pick('[data-pl="0|t"]', 'TFS');
  await p.fill('[data-s="0|dd"]', '2099-08-10'); await p.fill('[data-s="0|dt"]', '06:00'); await p.fill('[data-s="0|ad"]', '2099-08-10'); await p.fill('[data-s="0|at"]', '09:30');
  await p.click('#tvadd'); await p.waitForTimeout(300); await p.click('[data-sm="1|car"]'); await p.waitForTimeout(200); await pick('[data-pl="1|t"]', 'Musterstadt'); await p.fill('[data-s="1|dt"]', '11:00');
  await p.click('#tvf button[type=submit]'); await p.waitForTimeout(2500);
  await p.click('.tvb summary'); await p.waitForTimeout(300); const s = await p.locator('.tvb').first().innerText();
  await c.close(); ok(/Uhr −1 Std\./.test(s) && /⏱/.test(s) && /🔁|📍/.test(s), s.replace(/\n/g, ' | ')); ok(!p.errs.length, p.errs.join(' | '));
});

/* ---------- Gemeinsame Tageslogik: Node (Server) rechnet wie die App ---------- */
test('tageslogik: app.js enthält dayplan.js unverändert (sonst: node tools/dayplan-sync.js)', async () => {
  const S = require(path.join(H.ROOT, 'tools/dayplan-sync.js')), b = S.block(fs.readFileSync(path.join(H.ROOT, 'app.js'), 'utf8'));
  ok(fs.readFileSync(path.join(H.ROOT, 'functions/dayplan.js'), 'utf8') === fs.readFileSync(path.join(H.ROOT, 'dayplan.js'), 'utf8'), 'functions/dayplan.js veraltet – node tools/dayplan-sync.js');
  ok(b !== null, 'Markierungen in app.js fehlen'); ok(b === fs.readFileSync(path.join(H.ROOT, 'dayplan.js'), 'utf8').replace(/\r\n/g, '\n').replace(/\s*$/, '\n'), 'app.js und dayplan.js weichen ab');
});
// Projektion der Ergebnisse (gleicher Code in Browser und Node)
const DP_PROJ = `P.map(p=>{const c=dp.calc(p);return {day:p.day,today:dp.todayStr(),W:c.W,back:c.back,slack:c.slack,fee:c.fee,cost:c.cost,u:c.u,ret:c.ret,
  rows:c.rows.map(r=>[r.a,r.b,r.st,r.q.n,!!r.tour,!!r.board,!!r.dinner,!!r.skip,r.pi,r.lg&&r.lg.t]),emb:dp.embList(p),aab:dp.aabInfo(p),din:dp.dinRow(p)&&dp.dinRow(p).q.n,
  nn:(n=>n&&[n.now,n.cur&&n.cur.q.n,n.nx&&n.nx.q.n])(dp.nowNext(p)),live:c.rows.map(r=>dp.rowLive(p,r)),now:dp.portNow(p)}})`;
for (const name of ['kreuzfahrt', 'roadtrip'])
  test(`tageslogik: Node rechnet wie die App (${name})`, async ({ browser, base }) => {
    const RPDP = require(path.join(H.ROOT, 'dayplan.js')), t = H.trip(name), P = t.data.ports, plan = {};
    P.forEach(p => { plan[p.day] = [...(p.pois || []).slice(0, 2).filter(q => q.g).map((q, i) => ({ i, ti: q.id })), { x: 1, n: 'Kaffee', s: 30, t: 10 }, { x: 1, n: 'Fix', s: 60, at: '13:15' }, { x: 1, n: 'Bord', s: 30, at: '21:00', dk: 9, dv: 0 }]; });
    const din = { at: '18:30', s: 90, table: '7', skip: [3], ov: { 2: '19:45' } }, c = await H.context(browser), pg = await c.newPage();
    await pg.clock.setFixedTime(new Date(t.trip.start + 'T09:40:00Z').getTime() + 864e5);   // Tag 2, vormittags
    await pg.addInitScript(`window.__TEST_TRIP=${JSON.stringify(t)};localStorage.setItem('rp-${t.id}-plan-v1',${JSON.stringify(JSON.stringify(plan))});localStorage.setItem('rp-${t.id}-dinner',${JSON.stringify(JSON.stringify(din))})`);
    const errs = []; pg.on('pageerror', e => errs.push(e.message)); await pg.goto(base + '/index.html#plan'); await pg.waitForTimeout(1500);
    const r = await pg.evaluate(PROJ => ({ app: new Function('dp', 'P', 'return ' + PROJ)(DP, D.ports), data: JSON.parse(JSON.stringify({ trip: TRIP, ports: D.ports, plan, picks, din: DIN, ship: SHIP, cruise: CRUISE, now: nowMs() })) }), DP_PROJ);
    const d = r.data, dp = RPDP.make({ trip: d.trip, ports: d.ports, plan: d.plan, picks: d.picks, din: d.din, ship: d.ship, cruise: d.cruise, now: () => d.now });
    const node = new Function('dp', 'P', 'return ' + DP_PROJ)(dp, d.ports), a = JSON.stringify(r.app), b = JSON.stringify(node);
    await c.close(); ok(!errs.length, errs.join(' | ')); ok(r.app.some(x => x.rows.length > 2) && r.app.some(x => x.din), 'zu wenig geprüft');
    ok(a === b, 'Unterschied App/Node: ' + (() => { for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a.slice(Math.max(0, i - 80), i + 80) + ' ≠ ' + b.slice(Math.max(0, i - 80), i + 80); })());
  });

/* ---------- Server für den Claude-Konnektor (functions/test/mcp.test.js) ---------- */
test('mcp-server: Anmeldung, Werkzeuge, Angriffsfälle (functions/test/mcp.test.js)', async () => {
  if (!fs.existsSync(path.join(H.ROOT, 'functions/node_modules/@modelcontextprotocol/sdk'))) { console.log('      (übersprungen: erst „npm install“ im Ordner functions)'); return; }
  const r = require('child_process').spawnSync(process.execPath, [path.join(H.ROOT, 'functions/test/mcp.test.js')], { encoding: 'utf8', timeout: 120000 });
  ok(r.status === 0, (r.stdout || '').split('\n').filter(l => /FAIL|Fehler|Error/.test(l)).slice(0, 6).join(' | ') || (r.stderr || '').slice(0, 300));
});

/* ---------- Teilen aus Google Maps ---------- */
test('teilen: Google-Maps-Link setzt den Pin', async ({ browser, base }) => {
  const c = await H.context(browser), t = H.trip('kreuzfahrt');
  const p = await H.open(c, base, t, '?text=' + encodeURIComponent('Testort\nhttps://maps.app.goo.gl/abc') + '#heute'); await p.waitForTimeout(1000);
  const s = await p.locator('#apl').innerText();
  await c.close(); ok(/auf der Karte/.test(s), s); ok(!p.errs.length, p.errs.join(' | '));
});

/* ---------- Ablauf ---------- */
(async () => {
  const { srv, url } = await H.serve(), browser = await H.chromium.launch();
  let fail = 0; const t0 = Date.now();
  for (const x of T) {
    if (only && !x.name.toLowerCase().includes(only)) continue;
    try { await x.fn({ browser, base: url }); console.log('PASS  ' + x.name); }
    catch (e) { fail++; console.log('FAIL  ' + x.name + '\n      ' + String(e.message || e).slice(0, 400)); }
  }
  await browser.close(); srv.close();
  console.log(`\n${fail ? fail + ' Test(s) fehlgeschlagen' : 'Alle Tests bestanden'} · ${Math.round((Date.now() - t0) / 1000)} s`);
  process.exit(fail ? 1 : 0);
})();
