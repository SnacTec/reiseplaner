/* Bettet dayplan.js (gemeinsame Tageslogik) in app.js ein, zwischen den beiden Markierungen.
 * Aufruf nach jeder Änderung an dayplan.js:  node tools/dayplan-sync.js
 * Warum eingebettet: app.js startet so auch offline während eines Updates garantiert mit passender Logik
 * (keine zweite Datei, die im Zwischenspeicher veraltet sein könnte). Der Server nutzt dayplan.js direkt.
 * Zusätzlich Kopie nach functions/dayplan.js (Server). tests/run.js prüft, dass alle drei Fassungen gleich sind. */
'use strict';
const fs = require('fs'), path = require('path');
const ROOT = path.resolve(__dirname, '..');
const A = '/* === dayplan.js eingebettet: nicht hier ändern, sondern dayplan.js bearbeiten und `node tools/dayplan-sync.js` ausführen === */\n';
const Z = '/* === Ende dayplan.js === */\n';
// Zeilenenden vereinheitlichen (Windows-Git kann CRLF erzeugen)
const lf = t => t.replace(/\r\n/g, '\n');
function find(app) { const i = app.indexOf(A), j = i < 0 ? -1 : app.indexOf(Z, i + A.length); return i < 0 || j < 0 ? null : { i, j }; }
function embed(app, dp) {
  app = lf(app); const m = find(app);
  if (!m) throw new Error('Markierungen in app.js fehlen (Anfang: „=== dayplan.js eingebettet“, Ende: „=== Ende dayplan.js ===“)');
  return app.slice(0, m.i + A.length) + lf(dp).replace(/\s*$/, '\n') + app.slice(m.j);
}
function block(app) { app = lf(app); const m = find(app); return m ? app.slice(m.i + A.length, m.j) : null; }
module.exports = { embed, block, A, Z };
if (require.main === module) {
  const f = path.join(ROOT, 'app.js'), app = fs.readFileSync(f, 'utf8'), dp = fs.readFileSync(path.join(ROOT, 'dayplan.js'), 'utf8');
  const out = embed(app, dp);
  if (out === app) console.log('app.js ist schon aktuell.'); else { fs.writeFileSync(f, out); console.log('dayplan.js in app.js übernommen.'); }
  // Kopie für den Server (Cloud Function „mcp“): Firebase lädt nur den Ordner functions/ hoch
  const g = path.join(ROOT, 'functions', 'dayplan.js');
  if (!fs.existsSync(g) || fs.readFileSync(g, 'utf8') !== dp) { fs.writeFileSync(g, dp); console.log('functions/dayplan.js aktualisiert.'); }
}
