# App Check (unsichtbarer Schutz gegen fremde Anfragen)

App Check weist bei jeder Anfrage an Firestore, Storage und die Cloud Function nach, dass sie aus dieser App
auf `snactec.github.io` kommt (reCAPTCHA Enterprise, unsichtbar – niemand muss etwas anklicken).
Die Daten sind schon ohne App Check durch die Regeln geschützt; App Check hält zusätzlich fremde Skripte fern
(Schutz vor Missbrauch/Kosten).

## Einrichten (einmalig, Konsole)
1. **Schlüssel anlegen:** console.cloud.google.com → Projekt `reiseplaner-accd8` → Menü ☰ → **Sicherheit → reCAPTCHA**
   (ggf. „reCAPTCHA Enterprise API aktivieren“) → **Schlüssel erstellen**:
   Name „Reiseplaner“, Plattform **Website**, Domain `snactec.github.io`, **keine** Kästchen-Prüfung („Checkbox“ aus) → Erstellen.
   Die **Schlüssel-ID** (ID des Website-Schlüssels) kopieren. Sie ist öffentlich, kein Geheimnis.
2. **App registrieren:** console.firebase.google.com → Projekt → **Build → App Check** → Reiter **Apps** → Web-App
   „Reiseplaner“ → **reCAPTCHA Enterprise** → Schlüssel-ID einfügen → Speichern. Gültigkeit des Nachweises: 1 Stunde (Standard).
3. **Schlüssel in die App:** in `firebase-config.js` bei `window.APPCHECK_SITE_KEY` eintragen (macht Claude).
4. **Noch NICHT erzwingen.** Ein paar Tage normal nutzen.

## Prüfen
- In der App: Einstellungen → Konto → „🛡 App Check: aktiv ✓“ auf jedem Gerät.
- In der Konsole: App Check → Reiter **APIs** → bei Cloud Firestore und Cloud Storage den Anteil
  „Verifizierte Anfragen“. Fast 100 % → bereit.

## Erzwingen
App Check → APIs → **Cloud Firestore** → „Erzwingen“, dann **Cloud Storage** → „Erzwingen“ (wirkt nach einigen Minuten).
Cloud Function (optional): in der Cloud Shell `firebase functions:config` ist nicht nötig – stattdessen in
`functions/.env` die Zeile `APPCHECK_ENFORCE=1` anlegen und `firebase deploy --only functions` ausführen.

## Zurück
Hakt etwas: App Check → APIs → „Nicht erzwingen“ (wirkt nach wenigen Minuten, keine Daten gehen verloren).
App Check ganz aus: `APPCHECK_SITE_KEY` in `firebase-config.js` leeren.

## Hinweise
- Offline merkt man nichts; der Nachweis wird nur für Netzanfragen gebraucht.
- reCAPTCHA Enterprise ist bis 10.000 Prüfungen im Monat kostenlos.
- Werbeblocker, die Google-reCAPTCHA sperren, können den Nachweis verhindern.
