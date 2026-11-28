# Eine neue Reise anlegen

Zwei Wege:
- **Assistent in der App** (ohne Claude): Einstellungen → 🧳 Reisen → „+ Neue Reise anlegen“ (`wizard.js`).
  Grunddaten → Stationen (Ortssuche weltweit, „Wie Vortag“, bei Kreuzfahrt Hafen/Seetag + Zeiten) → Vorschau → anlegen.
  Ergebnis: Reise nur mit Stationen; Karte (`mapgen.js` + `world.json`), Route, Zeitzonen (Open-Meteo) entstehen automatisch.
  Wird nur auf dem eigenen Gerät geöffnet (`rp-trip`).
- **Import-Datei von Claude** (unten): mit recherchierten Inhalten – Tipps, Veranstalter-Ausflüge,
  Länder-Infos, Quiz, ggf. Deckplan/Getränke und handgemachte Karte. Ausflüge zeigt die App **nur**, wenn
  Daten vorhanden sind (`HAS_EX` in app.js).

## 1. Unterlagen und Wünsche sammeln (mit dem Nutzer klären)
- Buchungsbestätigung/Reiseroute: Daten, Orte, Zeiten; ggf. Ausflugskatalog (PDF/Screenshots).
- **Reiseart** (`kind`): Kreuzfahrt, Städtereise, Roadtrip … – Schiff ja/nein (Deckplan, Getränkekarte nötig?).
- **Aussehen**: Farbwelt (`look`), Anreise-Symbol (`arrival`), Symbol während der Reise (`vehicle`).
- **Besondere Tage** aktiv erfragen: Geburtstage, Hochzeitstag … (`special`, Stil party/herz/torte, Gruß).
- Feiertags-Designs (Advent/Weihnachten/Silvester) gewünscht? (`seasons`)
- Mitreisende tragen sich selbst ein (Anmeldung). Neue Personen: E-Mail in `firestore.rules` **und**
  `storage.rules` in der Konsole ergänzen (macht der Nutzer).

## 2. Import-Datei bauen (macht Claude)
- Format: `docs/IMPORT-FORMAT.md` (vollständig), Prüfen mit `node tripcheck.js datei.json`. Vorlage: Struktur der ersten Reise (deren `.trip.json` liegt beim Nutzer;
  notfalls aus Firestore `trips/<id>` lesen lassen oder aus einer Offline-Datei).
- Pro Station: `day`, `date`, `kind`, `name`, `land`, `times`, `tz`, `lat`, `lon`, Ortstexte, `pois`, `ex`.
- Länder-Infos (`kul`, `info`), Quizfragen (`quiz`), ggf. Hinweise (`notes`) neu schreiben – eigene Texte, keine Kopien.
- Ausflugs-Fotos in `photos` (klein, data-URL). Bei Schiff: `ship` mit Deckplan (`data`) und Getränkekarte (`drinks`).
- Datei dem Nutzer schicken (SendUserFile), **nie committen** (`.gitignore`: `*.trip.json`).
- Vorher im Test laufen lassen: `window.__TEST_TRIP=<Datei>` (siehe CLAUDE.md), alle Ansichten durchklicken.

## 3. Import (macht der Nutzer)
Einstellungen → 🧳 Reisen → „+ Neue Reise hinzufügen“ (beim allerersten Start erscheint der Import-Bildschirm).
Die Reise ist sofort für alle Mitreisenden in der Liste. Gewechselt wird je Gerät (`localStorage` „rp-trip“);
neue Geräte zeigen beim ersten Start alle Reisen zur Auswahl. Alte Reisen bleiben erhalten.
Pläne, Tickets, Buchungen legen die Reisenden danach selbst in der **Reise-Mappe** ab (auch direkt am Tag: „📎 Datei“).

## 4. Nachträglich ändern
- **In der App**: Einstellungen → 🧳 Reisen → bei der geöffneten Reise „Bearbeiten ›“ (`editor.js`, nur online).
  Grunddaten, Stationen verschieben (Kachel gedrückt halten oder ≡) / einfügen / löschen, Tipps je Station.
  Beim Speichern wandern Einträge, gebuchte Ausflüge, Abendessen-Ausnahmen und Datei-Zuordnungen mit ihrer Station mit
  (`dayRemap`); danach lädt die App neu. Ganz unten: „Reise löschen“.
- Kleine Felder ohne Oberfläche (besonderer Tag, Farbwelt, Feiertage): Firebase-Konsole → `trips/<id>`.
- Neuer Import mit gleicher `id` überschreibt die Stammdaten – vorher prüfen, dass Stationen (`sid`) und Tipp-Kennungen
  (`pois[].id`) erhalten bleiben, sonst verlieren Einträge ihren Bezug.

## 5. Andere Reisearten
Kreuzfahrt (`kind: "kreuzfahrt"` oder `ship`) und andere Reisen (Roadtrip, Städtereise, Rundreise) laufen beide:
- Ohne Schiff: `CRUISE=false` → `V()` ersetzt Hafen→Ort, Liegezeit→Aufenthalt usw. in Panel und Fenstern;
  keine „Ab Schiff/Zurück an Bord“-Zeilen; Ortsmarke statt Hafen-Symbol; „An Bord“ ausgeblendet (`body.noship`).
- Route: gerade Linien statt Bögen; Straßenverlauf optional über `route.legs[].p` (siehe DATEN.md).
- Offen: echte Fahrstrecken (Routenplaner), Hotels statt Kabine.
- Quiz-Kategorie „Schiff“ ohne Schiff ausblenden; Spiele-Lobby bleibt.
- Mehrere Reisen: Auswahl unter Einstellungen → 🧳 Reisen. Gerätespeicher ist je Reise getrennt (`rp-<trip-id>-…`).
- App-Icon ist allgemein (gilt für alle Reisen); je Reise ändern sich Titel, Kopf-Symbol, Farben und Daten.

## Checkliste nach dem Anlegen
- Alle Tage in Reiseplan/Mein Tag korrekt, Uhrzeiten in Ortszeit (`tz`).
- Quiz liefert Fragen ohne Fehler, Länder-Infos erscheinen bei jeder Station.
- Besondere Tage/Feiertage per Design-Vorschau („Für Tests“) geprüft.
- `APP_VER` und `sw.js`-`VERSION` erhöht, falls Code geändert wurde.
