# Reiseplaner – Import-Datei (Format `reiseplaner-trip-1`)

Diese Anleitung beschreibt **vollständig**, wie eine Reise-Datei für den Reiseplaner aufgebaut ist.
Sie richtet sich an Menschen und an KI-Assistenten (Claude, ChatGPT, Gemini …), die aus
Reiseunterlagen eine solche Datei erstellen sollen. Sie soll ohne weiteres Vorwissen verständlich sein.

- Beispiele (frei erfunden, nur zur Veranschaulichung):
  [`docs/beispiel/BEISPIEL-kreuzfahrt.json`](beispiel/BEISPIEL-kreuzfahrt.json) (alle Felder) und
  [`docs/beispiel/BEISPIEL-roadtrip.json`](beispiel/BEISPIEL-roadtrip.json) (kleinste sinnvolle Datei).
- Prüfprogramm: `node tripcheck.js meine-reise.json` (im Hauptordner). Es meldet Fehler, Hinweise und
  automatische Korrekturen. Dieselbe Prüfung läuft beim Import in der App.
- Fertige Anweisung für eine KI zum Kopieren: [`docs/KI-PROMPT.md`](KI-PROMPT.md).

> **Datenschutz:** Echte Reise-Dateien enthalten private Daten (Namen, Daten, Buchungen) und gehören
> **nie** in ein öffentliches Repository. Die Beispieldateien hier sind ausdrücklich erfunden.

---

## 1. Grundregeln

| Regel | Beispiel |
|---|---|
| Datei ist **JSON** (UTF-8). Kommentare sind in JSON nicht erlaubt. Felder, die mit `_` beginnen, ignoriert die App (gut für Hinweise). | `"_hinweis": "…"` |
| **Datum** immer `JJJJ-MM-TT` | `"2027-05-01"` |
| **Uhrzeit** immer `HH:MM` (24 Stunden), immer in **Ortszeit** des jeweiligen Ortes | `"08:00"`, `"17:30"` |
| **Koordinaten** in Dezimalgrad (WGS84), Breite `lat`, Länge `lon`; West und Süd negativ | `"lat": 41.381, "lon": 2.177` |
| **Zeitzone** `tz` = Stunden zu UTC **am Reisedatum** (Sommerzeit beachten), Zahl | Spanien im Mai: `2`, New York im Januar: `-5` |
| **Pro Kalendertag genau ein Eintrag** in `data.ports`, lückenlos von `trip.start` bis `trip.end` | 5 Tage → 5 Einträge |
| Texte auf **Deutsch**, kurz und sachlich, **eigene Formulierungen** (keine Kopien aus Katalogen oder Webseiten) | |
| Was man nicht sicher weiß, **weglassen** statt raten. Fehlende optionale Felder sind kein Problem. | |

---

## 2. Aufbau im Überblick

```
{
  "format": "reiseplaner-trip-1",          Pflicht, genau dieser Text
  "id": "mittelmeer-2027",                  Pflicht, eindeutige Kennung der Reise
  "trip":  { … Grunddaten … },              Pflicht
  "data":  {
    "ports": [ … ein Eintrag je Tag … ],   Pflicht
    "maps":  {},                            leer lassen (Karte erzeugt die App)
    "route": { … } ,                        optional
    "kul":   { … Land & Leute … },           optional
    "quiz":  [ … Quizfragen … ],            optional
    "notes": [ … Hinweise … ]               optional
  },
  "photos": { "<Ausflugscode>": "data:image/jpeg;base64,…" },   optional
  "ship":   { … Schiff, Deckplan, Getränkekarte … } | null       nur bei Kreuzfahrt
}
```

---

## 3. `id` – Kennung der Reise

Kleinbuchstaben, Ziffern, Bindestriche, 3–60 Zeichen, z. B. `"mittelmeer-2027"`.
Gleiche `id` beim erneuten Import **überschreibt** die Stammdaten dieser Reise (eingetragene Pläne der
Reisenden bleiben erhalten, siehe Abschnitt 11).

## 4. `trip` – Grunddaten

| Feld | Pflicht | Bedeutung |
|---|---|---|
| `title` | ja | Titel, z. B. „Mittelmeer-Kreuzfahrt“ |
| `kind` | ja | `kreuzfahrt` · `roadtrip` · `staedtereise` · `rundreise` |
| `start`, `end` | ja | erster und letzter Reisetag (`JJJJ-MM-TT`) |
| `tz` | empfohlen | Standard-Zeitzone (Stunden zu UTC), falls ein Tag kein eigenes `tz` hat |
| `region` | nein | Kurzname der Gegend, z. B. „Mittelmeer“ (Text: „Danach 7 Nächte Mittelmeer“) |
| `ship` | bei Kreuzfahrt | `id` des Schiffs aus `ship.id`, sonst `null` |
| `operator` | nein | Veranstalter/Reederei, z. B. „AIDA“ (erscheint als „AIDA-Ausflug“) |
| `arrival` | nein | Symbol vor der Reise: `plane` (Standard) · `car` · `train` · `bus` · `none` |
| `vehicle` | nein | Symbol während der Reise: `ship` · `car` · `camper` · `train` · `bus` · `suitcase` (Standard nach `kind`) |
| `look` | nein | Farbwelt: `meer` · `stadt` · `roadtrip` · `natur` · `winter` |
| `special` | nein | besondere Tage: `[{"date":"2027-05-03","title":"Alles Gute! 🎂","style":"party"\|"herz"\|"torte"}]` |
| `seasons` | nein | Feiertags-Designs an/aus: `{"advent":true,"xmas":true,"nye":false}` |
| `people` | nein | nur für Tests ohne Anmeldung; die echten Mitreisenden kommen aus den Anmeldungen |

## 5. `data.ports` – ein Eintrag je Tag

| Feld | Pflicht | Bedeutung |
|---|---|---|
| `day` | ja | fortlaufend ab 1 |
| `date` | ja | Datum des Tages; muss zu `trip.start` + (day − 1) passen |
| `kind` | ja | `start` (Einschiffung/Reisebeginn) · `port` (Hafen- bzw. Reisetag) · `sea` (Seetag, nur Kreuzfahrt) · `end` (letzter Tag) |
| `name` | ja (außer `sea`) | Ortsname, z. B. „Barcelona“ |
| `lat`, `lon` | ja (außer `sea`) | Lage des Hafens bzw. Ortes |
| `land` | empfohlen | Land, z. B. „Spanien“; verknüpft mit `kul.L` und `info` |
| `tz` | empfohlen | Zeitzone dieses Tages (Stunden zu UTC) |
| `cur` | nein | Währung als ISO-Code (`"USD"`), nur wenn sie vom Land abweicht – sonst ermittelt die App sie aus `land` |
| `curNote` | nein | Hinweis zum Bezahlen, z. B. „US-Dollar wird fast überall angenommen“ |
| `times` | Kreuzfahrt | Liegezeit `"08:00–18:00"`; bei `start`/`end` ein Wort wie `"Einschiffung"`/`"Rückkehr"` |
| `text` | nein | kurze Beschreibung (v. a. für Seetage, Start und Ende) |
| `ort` | nein | 1–3 Sätze über den Ort |
| `walk` | nein | „Zu Fuß möglich?“, z. B. „Ja, Altstadt 15 Min“ |
| `verdikt` | nein | „Selbst oder Ausflug?“ – eine kurze Einschätzung |
| `rec` | nein | Empfehlung in einem Satz |
| `recCodes` | nein | empfohlene Ausflugscodes, z. B. `["B12"]` |
| `price` | nein | Richtpreis des empfohlenen Ausflugs (Zahl, Euro p. P.) |
| `tips` | nein | Liste kurzer Tipps „Auf eigene Faust“ |
| `tr` | nein | Liste Hinweise zur Anreise im Hafen (Taxi, Shuttle, Tender) |
| `pois` | nein | Tipps/Sehenswertes, siehe 5.1 |
| `ex` | nein | Veranstalter-Ausflüge, siehe 5.2 |
| `emb` | nein | nur Kreuzfahrt, Tag 1 bzw. letzter Tag, siehe 5.4 |
| `sid` | nein | feste Kennung des Tages; fehlt sie, setzt die App `"s<Tag>"` |

Mehrere Nächte am selben Ort: einfach mehrere Tage mit gleichem `name`/`lat`/`lon`.

### 5.1 `pois` – Tipps vor Ort

```json
{ "id": "bcn-sagrada", "n": "Sagrada Família", "t": "sight", "lat": 41.4036, "lon": 2.1744,
  "w": "taxi", "d": "Gaudís Basilika, Eintritt nur mit Zeitfenster-Ticket.",
  "g": { "m": "taxi", "t": 20, "s": 90, "c": 20, "u": "€", "o": "tgl. 9–18", "f": 26, "v": 0, "n": "" } }
```

| Feld | Pflicht | Bedeutung |
|---|---|---|
| `id` | empfohlen | feste, eindeutige Kennung je Tag (Kleinbuchstaben). Fehlt sie, wird `t<Tag>_<Nr>` gesetzt. **Nach dem ersten Import nicht mehr ändern.** |
| `n` | ja | Name |
| `t` | ja | Art: `sight` (Sehenswert) · `beach` (Strand) · `nature` (Natur) · `factory` (Fabrik/Plantage) · `town` (Ort/Stadt) |
| `lat`, `lon` | ja | Lage |
| `w` | ja | Erreichbarkeit: `walk` (zu Fuß) · `taxi` (Taxi nötig) · `tour` (nur per Ausflug/Tour) |
| `d` | empfohlen | Beschreibung, 1–2 Sätze |
| `g` | empfohlen | Planungsdaten (fehlt es, schätzt die App): `m` wie `w`; `t` Wegzeit in Minuten ab Hafen; `s` Aufenthalt in Minuten; `c` Taxikosten pro Auto; `u` Währungszeichen; `o` Öffnungszeiten (Text); `f` Eintritt p. P. (`0` = frei, `null` = unbekannt); `v` `1` = geprüft; `n` Zusatznotiz |
| `ex` | nein | Code eines Ausflugs, der diesen Ort besucht |
| `ca` | nein | `1` = Lage nur ungefähr |
| `km` | nein | Entfernung zum Hafen; rechnet die App selbst |

### 5.2 `ex` – Veranstalter-Ausflüge (meist Kreuzfahrt)

```json
{ "c": "BCN01", "n": "Barcelona Highlights", "dur": "4 Std.", "p": 59, "lv": "leicht",
  "prog": "Busfahrt durch die Stadt, Sagrada Família von außen, Park Güell.", "note": "Viel Laufen.", "rec": 1 }
```

| Feld | Bedeutung |
|---|---|
| `c` | Ausflugscode, eindeutig je Tag (Pflicht) |
| `n` | Name (Pflicht) |
| `p` | Preis pro Person in Euro (Zahl) |
| `dur` | Dauer als Text mit „Std.“, z. B. „4,5 Std.“ (daraus rechnet die App die Zeit im Tagesplan) |
| `lv` | Schwierigkeit, z. B. „leicht“, „mittelschwer“ |
| `prog` | Programm in eigenen Worten |
| `note` | Hinweise |
| `rec` | `1` = empfohlen |
| `sold` | `1` = ausverkauft |
| `orte` | optional: Orte, die der Ausflug besucht, `[{ "n": "Leuchtturm", "lat": 39.861, "lon": 4.322 }]` (höchstens 20). In der App antippbar: mit Internet Google Maps, ohne Internet die eigene Karte. Namen, die genau so im Programm stehen, werden dort ebenfalls zu Links. |

Fotos dazu optional in `photos` mit dem Code als Schlüssel (siehe 8).

### 5.3 `fact` – entfällt
Fabriken/Plantagen als eigener Bereich gibt es nicht mehr. Weglassen; ältere Dateien bleiben gültig, das Feld wird ignoriert.
Fabriken oder Plantagen als Ausflugsziel einfach als Tipp mit Art `factory` eintragen (siehe 5.1).

### 5.4 `emb` – Ein- und Ausschiffung (nur Kreuzfahrt)

- Tag 1 (`kind: "start"`): `{ "ci1": "12:00", "ci2": "15:00", "ab": "17:30", "dep": "18:00", "pier": "Terminal B" }`
  (Check-in von/bis, Alle an Bord, Ablegen, Terminal)
- Letzter Tag (`kind: "end"`): `{ "arr": "07:00", "w1": "08:00", "w2": "09:30", "bag": "23:00", "grp": "Gruppe 7" }`
  (Ankunft, Ausschiffung von/bis, Koffer raus am Vorabend, Gruppe/Kofferfarbe)

Alle Zeiten `HH:MM`, alle Felder optional.

---

## 6. Weitere Teile von `data`

### 6.1 `maps` – leer lassen
`"maps": {}`. Die App erzeugt die Übersichtskarte selbst (Weltkarte + Kartenkacheln).
Felder wie `ox`, `oy`, `ompp`, `map`, `x`, `y` **nicht** setzen – das Prüfprogramm entfernt sie.

### 6.2 `route` – optional
Ohne `route` zeichnet die App bei Schiffen sanfte Bögen, sonst gerade Linien; bei Roadtrips berechnet sie
die Straßenroute automatisch. Wer einen bestimmten Verlauf will:
```json
"route": { "legs": [ { "a": 1, "b": 2, "c": [[lat,lon],[lat,lon],[lat,lon]] },
                     { "a": 2, "b": 4, "p": [[lat,lon],[lat,lon]] } ],
           "sea": { "3": [lat,lon] } }
```
`a`/`b` = Tagesnummern aufeinanderfolgender Orte (Seetage überspringen); `c` = Bézier-Punkte in Dreiergruppen;
`p` = Zwischenpunkte einer Linie; `sea` = Lage der Seetage.

### 6.3 `src` – entfällt
Gehörte zu den Fabrik-Angaben (5.3). Weglassen; ältere Dateien bleiben gültig, das Feld wird ignoriert.

### 6.4 `kul` – Land & Leute
```json
"kul": { "L": { "Spanien": { "g": ["Geschichte …"], "p": ["Politik & Alltag …"], "k": ["Kultur …"], "e": ["Essen & Trinken …"] } },
         "P": { "Barcelona": ["Fakt über den Ort …"] },
         "maskRe": "Spanien|Spanier\\w*|Barcelona" }
```
Schlüssel von `L` = Wert von `land` der Tage; Schlüssel von `P` = `name` der Tage. Je Thema 2–5 kurze Sätze.
`maskRe` (optional) = regulärer Ausdruck mit Wörtern, die im Quiz „Zu welchem Land passt das?“ ausgeblendet werden.

### 6.5 `quiz` – Quizfragen
Jede Frage ist eine Liste: `[Kategorie, Frage, richtige Antwort, [falsch, falsch, falsch], Erklärung]`.
Kategorien: `l` Länder · `r` Reise/Route · `s` Schiff (nur mit Schiff) · `g` Getränke.
Genau drei falsche Antworten, die richtige darf nicht darunter sein. Empfohlen 20–60 Fragen.
Die App erzeugt zusätzlich automatisch Fragen aus Route, Deckplan und Getränkekarte.

### 6.6 `info` – entfällt
Wird nicht mehr angezeigt. Weglassen (ältere Dateien mit `info` bleiben gültig).

### 6.7 `notes` – Hinweise
Liste kurzer Hinweise vor der Buchung, z. B. abweichende Zeiten in den Unterlagen.

---

## 7. `ship` – nur bei Kreuzfahrt

```json
"ship": { "id": "ms-beispiel", "name": "MS Beispiel", "short": "Beispiel", "deckNote": "…",
  "data": { "dk": [ [9, "Pooldeck", [ ["Hauptpool", 55, "pool", 0, "Beschreibung"] ]] ],
            "cab": { "7": "7001,20,1,60;7002,20,0,-60" },
            "lifts": { "9": [30, 70] } },
  "drinks": { "stand": "Stand der Karte …", "groups": [ { "n": "Cocktails", "secs": [
      { "n": "Klassiker", "pr": "8,50 €", "nt": "", "items": [ { "n": "Mojito", "p": "8,50 €", "d": "Rum, Minze, Limette", "k": "M", "h": "Kurze Geschichte" } ] } ] } ] } }
```

- `dk`: je Deck `[Decknummer, "Deckname", [Orte]]`; je Ort `["Name", Position 0–100 (0 = Bug, 100 = Heck), Art, Seite −1…1 (− = Backbord/links, + = Steuerbord/rechts), "Beschreibung"]`.
  Arten: `food` `bar` `pool` `show` `spa` `sport` `kids` `shop` `service` `sun` `other`.
- `cab`: je Deck ein Text `"Kabine,Position,Seite,Querlage;…"` (Seite `1` = Steuerbord, `0` = Backbord; Querlage −100…100). Optional.
- `lifts`: je Deck Liste der Aufzugspositionen (0–100). Optional.
- `drinks`: Getränkekarte. `k` enthält `M`, wenn das Getränk im Getränkepaket enthalten ist; `h` = kurze Hintergrundgeschichte (optional).

Ein Schiff wird separat gespeichert und kann von mehreren Reisen genutzt werden (`trip.ship` = `ship.id`).

## 8. `photos`
`{ "<Ausflugscode>": "data:image/jpeg;base64,…" }` – kleine Bilder (max. ca. 650 KB je Bild, besser 100–200 KB).
Nur verwenden, wenn die Nutzungsrechte vorliegen.

---

## 9. Was die App selbst ergänzt (nicht in die Datei schreiben)

- Übersichtskarte, Kartenpositionen, Entfernungen (`km`), Straßenrouten bei Roadtrips
- Wetter (online), Zeitunterschied zu Deutschland, Umgebung aus OpenStreetMap
- Kennungen `sid`/`pois[].id`, falls sie fehlen
- **Nicht** über die Datei, sondern in der App eingetragen: An-/Abreise, Unterkünfte, Abendessen-Zeit,
  Kabine, eigene Einträge, ToDos, Dateien. Diese gehören den Reisenden und bleiben bei einem Neuimport erhalten.

## 10. Import

1. Datei prüfen: `node tripcheck.js reise.json` (optional, die App prüft ebenfalls).
2. In der App: Einstellungen → 🧳 Reisen → „Oder Import-Datei“ → Datei wählen
   (beim allerersten Start erscheint der Import-Bildschirm automatisch).
3. Die App zeigt Fehler bzw. Hinweise und speichert die Reise dann für alle Mitreisenden.

Mit dem Claude-Konnektor (`docs/MCP.md`) geht es ohne Datei: `reise_pruefen` statt `node tripcheck.js`,
dann `reise_entwurf_speichern`; in der App unter Einstellungen → 🧳 Reisen „Entwurf von Claude“ übernehmen.

## 11. Eine bestehende Reise erneut importieren

Gleiche `id` überschreibt die Stammdaten. Damit eingetragene Pläne erhalten bleiben:
gleiche Tage (`day`), gleiche Ausflugscodes (`c`) und gleiche Tipp-Kennungen (`pois[].id`) beibehalten.
Kleine Änderungen besser direkt in der App: Einstellungen → Reisen → „Bearbeiten ›“.

## 12. Checkliste

- [ ] `format`, `id`, `trip.title`, `trip.kind`, `trip.start`, `trip.end` gesetzt
- [ ] genau ein `ports`-Eintrag je Kalendertag, `day` fortlaufend, `date` passend
- [ ] jeder Tag außer Seetagen hat `name`, `lat`, `lon`, `land`, `tz`
- [ ] Kreuzfahrt: Tag 1 `start`, letzter Tag `end`, Hafentage `times` als „HH:MM–HH:MM“
- [ ] Tipps mit `id`, `n`, `t`, `lat`, `lon`, `w`, `d`
- [ ] keine Kartenfelder (`ox`, `oy`, …), `maps` leer
- [ ] eigene Texte, nichts Erfundenes als Tatsache, Unsicheres weggelassen
- [ ] `node tripcheck.js` meldet „OK“

## 13. Versionen dieses Formats

| Version | Änderung |
|---|---|
| `reiseplaner-trip-1` | aktuelles Format (seit 2026). Neue optionale Felder können dazukommen; alte Dateien bleiben gültig. |

Ändert sich das Format grundlegend, bekommt es eine neue Kennung (`reiseplaner-trip-2`) und diese Datei
wird um eine Umstellungsanleitung ergänzt.
