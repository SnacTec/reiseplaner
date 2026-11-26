# Claude-Konnektor (MCP) – Einrichtung und Nutzung

Mit dem Konnektor kann Claude (claude.ai, App am Handy/PC) den Reiseplan der **aktuellen Reise lesen**,
z. B. „Was steht morgen an?“ oder „Wann müssen wir zurück an Bord?“. In Stufe 1 kann Claude **nichts ändern**.
Technik und Sicherheitskonzept: `docs/MCP-PLAN.md`. Code: `functions/mcp/`, Tests: `node functions/test/mcp.test.js`.

## Was Claude sieht – und was nicht
- **Ja:** Stationen, Daten, Zeiten, Tagesplan, Tipps, Abendessen-Zeit/Ort, An-/Abreise (Flughafen bzw. Stadt, Zeiten,
  Flugnummern), Unterkünfte (nur Name und Zeitraum), Dateinamen der Reise-Mappe.
- **Nein:** Sitzplätze, Buchungsnummern, Kabinen- und Tischnummer, Notizen zur Anreise, Zuhause-Adresse,
  Adressen der Unterkünfte, Namen und E-Mail-Adressen, Fotos, Dateiinhalte, Quiz, ToDos, Sicherungen.

## Einmalige Einrichtung (am PC, ca. 20 Min.)
Basis-Adresse unten: `https://mcp-97052290110.europe-west3.run.app`. Zeigt `firebase deploy` eine andere Adresse an,
in `functions/.env` `MCP_BASE_URL=<Adresse>` setzen, neu hochladen und die Weiterleitungs-URI aus Schritt 1 anpassen.

1. **Google-Anmeldung für den Konnektor** – Google-Cloud-Konsole, Projekt `reiseplaner-accd8`,
   „APIs & Dienste“ → „Anmeldedaten“ → „Anmeldedaten erstellen“ → „OAuth-Client-ID“:
   - Typ **Webanwendung**, Name „Reiseplaner Claude-Konnektor“
   - Autorisierte Weiterleitungs-URI: `https://mcp-97052290110.europe-west3.run.app/google/callback`
   - Client-ID und Client-Secret notieren (Secret **nicht** in Chat, Datei oder Repository).
2. **Secrets** (im Ordner des Projekts):
   ```
   firebase functions:secrets:set MCP_PEPPER          # langer Zufallswert, z. B. aus: openssl rand -base64 48
   firebase functions:secrets:set MCP_ALLOWED_EMAILS  # die beiden Google-Adressen, kommagetrennt
   firebase functions:secrets:set MCP_GOOGLE_SECRET   # Client-Secret aus Schritt 1
   ```
3. **Hochladen:** `cd functions && npm ci && cd .. && firebase deploy --only functions:mcp`
   (fragt beim ersten Mal nach `MCP_GOOGLE_CLIENT_ID` → Client-ID aus Schritt 1). **Regeln nie per CLI hochladen.**
4. **Aufräumen automatisch** – Firestore → „Gültigkeitsdauer (TTL)“: je eine Richtlinie mit Feld `ttl` für
   `mcp_pending`, `mcp_codes`, `mcp_tokens`, `mcp_families`, `mcp_clients`, `mcp_rate`.
5. **Budget-Alarm** (Abrechnung → Budgets), z. B. 5 €.
6. Prüfen: `https://mcp-97052290110.europe-west3.run.app/.well-known/oauth-authorization-server` zeigt JSON.

## In Claude verbinden (jede Person einmal)
1. claude.ai → Einstellungen → **Konnektoren** → „Benutzerdefinierten Konnektor hinzufügen“.
2. Name „Reiseplaner“, URL `https://mcp-97052290110.europe-west3.run.app/mcp` → Hinzufügen → **Verbinden**.
3. Google-Konto wählen (dasselbe wie in der App) → Seite „claude.ai möchte deinen Reiseplan lesen“ → **Erlauben**.
4. Empfohlen: Werkzeuge auf „Immer erlauben“ stellen (nur lesend).
5. Datenschutz: in Claude unter Einstellungen → Datenschutz „Zur Verbesserung von Claude beitragen“ **ausschalten**.

## Eintragen lassen (Stufe 2a)
Beim Verbinden wählst du auf der Seite „Zugriff erlauben?“ **Nur lesen** oder **Lesen und eintragen**.
Wer schon „nur lesen“ verbunden ist: in Claude den Konnektor trennen und neu verbinden, dann „Lesen und eintragen“ wählen.
- Claude kann dann:
  - Einträge im Tagesplan anlegen (auch täglich bis Tag N), ändern und löschen. Löschen geht nur bei Einträgen,
    die Claude selbst angelegt hat.
  - Gemeinsame ToDos anlegen und abhaken.
  - Das Abendessen an einem Tag ausfallen lassen, auf eine andere Zeit legen oder wieder normal setzen.
  - Ausflüge wählen oder abwählen.
- **Nie:** Reisen direkt anlegen (nur als Entwurf, siehe unten) oder löschen, Stationen/Zeiten, An-/Abreise, Unterkünfte, Dateien, private Listen.
- Orte sucht der Server selbst, nahe der Station. Auf See gehen nur Orte an Bord, an Land nur mit „an Bord: …“.
- Gibt es eine Überschneidung, speichert Claude nichts und fragt nach.
- **In der App:** Änderungen von Claude tragen ein 🤖. Unter Einstellungen → Konto → „Änderungen durch KI ›“ lässt sich
  jede Änderung rückgängig machen.
- **Empfehlung:** In Claude die schreibenden Werkzeuge auf „Vorher fragen“ stellen, dann bestätigst du jede Änderung.
- **Grenzen:** höchstens 30 Änderungen pro Stunde und 150 pro Tag je Person.

## Neue Reise als Entwurf (Stufe 2b)
- „Bau mir aus diesen Unterlagen eine neue Reise“: Claude holt sich mit `reise_format` die Format-Beschreibung und eine
  **erfundene** Beispielreise als Vorlage, prüft das Ergebnis mit `reise_pruefen` (dieselbe Prüfung wie der Datei-Import)
  und speichert es mit `reise_entwurf_speichern` als **Entwurf** (nur mit „Lesen und eintragen“).
- **In der App:** Einstellungen → 🧳 Reisen → „🤖 Entwurf von Claude“: **Vorschau ›** · **Übernehmen** · **Verwerfen**.
  Erst „Übernehmen“ legt die Reise an – über den normalen Import mit erneuter Prüfung. Sie öffnet sich auf diesem Gerät;
  die aktuelle Reise der anderen bleibt eingestellt.
- Bestehende Reisen werden nie überschrieben (Kennung schon vergeben → Fehler). Gibt es das Schiff schon, bleibt dessen
  Deckplan unverändert. Fotos werden bei Entwürfen nicht übernommen.
- Höchstens 3 offene Entwürfe, nach 30 Tagen gelöscht (beim nächsten Speichern; App blendet ältere aus).
  Gleiche Kennung ersetzt den eigenen Entwurf (den eines anderen Mitreisenden nicht).
- Ohne Konnektor geht es weiterhin über eine Import-Datei (`docs/KI-PROMPT.md`).

## Nutzen
Einfach fragen, z. B. „Was machen wir heute?“, „Plan für Tag 3“, „Wann geht morgen der Flug?“,
„Welche Tipps gibt es für den nächsten Hafen?“, mit Eintragen auch „Trag an Tag 5 Schnorcheln von 10 bis 12 ein“.
Lesende Werkzeuge: `reise_info`, `tag_plan`, `jetzt`, `an_abreise`, `suchen`, `tipps`, `aufgaben`, `reise_format`, `reise_pruefen`.
Eintragende: `eintrag_anlegen`, `eintrag_aendern`, `eintrag_loeschen`, `aufgabe_anlegen`, `aufgabe_erledigt`,
`abendessen`, `ausflug_waehlen`, `letzte_aenderungen`, `reise_entwurf_speichern`. Gelesen wird immer die in der App als aktuell eingestellte Reise.

## Trennen und Notfall
- **Eine Verbindung trennen:** in Claude den Konnektor entfernen (später auch in der App unter Einstellungen → Konto).
- **Sofort alles sperren:** Firestore → Dokument `mcp_ctl/state` mit Feld `enabled` = `false` (wirkt nach ≤ 30 s).
- **Nur das Eintragen sperren:** im selben Dokument Feld `write` = `false`. Lesen geht weiter.
- **Ganz entfernen:** `firebase functions:delete mcp --region europe-west3`, OAuth-Client aus Schritt 1 und die
  drei Secrets löschen, Sammlungen `mcp_*` löschen.
