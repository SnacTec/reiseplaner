# Reiseplaner – Hinweise für Claude

Private Reise-App (PWA) für zwei Personen. Antworten an den Nutzer: **Deutsch, kurz**.
Live: https://snactec.github.io/reiseplaner/ (GitHub Pages, Branch `main`).

## Grundregel: keine Reisedaten im Repository
Das Repository ist **öffentlich**. Hier steht nur der „Motor“ der App.
Alles Reisebezogene (Stationen, Daten, Zeiten, Ausflüge, Fotos, Namen der Reisenden,
Länder-Infos, Quizfragen, Deckplan …) liegt **nur in Firestore** und wird nach der
Google-Anmeldung geladen. Niemals Namen, E-Mail-Adressen, Reisedaten oder `*.trip.json`
committen (`.gitignore` schließt `*.trip.json` aus).

## Dateien
- `index.html` – Oberfläche, CSS und der **Lader** (Anmeldung → Daten aus Firestore → `app.js` starten).
- `app.js` – die eigentliche App. Liest alles Reisebezogene aus `window.__T` (vom Lader gesetzt).
- `sw.js` – Service Worker (offline). Bei Änderungen an index.html/app.js `VERSION` erhöhen.
- `firebase-config.js` – öffentliche Firebase-Konfiguration (Projekt `reiseplaner-accd8`).
- `firestore.rules`, `storage.rules` – Regeln (Platzhalter `<mail1>`/`<mail2>`; echte Adressen nur in der Konsole).
- `docs/DATEN.md` – Aufbau der Daten in Firestore und der Import-Datei.
- `docs/NEUE-REISE.md` – Schritt für Schritt: eine neue Reise anlegen, andere Reisearten.
- `docs/IMPORT-FORMAT.md` – **vollständige** Beschreibung der Import-Datei (für Menschen und andere KIs), `docs/KI-PROMPT.md`,
  erfundene Beispiele in `docs/beispiel/`, Prüfung `tripcheck.js` (Browser-Import und `node tripcheck.js datei.json`).
  Bei jeder Formatänderung alle drei anpassen.
- `wizard.js` – Reise-Assistent (neue Reise ohne Claude), `editor.js` – Reise bearbeiten/löschen; beide erst beim Öffnen geladen.
- `mapgen.js` + `world.json` – automatische Übersichtskarte für Reisen ohne eigene Karte (Natural Earth, gemeinfrei).
- `functions/` – Cloud Function `mapLink` (Google-Maps-Kurzlinks → Koordinaten), Anleitung `docs/CLOUD-FUNCTION.md`.
  Nur mit `firebase deploy --only functions` hochladen (Regeln nie per CLI – Platzhalter!).

## Arbeitsweise
- Nach jeder Änderung `APP_VER` in `app.js` erhöhen (sichtbar unter Einstellungen bzw. Menü).
- Testen ohne Firebase: Playwright, Seite lokal ausliefern (`python3 -m http.server`),
  vor dem Laden `window.__TEST_TRIP = <Inhalt einer .trip.json>` setzen, Requests an
  `gstatic|firebase-config|openstreetmap|fonts|overpass|open-meteo` abbrechen.
  Dann läuft die App im lokalen Modus mit den Testdaten.
- Gerätespeicher-Schlüssel beginnen mit `rp-`, reisebezogene mit `rp-<trip-id>-`.
- Vorsicht bei Code, der beim Start läuft: `const`/`let` erst nach ihrer Zeile nutzbar
  (Startfehler „Cannot access … before initialization“). Ladebildschirm zeigt solche Fehler an.

## Aufbau der App (Stand R55)
- Untere Leiste: Karte · Reiseplan · **Mein Tag (Mitte)** · An Bord · Menü.
- Menü: Suche, ToDos, Reise-Mappe, Getränkekarte, Deckplan, **Spiele** (Lobby: Quiz, Spider), Einstellungen, Konto.
- **Große Ansichten = eigene Seite** (`asPage()` bzw. Klasse `.dlg.full.page`, oben „‹“): Deckplan, Getränke,
  Suche, Einstellungen, Reise-Mappe, Spiele-Lobby. Quiz und Spider sind eigene Vollbild-Seiten (`.dlg.full`).
  **Kurze Aktionen = halbes Fenster** (Menü, Abendessen, Ausflug, Eintrag/Aufgabe/Datei bearbeiten).
- Zurück-Taste: Unterseiten über `pushSub()`/`popSub()` (z. B. Quiz-Spiel → Quiz-Lobby); Reiter im Deckplan sind
  gleichrangig (Zurück schließt die Seite). Aus Lobby geöffnete Seiten setzen `dlgReturn=gamesDlg`.
- Einstellungen: aufklappbare Gruppen (Reisen, Abendessen & Kabine, Offline, Konto, Sicherung); „Für Tests“ nur nach
  7× Tippen auf die App-Version (pro Gerät `rp-dev`) – Überraschungs-Designs nicht vorab zeigen.
- Mitreisende kommen aus den Anmeldungen (`members`), Zugang nur über die E-Mail-Liste in den Regeln (macht der Nutzer).
- Reise-Mappe: Dateien in Storage, alle Dateien der Reise werden automatisch offline gespeichert; Bilder und PDFs
  (pdf.js) zeigt die App selbst an; lange drücken auf eine Datei → „Von Tag lösen“.
- Offline/Sync: Start aus Gerätespeicher (SW stale-while-revalidate, Reise-Kopie in IndexedDB), feldgenaues Speichern,
  Tagesplan je Eintrag (`planitems`), Upload-Warteschlange – Details in `docs/DATEN.md`.
- Spiele: Quiz (Lobby mit Podest, Tages-Duell, Rangliste, Abzeichen; Punkte je Reise in Firestore),
  Spider Solitaire (eigene Umsetzung, Spielstand/Statistik nur auf dem Gerät: `rp-spider`, `rp-spider-stats`).

- Karte: unabhängig vom gewählten Tag; ★ = Einträge im Tagesplan (alle Tage), Tipps (`pois`) = gefüllter Kreis mit Symbol,
  Umgebung (OpenStreetMap) = weißer Kreis mit Symbol; gemeinsamer Filter + Legende im 📍-Knopf (`CAT`, `mapPins`, `tipDlg`).
- Route kommt aus den Reisedaten (`route`, siehe docs/DATEN.md), sonst automatisch (Schiff: Bögen, sonst gerade Linien).
- Tagesansicht: Kopf (Datum · Land, Name), eine Infozeile (`infoHTML`: Liegezeit, an Bord, Zeitunterschied mit Sommerzeit
  `deOff`, Wetter; antippen = Details), kompakte Karten („bis 13:00“), Bord-Zeilen in zeitlicher Reihenfolge.
  Ziehgriff unter der Karte (klein/mittel/groß, `rp-map-size`). Wischen in der Infozeile wechselt den Tag nicht.
- Reisearten: `CRUISE` (kreuzfahrt oder Schiff) steuert die Wortwahl; `V()` macht aus Hafen → Ort usw.
  Veranstalter-Ausflüge, Fabriken, Quellen nur, wenn Daten da sind (`HAS_EX`, `HAS_FA`, `HAS_SRC`).
- Neue Reise: Assistent (Einstellungen → Reisen); Bearbeiten nur für die geöffnete Reise (`editOpen`, `tripSave`,
  `dayRemap` nummeriert Einträge/Ausflüge/Abendessen/Dateien um). Tipps haben feste `id`, Plan-Einträge `ti`.
- Google Maps teilen → Eintrag (`shareCheck`), Kurzlinks über Cloud Function `mapLink`, Pins werden offline nachgeholt.
- Unterkunft je Nacht (`STAYS`, `stayDlg`, nur ohne Schiff), Fahrstrecken nach Straßen (`DRIVE`, `driveCalc` über OSRM),
  An- und Abreise für alle Reisen (`TRV`, `tvDlg`, `tvSum`: Zeiten in Ortszeit, Dauer/Zeitumstellung über Zeitzonen).
- Kreuzfahrt: Ein-/Ausschiffung je Station `emb` (Tag 1/letzter Tag; `embFormHTML`, `embMarks`, `embWarn`), Warnungen zur An-/Abreise.
- Offline-Daten im Hintergrund: `places.txt` (GeoNames, CC BY), `airports.txt` (OpenFlights, ODbL), `tzlookup.js` (CC0).
- Vorschauen vor dem Live-Gang auf dem Branch `vorschau` (wird wiederverwendet), live = `main`.

## Design-Regeln (mit dem Nutzer abgestimmt)
- **Blauer Textlink mit ›** für Navigation und Aktionen in Listen (`.lnk`): „Deckplan ›“, „+ Eintrag“, „📎 Datei“, „Weg ›“.
- **Blauer Knopf** (`.chip.btn`) nur für die eine Hauptaktion eines Fensters; **beige** (`.chip`) für Nebenaktionen.
- **Löschen** rot umrandet, rechts – mit „Rückgängig“-Meldung (`undoToast`).
- Seiten haben „‹“ oben links, kein ✕; Formulare haben „Speichern/Abbrechen“; kleine Info-Fenster schließen per Wischen/Antippen daneben.
- Info-Texte auf/zu per Antippen, immer nur eins offen. Kategorie-Leisten in einer Zeile (wischbar bzw. Kacheln), kein Umbruch.
- Vor größeren Umbauten: Screenshot-Vorschau zeigen und fragen; Header-Gestaltung nicht ändern (Nutzerwunsch).
- Antworten an den Nutzer kurz, auf Deutsch; Version (`APP_VER` in app.js, `VERSION` in sw.js) bei jeder Änderung erhöhen.
