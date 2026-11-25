# Anweisung für einen KI-Assistenten (zum Kopieren)

So lässt man eine KI (Claude, ChatGPT, Gemini …) eine Import-Datei für den Reiseplaner erstellen:

1. Der KI diese drei Dinge geben (hochladen oder einfügen):
   - die Datei [`docs/IMPORT-FORMAT.md`](IMPORT-FORMAT.md) (die Anleitung),
   - die Beispieldatei [`docs/beispiel/BEISPIEL-kreuzfahrt.json`](beispiel/BEISPIEL-kreuzfahrt.json)
     (bei Reisen ohne Schiff zusätzlich [`BEISPIEL-roadtrip.json`](beispiel/BEISPIEL-roadtrip.json)),
   - die eigenen Reiseunterlagen (Buchungsbestätigung, Route, Zeiten, ggf. Ausflugskatalog).
2. Den Text unten kopieren und die Platzhalter in `<…>` ausfüllen.
3. Die fertige Datei mit `node tripcheck.js datei.json` prüfen (oder einfach in der App importieren –
   die App prüft ebenfalls und zeigt verständliche Fehlermeldungen).

---

```text
Erstelle bitte eine Import-Datei für die Web-App „Reiseplaner“.

Halte dich GENAU an die beigefügte Anleitung IMPORT-FORMAT.md (Format "reiseplaner-trip-1").
Die Beispieldatei zeigt den Aufbau; ihre Inhalte sind erfunden und dürfen NICHT übernommen werden.

Reise:
- Art: <kreuzfahrt | roadtrip | staedtereise | rundreise>
- Titel: <z. B. Mittelmeer-Kreuzfahrt 2027>
- Kennung (id): <z. B. mittelmeer-2027>
- Zeitraum: <erster Tag> bis <letzter Tag>
- Veranstalter/Reederei und Schiff: <falls Kreuzfahrt>
- Besondere Tage: <z. B. Geburtstag am …, sonst „keine“>
- Unterlagen: siehe Anhang

Anforderungen:
1. Pro Kalendertag genau ein Eintrag in data.ports, lückenlos, day ab 1, date passend.
2. Für jeden Ort korrekte Koordinaten (lat/lon in Dezimalgrad) und die Zeitzone tz in Stunden
   zu UTC AM REISEDATUM (Sommerzeit beachten).
3. Uhrzeiten wie in den Unterlagen, in Ortszeit, Format HH:MM. Liegezeiten als "HH:MM–HH:MM".
4. Je Ort 3–8 Tipps (pois) mit fester id, Art t, Erreichbarkeit w, kurzer Beschreibung d und
   Planungsdaten g (Wegzeit, Aufenthalt, Eintritt, Öffnungszeiten – nur wenn bekannt).
5. Veranstalter-Ausflüge (ex) nur aus den Unterlagen übernehmen, mit Code, Preis und Dauer.
6. Optional: Land & Leute (kul), 20–40 Quizfragen (quiz), Hinweise (notes).
7. data.maps leer lassen ({}), keine Kartenfelder (ox, oy …) setzen.
8. Alle Texte auf Deutsch, kurz, in eigenen Worten. Nichts erfinden: Was nicht sicher ist, weglassen
   und am Ende in einer Liste „Bitte prüfen“ nennen.
9. Ausgabe: nur die vollständige JSON-Datei (gültiges JSON, keine Kommentare), Dateiname <id>.json.
   Danach getrennt die Liste „Bitte prüfen“.
```

---

**Tipp:** Große Reisen in Schritten erstellen lassen (erst Grunddaten und alle Tage, dann Tipps je Ort,
dann Land & Leute und Quiz) und am Ende zu einer Datei zusammenfügen lassen.
