// Cloud Function „mapLink“: geteilte Google-Maps-Kurzlinks auflösen (der Browser darf das wegen CORS nicht).
// Aufruf nur für angemeldete Mitreisende (Eintrag in trips/<trip>/members/<uid>).
'use strict';
const { onRequest } = require('firebase-functions/v2/https');
const admin = require('firebase-admin');
const { resolveLink } = require('./lib');
admin.initializeApp();

const ORIGINS = ['https://snactec.github.io', 'http://localhost:8766'];

exports.mapLink = onRequest({ region: 'europe-west3', memory: '256MiB', maxInstances: 2, timeoutSeconds: 30 }, async (req, res) => {
  const o = req.get('origin') || '';
  if (ORIGINS.includes(o)) res.set('Access-Control-Allow-Origin', o);
  res.set('Vary', 'Origin');
  if (req.method === 'OPTIONS') {
    res.set('Access-Control-Allow-Methods', 'POST').set('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Firebase-AppCheck').set('Access-Control-Max-Age', '86400');
    return res.status(204).send('');
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST' });
  try {
    const tok = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
    // App Check: erst nur protokollieren; mit APPCHECK_ENFORCE=1 (Umgebungsvariable) werden Anfragen ohne Nachweis abgelehnt
    const ac = req.get('x-firebase-appcheck'), acOk = ac ? !!(await admin.appCheck().verifyToken(ac).catch(() => null)) : false;
    if (!acOk) { if (process.env.APPCHECK_ENFORCE === '1') return res.status(401).json({ error: 'App Check fehlt' }); console.log('mapLink ohne gültigen App-Check-Nachweis'); }
    const user = await admin.auth().verifyIdToken(tok).catch(() => null);
    if (!user) return res.status(401).json({ error: 'nicht angemeldet' });
    const { url, trip } = req.body || {};
    if (!/^[\w-]{1,80}$/.test(String(trip || ''))) return res.status(400).json({ error: 'trip fehlt' });
    const m = await admin.firestore().doc(`trips/${trip}/members/${user.uid}`).get();
    if (!m.exists) return res.status(403).json({ error: 'kein Zugriff' });
    res.json(await resolveLink(String(url || '').slice(0, 2000)));
  } catch (e) {
    res.status(e.status || 502).json({ error: String(e.message || e).slice(0, 200) });
  }
});

// Claude-Konnektor (MCP-Server), siehe docs/MCP-PLAN.md
exports.mcp = require('./mcp').mcp;
