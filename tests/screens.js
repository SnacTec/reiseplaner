/* Reiseplaner – Screenshots zum Vergleichen (Handy, Tablet, PC).
 *   node tests/screens.js vorher      Screenshots in tests/out/vorher/
 *   (Änderung machen)
 *   node tests/screens.js nachher     Screenshots in tests/out/nachher/ + Vergleich mit „vorher“
 * Der Vergleich nennt jede Ansicht, die sich verändert hat (Animationen im Kopf können kleine Abweichungen erzeugen). */
'use strict';
const H = require('./helpers'), fs = require('fs'), path = require('path');
const tag = process.argv[2] || 'aktuell', OUT = path.join(__dirname, 'out', tag);
const SIZES = [['handy', { device: 'Pixel 7' }], ['tablet', { device: 'iPad Mini' }], ['pc', { viewport: { width: 1440, height: 900 } }]];
const VIEWS = ['', '#heute', '#plan', '#tag-1', '#tag-2', '#bord'];
const DLGS = ['menuDlg', 'deckDlg', 'mappeDlg', 'drinksDlg', 'gamesDlg', 'editOpen'];
(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const { srv, url } = await H.serve(), b = await H.chromium.launch(), t = H.trip('kreuzfahrt');
  // feste Uhrzeit, damit Countdown/„heute“ in beiden Läufen gleich sind
  const pre = 'Date.now=(()=>{const f=4102444800000;return()=>f})();';
  for (const [sz, opt] of SIZES) {
    const c = await H.context(b, opt), p = await H.open(c, url, t, '', pre);
    await p.addStyleTag({ content: '*{animation:none!important;transition:none!important}' }).catch(() => {});
    for (const v of VIEWS) { await H.go(p, url, v); await p.addStyleTag({ content: '*{animation:none!important;transition:none!important}' }); await p.screenshot({ path: path.join(OUT, `${sz}_${v.replace('#', '') || 'start'}.png`) }); }
    for (const f of DLGS) { await H.go(p, url, '#tag-2'); await p.evaluate(f => window[f](), f); await p.waitForTimeout(700); await p.screenshot({ path: path.join(OUT, `${sz}_${f}.png`) }); }
    if (p.errs.length) console.log(sz, 'Fehler:', p.errs.join(' | '));
    await c.close();
  }
  await b.close(); srv.close();
  console.log('Screenshots: ' + OUT);
  const A = path.join(__dirname, 'out', 'vorher');
  if (tag !== 'vorher' && fs.existsSync(A)) {
    let diff = 0;
    for (const f of fs.readdirSync(OUT)) { const a = path.join(A, f); if (!fs.existsSync(a)) continue;
      if (!fs.readFileSync(a).equals(fs.readFileSync(path.join(OUT, f)))) { diff++; console.log('verändert: ' + f); } }
    console.log(diff ? `${diff} Ansicht(en) verändert – bitte ansehen.` : 'Keine Veränderung gegenüber „vorher“.');
  }
})();
