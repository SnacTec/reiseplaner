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

/* ---------- Tagesplan ---------- */
test('tagesplan: Eintrag hinzufügen und Reihenfolge Ab Schiff → … → Zurück an Bord', async ({ browser, base }) => {
  const c = await H.context(browser), t = H.trip('kreuzfahrt'), p = await H.open(c, base, t, '#tag-2');
  await p.evaluate(() => addPointDlg(2)); await p.fill('#apf [name=n]', 'Kaffee'); await p.fill('#apf [name=at]', '10:00'); await p.click('#apf button[type=submit]'); await p.waitForTimeout(500);
  const txt = await p.evaluate(() => document.querySelector('.tl').innerText);
  await c.close(); ok(/Ab Schiff[\s\S]*Kaffee[\s\S]*Zurück an Bord/.test(txt), 'Reihenfolge falsch: ' + txt.slice(0, 200)); ok(!p.errs.length, p.errs.join(' | '));
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
  const s = await p.locator('.tvb').first().innerText();
  await c.close(); ok(/Uhr 1 Std\. zurückstellen/.test(s) && /Reisedauer gesamt/.test(s), s.replace(/\n/g, ' | ')); ok(!p.errs.length, p.errs.join(' | '));
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
