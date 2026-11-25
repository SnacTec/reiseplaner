# Reiseplaner

Private Reise-App (PWA) zum Planen und Begleiten von Reisen – Kreuzfahrten, Roadtrips, Städtereisen.
Läuft im Browser und als installierte App, auch offline. Daten liegen in Firebase (Anmeldung mit Google).

Dieses Repository enthält nur die App selbst, **keine Reisedaten**.

**Eigene Kopie?** Gern – aber bitte ein **eigenes Firebase-Projekt** anlegen und `firebase-config.js`
(inkl. App-Check-Schlüssel) durch die eigenen Werte ersetzen. Die hier eingetragenen Schlüssel funktionieren
nur auf der Original-Adresse und für die freigegebenen Konten.

## Eine Reise anlegen
- **In der App:** Einstellungen → 🧳 Reisen → „+ Neue Reise anlegen“ (Assistent).
- **Per Import-Datei** (z. B. von einem KI-Assistenten erstellt):
  - Format und alle Felder: [`docs/IMPORT-FORMAT.md`](docs/IMPORT-FORMAT.md)
  - Anweisung zum Kopieren für eine KI: [`docs/KI-PROMPT.md`](docs/KI-PROMPT.md)
  - Erfundene Beispiele: [`docs/beispiel/`](docs/beispiel/)
  - Prüfen: `node tripcheck.js reise.json`

## Weitere Unterlagen
- [`docs/DATEN.md`](docs/DATEN.md) – wie die Daten in Firestore liegen
- [`docs/NEUE-REISE.md`](docs/NEUE-REISE.md) – Ablauf beim Anlegen einer Reise
- [`docs/CLOUD-FUNCTION.md`](docs/CLOUD-FUNCTION.md) – Hilfsfunktion für Google-Maps-Links
- [`CLAUDE.md`](CLAUDE.md) – Hinweise für die Weiterentwicklung

Kartendaten: © OpenStreetMap-Mitwirkende (ODbL), Natural Earth (gemeinfrei), GeoNames (CC BY 4.0),
OpenFlights (ODbL).
