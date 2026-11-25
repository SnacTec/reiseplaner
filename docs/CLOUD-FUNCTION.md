# Cloud Function „mapLink“ (Google-Maps-Links → Koordinaten)

Teilt man einen Ort aus Google Maps, kommt nur ein Kurzlink (`maps.app.goo.gl/…`) ohne Koordinaten an.
Der Browser darf die Weiterleitung nicht auslesen (CORS). Die Funktion `mapLink` in `functions/` macht das
auf dem Server und gibt `{found, lat, lon, name}` zurück.

- Region `europe-west3`, höchstens 2 Instanzen, nur Google-Adressen werden aufgerufen.
- Nur für angemeldete Mitreisende: gültiges Firebase-Anmeldetoken **und** Eintrag in `trips/<trip>/members/<uid>`.
- Die App (`mapResolve()` in `app.js`) ruft sie beim Teilen auf; ohne Netz merkt sie sich den Eintrag
  und trägt den Pin später nach (`gResolveAll()`, höchstens 3 Versuche je Gerät, Zähler in `rp-<trip>-gres`).
- Kosten: im kostenlosen Kontingent des Blaze-Tarifs (2 Mio. Aufrufe/Monat).

## Einmalig hochladen (am PC)

1. **Node.js** (LTS) installieren: https://nodejs.org
2. Dieses Repository holen: auf GitHub „Code › Download ZIP“ und entpacken (oder `git clone`).
3. Eingabeaufforderung/Terminal im entpackten Ordner öffnen und nacheinander:
   ```
   npm install -g firebase-tools
   firebase login
   cd functions
   npm install
   cd ..
   firebase deploy --only functions
   ```
   - Beim ersten Mal schaltet Firebase einige Google-Cloud-Dienste ein (dauert ein paar Minuten).
   - Frage nach „cleanup policy“ / Aufbewahrung alter Container-Images: mit **Enter** bzw. „1“ Tag bestätigen.
4. Fertig – am Ende steht eine Adresse `https://europe-west3-reiseplaner-accd8.cloudfunctions.net/mapLink`.

**Wichtig:** Immer `--only functions` verwenden. `firebase.json` enthält absichtlich keine Regeln –
die Regeln im Repository haben nur Platzhalter-Adressen und würden euch sonst aussperren.

Update der Funktion: Schritt 3 ab `cd functions` wiederholen.
