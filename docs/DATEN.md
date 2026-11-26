# Datenaufbau

## Firestore (Projekt `reiseplaner-accd8`)
```
config/app                         { activeTrip: "<trip-id>" }
trips/<trip-id>                    Stammdaten der Reise (siehe unten) + json: "<String>"
trips/<trip-id>/photos/<code>      { c: "<Ausflugscode>", d: "data:image/jpeg;base64,..." }
trips/<trip-id>/picks|planitems|lists|tasks|drinkfavs|backups   gemeinsame Einträge der Reisenden
trips/<trip-id>/plandays/meta     { dinner:{…}, cabin, fx, planV2:true }  (alte Tagesdokumente d1…d15 werden nicht mehr genutzt)
trips/<trip-id>/stays/<id>         { n, addr, lat, lon, d1 (Anreisetag), d2 (Abreisetag), ci, co, ref, note } – Unterkunft (nicht bei Kreuzfahrt)
trips/<trip-id>/travel/out|back    { mode: plane|train|car|bus, segs:[{f,t:{n,c,lat,lon,tz}, dd,dt,ad,at (Ortszeit), no, al, seat:{<uid>:"23A"} (Sitzplatz je Mitreisendem), km, min}], ref, note }
trips/<trip-id>/members/<uid>      { n: Name, l: Buchstabe, c: Farbnummer, ts } – Mitreisende, legt sich bei der ersten Anmeldung selbst an
trips/<trip-id>/users/<uid>/lists|tasks   private Listen/Aufgaben (Regel: nur die Person selbst)
ships/<ship-id>                    { name, short, deckNote, json: "<Deckplan>", drinks: "<Getränkekarte>" }
```
Große/verschachtelte Teile liegen als **JSON-String** in einem Feld (`json`), weil Firestore
keine Arrays in Arrays erlaubt und ein Dokument höchstens 1 MB groß sein darf (Fotos deshalb einzeln).

Die App leitet alle Datenbank-Zugriffe automatisch auf `trips/<aktive Reise>/…` um
(`FBX.db.collection(name)` in `app.js`). Einträge beziehen sich auf Tag-Nummern,
Ausflugscodes und die **Reihenfolge** der Orte je Station – beim Ändern einer laufenden
Reise deshalb nichts umsortieren.

## Stammdaten `trips/<id>`
| Feld | Bedeutung |
|---|---|
| `title` | z. B. „Mittelmeer-Kreuzfahrt“ (Kopfzeile, Anmeldefenster) |
| `region` | z. B. „Mittelmeer“ („Danach 14 Nächte Mittelmeer“) |
| `kind` | `kreuzfahrt` · `staedtereise` · `roadtrip` (bisher nur `kreuzfahrt` umgesetzt) |
| `start`, `end` | `YYYY-MM-DD` |
| `people` | optional, nur Rückfall ohne Firebase. Die echten Mitreisenden kommen aus `members` (jede Anmeldung mit freigegebenem Konto). Name/Buchstabe änderbar unter Einstellungen → Konto. |
| `ship` | ID in `ships/…` oder `null` (ohne Schiff wird „An Bord“ ausgeblendet) |
| `tz` | Standard-Zeitzone der Reise in Stunden zu UTC (z. B. -4) |
| `operator` | Name des Veranstalters/der Reederei, z. B. für „…-Ausflug“ (Standard: „Veranstalter“) |
| `flight` | `true`: vor der Reise fliegt ein Flugzeug im Kopf statt des Schiffs |
| `look` | Farbwelt: `meer` (Standard bei Kreuzfahrt) · `stadt` · `roadtrip` · `natur` · `winter` |
| `arrival` | Symbol vor der Reise: `plane` (Standard) · `car` · `train` · `bus` · `none` |
| `vehicle` | Symbol während der Reise: `ship` (Standard bei Kreuzfahrt) · `car` · `camper` · `train` · `bus` · `suitcase` |
| `seasons` | Feiertags-Designs an/aus, z. B. `{advent:true, xmas:true, nye:false}` (Standard: alle an) |
| `special` | Besondere Tage: `[{date:"2026-12-30", title:"Alles Gute, …! 🎂", style:"party"\|"herz"\|"torte"}]` |
| `arrival`, `vehicle` | auch vom Assistenten gesetzt; `vehicle` leer = automatisch nach `kind` |

Diese Felder werden **nicht in der App** eingestellt, sondern direkt in der Reise
(Import-Datei oder Firebase-Konsole → `trips/<id>` → Feld hinzufügen). So mit dem Nutzer vereinbart.
Initialen auf Schiff/Fahrzeug kommen automatisch aus den Buchstaben der Mitreisenden.

## `json` der Reise
```
{ ports: [ … Stationen … ], maps: { … }, src: { … },
  kul:  { L: {Land: {g,p,k,e}}, P: {Station: [...]}, maskRe: "<Regex für Quiz>" },
  quiz: [ [kategorie, frage, richtig, [falsch1,falsch2,falsch3], erklärung], … ],
  info: { Länder-Stichwort: {cur, k, tz, plug, em} },
  notes: [ "Hinweis vor der Buchung", … ] }
```
### Station (`ports[i]`)
`sid` (feste Kennung, sonst „s<Tag>“), `emb` (nur Kreuzfahrt, Tag 1: `{ci1,ci2,ab,dep,pier}`, letzter Tag: `{arr,w1,w2,bag,grp}`), `day, date, kind (start|port|sea|end), name, land, times ("08:00–18:00"), tz, lat, lon,
walk, price, ort, verdikt, rec, recCodes, tips[], tr[], pois[], ex[], fact[], map, ox, oy, …`
- `pois[]`: Tipps vor Ort `{id, n, t (Typ), lat, lon, km, w (zu Fuß), d (Text), g (Anfahrt), ex?}` – `id` fest
  (sonst „t<Tag>_<Index>“); Einträge im Tagesplan verweisen über `ti` darauf (`i` = Position, wird daraus neu bestimmt).
- `ox, oy, ompp` (Kartenposition): nur bei handgemachter Karte (`maps.ov`) gespeichert; fehlt `maps.ov`, erzeugt
  `mapgen.js` beim Laden Karte und Positionen aus `world.json` (Natural Earth 1:50m).
  - `t` = `sight` · `beach` · `nature` · `factory` · `town` (Symbol auf der Karte 🏛 🏖 🌴 🏭 🏘; Unbekanntes gilt als `sight`)
- `route` (optional, im `json`): Verlauf der Strecke auf der Karte, in Erdkoordinaten – für Schiff, Auto, Zug gleich:
  ```
  route: { legs: [ { a: 1, b: 2, c: [[lat,lon],[lat,lon],[lat,lon], …] },   // Bögen (Bézier, je 3 Punkte) – z. B. Seeweg
                   { a: 2, b: 3, p: [[lat,lon], …] } ],                       // Linie über Zwischenpunkte – z. B. Straße
           sea: { "4": [lat,lon] } }                                          // Lage der Seetage (optional)
  ```
  Roadtrip/Auto: `legs[]` bekommen zusätzlich `km`, `min`, `k` (Koordinaten-Schlüssel) – automatisch über OSRM berechnet.
  Fehlende Abschnitte verbindet die App selbst: bei Kreuzfahrt/Schiff mit sanftem Bogen (Seetage gleichmäßig darauf),
  sonst (Roadtrip, Städtereise) mit gerader Linie. Für Straßenverlauf `p` z. B. aus einem Routenplaner übernehmen.

### Karte (für jede Reise gleich)
- ★ **Unsere Orte**: alle Einträge im Tagesplan mit Ort (eigene, aus Google Maps, aus Tipps) – über die ganze Reise sichtbar.
- **Tipps** (`pois`): gefüllter Kreis mit Symbol, ab Hafen-Zoom. **Umgebung** (OpenStreetMap): weißer Kreis, ganz nah.
- Gemeinsamer Filter im 📍-Knopf. Die Karte wechselt beim Verschieben/Zoomen nicht den Tag.
- `ex[]`: Ausflüge `{c (Code), n, p (Preis p. P.), dur, lv, prog, note, rec, sold}`
- `kul`: Land & Leute (Geschichte, Politik, Kultur, Essen) – Schlüssel = `land` der Station
- Fotos der Ausflüge: `trips/<id>/photos/<Code>`

## Import-Datei `<id>.trip.json` (nie ins Repository!)
Vollständige Feldbeschreibung: **docs/IMPORT-FORMAT.md** (maßgeblich), Prüfung: `tripcheck.js`.
```
{ format: "reiseplaner-trip-1", id: "<trip-id>",
  trip: { …Stammdaten… }, data: { ports, maps, src, kul, quiz, info, notes },
  photos: { "<Code>": "data:image/…" },
  ship: { id, name, short, deckNote, data: <Deckplan>, drinks: <Getränkekarte> } | null }
```
Import: Ist noch keine Reise aktiv, fragt die App nach der Datei. Sonst in der
Einstellungen → 🧳 Reisen → „+ Neue Reise hinzufügen“.
Der Import setzt `config/app.activeTrip` auf die neue Reise.

## Zugang
Wer rein darf, steht **nur** in den Firestore-Regeln (`allowed()`, E-Mail-Liste in der Konsole).
So ist es mit dem Nutzer vereinbart: neue Personen trägt er selbst in der Firebase-Konsole ein.
Neue Person = E-Mail in die Regeln aufnehmen → Person meldet sich an → erscheint automatisch als Mitreisende.

## Quiz
`trips/<id>/plandays/quiz_<uid>`: `{ uid, name, l, pts, n, ok, best, cat:{l|g|s|r:{n,ok}}, daily:{ "YYYY-MM-DD": {ok, t (ms), done} } }`.
- Rangliste, Live-Hinweise (überholt/Gleichstand), Abzeichen werden daraus in der App berechnet.
- Tages-Duell: 5 Fragen je Tag, für alle gleich (Zufall aus Reise-ID + Datum, `qzDailyQs`). Ein Versuch pro Tag.
  Tagessieg zählt, wenn mindestens 2 gespielt haben (heute erst, wenn alle Mitreisenden fertig sind); Gleichstand → schnellere Zeit.

## Reise-Mappe (Dateien)
- Dateien in **Firebase Storage** (Bucket `reiseplaner-accd8.firebasestorage.app`, Region europe-west3), Regeln in `storage.rules`:
  `trips/<id>/files/<fileId>-<name>` (gemeinsam), `trips/<id>/users/<uid>/files/…` (privat), max. 25 MB.
- Einträge in Firestore: `trips/<id>/files/<fileId>` bzw. `trips/<id>/users/<uid>/files/<fileId>`:
  `{ title, cat (plan|ticket|hotel|flight|doc|misc), days:[Tag-Nummern], tv?:["out"|"back"] (An-/Abreise), path, name, type, size, thumb (kleines Vorschaubild als data-URL), ts, by, priv?, owner? }`
- Große Bilder (> 1,2 MB) werden vor dem Hochladen auf 2400 px verkleinert (JPEG).
- Offline: Dateien mit Tag-Zuordnung landen automatisch im Cache Storage `rp-files`; Bilder öffnen im eigenen Betrachter, andere Dateien im Programm des Handys.
- Test ohne Firebase: `window.__TEST_STORAGE = {put(path,blob,meta,prog), url(path), del(path)}` setzen.
- Kosten: Blaze-Tarif (Budget-Warnung 1 €), Storage in der EU kostet Cent-Beträge.
- **CORS** am Bucket ist nötig, damit die App Dateien selbst laden/offline speichern kann (`storage-cors.json`).
  Einmalig in der Google Cloud Shell: `gcloud storage buckets update gs://reiseplaner-accd8.firebasestorage.app --cors-file=storage-cors.json`
- PDFs zeigt die App selbst an (pdf.js 3.11.174 von cdnjs, vom Service Worker zwischengespeichert).

## Offline & Synchronisation
- **Start ohne Warten:** Der Service Worker liefert index.html/app.js/firebase-config.js sofort aus dem Speicher
  und lädt im Hintergrund nach (geändert → Hinweis „Neue App-Version geladen · Neu laden“).
  Der Lader startet aus der Reise-Kopie in IndexedDB `rp-cache` (wenn `rp-uid` + Reise bekannt) und holt die Reise
  danach im Hintergrund vom Server (geändert → „Reisedaten wurden aktualisiert · Neu laden“).
- **Firestore-Persistenz** hält alle Daten offline; Schreibvorgänge werden automatisch übertragen.
- **Konflikte:** „wer zuletzt speichert, gewinnt“ – aber **feldgenau**: `fsWrite()` schreibt nur geänderte Felder
  (+ Pflichtfelder `REQ`) mit `merge`, gelöschte Felder per `FieldValue.delete()`.
  Tagesplan: jeder Eintrag eigenes Dokument `planitems/<id>` `{d, o, …}` (Übernahme aus alten `plandays/dN` einmalig,
  Flag `plandays/meta.planV2`). Offline vor dem ersten Abgleich gemachte Planänderungen werden über den gespeicherten
  Stand `rp-<trip>-planbase` erkannt und hochgeladen. Abendessen feldgenau (skip per arrayUnion/arrayRemove, ov je Tag).
- **Uploads:** Warteschlange in IndexedDB `rp-up`; Datei ist sofort lokal nutzbar (`pending:1`), Upload im Hintergrund.
- **Sync-Anzeige:** Symbol im Kopf nur bei „wird übertragen“/„offline“ (`#syncb`), sonst Status unten im Menü.
- Test ohne Firebase mit nachgebildetem Firestore: siehe Testskripte im Verlauf (fakefs: Server, Offline-Warteschlange).

## Orte suchen / aus Google Maps teilen
- Ortssuche im Eintrag-Fenster: Photon (`photon.komoot.io`, OpenStreetMap, kostenlos, kein Schlüssel), nach Nähe zur Station.
- Teilen aus Google Maps (Android, installierte App): `share_target` im Manifest → `./?share&title&text&url`.
  `parseShare()` liest Name/Adresse/Link; Koordinaten aus langen Links (`@lat,lon`), Kurzlinks über die Cloud Function `mapLink`
  (`docs/CLOUD-FUNCTION.md`); erst wenn die nichts liefert, Photon-Suche nach dem Namen. Offline geteilte Einträge
  (`gurl` ohne `lat`) bekommen ihren Pin automatisch, sobald Netz da ist (`gResolveAll()`).
- Plan-Eintrag mit Ort: `{lat, lon, addr?, gurl?}` → Pin auf der Karte; „Google Maps ›“ nutzt `gurl`.
- Bewusst **keine** Google-Places-API (Kosten, Nutzungsbedingungen: keine Speicherung/fremde Karte).

## Persönliche Daten je Google-Konto
`config/user_<uid>`: `{ home:{n,a,lat,lon,tz} (Zuhause, Einstellungen → Konto), spider:{g:"<Spielstand als Text, ohne Rückgängig-Verlauf>",ts}, spst:{s:"<Statistik als Text>",ts} }`.

**Änderungen durch den Claude-Konnektor** (Stufe 2a, `functions/mcp/write.js`):
- Geänderte oder angelegte Einträge und Aufgaben tragen `ki:{uid, at, neu:1|0}` (`neu` = von Claude angelegt). Die App zeigt 🤖.
  Wird der Eintrag in der App neu gespeichert, fällt `ki` weg.
- Protokoll `trips/<id>/kilog/<id>`: `{uid, at, tool, col: planitems|tasks|picks|dinner, doc, before, after, txt, undone}`.
- Rückgängig in der App (`kiUndo`, Einstellungen → Konto → Änderungen durch KI). Schreibt über die normalen Speicherwege
  und setzt `undone:true`.
Neuerer Stand (`ts`) gewinnt; auf dem Gerät zusätzlich `rp-home`, `rp-spider`, `rp-spider-stats` (+ `-ts`).
Quiz-Duell: `plandays/quiz_<uid>.daily.<Datum> = {ok, t, done, res:[1|0 je Frage], ans:[gewählte Antwort je Frage]}`.
