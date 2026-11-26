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
