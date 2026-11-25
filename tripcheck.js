/* Reiseplaner – Prüfung und Aufbereitung einer Import-Datei (Format "reiseplaner-trip-1").
 *
 * Läuft im Browser (App-Import) und in Node (Selbsttest für KIs/Menschen):
 *   node tripcheck.js meine-reise.json
 *
 * tripCheck(o) gibt {ok, errors[], warnings[], fixes[], trip} zurück.
 *  - errors:   Datei kann so nicht importiert werden (bitte korrigieren).
 *  - warnings: Import möglich, aber etwas fehlt oder sieht ungewöhnlich aus.
 *  - fixes:    Dinge, die automatisch ergänzt/korrigiert wurden (trip ist die korrigierte Fassung).
 * Die vollständige Beschreibung des Formats steht in docs/IMPORT-FORMAT.md.
 */
(function (root) {
  'use strict';
  const FORMAT = 'reiseplaner-trip-1';
  const KINDS = ['kreuzfahrt', 'roadtrip', 'staedtereise', 'rundreise'];
  const PKINDS = ['start', 'port', 'sea', 'end'];
  const TIPT = ['sight', 'beach', 'nature', 'factory', 'town'];
  const WALK = ['walk', 'taxi', 'tour'];
  const DK = ['food', 'bar', 'pool', 'show', 'spa', 'sport', 'kids', 'shop', 'service', 'sun', 'other'];
  const QZ = ['l', 's', 'g', 'r'];
  const isDate = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(new Date(s + 'T12:00:00Z'));
  const isTime = s => typeof s === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
  const isNum = v => typeof v === 'number' && isFinite(v);
  const addD = (s, n) => { const d = new Date(s + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const km = (a, b, c, d) => +(6371 * Math.hypot((d - b) * Math.PI / 180 * Math.cos((a + c) * Math.PI / 360), (c - a) * Math.PI / 180)).toFixed(1);

  function tripCheck(input) {
    const E = [], W = [], F = [];
    const err = m => E.push(m), warn = m => W.push(m), fix = m => F.push(m);
    let o;
    try { o = typeof input === 'string' ? JSON.parse(input) : JSON.parse(JSON.stringify(input)); }
    catch (e) { return { ok: false, errors: ['Die Datei ist kein gültiges JSON: ' + e.message], warnings: [], fixes: [], trip: null }; }
    if (!o || typeof o !== 'object') return { ok: false, errors: ['Leere oder ungültige Datei.'], warnings: [], fixes: [], trip: null };

    /* Kopf */
    if (o.format !== FORMAT) err(`"format" muss genau "${FORMAT}" sein (ist: ${JSON.stringify(o.format)}).`);
    if (typeof o.id !== 'string' || !/^[a-z0-9][a-z0-9-]{2,59}$/.test(o.id)) err('"id" fehlt oder ist ungültig: nur Kleinbuchstaben, Ziffern und Bindestriche, 3–60 Zeichen (z. B. "mittelmeer-2027").');
    const t = o.trip;
    if (!t || typeof t !== 'object') { err('"trip" (Grunddaten) fehlt.'); return { ok: false, errors: E, warnings: W, fixes: F, trip: null }; }
    if (!t.title) err('trip.title (Titel der Reise) fehlt.');
    if (!KINDS.includes(t.kind)) err(`trip.kind muss einer dieser Werte sein: ${KINDS.join(', ')}.`);
    if (!isDate(t.start)) err('trip.start muss ein Datum im Format JJJJ-MM-TT sein.');
    if (!isDate(t.end)) err('trip.end muss ein Datum im Format JJJJ-MM-TT sein.');
    if (t.tz != null && !isNum(t.tz)) err('trip.tz muss eine Zahl sein (Stunden zu UTC, z. B. -4 oder 1).');
    const d = o.data;
    if (!d || typeof d !== 'object') { err('"data" fehlt.'); return { ok: false, errors: E, warnings: W, fixes: F, trip: null }; }
    const P = d.ports;
    if (!Array.isArray(P) || !P.length) { err('data.ports (Liste der Tage/Stationen) fehlt oder ist leer.'); return { ok: false, errors: E, warnings: W, fixes: F, trip: null }; }
    const cruise = t.kind === 'kreuzfahrt' || !!t.ship;

    /* Tage */
    if (isDate(t.start) && isDate(t.end)) {
      const n = Math.round((new Date(t.end) - new Date(t.start)) / 864e5) + 1;
      if (n !== P.length) err(`Zwischen trip.start und trip.end liegen ${n} Tage, data.ports hat aber ${P.length} Einträge. Pro Kalendertag genau ein Eintrag.`);
    }
    P.forEach((p, i) => {
      const L = `Tag ${i + 1}`;
      if (!p || typeof p !== 'object') return err(`${L}: Eintrag ist kein Objekt.`);
      if (p.day !== i + 1) { if (p.day != null) warn(`${L}: "day" war ${p.day}, wird auf ${i + 1} gesetzt (fortlaufend ab 1).`); else fix(`${L}: "day" ergänzt.`); p.day = i + 1; }
      if (isDate(t.start)) { const want = addD(t.start, i); if (p.date !== want) { if (p.date) warn(`${L}: "date" war ${p.date}, wird auf ${want} gesetzt (fortlaufend ab trip.start).`); else fix(`${L}: "date" ergänzt.`); p.date = want; } }
      if (!PKINDS.includes(p.kind)) err(`${L}: "kind" muss start, port, sea oder end sein.`);
      if (!cruise && p.kind === 'sea') err(`${L}: Seetage ("sea") gibt es nur bei Kreuzfahrten.`);
      if (p.kind !== 'sea') {
        if (!p.name) err(`${L}: "name" (Ort) fehlt.`);
        if (!isNum(p.lat) || !isNum(p.lon) || Math.abs(p.lat) > 90 || Math.abs(p.lon) > 180) err(`${L}: "lat"/"lon" fehlen oder sind ungültig (Dezimalgrad, z. B. 41.38 und 2.18).`);
      } else if (!p.name) { p.name = 'Seetag'; fix(`${L}: Name „Seetag“ ergänzt.`); }
      if (p.tz != null && !isNum(p.tz)) err(`${L}: "tz" muss eine Zahl sein (Stunden zu UTC).`);
      if (p.tz == null && t.tz == null) warn(`${L}: keine Zeitzone ("tz") – die App nimmt UTC an.`);
      if (cruise && p.kind === 'port' && p.times && !/^\d{1,2}:\d{2}\s*[–-]\s*\d{1,2}:\d{2}/.test(p.times)) warn(`${L}: "times" sollte „HH:MM–HH:MM“ sein (Liegezeit), ist: "${p.times}".`);
      if (!p.sid) { p.sid = 's' + p.day; }
      ['tips', 'tr', 'pois', 'ex', 'fact'].forEach(k => { if (p[k] != null && !Array.isArray(p[k])) err(`${L}: "${k}" muss eine Liste sein.`); });
      if (p.emb && !cruise) { delete p.emb; warn(`${L}: "emb" (Ein-/Ausschiffung) nur bei Kreuzfahrten – entfernt.`); }
      if (p.emb) Object.entries(p.emb).forEach(([k, v]) => { if (['ci1', 'ci2', 'ab', 'dep', 'arr', 'w1', 'w2', 'bag'].includes(k) && !isTime(v)) err(`${L}: emb.${k} muss „HH:MM“ sein.`); });
      /* Tipps */
      const ids = new Set();
      (p.pois || []).forEach((q, j) => {
        const Q = `${L}, Tipp ${j + 1}${q && q.n ? ' („' + q.n + '“)' : ''}`;
        if (!q || !q.n) return err(`${Q}: "n" (Name) fehlt.`);
        if (!isNum(q.lat) || !isNum(q.lon)) err(`${Q}: "lat"/"lon" fehlen.`);
        if (!TIPT.includes(q.t)) { warn(`${Q}: "t" war ${JSON.stringify(q.t)}, wird zu "sight" (erlaubt: ${TIPT.join(', ')}).`); q.t = 'sight'; }
        if (!WALK.includes(q.w)) { if (q.w != null) warn(`${Q}: "w" war ${JSON.stringify(q.w)}, wird zu "taxi" (erlaubt: ${WALK.join(', ')}).`); q.w = q.w == null ? 'taxi' : 'taxi'; }
        if (!q.id) { q.id = 't' + p.day + '_' + j; fix(`${Q}: Kennung "id" ergänzt.`); }
        if (ids.has(q.id)) err(`${Q}: "id" ${q.id} kommt an diesem Tag doppelt vor.`); ids.add(q.id);
        if (isNum(p.lat) && isNum(q.lat)) { const k2 = km(p.lat, p.lon, q.lat, q.lon); if (q.km == null) q.km = k2; if (k2 > 150) warn(`${Q}: liegt ${k2} km vom Ort entfernt – Koordinaten prüfen.`); }
        if (!q.g || typeof q.g !== 'object') {
          const mode = q.w === 'walk' ? 'walk' : q.w === 'tour' ? 'tour' : 'taxi';
          q.g = { m: mode, t: Math.max(5, Math.round(mode === 'walk' ? (q.km || 1) * 13 : (q.km || 3) * 2.5 + 8)), s: 60, c: 0, u: '€', o: '', f: null, v: 0, n: '' };
          fix(`${Q}: Anfahrt "g" geschätzt (Wegzeit aus Entfernung, 60 Min Aufenthalt).`);
        } else {
          const g = q.g; if (!WALK.includes(g.m)) g.m = q.w; ['t', 's'].forEach(k => { if (!isNum(g[k])) { g[k] = k === 's' ? 60 : 15; fix(`${Q}: g.${k} ergänzt.`); } });
          if (g.u == null) g.u = '€'; if (g.v == null) g.v = 0;
        }
      });
      /* Ausflüge */
      const codes = new Set();
      (p.ex || []).forEach((e, j) => {
        const X = `${L}, Ausflug ${j + 1}`;
        if (!e || !e.c) return err(`${X}: "c" (Ausflugscode, eindeutig je Tag) fehlt.`);
        if (codes.has(e.c)) err(`${X}: Code ${e.c} doppelt.`); codes.add(e.c);
        if (!e.n) err(`${X}: "n" (Name) fehlt.`);
        if (e.p != null && !isNum(e.p)) err(`${X}: "p" (Preis pro Person) muss eine Zahl sein.`);
        if (e.dur && !/\d+(?:[.,]\d+)?\s*Std/.test(e.dur)) warn(`${X}: "dur" sollte wie „4,5 Std.“ aussehen (sonst rechnet die App mit 4 Std.).`);
      });
      (p.recCodes || []).forEach(c => { if (!codes.has(c)) warn(`${L}: recCodes enthält ${c}, den es in "ex" nicht gibt.`); });
      (p.pois || []).forEach(q => { if (q && q.ex && !codes.has(q.ex)) warn(`${L}: Tipp „${q.n}“ verweist auf Ausflug ${q.ex}, den es nicht gibt.`); });
      (p.fact || []).forEach((f, j) => { if (!f || !f.n) err(`${L}, Fabrik/Plantage ${j + 1}: "n" fehlt.`); if (f && f.src && !(d.src || {})[f.src]) warn(`${L}: Quelle "${f.src}" fehlt in data.src.`); });
    });
    if (cruise) {
      if (P[0] && P[0].kind !== 'start') warn('Tag 1 sollte bei Kreuzfahrten kind "start" (Einschiffung) haben.');
      if (P[P.length - 1] && P[P.length - 1].kind !== 'end') warn('Der letzte Tag sollte bei Kreuzfahrten kind "end" (Ausschiffung) haben.');
    }
    /* Karte: ohne handgemachte Karte erzeugt die App sie selbst – alte Kartenpositionen entfernen */
    if (!d.maps || !d.maps.ov) {
      let n = 0; P.forEach(p => { ['ox', 'oy', 'ompp', 'map', 'mx', 'my', 'ovOff'].forEach(k => { if (p[k] != null) { delete p[k]; n++; } }); (p.pois || []).forEach(q => ['ox', 'oy', 'x', 'y'].forEach(k => { if (q[k] != null) { delete q[k]; n++; } })); });
      if (n) fix('Kartenpositionen (ox/oy …) entfernt – die App erzeugt die Karte automatisch.');
      d.maps = {};
    }
    /* Route */
    if (d.route != null) {
      if (!d.route.legs || !Array.isArray(d.route.legs)) err('data.route muss { legs: [...] } enthalten (oder ganz weglassen).');
      else d.route.legs.forEach((l, i) => { if (!P[l.a - 1] || !P[l.b - 1]) err(`route.legs[${i}]: Tag ${l.a} oder ${l.b} gibt es nicht.`); if (l.c && l.c.length % 3) warn(`route.legs[${i}]: "c" sollte aus Dreiergruppen bestehen (Bézier).`); });
    }
    /* Land & Leute, Quiz, Infos */
    if (d.kul && d.kul.L) Object.entries(d.kul.L).forEach(([land, v]) => { if (!P.some(p => p.land === land)) warn(`kul.L["${land}"]: kein Tag hat land = "${land}" – wird nie angezeigt.`); ['g', 'p', 'k', 'e'].forEach(k => { if (v[k] != null && !Array.isArray(v[k])) err(`kul.L["${land}"].${k} muss eine Liste von Texten sein.`); }); });
    if (d.kul && d.kul.P) Object.keys(d.kul.P).forEach(n => { if (!P.some(p => p.name === n)) warn(`kul.P["${n}"]: kein Tag heißt so – wird nie angezeigt.`); });
    if (d.kul && d.kul.maskRe) { try { new RegExp(d.kul.maskRe); } catch (e) { err('kul.maskRe ist kein gültiger regulärer Ausdruck.'); } }
    (d.quiz || []).forEach((q, i) => {
      if (!Array.isArray(q) || q.length < 4) return err(`quiz[${i}]: Format [Kategorie, Frage, richtig, [falsch1, falsch2, falsch3], Erklärung].`);
      if (!QZ.includes(q[0])) err(`quiz[${i}]: Kategorie muss ${QZ.join(', ')} sein.`);
      if (!Array.isArray(q[3]) || q[3].length < 3) err(`quiz[${i}]: genau drei falsche Antworten als Liste angeben.`);
      else if (q[3].includes(q[2])) err(`quiz[${i}]: die richtige Antwort steht auch bei den falschen.`);
      if (q[0] === 's' && !o.ship) warn(`quiz[${i}]: Kategorie "s" (Schiff) ohne Schiff – wird ausgeblendet.`);
    });
    /* data.info wird nicht mehr angezeigt – wird ignoriert */
    ['src', 'kul', 'info'].forEach(k => { if (d[k] == null) d[k] = k === 'kul' ? { L: {}, P: {} } : {}; });
    ['quiz', 'notes'].forEach(k => { if (d[k] == null) d[k] = []; });
    /* Fotos */
    Object.entries(o.photos || {}).forEach(([k, v]) => { if (typeof v !== 'string' || !/^data:image\//.test(v)) err(`photos["${k}"] muss eine data:image/…-Adresse sein.`); else if (v.length > 900000) err(`photos["${k}"] ist zu groß (max. ca. 650 KB je Bild, Firestore-Grenze 1 MB).`); if (!P.some(p => (p.ex || []).some(e => e.c === k))) warn(`photos["${k}"]: kein Ausflug mit Code ${k}.`); });
    /* Schiff */
    const s = o.ship;
    if (s != null) {
      if (!s.id || !/^[a-z0-9-]{2,40}$/.test(s.id)) err('ship.id fehlt oder ist ungültig (Kleinbuchstaben, Ziffern, Bindestrich).');
      if (!s.name) err('ship.name fehlt.');
      if (t.ship !== s.id) { t.ship = s.id; fix('trip.ship auf ship.id gesetzt.'); }
      const sd = s.data || {};
      if (!Array.isArray(sd.dk)) err('ship.data.dk (Decks) muss eine Liste sein.');
      else sd.dk.forEach((x, i) => { if (!Array.isArray(x) || !isNum(x[0]) || !Array.isArray(x[2])) return err(`ship.data.dk[${i}]: Format [Decknummer, "Deckname", [Orte…]].`);
        x[2].forEach((v, j) => { if (!Array.isArray(v) || !v[0] || !isNum(v[1]) || !DK.includes(v[2])) err(`Deck ${x[0]}, Ort ${j + 1}: Format ["Name", Position 0–100, Art (${DK.join('|')}), Seite −1…1, "Beschreibung"].`); }); });
      Object.entries(sd.cab || {}).forEach(([dk, str]) => { if (typeof str !== 'string' || !/^\d+,\d+,[01],-?\d+(;\d+,\d+,[01],-?\d+)*;?$/.test(str)) err(`ship.data.cab["${dk}"]: Format "Kabine,Position,Seite(0/1),Querlage;…".`); });
      if (s.drinks && !Array.isArray(s.drinks.groups)) err('ship.drinks.groups muss eine Liste sein.');
      if (!sd.cab) sd.cab = {}; if (!sd.lifts) sd.lifts = {};
    } else if (t.ship) { err(`trip.ship ist "${t.ship}", aber "ship" fehlt in der Datei.`); }
    return { ok: !E.length, errors: E, warnings: W, fixes: F, trip: o };
  }
  root.tripCheck = tripCheck;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = tripCheck;
    if (require.main === module) {
      const f = process.argv[2]; if (!f) { console.log('Aufruf: node tripcheck.js <datei.json>'); process.exit(2); }
      const r = tripCheck(require('fs').readFileSync(f, 'utf8'));
      r.errors.forEach(m => console.log('FEHLER   ' + m)); r.warnings.forEach(m => console.log('Hinweis  ' + m)); r.fixes.forEach(m => console.log('korrigiert ' + m));
      console.log(r.ok ? `\nOK – die Datei kann importiert werden (${r.warnings.length} Hinweise, ${r.fixes.length} automatische Korrekturen).` : `\nNICHT importierbar: ${r.errors.length} Fehler.`);
      process.exit(r.ok ? 0 : 1);
    }
  }
})(typeof window !== 'undefined' ? window : globalThis);
