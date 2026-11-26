/* Bettet dayplan.js (gemeinsame Tageslogik) in app.js ein, zwischen den beiden Markierungen.
 * Aufruf nach jeder Änderung an dayplan.js:  node tools/dayplan-sync.js
 * Warum eingebettet: app.js startet so auch offline während eines Updates garantiert mit passender Logik
 * (keine zweite Datei, die im Zwischenspeicher veraltet sein könnte). Der Server nutzt dayplan.js direkt.
 * tests/run.js prüft, dass beide Fassungen gleich sind. */
'use strict';
const fs = require('fs'), path = require('path');
const ROOT = path.resolve(__dirname, '..');
const A = '/* === dayplan.js eingebettet: nicht hier ändern, sondern dayplan.js bearbeiten und `node tools/dayplan-sync.js` ausführen === */\n';
const Z = '/* === Ende dayplan.js === */\n';
function embed(app, dp) {
  const i = app.indexOf(A), j = app.indexOf(Z);
  if (i < 0 || j < i) throw new Error('Markierungen in app.js fehlen');
  return app.slice(0, i + A.length) + dp.replace(/\s*$/, '\n') + app.slice(j);
}
function block(app) { const i = app.indexOf(A), j = app.indexOf(Z); return i < 0 || j < i ? null : app.slice(i + A.length, j); }
module.exports = { embed, block, A, Z };
if (require.main === module) {
  const f = path.join(ROOT, 'app.js'), app = fs.readFileSync(f, 'utf8'), dp = fs.readFileSync(path.join(ROOT, 'dayplan.js'), 'utf8');
  const out = embed(app, dp);
  if (out === app) console.log('app.js ist schon aktuell.'); else { fs.writeFileSync(f, out); console.log('dayplan.js in app.js übernommen.'); }
}
