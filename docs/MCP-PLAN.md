# Plan: Reiseplaner als eigener Konnektor in Claude (MCP) – Stufe 1: lesen (live seit 26.11.2026), Stufe 2: schreiben (Plan, Abschnitt 9)

Stand: 26.11.2026 (überarbeitet nach unabhängiger Sicherheitsprüfung) · Status: **Plan, noch nicht umgesetzt** · Stufe 2 (Einträge anlegen) folgt separat.

Ziel: Jede freigegebene Person (Mitreisende der Reise) kann in **ihrem eigenen Claude-Konto** (claude.ai, Desktop,
Handy-App) fragen „Was machen wir heute?“ – Claude liest den Reiseplan über einen eigenen MCP-Server.
GitHub Pages und die App bleiben, wie sie sind; der MCP-Server ist ein **zweiter, unabhängiger Zugang** zu Firestore.

> Dieses Dokument ist öffentlich (Repository). Es enthält keine Reisedaten, keine E-Mail-Adressen und keine Schlüssel.
> Die Sicherheit beruht auf geheimen Schlüsseln und Prüfungen, nicht darauf, dass der Aufbau geheim ist.

---

## 1. Überblick

```
Claude (Server von Anthropic)                        Browser der Person (nur bei der Anmeldung)
   │  1. MCP-Aufruf ohne Schlüssel → 401                 │
   │  2. Anmeldung (OAuth 2.1 + PKCE) ───────────────────┼──▶ Anmeldeseite (Google-Login, Zustimmung)
   │  3. Zugangsschlüssel (Access-/Refresh-Token)        │
   ▼                                                     ▼
Cloud Function „mcp“ (europe-west3, Firebase-Projekt)  ◀── prüft Google-Anmeldung + Mitgliedschaft
   │  Werkzeuge: reise_info, tag_plan, jetzt, an_abreise, suchen, tipps
   ▼
Firestore (dieselben Daten wie die App, nur lesend, nur freigegebene Sammlungen)
```

- **Claude ruft den Server direkt aus dem Internet auf** (von Anthropic-Servern), nicht vom Handy aus.
  Funktioniert also auch, wenn die App geschlossen ist.
- **KI-Kosten: keine** (läuft über das Claude-Abo der jeweiligen Person; Free = 1 eigener Konnektor, reicht).
- **Firebase-Kosten:** wenige Cent/Monat (Function-Aufrufe, Firestore-Lesezugriffe). Optional ~ein paar €/Monat
  für eine „warme“ Instanz (siehe Entscheidung E1).

---

## 2. Anforderungen von Claude an eigene Konnektoren (recherchiert 26.11.2026)

Quellen: claude.com/docs/connectors (Building, Authentication, Troubleshooting, Review criteria),
platform.claude.com/docs/en/api/ip-addresses, GitHub modelcontextprotocol/typescript-sdk.

| Thema | Anforderung |
|---|---|
| Transport | **Streamable HTTP** (SSE veraltet). Zustandsloser Server erlaubt (Anthropics eigenes Beispiel ist zustandslos). |
| Netz | Öffentliche HTTPS-URL mit IPv4, **keine Weiterleitung auf einen anderen Host** (sonst verwirft Claude den Authorization-Header). |
| Anmeldestart | Ohne/ungültiger Schlüssel: **HTTP 401** mit `WWW-Authenticate: Bearer resource_metadata="<URL>"`. |
| Protected Resource Metadata (RFC 9728) | `resource` = **exakt** die eingetragene MCP-URL; `authorization_servers[0]` = unser Autorisierungsserver. |
| AS-Metadaten | RFC 8414 (`/.well-known/oauth-authorization-server`) **oder** OIDC-Discovery – an der **Wurzel** des Issuers. |
| PKCE | **S256 Pflicht** (`code_challenge_methods_supported: ["S256"]`). |
| Client-Registrierung | eine von: DCR (RFC 7591) · CIMD · **eigene Client-ID** („Use your own OAuth client“ im Dialog „Add custom connector“). |
| Redirect | `https://claude.ai/api/mcp/auth_callback` (Web, Desktop, Handy). |
| Resource Indicator (RFC 8707) | Claude sendet `resource` (kanonische MCP-URL) bei authorize + token → Token an diese Audience binden und prüfen. |
| Token-Endpunkt | `application/x-www-form-urlencoded`; Antwort **< 10 s** (Refresh < 30 s). |
| Refresh | Claude erneuert bei 401 und bis 5 Min vor Ablauf; `offline_access` nur wenn in `scopes_supported`; ungültig → `invalid_grant`; Rotation empfohlen. |
| Grenzen | Werkzeug-Antwort ≤ ~150.000 Zeichen, Aufruf ≤ 240 s. |
| Werkzeug-Hinweise | `title` + `readOnlyHint: true` (Lesen) bzw. `destructiveHint` – Lesen und Schreiben als **getrennte** Werkzeuge. |
| Anthropic-IP-Bereiche | Aufrufe kommen aus `160.79.104.0/21` und `153.61.208.0/20` (gilt für alle Claude-Nutzer → nur Zusatzschutz). |
| Freigaben | Pro Werkzeug „Immer erlauben / Nachfragen / Blockiert“ unter claude.ai → Konnektoren → eigener Konnektor. |
| Handy | In claude.ai (Web) angelegt → auch in der Handy-App nutzbar. |

**Unsicher (vor Umsetzung erneut prüfen):** ob Claude schon die MCP-Spezifikation 2026-07-28 spricht (SDK v2 bedient beide);
ob die Option „eigene Client-ID“ für Privatkonten sichtbar ist (sonst DCR, siehe 4.3).

---

## 3. Architektur-Entscheidungen

### 3.1 Eine Cloud Function `mcp` (v2) mit eigener Herkunft
- Firebase Functions v2 laufen auf Cloud Run und haben eine eigene run.app-URL. **Diese Wurzel gehört allein der
  Function** → `/.well-known/...` an der Wurzel möglich (Pflicht für AS-Metadaten).
- Es gibt zwei run.app-Schreibweisen (`mcp-<hash>-ey.a.run.app` und `mcp-<projektnummer>.europe-west3.run.app`):
  **eine** festlegen und überall gleich verwenden (`resource`, Metadaten, Host-Prüfung). Die `cloudfunctions.net`-URL
  wird **nie** eingetragen und von der Host-Prüfung abgelehnt (Claude verbietet Weiterleitungen auf andere Hosts).
- `invoker: 'public'` ausdrücklich setzen; Firebase v2 liefert `req.body` schon geparst → an den MCP-Transport durchreichen.
- Pfade (Express-App in der Function):
  - `POST /mcp` – MCP (Streamable HTTP, zustandslos, JSON-Antworten)
  - `GET /.well-known/oauth-protected-resource/mcp` – Resource-Metadaten
  - `GET /.well-known/oauth-authorization-server` – AS-Metadaten
  - `GET /authorize` – Anmeldestart (prüft Parameter, setzt Browser-Cookie, zeigt Anmelde- und Zustimmungsseite)
  - `POST /authorize/complete` – Formular-POST der Zustimmungsseite (ID-Token + Zustimmung) → `302` zu Claude mit Code
  - `POST /token` – Code → Token, Refresh
  - `POST /revoke` – Token widerrufen (RFC 7009)
  - `GET|POST /connections` – für die App: eigene Verbindungen anzeigen/trennen (mit Firebase-ID-Token; CORS nur `snactec.github.io`)
- Kanonische MCP-URL = `https://mcp-<hash>-ey.a.run.app/mcp` (genau so in Claude eintragen; Kleinbuchstaben, kein `/` am Ende).
- Die vorhandene Function `mapLink` bleibt unverändert.

### 3.2 Google-Anmeldung serverseitig, Zustimmungsseite aus der Function (umgesetzt)
- **Keine Firebase-Skripte im Browser:** Die Function leitet zur normalen Google-Anmeldeseite weiter
  (OAuth Authorization Code + PKCE + nonce) und prüft das Ergebnis selbst (Client-Secret im Secret Manager).
  Grund: Die Firebase-Anmeldung im Browser (Popup/Weiterleitung) scheitert oft in den eingebetteten Browsern,
  die Claude am Handy für die Anmeldung öffnet. **GitHub Pages bleibt unverändert**, Firebase-Auth-Domains und
  API-Schlüssel müssen **nicht** geändert werden.
- Danach Zuordnung zum Firebase-Konto der App (`getUserByProviderUid('google.com', …)`) und Prüfungen aus 3.4.
- Zustimmungsseite von der Function ausgeliefert (keine Skripte): `X-Frame-Options: DENY`, CSP `frame-ancestors 'none'`,
  `form-action 'self' https://claude.ai`, `Referrer-Policy: no-referrer`, `Cache-Control: no-store`.
- Inhalt: „**claude.ai** möchte deinen Reiseplan **lesen** · angemeldet als <E-Mail> · Reise: <Titel>“, was gelesen wird und was
  nicht, Hinweis „Nur fortfahren, wenn du gerade selbst in Claude auf ‚Verbinden‘ getippt hast“, Datenschutz-Hinweis,
  **Erlauben** / **Ablehnen**.
- Einmalig in der Google-Cloud-Konsole (durch den Nutzer, Anleitung `docs/MCP.md`): OAuth-Client „Webanwendung“ mit der
  Weiterleitungs-URI `<Basis>/google/callback` anlegen.

### 3.3 Client-Registrierung: feste Client-ID statt offener Registrierung
- Empfehlung: in Claude „**Use your own OAuth client**“ mit einer festen, öffentlichen Client-ID (z. B. `reiseplaner-claude`),
  ohne Secret (öffentlicher Client, PKCE).
- Server akzeptiert **nur** diese Client-ID und **nur** die Redirect-URLs `https://claude.ai/api/mcp/auth_callback`
  und `https://claude.com/api/mcp/auth_callback` (von Anthropic angekündigt).
- Per DCR registrierte Clients verfallen nach **1 h**, wenn sie nie Tokens bekommen (sonst ließen sich alle 20 Plätze
  blockieren); jede Token-Ausgabe verlängert auf 90 Tage. Andere `token_endpoint_auth_method` werden durch `none` ersetzt.
- Kein offener `/register`-Endpunkt → weniger Angriffsfläche.
- Fallback, falls die Option fehlt: DCR anbieten, aber eingeschränkt (nur diese Redirect-URL, max. N Clients, Ablauf 90 Tage).

### 3.4 Wer darf: doppelte Prüfung
1. Google-ID-Token gültig (`verifyIdToken` mit Widerrufsprüfung), `email_verified`, Anbieter `google.com`.
2. **E-Mail auf der Freigabeliste** im Secret Manager (`MCP_ALLOWED_EMAILS`, nicht im Repository).
3. **Mitglied der Reise**: `trips/<trip>/members/<uid>` existiert (entsteht nur bei freigegebenen Konten).
Alle drei bei der Anmeldung. **Beim Refresh** (dort gibt es kein ID-Token): Freigabeliste + Mitgliedschaft +
`admin.auth().getUser(uid)` (Konto nicht `disabled`, `tokensValidAfterTime` nicht nach dem Start der Token-Kette).
Freigabe entziehen wirkt damit spätestens nach 1 h (Ablauf des Access-Tokens), „Trennen“ in der App sofort.

### 3.5 Tokens: undurchsichtig, gehasht gespeichert
- Access-Token: 32 Byte Zufall, **1 h** gültig. Refresh-Token: 32 Byte Zufall, **30 Tage**, bei jeder Nutzung **rotiert**;
  Wiederverwendung eines alten Refresh-Tokens → ganze Kette widerrufen (Diebstahlschutz) – **außer** innerhalb eines
  Kulanzfensters von 60 s (Claude erneuert evtl. doppelt oder wiederholt nach Netzfehler): dann **einmal** ein weiteres Paar
  derselben Kette (kein Klartext-Speicher nötig); eine zweite Wiederverwendung widerruft die Kette.
- Absolute Höchstdauer einer Kette: **90 Tage**, danach neu anmelden.
- Gespeichert wird nur `HMAC-SHA256(token, MCP_PEPPER)` (Pepper im Secret Manager) in `mcp_tokens/<hash>`:
  `{uid, kind, aud, trip, exp, family, createdAt, lastUsed, client}`.
- Autorisierungscode: 60 s gültig, einmalig (Verbrauch in einer **Firestore-Transaktion**), gebunden an Client-ID,
  Redirect-URL, `code_challenge`, `resource`, uid. Wird ein Code doppelt benutzt → alle daraus erzeugten Tokens widerrufen.
- `exp` wird **immer im Code** geprüft (die Firestore-TTL löscht erst mit bis zu 24 h Verzögerung).
- Vorteil gegenüber JWT: **sofort widerrufbar** (App: „Trennen“), keine Schlüsselverwaltung für Signaturen.
- Sammlungen `mcp_*` liegen auf oberster Ebene → durch die bestehende Regel „Alles andere ist gesperrt“ für die App
  **nicht lesbar**; nur die Function (Admin SDK) greift zu. Firestore-TTL-Richtlinie auf das Feld **`ttl`** (Zeitstempel; `exp` ist eine Zahl in ms und taugt dafür nicht) räumt Altes auf.

### 3.6 Gemeinsame Rechenlogik `dayplan.js` (umgesetzt in S1)
- Die Tageslogik (wann „Ab Schiff“, „Zurück an Bord“, Puffer, Ausflüge, Abendessen, Ein-/Ausschiffung, An-/Abreise,
  „heute“, „jetzt/als Nächstes“) steckt heute DOM-frei, aber an globale Variablen gebunden in `app.js`
  (`calc`, `portWin`, `leg`, `dinRow`, `embMarks`, `tvSum`, `todayStr`, `portNow`, `aabInfo`, `rowTxt`/`tripText` …).
- **Herauslösen** in `dayplan.js` (Projektwurzel, UMD-Stil wie `tripcheck.js`), Aufruf mit Kontext
  `ctx = {trip, ports, plan, picks, dinner, ship, stays, travel, now}`. Die App nutzt dünne Hüllen
  (`function calc(p){return DP.calc(p)}`), die Function dieselbe Datei. In `app.js` ist `dayplan.js` wörtlich eingebettet
  (`node tools/dayplan-sync.js`), damit die App offline und bei Updates nie eine zweite, evtl. veraltete Datei braucht.
- Grund: **Zwei Kopien würden auseinanderlaufen** (calc wurde schon oft erweitert).
- Die Function bekommt die Datei beim Hochladen per `predeploy`-Schritt kopiert (`functions/dayplan.js`); ein Test prüft,
  dass beide Dateien gleich sind.
- Normalisierung wie in der App: fehlende `pois[].id` → `t<Tag>_<i>`, Tipp-Index `i` aus `ti` neu bestimmen,
  `planitems` je Tag nach `o`, dann `id` sortieren (`o` ist immer die Reihenfolge-Zahl).

---

## 4. Abläufe im Detail

### 4.1 Einrichten (je Person einmal)
1. claude.ai → Einstellungen → **Konnektoren** → „Eigenen Konnektor hinzufügen“.
2. Name „Reiseplaner“, URL = kanonische MCP-URL, unter „Erweitert/OAuth client“: Client-ID eintragen.
3. „Verbinden“ → Browser öffnet unsere Anmeldeseite → Google-Konto wählen → Zustimmung „Erlauben“.
4. Zurück in Claude: verbunden. Werkzeuge stehen auf „Immer erlauben“ (nur Lesen) oder „Nachfragen“ – nach Wunsch.
5. In der Handy-App ist der Konnektor danach ebenfalls verfügbar.

### 4.2 Anmeldung (technisch)
1. Claude → `POST /mcp` ohne Token → `401` + `WWW-Authenticate: Bearer resource_metadata=".../.well-known/oauth-protected-resource/mcp"`.
2. Claude liest Resource- und AS-Metadaten.
3. Claude → Browser → `GET /authorize?response_type=code&client_id=…&redirect_uri=…&code_challenge=…&code_challenge_method=S256&state=…&resource=…&scope=reise.lesen offline_access`.
   Strenge Prüfung **jedes** Parameters:
   - `client_id` und `redirect_uri` exakt die erlaubten Werte; `response_type=code`;
   - `code_challenge` Pflicht (base64url, genau 43 Zeichen), Methode **nur** `S256` – fehlt etwas: ablehnen (kein Downgrade);
   - `resource`: fehlt es, gilt die kanonische URL; jeder andere Wert wird abgelehnt;
   - `state` Pflicht, Länge begrenzt.
   Bei Fehlern **keine** Weiterleitung an unbekannte Adressen, sondern eine Fehlerseite.
4. Server legt `mcp_pending/<id>` an (10 Min, einmalig) und setzt das Cookie
   `__Host-mcp_req=<Zufallswert>` (`Secure; HttpOnly; SameSite=Lax; Path=/`); im pending steht nur dessen Hash.
   Antwort: Weiterleitung zu Google (state = pending-Kennung, nonce, PKCE).
5. Google → `GET /google/callback`: Cookie passt zum pending · Google-Code serverseitig eintauschen · ID-Token prüfen
   (Signatur, Zielgruppe, nonce, `email_verified`) · Prüfungen aus 3.4 → Zustimmungsseite mit CSRF-Wert.
6. Person tippt **Erlauben** → Formular-POST an `/authorize/complete`. Server prüft Cookie, CSRF, pending (nicht abgelaufen,
   nicht verbraucht) und dass die Google-Anmeldung höchstens **5 Min** her ist. Dann pending in einer Transaktion
   verbrauchen, Code erzeugen und **direkt `302`** zu `https://claude.ai/api/mcp/auth_callback?code=…&state=…&iss=<Issuer>` (RFC 9207 gegen
   Verwechslung). „Ablehnen“ → `error=access_denied`.
7. Claude → `POST /token` (form-urlencoded: code, code_verifier, redirect_uri, client_id, resource) → Server prüft PKCE und
   dass `redirect_uri`, `client_id`, `resource` **exakt** zum Code passen → Access- + Refresh-Token,
   Antwort mit `Cache-Control: no-store`.

### 4.3 Werkzeug-Aufruf
1. Claude → `POST /mcp` mit `Authorization: Bearer <access>`.
2. Server: Hash nachschlagen → gültig, `aud` = kanonische URL, nicht widerrufen → uid, Reise.
3. Ratenbegrenzung prüfen (4.4) → Werkzeug ausführen → kompakte Antwort (Text, < 10.000 Zeichen).

### 4.4 Schutzmaßnahmen im Betrieb
- **Ratenbegrenzung:** z. B. 120 Werkzeug-Aufrufe/Stunde und 600/Tag je Person (Zähler in Firestore); `/authorize` und
  `/token` je IP/Kennung begrenzt.
- **`maxInstances: 2`**, Speicher 256–512 MiB, Zeitlimit 30 s → Kosten nach oben begrenzt.
- **Host-Prüfung** (eigene Middleware, nur `<Basis>`-Host); Origin-Prüfung auf `/mcp` entfällt, weil dort nur Bearer-Tokens
  ohne Cookies gelten (kein Browser-Angriff möglich). CORS nur für `snactec.github.io`
  auf `/connections` (die Zustimmungsseite liegt auf derselben Herkunft wie der Server).
- **Optional:** `/mcp` und `/token` nur aus den Anthropic-IP-Bereichen annehmen (Zusatzschutz, ersetzt keine Anmeldung).
- **Not-Aus (schnell):** Dokument `mcp_ctl/state` `{enabled:false}` (von der App aus nicht erreichbar, in der
  Firestore-Konsole umschaltbar; Function liest es mit 30 s Zwischenspeicher) → alle Anfragen `503`.
  Zusätzlich Umgebungsvariable `MCP_ENABLED=0` (wirkt erst nach neuem Deploy).
- **Protokolle:** nur uid-Kürzel, Werkzeugname, Dauer, Ergebnis-Status – **keine Inhalte, keine Tokens**. Fehlerausgaben
  über einen eigenen Logger, der Anfrage-Inhalte (Code, Verifier, Refresh-Token, ID-Token) nie mitschreibt.
  Hinweis: Cloud Run protokolliert die Anfrage-URL von `/authorize` automatisch (enthält nur `state`/`code_challenge`, unkritisch).
- **IP-Prüfung (E5):** Absender-IP = letzter Eintrag in `X-Forwarded-For` (Cloud Run hängt ihn an; `trust proxy` bleibt aus).
  Nur IPv4-Bereiche. Vor `MCP_IP_ENFORCE=1` im Protokoll (`ip-fremd`) prüfen, dass Claudes Aufrufe passen.
- Ungültige Tokens werden vor jedem Firestore-Zugriff an der Form erkannt; Fehlversuche je IP begrenzt (Kosten).
- Die Freigabeliste (`MCP_ALLOWED_EMAILS`) wird je Instanz einmal gelesen: Entfernen wirkt erst nach neuem Hochladen –
  sofort sperren über den Not-Aus `mcp_ctl/state`.
- **Ratenzähler:** im Speicher der Instanz plus ein Tageszähler je Person in Firestore (wenige Schreibzugriffe).
- **Kosten-Deckel:** Budget-Alarm in Google Cloud (z. B. 5 €/Monat, Benachrichtigung per E-Mail).
- **Kaltstart:** Secrets, Firebase Admin und MCP-SDK nur einmal pro Instanz laden (erwartet 1–3 s, Grenze 10 s).
- **Abhängigkeiten** fest versioniert (`package-lock.json`), keine unnötigen Pakete.

---

## 5. Werkzeuge (Stufe 1, alle `readOnlyHint: true`)

| Werkzeug | Eingabe | Ausgabe (kurz, Text) |
|---|---|---|
| `reise_info` | – | Titel, Zeitraum, Art (Kreuzfahrt/Roadtrip …), heute = Tag N oder „noch X Tage“, Liste aller Tage (Tag, Datum, Ort, Land, Art) |
| `tag_plan` | `tag` (Nummer) **oder** `datum` **oder** `"heute"`/`"morgen"` | Kopf (Tag · Datum · Ort · Land), Liegezeit, „an Bord“, Zeitunterschied zu Deutschland, Ein-/Ausschiffung, Ab Schiff → Einträge mit Uhrzeit/Dauer/Ort (an Bord: Deck) → Zurück an Bord + Puffer, Ausflüge des Veranstalters, Abendessen (oder „heute nicht“), Unterkunft/Fahrt (ohne Schiff), An-/Abreise an diesem Tag, Titel verknüpfter Dateien |
| `jetzt` | – | Ortszeit jetzt, was läuft gerade, was als Nächstes (in X Min), Zeit bis „alle an Bord“ |
| `an_abreise` | `richtung`: `hin`/`zurueck` | Teilstrecken mit Ortszeiten, Datum bei Folgetag, Dauer, Umstiege, Zeitumstellung |
| `suchen` | `text` (2–60 Zeichen) | Treffer in Orten, Einträgen, Tipps, Ausflügen, Orten an Bord – je Treffer Tag + Kurzinfo (max. 20) |
| `tipps` | `tag` | Tipps des Tages: Name, Art, Entfernung, zu Fuß/Taxi, kurze Beschreibung |

**Datensparsamkeit (Standard, änderbar – Entscheidung E3):**
- **Nicht** ausgegeben: private Daten (`users/<uid>/…`, `config/user_*`), Quiz, Sicherungen, Fotos, Dateiinhalte,
  E-Mail-Adressen, Nutzer-IDs.
- **Ein einziger Lesebaustein** mit fester Positivliste (im Code, nicht nur hier); Reise-Kennung per Regex prüfen und
  Mitgliedschaft prüfen; ein Test belegt, dass `users/…`, `config/user_*` und `plandays/quiz_*` nicht erreichbar sind.
- Server liest **nur** freigegebene Pfade: `config/app`, `trips/<id>`, `ships/<id>`, `trips/<id>/{planitems, picks,
  plandays/meta (nur dieses Dokument), travel (ohne `seat`, `ref`), stays (ohne `ref`), files (nur Titel/Tage), members (nur zur Prüfung der Mitgliedschaft, keine Ausgabe)}`.
- Training: Hinweis in der Anleitung, in Claude unter Datenschutz die Nutzung der Chats fürs Training auszuschalten.
- **Gegen Prompt-Injection:** Texte aus den Daten (Notizen, Tipps, OSM-Namen) werden gekürzt, Steuerzeichen entfernt und
  im Antworttext klar als Daten gekennzeichnet; Werkzeugbeschreibungen enthalten **keine** Anweisungen an Claude.
  In Stufe 1 gibt es nichts zu schreiben. **Aber:** Hat jemand in Claude weitere Konnektoren oder die Websuche aktiv,
  könnte eingeschleuster Text Claude dazu bringen, Reisedaten weiterzugeben. Wichtigster Schutz bleibt daher die
  **Datensparsamkeit** (E3); Hinweis dazu in der Bedienungsanleitung.

**Welche Reise:** `config/app.activeTrip`; optionaler Parameter `reise` nur für Reisen, in denen die Person Mitglied ist.
**„Heute“:** wie die App (`todayStr` mit Reise-Zeitzone); außerhalb der Reise: Europe/Berlin.

---

## 6. App-Ergänzung: „Verbundene KI“
- Einstellungen → Konto → **Verbundene KI**: Liste der eigenen Verbindungen (Claude · verbunden seit · zuletzt genutzt)
  mit **Trennen** (widerruft alle Tokens dieser Verbindung sofort) – über `/connections` mit Firebase-ID-Token.
- Kurzer Hilfetext mit der MCP-URL und Client-ID zum Kopieren.

---

## 7. Umsetzung in Schritten (je mit Vorschau/Test, live erst nach Freigabe)

| Schritt | Inhalt | Prüfung |
|---|---|---|
| **S1** ✅ | `dayplan.js` aus `app.js` herauslösen; App nutzt es; keine sichtbare Änderung | voller `node tests/run.js` + neuer Node-Test: gleiche Ergebnisse für die Beispielreisen in Browser und Node |
| **S2** ✅ | Function `mcp`: Metadaten, `/authorize`, `/authorize/complete`, `/token`, `/revoke`, Token-Speicher, Prüfungen | Node-Tests mit nachgebildetem Firestore/Auth. Fehlerfälle: falsche Redirect-URL, PKCE fehlt/falsch/`plain`, Code doppelt, abgelaufen, fremde E-Mail, Nicht-Mitglied, fehlendes/falsches `resource`, Refresh-Wiederverwendung (außer Kulanzfenster), parallele Refreshs, Kette > 90 Tage, fremde `reise`, Logs ohne Geheimnisse, öffentlicher Client ohne Secret (`token_endpoint_auth_methods_supported: ["none"]`) |
| **S3** ✅ | Anmelde-/Zustimmungsseite (aus der Function, Google serverseitig) | Playwright-Test: ohne/mit falschem Cookie, `auth_time` zu alt, Seite im Rahmen nicht bedienbar |
| **S4** ✅ | MCP-Werkzeuge (6 Stück) mit `dayplan.js` | Node-Tests mit Beispielreisen; Antwortgrößen; MCP Inspector lokal |
| **S5** ✅ | Hochladen (Nutzer), Konnektor in Claude einrichten, Ende-zu-Ende-Test | Checkliste unten |
| **S6** ✅ | App: „Verbundene KI“ (Trennen) | Test + Screenshots |
| **S7** ✅ | Doku: `docs/MCP.md` (Bedienung), CLAUDE.md, DATEN.md | – |

Geschätzter Aufwand: S1 mittel, S2–S4 groß (Hauptteil), S5–S7 klein.

### Was der Nutzer tun muss (S5)
1. In der Google-Cloud-Konsole einen OAuth-Client „Webanwendung“ anlegen (Weiterleitungs-URI `<Basis>/google/callback`).
   Secrets anlegen (einmalig, am PC): `MCP_PEPPER` (langer Zufallswert), `MCP_ALLOWED_EMAILS` (die beiden Adressen,
   kommagetrennt), `MCP_GOOGLE_SECRET` (Client-Secret). Die Client-ID fragt die Firebase-CLI beim Hochladen ab.
2. Firestore-TTL-Richtlinien auf Feld `ttl` für `mcp_pending`, `mcp_codes`, `mcp_tokens`, `mcp_families`, `mcp_clients`,
   `mcp_rate` aktivieren (Klick-Anleitung `docs/MCP.md`).
3. `firebase deploy --only functions` (wie bei `mapLink`; Regeln nie per CLI).
4. Budget-Alarm einrichten.
5. Konnektor in Claude einrichten (4.1); die zweite Person ebenso mit ihrem eigenen Konto.

### Ende-zu-Ende-Checkliste
- [ ] Verbinden klappt mit beiden Konten; fremdes Google-Konto wird abgelehnt.
- [ ] „Was machen wir heute?“, „Wann müssen wir an Bord sein?“, „Wann landen wir bei der Rückreise?“ stimmen mit der App überein.
- [ ] Handy-App: Konnektor nutzbar.
- [ ] „Trennen“ in der App → Claude muss sich neu anmelden.
- [ ] Not-Aus `MCP_ENABLED=0` wirkt.
- [ ] Protokolle enthalten keine Inhalte/Tokens.

---

## 8. Offene Entscheidungen (vor dem Start klären)

| Nr | Frage | Vorschlag |
|---|---|---|
| E1 | Kaltstart: Function „schläft“ → erste Anfrage evtl. 2–5 s (Grenze 10 s). Warme Instanz (`minInstances: 1`) kostet einige €/Monat. | **Entschieden (26.11.):** erst ohne; nur wenn es hakt, nach Rücksprache einschalten. |
| E2 | Wo läuft die Anmeldung? | **Entschieden (26.11.): Function, Google-Anmeldung serverseitig** (Clickjacking-/Link-Schutz, funktioniert in eingebetteten Browsern; GitHub Pages bleibt unverändert). |
| E3 | Was darf an Claude gehen? | **Entschieden (26.11.):** Orte, Tage, Zeiten, Einträge, Ausflüge, Abendessen, Tipps. **Nicht:** Sitzplätze, Buchungsnummern, Kabinennummer, Heimatadresse, Namen/E-Mails der Mitreisenden. |
| E4 | Werkzeug-Freigabe in Claude: Lesen „Immer erlauben“? | **Entschieden (26.11.):** Ja (E3 ist sparsam). |
| E5 | IP-Beschränkung auf Anthropic-Bereiche für `/mcp` + `/token`? | **Entschieden (26.11.):** Ja (Zusatzschutz), mit Not-Schalter, falls Anthropic die Bereiche ändert. |

## 9. Stufe 2: Schreiben (2a gebaut 26.11.2026: W1–W3 ✅, Sicherheitsprüfung eingearbeitet; 2b gebaut 26.11.2026: W4 ✅, Vorschau)

### 9.1 Ziel und Abgrenzung
- **Import (gibt es schon):** Eine KI baut eine komplette Reise-Datei nach `docs/IMPORT-FORMAT.md`, die App prüft sie
  (`tripcheck.js`) und legt die Reise an. Richtig für **neue Reisen**.
- **Stufe 2a – Eintragen:** Claude ändert über den Konnektor gezielt die **aktuelle** Reise, also Tagesplan, gemeinsame ToDos,
  Abendessen und Ausflugswahl. Richtig für kleine Änderungen, auch unterwegs.
- **Stufe 2b – Reise-Entwurf:** Claude legt eine neue Reise nur als **Entwurf** ab. Die App zeigt ihn an, übernommen wird
  er erst nach Tippen auf „Übernehmen“, über denselben Weg wie der Import, mit derselben Prüfung.
- **Nie:** bestehende Reisen ganz überschreiben oder löschen, Stationen, Zeiten oder Stammdaten ändern, Mitglieder, Dateien,
  Fotos, Quiz, An-/Abreise, Unterkünfte, private Listen.

### 9.2 Grundsätze
- **Eigener Bereich `reise.schreiben`.** Bestehende Verbindungen bleiben lesend. Zum Eintragen verbindet man einmal neu,
  die Zustimmungsseite sagt dann ausdrücklich „lesen **und eintragen**“. Jede Person entscheidet für sich.
- **Bestätigung in Claude:** Die schreibenden Werkzeuge stehen auf „Vorher fragen“ (Empfehlung). Claude zeigt dann jede
  Änderung, bevor sie passiert.
- **Feste Positivliste je Werkzeug**, und der Server prüft alles selbst, wie die App:
  - Der Tag existiert.
  - Uhrzeit im Format `HH:MM`, Dauer 5–720 Min.
  - Texte gekürzt (Name ≤ 80, Notiz ≤ 300 Zeichen), Steuer- und Unsichtbar-Zeichen entfernt.
  - Ein Ort an Bord nur aus dem Deckplan (gleiche Suche wie `shipFind`).
  - Koordinaten nur in der Nähe der Station (≤ 200 km).
- **Gleiches Datenformat wie die App:**
  - Jeder Tagesplan-Eintrag ist ein eigenes Dokument `planitems/<id>` `{d, o, …}`.
  - Abendessen wird feldgenau geschrieben (`skip` per arrayUnion/arrayRemove, `ov` je Tag), Ausflüge über `picks`.
  - Die App sieht Änderungen sofort über ihre bestehenden Firestore-Listener, auch auf dem zweiten Handy.
- **Herkunft und Rückgängig:**
  - Jede Änderung trägt `ki:{uid, at}`. Dazu kommt ein Protokoll-Dokument `trips/<id>/kilog/<id>` mit dem Zustand
    vorher und nachher.
  - Die App zeigt 🤖 an Einträgen, die Claude angelegt oder geändert hat, und eine Liste „Änderungen durch KI“
    mit **Rückgängig**.
  - Die Firestore-Regeln müssen dafür **nicht** geändert werden: `trips/{trip}/{coll}/{id}` gilt schon für neue Sammlungen.
- **Grenzen:**
  - Höchstens 30 Änderungen pro Stunde und 150 pro Tag je Person.
  - Ein Aufruf ändert genau einen Eintrag. Ausnahme ist „wiederholen bis Tag N“ wie in der App, höchstens 30 Kopien.
- **Schutz vor untergeschobenen Anweisungen** (z. B. Text in einer Webseite, die Claude liest):
  - Werkzeuge verlangen klare Einzelwerte, keine freien „Befehle“.
  - Löschen geht nur bei Einträgen, die Claude selbst angelegt hat.
  - Es gibt Bestätigung, Protokoll und Rückgängig.
  - Ausgaben bleiben als „Daten, keine Anweisungen“ markiert.
- **Not-Aus für das Schreiben allein:** `mcp_ctl/state.write = false`. Lesen geht dann weiter.

### 9.3 Werkzeuge Stufe 2a (Entwurf)
| Werkzeug | Zweck | Hinweise |
|---|---|---|
| `tag_plan` (erweitert) | liefert zusätzlich kurze Kennungen je Eintrag (`#a3f`) | damit Claude gezielt ändern kann |
| `eintrag_anlegen` | Tag, Name, Uhrzeit?, Dauer?, Ort? (Suchtext oder „an Bord: …“), Notiz?, bis_tag? | Überschneidungen werden gemeldet; Claude fragt dann nach |
| `eintrag_aendern` | Kennung + geänderte Felder (Uhrzeit, Dauer, Name, Notiz, Ort, Tag) | vorher/nachher im Protokoll |
| `eintrag_loeschen` | Kennung | nur Einträge mit `ki` (siehe E6) |
| `aufgabe_anlegen` / `aufgabe_erledigt` | gemeinsame ToDos (`tasks`) | private Listen nie |
| `abendessen` | Tag: fällt aus / andere Zeit / wieder normal | feldgenau wie die App |
| `ausflug_waehlen` | Tag + Ausflugs-Code, gewählt ja/nein | nur Codes, die es an dem Tag gibt |
| `letzte_aenderungen` | was Claude zuletzt geändert hat | lesend |

**Ortssuche (E8):** Claude erfindet keine Koordinaten. Der Server sucht den Ort mit derselben Photon-Suche wie die App,
nahe der Station, und speichert den Treffer mit dem Vermerk „Ort automatisch gesucht“. In der App ist er wie gewohnt änderbar.

### 9.4 Woher Claude weiß, was es eintragen muss
- Jedes Werkzeug beschreibt Zweck und Felder, Claude sieht das bei jeder Anfrage.
- Beim Verbinden gibt der Server kurze `instructions` mit:
  - erst `tag_plan` lesen, dann eintragen;
  - Uhrzeiten in Ortszeit;
  - bei fehlenden Angaben nachfragen statt raten;
  - nach dem Eintragen kurz zusammenfassen.
- Für 2b liefert `reise_format` die Import-Beschreibung **und eine passende erfundene Beispielreise** (siehe 9.5).
  Beides wird wie `dayplan.js` per Sync-Werkzeug nach `functions/` kopiert, damit es immer zur App passt.

### 9.5 Stufe 2b: neue Reise als Entwurf
- `reise_format(art)` liefert die Format-Beschreibung **plus eine vollständige, gültige Beispielreise** als Vorlage
  (Entscheidung 26.11.: mit Beispiel baut Claude deutlich zuverlässiger als nur nach Beschreibung):
  - `art = kreuzfahrt` → `docs/beispiel/BEISPIEL-kreuzfahrt.json`, `art = rundreise` → `docs/beispiel/BEISPIEL-roadtrip.json`,
    ohne Angabe beide.
  - Quelle: `docs/IMPORT-FORMAT.md` + `docs/beispiel/*.json`, erfunden und öffentlich. Kopie nach `functions/format/`
    über `tools/dayplan-sync.js` (bzw. ein eigenes Sync-Werkzeug). Ein Test prüft, dass die Kopien gleich sind und die
    Beispiele `tripcheck.js` bestehen.
  - Größe zusammen ca. 25 kB, passt gut in eine Werkzeug-Antwort.
  - Die Antwort sagt ausdrücklich: Das Beispiel ist erfunden, nur Aufbau und Feldnamen übernehmen, keine Inhalte.
- Ohne Konnektor geht es weiterhin: Beschreibung und Beispiele als Dateien in ein Claude-Projekt legen, die Reise-Datei
  erzeugen lassen und in der App importieren (`docs/KI-PROMPT.md`).
- `reise_pruefen(reise)` prüft mit `tripcheck.js`, das wie `dayplan.js` nach `functions/` kopiert wird. Fehler kommen als
  Liste zurück, Claude bessert nach.
- `reise_entwurf_speichern(reise)` speichert nur nach bestandener Prüfung, in `config/kientwurf_<id>`
  (lesbar für beide, keine Regeländerung). Höchstens 3 offene Entwürfe, nach 30 Tagen gelöscht.
- In der App unter Einstellungen → Reisen steht dann „Entwurf von Claude: Vorschau · Übernehmen · Verwerfen“.
  „Übernehmen“ nutzt den bestehenden Import (`__checkTrip`).
- **Umgesetzt (26.11.):** `reise_format` und `reise_pruefen` auch für Lese-Verbindungen (speichern nichts), Speichern nur mit
  `reise.schreiben` und unter Not-Aus `write`. Verzeichnis `config/kientwuerfe`, damit weder Server noch App `config/*`
  (mit `config/user_*`) auflisten müssen. Kennung schon vergeben → Fehler; Schiff schon vorhanden → Deckplan bleibt;
  Fotos werden entfernt. Übernehmen ändert `config/app.activeTrip` nicht (nur auf dem eigenen Gerät öffnen).
  Großer Inhalt (bis 960 kB) wird erst **nach** der Token-Prüfung gelesen und nur für einen einzelnen Aufruf von
  `reise_pruefen`/`reise_entwurf_speichern` angenommen, sonst 413.
- Größe: Eine Reise mit Tipps kann einige 100 kB groß sein. Für dieses Werkzeug wird die Größengrenze auf 900 kB angehoben
  (Firestore-Grenze 1 MiB je Dokument), sonst bleibt sie bei 64 kB.

### 9.6 Schritte
| Schritt | Inhalt | Prüfung |
|---|---|---|
| **W1** | Bereich `reise.schreiben`, Zustimmungsseite, Not-Aus `write`, Protokoll `kilog`, Ratenlimits | Node-Tests: Lese-Token darf nicht schreiben, Grenzen, Not-Aus |
| **W2** | Werkzeuge 2a; Schreibweg identisch zur App (gemeinsame Hilfsfunktionen in `dayplan.js` bzw. neuer gemeinsamer Datei) | Node-Tests je Werkzeug inkl. Angriffsfälle; App-Test: vom Server geschriebene Einträge erscheinen richtig (Reihenfolge, Ort, Abendessen) |
| **W3** | App: 🤖-Kennzeichen, „Änderungen durch KI“ mit Rückgängig | voller Testlauf + Screenshots (Vorschau zeigen) |
| **W4** ✅ | Stufe 2b: Format, Prüfung, Entwurf, App „Übernehmen“ (`functions/mcp/draft.js`, `functions/format/`, App `kdRender`/`kdPreview`/`kdAccept`) | Tests mit den erfundenen Beispielreisen, fehlerhafte Entwürfe |
| **W5** | Unabhängige Sicherheitsprüfung (Agents), Doku `docs/MCP.md` | – |
| **W6** | Hochladen (Nutzer, Cloud Shell), neu verbinden, Ende-zu-Ende-Test | Checkliste |

### 9.7 Offene Entscheidungen (vor W1 klären)
| Nr | Frage | Vorschlag |
|---|---|---|
| E6 | Was darf Claude ändern/löschen? | **Anlegen:** alles aus 9.3. **Ändern:** alle Tagesplan-Einträge (mit Protokoll + Rückgängig). **Löschen:** nur eigene KI-Einträge. |
| E7 | Bestätigung in Claude | Schreibende Werkzeuge auf „Vorher fragen“. |
| E8 | Ortssuche | Server sucht per Photon nahe der Station; Claude liefert keine Koordinaten. |
| E9 | Entwürfe (2b) | Beide sehen Entwürfe; höchstens 3; nach 30 Tagen weg. |
| E10 | ToDos | Nur gemeinsame Listen, private nie. |
| E11 | Reihenfolge | Erst 2a (W1–W3) bauen und nutzen, 2b danach. |

## 10. Datenschutz, Notfall, Abschalten
- **Datenschutz:** Was Claude liest, landet im Claude-Verlauf der jeweiligen Person bei Anthropic – auch Daten, die die
  andere Person eingetragen hat. Beide Mitreisenden sollten zustimmen; Hinweis auf der Zustimmungsseite und in `docs/MCP.md`.
- **Notfall (Verdacht auf Leck):**
  1. Not-Aus `mcp_ctl/state` → `enabled:false`.
  2. **Pepper rotieren** (`firebase functions:secrets:set MCP_PEPPER` + Deploy) → alle Tokens sofort ungültig
     (eingebauter „alle trennen“-Knopf).
  3. Sammlung `mcp_tokens` leeren; bei Bedarf Google-Sitzungen der Konten widerrufen.
  4. Notfalls Function in der Konsole löschen bzw. den öffentlichen Aufruf („allUsers“) entziehen.
- **Ganz abschalten:** Konnektor in Claude entfernen → Function `mcp` löschen → Sammlungen `mcp_*` löschen →
  OAuth-Client „Reiseplaner Claude-Konnektor“ in der Google-Cloud-Konsole löschen, Secrets löschen.
