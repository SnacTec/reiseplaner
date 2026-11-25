# Reiseplaner – Hinweise für Claude

Private Reise-App (PWA) für zwei Personen. Antworten an den Nutzer: **Deutsch, kurz**.
Live: https://snactec.github.io/reiseplaner/ (GitHub Pages, Branch `main`).

## Grundregel: keine Reisedaten im Repository
Das Repository ist **öffentlich**. Hier steht nur der „Motor“ der App.
Alles Reisebezogene (Stationen, Daten, Zeiten, Ausflüge, Fotos, Namen der Reisenden,
Länder-Infos, Quizfragen, Deckplan …) liegt **nur in Firestore** und wird nach der
Google-Anmeldung geladen. Niemals Namen, E-Mail-Adressen, Reisedaten oder `*.trip.json`
committen (`.gitignore` schließt `*.trip.json` aus).
Das gilt auch für **Commit-Nachrichten, Code-Kommentare, Doku-Beispiele und Reise-Kennungen im Code**
(keine echten Trip-IDs wie `<name>-<jahr>`, keine Ziel-/Schiffs-/Veranstalternamen echter Reisen).
Beispiele in der Doku immer erfunden und als „erfunden“ markiert (siehe `docs/beispiel/`).
Die Git-Historie wurde am 25.11.2026 bereinigt (ein einziger Start-Commit) – nichts Privates mehr nachtragen.

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
- App Check (reCAPTCHA Enterprise, unsichtbar): Schlüssel `APPCHECK_SITE_KEY` in `firebase-config.js` (leer = aus),
  Start im Lader (`window.__AC`), Status unter Einstellungen → Konto, Anleitung `docs/APP-CHECK.md`.
- `functions/` – Cloud Function `mapLink` (Google-Maps-Kurzlinks → Koordinaten), Anleitung `docs/CLOUD-FUNCTION.md`.
  Nur mit `firebase deploy --only functions` hochladen (Regeln nie per CLI – Platzhalter!).

## Arbeitsweise
- Nach jeder Änderung `APP_VER` in `app.js` erhöhen (sichtbar unter Einstellungen bzw. Menü).
- **Testen:** `node tests/run.js` (alle Funktionstests, ca. 3 Min, nur mit den erfundenen Beispielreisen, ohne Firebase) und
  bei Layout-Änderungen `node tests/screens.js vorher` → ändern → `node tests/screens.js nachher` (Handy/Tablet/PC-Vergleich).
  Details in `tests/README.md`. Neue Funktionen bekommen einen Test in `tests/run.js`.
  **Mit dem Nutzer abgestimmt:** reine Optik (Abstände, Texte, Anordnung) ohne Testlauf, nur Screenshots;
  Logik (Speichern, Import, Datum/Zeit, Sync, Dateien) immer voller Lauf. Teilläufe sparen kaum Zeit.
  Prinzip: Seite lokal ausliefern, vor dem Laden `window.__TEST_TRIP = <Reise>` setzen → App läuft im lokalen Modus;
  externe Dienste werden in `tests/helpers.js` abgefangen. Echte Reisedaten nie für Tests ins Repository legen.
- Gerätespeicher-Schlüssel beginnen mit `rp-`, reisebezogene mit `rp-<trip-id>-`.
- Vorsicht bei Code, der beim Start läuft: `const`/`let` erst nach ihrer Zeile nutzbar
  (Startfehler „Cannot access … before initialization“). Ladebildschirm zeigt solche Fehler an.

## Aufbau der App (Stand R67)
- Untere Leiste: Mappe · Reiseplan · **Mein Tag (Mitte)** · An Bord · Menü (keine „Karte“ mehr).
- Tagesseite (Karte + Details eines Tages) öffnet aus Reiseplan (Tagesüberschrift) bzw. Mein Tag („Details ›“) als eigene Seite:
  am Handy ohne Kopf/untere Leiste, feste Leiste `#pgbar` „‹ Herkunft · Tag N · Ort“ (`DAYFROM`, Klasse `body.dpage`).
  Übersichtskarte (ganze Route) über Menü → „Übersichtskarte“, gleiche Seite. PC unverändert.
  Am Handy keine Tagesleiste (`.days`) mehr; auf der Tagesseite Pfeile `#pgnav`. ToDos (Menü) ebenfalls als Seite mit `#pgbar`.
- Reise-Mappe ist Hauptseite (`showMappe`, `mappeView`, Hash `#mappe`). Im Reiseplan je Tag „Details ›“ (`.tdd`).
  Tageswechsel auf der Tagesseite ersetzt den Verlauf (`nav(hash,true)`), Zurück führt direkt zur Herkunft.
- Einträge: kein Wischen-Löschen mehr (nur ToDos); Löschen per Antippen im Fenster (Tipps: `tipDlg` „Aus dem Plan entfernen“).
  „+ Eintrag/+ Datei“ nur auf der Tagesseite. Scroll-Stelle je Hauptseite (`restoreScroll`), erneutes Tippen = nach oben.
- Menü: Suche, ToDos, Übersichtskarte, Getränkekarte, Deckplan, **Spiele** (Lobby: Quiz, Spider), Einstellungen, Konto.
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

- Orte (OSM, `osmDlg`) und Tipps immer zum geöffneten Tag (`sel`), mehrfach planbar; Hinweis „Schon im Tagesplan: Tag …“.
- Tipps auf der Tagesseite: andere Tage klein/blass (`oth`); `tipDlg` fügt zum geöffneten Tag hinzu (fremder Tag → eigener Eintrag mit Lage), „Anderer Tag …“.
- Karte: unabhängig vom gewählten Tag; ★ = Einträge im Tagesplan (alle Tage), Tipps (`pois`) = gefüllter Kreis mit Symbol,
  Umgebung (OpenStreetMap) = weißer Kreis mit Symbol; gemeinsamer Filter + Legende im 📍-Knopf (`CAT`, `mapPins`, `tipDlg`).
- Route kommt aus den Reisedaten (`route`, siehe docs/DATEN.md), sonst automatisch (Schiff: Bögen, sonst gerade Linien).
- Tagesansicht: Kopf (Datum · Land, Name), eine Infozeile (`infoHTML`: Liegezeit, an Bord, Zeitunterschied mit Sommerzeit
  `deOff`, Wetter; antippen = Details), Tagesplan als eine Karte (`dayView`, Klasse `.dcard`) – dieselbe in „Mein Tag“.
- Einheitlicher Tages-Stil (Reiseplan, Tageskarte, Mein Tag): Kopf zweizeilig (grau „Tag · Datum · Land“, darunter Ort),
  Einträge ohne Trennstriche, darunter „+ Eintrag“, dann Strich, Dateien als Zeilen (`fRowsHTML`) und „+ Datei“ (`.dyadd`).
  Dateien hängen an Tagen (`days`) oder An-/Abreise (`tv`). Chips mit Erklärung per `data-hint`.
  Ziehgriff unter der Karte (klein/mittel/groß, `rp-map-size`). Wischen in der Infozeile wechselt den Tag nicht.
- Reisearten: `CRUISE` (kreuzfahrt oder Schiff) steuert die Wortwahl; `V()` macht aus Hafen → Ort usw.
  Veranstalter-Ausflüge, Fabriken, Quellen nur, wenn Daten da sind (`HAS_EX`, `HAS_FA`, `HAS_SRC`).
- Neue Reise: Assistent (Einstellungen → Reisen); Bearbeiten nur für die geöffnete Reise (`editOpen`, `tripSave`,
  `dayRemap` nummeriert Einträge/Ausflüge/Abendessen/Dateien um). Tipps haben feste `id`, Plan-Einträge `ti`.
- Google Maps teilen → Eintrag (`shareCheck`), Kurzlinks über Cloud Function `mapLink`, Pins werden offline nachgeholt.
- Unterkunft je Nacht (`STAYS`, `stayDlg`, nur ohne Schiff), Fahrstrecken nach Straßen (`DRIVE`, `driveCalc` über OSRM),
  An- und Abreise für alle Reisen (`TRV`, `tvDlg`, `tvSum`: Zeiten in Ortszeit, Dauer/Zeitumstellung über Zeitzonen).
- Import-Datei: vollständige Doku `docs/IMPORT-FORMAT.md`, Prüfung `tripcheck.js` läuft beim Import (`__checkTrip` im Lader)
  und per `node tripcheck.js datei.json`. Feld `data.info` (Infobox „Wichtig vor Ort“) entfällt, wird ignoriert.
- PC (ab 861 px): breitere Seiten, Listen-Ansichten über die volle Fläche – alle PC-Regeln in einem `@media (min-width:861px)`-Block
  in index.html; Handy-Layout (≤ 860 px) davon unberührt. Vor Änderungen am Layout Handy-Screenshots vorher/nachher vergleichen.
- Kreuzfahrt: Ein-/Ausschiffung je Station `emb` (Tag 1/letzter Tag; `embFormHTML`, `embMarks`, `embWarn`), Warnungen zur An-/Abreise.
- Offline-Daten im Hintergrund: `places.txt` (GeoNames, CC BY), `airports.txt` (OpenFlights, ODbL), `tzlookup.js` (CC0).
- Ortssuche: fehlt eine Hausnummer in OpenStreetMap, wird die eigene Eingabe mit Lage der nächsten Hausnummer angeboten (`hnOffer`);
  gewählte Orte speichern `n` (Straße) und `a` (PLZ Ort). `putDoc` entfernt leere Felder (Firestore lehnt `undefined` ab).
- Leere Datums-/Uhrzeitfelder zeigen grauen Beispieltext (`phMark`, Klasse `.empty`).
- Vorschauen vor dem Live-Gang auf dem Branch `vorschau` (wird wiederverwendet), live = `main`.

## Design-Regeln (mit dem Nutzer abgestimmt)
- **Blauer Textlink mit ›** für Navigation und Aktionen in Listen (`.lnk`): „Deckplan ›“, „+ Eintrag“, „📎 Datei“, „Weg ›“.
- **Blauer Knopf** (`.chip.btn`) nur für die eine Hauptaktion eines Fensters; **beige** (`.chip`) für Nebenaktionen.
- **Löschen** rot umrandet, rechts – mit „Rückgängig“-Meldung (`undoToast`).
- Seiten haben „‹“ oben links, kein ✕; Formulare haben „Speichern/Abbrechen“; kleine Info-Fenster schließen per Wischen/Antippen daneben.
- Info-Texte auf/zu per Antippen, immer nur eins offen. Kategorie-Leisten in einer Zeile (wischbar bzw. Kacheln), kein Umbruch.
- Vor größeren Umbauten: Screenshot-Vorschau zeigen und fragen; Header-Gestaltung nicht ändern (Nutzerwunsch).
- Antworten an den Nutzer kurz, auf Deutsch; Version (`APP_VER` in app.js, `VERSION` in sw.js) bei jeder Änderung erhöhen.
