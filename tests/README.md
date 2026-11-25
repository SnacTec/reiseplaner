# Tests

Laufen ohne Firebase im lokalen Modus der App, nur mit den **erfundenen** Beispielreisen aus `docs/beispiel/`.
Alle Anfragen nach außen (Karten, Ortssuche, Routen, Wetter, Google) werden abgefangen und mit festen Testantworten beantwortet.

Voraussetzung: Node.js und Playwright mit Chromium (`npm i -D playwright && npx playwright install chromium`;
in Claude-Code-Cloud-Umgebungen ist beides schon vorhanden).

| Befehl | Zweck |
|---|---|
| `node tests/run.js` | alle Funktionstests (ca. 3 Minuten), Ausgabe PASS/FAIL |
| `node tests/run.js bearbeiten` | nur Tests, deren Name das Wort enthält |
| `node tests/screens.js vorher` → ändern → `node tests/screens.js nachher` | Screenshots Handy/Tablet/PC und Vergleich, z. B. vor/nach Layout-Änderungen |
| `node tripcheck.js datei.json` | eine Import-Datei prüfen |

Was geprüft wird: Import-Prüfung · alle Ansichten und Fenster ohne JavaScript-Fehler (Handy, PC, dunkel; Kreuzfahrt und Roadtrip) ·
Pins auf der Karte · Tagesplan-Reihenfolge · Reise bearbeiten (Einträge wandern mit) · Assistent · An-/Abreise mit Zeitumstellung ·
Teilen aus Google Maps.

Nicht geprüft (braucht echtes Firebase): Anmeldung, Speichern/Abgleich zwischen Geräten, Reise-Mappe-Uploads, Cloud Function.
Das bei größeren Änderungen am echten Gerät mit einer Testreise ausprobieren.

Neue Funktion → passenden Test in `tests/run.js` ergänzen (Muster: `test('name', async ({browser, base}) => { … })`).
