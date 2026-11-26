/* Firebase-Function „mcp“: verbindet Firestore, Firebase Auth, Google-Anmeldung und Secrets mit der App (app.js). */
'use strict';
process.env.TZ = 'Europe/Berlin';   // „heute“ außerhalb der Reise wie in Deutschland
const { onRequest } = require('firebase-functions/v2/https');
const { defineSecret, defineString } = require('firebase-functions/params');
const admin = require('firebase-admin');
const { OAuth2Client } = require('google-auth-library');
const { firestoreStore } = require('./store');
const { createApp } = require('./app');

const PEPPER = defineSecret('MCP_PEPPER'), ALLOWED = defineSecret('MCP_ALLOWED_EMAILS'), GSECRET = defineSecret('MCP_GOOGLE_SECRET');
// Client-ID des Google-OAuth-Clients (nicht geheim): beim ersten Hochladen fragt die Firebase-CLI danach und merkt sie sich
const GCLIENT = defineString('MCP_GOOGLE_CLIENT_ID', { description: 'Client-ID des Google-OAuth-Clients „Reiseplaner Claude-Konnektor“' });
let app = null;
function build() {
  if (!admin.apps.length) admin.initializeApp();
  const db = admin.firestore(), gid = GCLIENT.value(), g = new OAuth2Client(gid);
  if (!/\.apps\.googleusercontent\.com$/.test(gid)) throw new Error('MCP_GOOGLE_CLIENT_ID fehlt oder ist ungültig');
  const allowed = new Set(String(process.env.MCP_ALLOWED_EMAILS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean));
  return createApp({
    store: firestoreStore(db, admin),
    pepper: () => { const p = process.env.MCP_PEPPER || ''; if (p.length < 32) throw new Error('MCP_PEPPER fehlt'); return p; },
    allowed: () => allowed,
    google: {
      authUrl: ({ state, nonce, challenge, redirectUri }) => 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({ client_id: gid, redirect_uri: redirectUri, response_type: 'code', scope: 'openid email', state, nonce, code_challenge: challenge, code_challenge_method: 'S256', prompt: 'select_account' }),
      async exchange({ code, verifier, redirectUri }) {
        const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ code, code_verifier: verifier, client_id: gid, client_secret: process.env.MCP_GOOGLE_SECRET || '', redirect_uri: redirectUri, grant_type: 'authorization_code' }) });
        if (!r.ok) throw new Error('Google-Token ' + r.status);
        const j = await r.json(), t = await g.verifyIdToken({ idToken: j.id_token, audience: gid }), c = t.getPayload();
        return { sub: c.sub, email: c.email, email_verified: c.email_verified === true, nonce: c.nonce };
      },
    },
    users: {
      async byGoogle(sub, email) { const u = await admin.auth().getUserByProviderUid('google.com', sub).catch(() => null) || await admin.auth().getUserByEmail(email).catch(() => null); return u && { uid: u.uid, disabled: u.disabled, validAfter: u.tokensValidAfterTime ? Date.parse(u.tokensValidAfterTime) : 0 }; },
      async get(uid) { const u = await admin.auth().getUser(uid).catch(() => null); return u && { uid: u.uid, disabled: u.disabled, validAfter: u.tokensValidAfterTime ? Date.parse(u.tokensValidAfterTime) : 0 }; },
    },
    verifyFirebase: async t => { const d = await admin.auth().verifyIdToken(t, true); return { uid: d.uid }; },
  });
}
exports.mcp = onRequest({ region: 'europe-west3', memory: '512MiB', maxInstances: 2, timeoutSeconds: 30, concurrency: 20, invoker: 'public', secrets: [PEPPER, ALLOWED, GSECRET] },
  (req, res) => { if (!app) app = build(); return app(req, res); });
