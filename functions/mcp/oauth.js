/* Anmeldung für Claude (OAuth 2.1 mit PKCE), eigener kleiner Autorisierungsserver.
 * Ablauf (Details docs/MCP-PLAN.md, Abschnitt 4.2):
 *  1. GET  /authorize          Claude-Parameter streng prüfen → Anfrage speichern, Browser-Cookie setzen → weiter zu Google
 *  2. GET  /google/callback    Google-Anmeldung prüfen (Freigabeliste, Firebase-Konto, Mitglied der Reise) → Zustimmungsseite
 *  3. POST /authorize/complete Formular „Erlauben/Ablehnen“ (Cookie + CSRF) → Code → 302 zu Claude
 *  4. POST /token              Code → Tokens (PKCE) bzw. Refresh (Rotation, Kulanzfenster, Höchstdauer)
 * Gespeichert werden nur HMAC-Hashes von Codes/Tokens (Schlüssel MCP_PEPPER). */
'use strict';
const C = require('./config');
const U = require('./util');
const P = require('./pages');

const now0 = () => Date.now();
const err = (res, code, error, desc) => res.status(code).set('Cache-Control', 'no-store').json({ error, error_description: desc });

/* einfache Begrenzung je Schlüssel im Arbeitsspeicher der Instanz */
function limiter(max, winMs) {
  const m = new Map();
  return k => {
    const t = Date.now(), a = (m.get(k) || []).filter(x => t - x < winMs);
    if (a.length >= max) { m.set(k, a); return false; }   // über dem Limit nicht weiter anhängen
    a.push(t); m.delete(k); m.set(k, a);
    if (m.size > 5000) m.delete(m.keys().next().value);   // ältesten Schlüssel verdrängen, nicht alle zurücksetzen
    return true;
  };
}

function oauth(deps) {
  const S = deps.store, now = deps.now || now0;
  const H = s => U.hmac(deps.pepper(), s);
  const lim = { auth: limiter(C.LIMITS.authPerHour, 3600e3), reg: limiter(C.LIMITS.registerPerHour, 3600e3), token: limiter(C.LIMITS.authPerHour * 2, 3600e3), bad: limiter(C.LIMITS.badPerHour, 3600e3) };
  const TOK_RE = /^[A-Za-z0-9_-]{43}$/;   // Form unserer Codes/Tokens (rand(32)) – andere gar nicht erst nachschlagen
  const ttl = ms => new Date(now() + ms);   // für die Firestore-TTL-Richtlinie (Feld „ttl“); geprüft wird immer „exp“

  // Zugang: freigegebenes Google-Konto (MCP_ALLOWED_EMAILS) mit Konto in der Reise-App – für alle Reisen (wie die Firestore-Regeln).
  // Es gibt keine „aktive Reise“ mehr; Mitglieder je Reise sind geplant (docs/MCP-PLAN.md 9.9).
  const allowed = email => !!email && deps.allowed().has(String(email).toLowerCase());

  async function client(id) {
    if (id === C.FIXED_CLIENT_ID) return { id, redirect_uris: C.CLAUDE_REDIRECTS };
    if (!/^c_[A-Za-z0-9_-]{20,64}$/.test(String(id || ''))) return null;
    const c = await S.get('mcp_clients/' + id); return c && c.exp > now() ? { id, redirect_uris: c.redirect_uris, exp: c.exp } : null;
  }

  /* ---------- Metadaten ---------- */
  const prm = { resource: C.RESOURCE, authorization_servers: [C.BASE], scopes_supported: ['reise.lesen', 'reise.schreiben'], bearer_methods_supported: ['header'], resource_name: 'Reiseplaner' };
  const asm = {
    issuer: C.BASE, authorization_endpoint: C.BASE + '/authorize', token_endpoint: C.BASE + '/token', registration_endpoint: C.BASE + '/register',
    revocation_endpoint: C.BASE + '/revoke', response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'], revocation_endpoint_auth_methods_supported: ['none'],
    scopes_supported: C.SCOPES, authorization_response_iss_parameter_supported: true, service_documentation: 'https://github.com/SnacTec/reiseplaner/blob/main/docs/MCP-PLAN.md',
  };

  /* ---------- Client-Registrierung (DCR, eingeschränkt: nur Claudes Rücksprungadresse) ---------- */
  async function register(req, res) {
    if (!lim.reg(U.clientIp(req))) return err(res, 429, 'slow_down', 'Zu viele Registrierungen');
    const b = req.body || {}, ru = Array.isArray(b.redirect_uris) ? b.redirect_uris : [];
    if (!ru.length || ru.some(u => !C.CLAUDE_REDIRECTS.includes(u))) return err(res, 400, 'invalid_redirect_uri', 'Nur die Rücksprungadresse von Claude ist erlaubt');
    // andere Client-Authentifizierung wird nicht abgelehnt, sondern durch „none“ ersetzt (RFC 7591, 3.2.1)
    const uris = [...new Set(ru)];
    const act = (await S.list('mcp_clients')).filter(x => x.data && x.data.exp > now());
    if (act.length >= C.LIMITS.maxClients) return err(res, 400, 'invalid_client_metadata', 'Zu viele registrierte Clients');
    // unbenutzte Clients verfallen nach 1 h (sonst ließen sich alle Plätze 90 Tage blockieren); jede Token-Ausgabe verlängert
    const id = 'c_' + U.rand(24), t = now();
    await S.set('mcp_clients/' + id, { redirect_uris: uris, name: U.clean(b.client_name || '', 60), created: t, exp: t + C.TTL.clientUnused, ttl: ttl(C.TTL.clientUnused) });
    res.status(201).set('Cache-Control', 'no-store').json({ client_id: id, client_id_issued_at: Math.floor(t / 1000), redirect_uris: uris, token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] });
  }

  /* ---------- 1. Anmeldestart ---------- */
  async function authorize(req, res) {
    if (!lim.auth(U.clientIp(req))) return res.status(429).send(P.error('Zu viele Versuche. Bitte später erneut.'));
    const q = req.query, one = k => (typeof q[k] === 'string' ? q[k] : undefined);
    const cid = one('client_id'), ru = one('redirect_uri');
    const cl = await client(cid);
    // Ohne gültigen Client und passende Rücksprungadresse niemals weiterleiten (keine offene Weiterleitung)
    if (!cl || !ru || !cl.redirect_uris.includes(ru)) return res.status(400).send(P.error('Unbekannte Anwendung oder Rücksprungadresse.'));
    const back = (e, d) => res.redirect(302, `${ru}?error=${e}&error_description=${encodeURIComponent(d)}&state=${encodeURIComponent(one('state') || '')}&iss=${encodeURIComponent(C.BASE)}`);
    const state = one('state');
    if (!state || state.length > 512 || !/^[\x21-\x7e]+$/.test(state)) return back('invalid_request', 'state fehlt oder ungültig');
    if (one('response_type') !== 'code') return back('unsupported_response_type', 'Nur code');
    const ch = one('code_challenge');
    if (one('code_challenge_method') !== 'S256' || !/^[A-Za-z0-9_-]{43}$/.test(ch || '')) return back('invalid_request', 'PKCE (S256) ist Pflicht');
    const r = one('resource');
    if (r !== undefined && U.canon(r) !== C.RESOURCE) return back('invalid_target', 'Unbekannte Ressource');
    const sc = String(one('scope') || 'reise.lesen').split(/\s+/).filter(Boolean);
    if (sc.some(s => !C.SCOPES.includes(s))) return back('invalid_scope', 'Unbekannter Bereich');
    if (!sc.includes('reise.lesen')) sc.unshift('reise.lesen');
    const id = U.rand(32), nonce = U.rand(16), cookie = U.rand(32), gv = U.rand(48), t = now();
    await S.set('mcp_pending/' + H(id), { client_id: cid, redirect_uri: ru, state, code_challenge: ch, resource: C.RESOURCE, scope: sc.join(' '),
      cookie: H(cookie), nonce, gv, exp: t + C.TTL.pending, ttl: ttl(C.TTL.pending), used: false });
    U.setCookie(res, cookie, Math.round(C.TTL.pending / 1000));
    res.set('Cache-Control', 'no-store').redirect(302, deps.google.authUrl({ state: id, nonce, challenge: U.sha256b64u(gv), redirectUri: C.BASE + '/google/callback' }));
  }

  async function pendingFor(req, id) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(String(id || ''))) return null;
    const p = await S.get('mcp_pending/' + H(id)), ck = U.cookies(req)[U.COOKIE];
    if (!p || p.used || p.exp <= now() || !ck || !U.safeEq(p.cookie, H(ck))) return null;   // an diesen Browser gebunden
    return p;
  }

  /* ---------- 2. Rückkehr von Google ---------- */
  async function googleCallback(req, res) {
    const id = String(req.query.state || ''), p = await pendingFor(req, id);
    if (!p) return res.status(400).send(P.error('Die Anmeldung ist abgelaufen oder wurde in einem anderen Browser gestartet. Bitte in Claude erneut auf „Verbinden“ tippen.'));
    if (req.query.error || !req.query.code) return res.status(400).send(P.error('Die Google-Anmeldung wurde abgebrochen.'));
    let g; try { g = await deps.google.exchange({ code: String(req.query.code), verifier: p.gv, redirectUri: C.BASE + '/google/callback' }); }
    catch (e) { deps.log('google', e && e.message); return res.status(400).send(P.error('Die Google-Anmeldung konnte nicht geprüft werden.')); }
    if (!g || g.nonce !== p.nonce || !g.email_verified || !g.sub) return res.status(400).send(P.error('Die Google-Anmeldung konnte nicht geprüft werden.'));
    const email = String(g.email || '').toLowerCase();
    if (!allowed(email)) return res.status(403).send(P.error('Dieses Google-Konto ist nicht freigegeben.'));
    const u = await deps.users.byGoogle(g.sub, email);
    if (!u || u.disabled) return res.status(403).send(P.error('Zu diesem Google-Konto gibt es kein Konto in der Reise-App. Bitte einmal in der App anmelden.'));
    const csrf = U.rand(32);
    await S.set('mcp_pending/' + H(id), { uid: u.uid, email, authAt: now(), csrf: H(csrf) }, true);
    res.set('Cache-Control', 'no-store').send(P.consent({ id, csrf, email, client: new URL(p.redirect_uri).host }));
  }

  /* ---------- 3. Zustimmung ---------- */
  async function complete(req, res) {
    const b = req.body || {}, id = String(b.req || ''), p = await pendingFor(req, id);
    if (!p || !p.uid) return res.status(400).send(P.error('Die Anmeldung ist abgelaufen. Bitte in Claude erneut auf „Verbinden“ tippen.'));
    if (!b.csrf || !U.safeEq(p.csrf || '', H(String(b.csrf)))) return res.status(400).send(P.error('Ungültige Anfrage.'));
    if (now() - p.authAt > C.TTL.authAge) return res.status(400).send(P.error('Die Google-Anmeldung ist zu lange her. Bitte erneut verbinden.'));
    // Anfrage genau einmal verbrauchen; dabei prüfen, dass sie seit dem Lesen nicht verändert wurde (Konto/CSRF)
    const ok = await S.txn(async t => { const x = await t.get('mcp_pending/' + H(id)); if (!x || x.used || x.uid !== p.uid || x.csrf !== p.csrf || x.authAt !== p.authAt) return false; t.set('mcp_pending/' + H(id), { used: true }, true); return true; });
    if (!ok) return res.status(400).send(P.error('Diese Anmeldung wurde schon verwendet.'));
    U.setCookie(res, '', 0);
    const back = q => res.set('Cache-Control', 'no-store').redirect(302, `${p.redirect_uri}?${q}&state=${encodeURIComponent(p.state)}&iss=${encodeURIComponent(C.BASE)}`);
    if (b.decision !== 'allow') return back('error=access_denied');
    // Bereich nach Wahl auf der Zustimmungsseite (nicht nach Wunsch des Clients): nur lesen oder lesen + eintragen
    const sc = p.scope.split(' ').filter(x => x !== 'reise.schreiben'); if (b.access === 'write') sc.splice(1, 0, 'reise.schreiben');
    const code = U.rand(32), t = now();
    await S.set('mcp_codes/' + H(code), { uid: p.uid, email: p.email, client_id: p.client_id, redirect_uri: p.redirect_uri, code_challenge: p.code_challenge,
      resource: p.resource, scope: sc.join(' '), exp: t + C.TTL.code, ttl: ttl(C.TTL.code), used: false });
    deps.log('verbunden', p.uid.slice(0, 6), b.access === 'write' ? 'schreiben' : 'lesen');
    back('code=' + code);
  }

  /* ---------- Tokens ---------- */
  async function issue(fam, uid, scope) {
    const a = U.rand(32), r = U.rand(32), t = now();
    await S.set('mcp_tokens/' + H(a), { kind: 'access', uid, family: fam, aud: C.RESOURCE, scope, exp: t + C.TTL.access, ttl: ttl(C.TTL.access) });
    await S.set('mcp_tokens/' + H(r), { kind: 'refresh', uid, family: fam, aud: C.RESOURCE, scope, exp: t + C.TTL.refresh, ttl: ttl(C.TTL.refresh) });
    return { access_token: a, token_type: 'Bearer', expires_in: Math.round(C.TTL.access / 1000), refresh_token: r, scope };
  }
  // DCR-Client lebt so lange wie seine Nutzung: jede Token-Ausgabe verlängert auf 90 Tage (höchstens einmal am Tag schreiben)
  async function keepClient(cl) {
    if (cl.id === C.FIXED_CLIENT_ID || cl.exp - now() > C.TTL.client - 864e5) return;
    await S.set('mcp_clients/' + cl.id, { exp: now() + C.TTL.client, ttl: ttl(C.TTL.client), used: true }, true);
  }
  const revokeFamily = (fam, why) => fam && S.set('mcp_families/' + fam, { revoked: true, revokedAt: now(), why }, true);

  async function token(req, res) {
    res.set('Cache-Control', 'no-store').set('Pragma', 'no-cache');
    if (!lim.token(U.clientIp(req))) return err(res, 429, 'slow_down', 'Zu viele Anfragen');
    const b = req.body || {}, s = k => (typeof b[k] === 'string' ? b[k] : undefined);
    const cl = await client(s('client_id'));
    if (!cl) return err(res, 401, 'invalid_client', 'Unbekannter Client');
    if (s('resource') !== undefined && U.canon(s('resource')) !== C.RESOURCE) return err(res, 400, 'invalid_target', 'Unbekannte Ressource');
    if (s('grant_type') === 'authorization_code') {
      const code = s('code'), ver = s('code_verifier');
      if (!code || !ver || !/^[A-Za-z0-9._~-]{43,128}$/.test(ver)) return err(res, 400, 'invalid_request', 'code/code_verifier fehlt');
      const key = 'mcp_codes/' + H(code), fam = 'f_' + U.rand(18);
      const r = await S.txn(async t => {
        const c = await t.get(key); if (!c) return { e: 'invalid_grant' };
        if (c.used) return { e: 'invalid_grant', reuse: c.family };
        // redirect_uri muss passen, wenn sie mitgeschickt wird (Claude/SDK schicken sie immer)
        if (c.exp <= now() || c.client_id !== cl.id || (s('redirect_uri') !== undefined && c.redirect_uri !== s('redirect_uri'))) return { e: 'invalid_grant' };
        if (!U.safeEq(U.sha256b64u(ver), c.code_challenge)) return { e: 'invalid_grant' };
        t.set(key, { used: true, family: fam }, true);
        // Familie in derselben Transaktion anlegen (ein gleichzeitiger Widerruf kann nicht überschrieben werden)
        const t0 = now(); t.set('mcp_families/' + fam, { uid: c.uid, email: c.email, client_id: cl.id, created: t0, lastUsed: t0, maxExp: t0 + C.TTL.family, revoked: false, ttl: ttl(C.TTL.family) });
        return { c };
      });
      if (r.reuse) await revokeFamily(r.reuse, 'code-reuse');   // Code doppelt benutzt → alles daraus widerrufen
      if (r.e) return err(res, 400, r.e, 'Code ungültig, abgelaufen oder schon benutzt');
      await keepClient(cl);
      return res.json(await issue(fam, r.c.uid, r.c.scope));
    }
    if (s('grant_type') === 'refresh_token') {
      const rt = s('refresh_token'); if (!rt) return err(res, 400, 'invalid_request', 'refresh_token fehlt');
      if (!TOK_RE.test(rt)) return err(res, 400, 'invalid_grant', 'Refresh-Token ungültig');
      const key = 'mcp_tokens/' + H(rt);
      const r = await S.txn(async t => {
        const x = await t.get(key); if (!x || x.kind !== 'refresh' || x.exp <= now()) return { e: 1 };
        // alter Refresh-Token wiederverwendet: nach dem Kulanzfenster oder ein zweites Mal → ganze Verbindung widerrufen
        if (x.rotatedAt && (now() - x.rotatedAt > C.TTL.grace || x.graceUsed)) return { e: 1, reuse: x.family };
        t.set(key, x.rotatedAt ? { graceUsed: true } : { rotatedAt: now() }, true);   // Kulanz genau einmal (z. B. Antwort ging verloren)
        return { x };
      });
      if (r.reuse) await revokeFamily(r.reuse, 'refresh-reuse');
      if (r.e) return err(res, 400, 'invalid_grant', 'Refresh-Token ungültig');
      const x = r.x, f = await S.get('mcp_families/' + x.family);
      if (!f || f.revoked || f.maxExp <= now() || f.client_id !== cl.id) return err(res, 400, 'invalid_grant', 'Verbindung beendet – bitte neu verbinden');
      // Freigabe und Konto erneut prüfen (beim Refresh gibt es kein Google-Token)
      const u = await deps.users.get(x.uid);
      if (!allowed(f.email) || !u || u.disabled || (u.validAfter && u.validAfter > f.created)) {
        await revokeFamily(x.family, 'access-removed'); return err(res, 400, 'invalid_grant', 'Zugang nicht mehr freigegeben');
      }
      await keepClient(cl);
      return res.json(await issue(x.family, x.uid, x.scope));
    }
    return err(res, 400, 'unsupported_grant_type', 'Nur authorization_code und refresh_token');
  }

  async function revoke(req, res) {
    if (!lim.bad(U.clientIp(req))) return err(res, 429, 'slow_down', 'Zu viele Anfragen');
    const tk = (req.body || {}).token;
    if (typeof tk === 'string' && TOK_RE.test(tk)) { const x = await S.get('mcp_tokens/' + H(tk)); if (x && x.family) await revokeFamily(x.family, 'revoked'); }
    res.status(200).set('Cache-Control', 'no-store').end();
  }

  /* ---------- Zugriffsprüfung für /mcp ---------- */
  async function verifyAccess(tok) {
    if (!tok || !TOK_RE.test(tok)) return null;
    const x = await S.get('mcp_tokens/' + H(tok));
    if (!x || x.kind !== 'access' || x.exp <= now() || x.aud !== C.RESOURCE) return null;
    const f = await S.get('mcp_families/' + x.family);
    if (!f || f.revoked || f.maxExp <= now()) return null;
    if (now() - (f.lastUsed || 0) > 10 * 60e3) S.set('mcp_families/' + x.family, { lastUsed: now() }, true).catch(() => {});
    return { uid: x.uid, family: x.family, scope: x.scope };
  }

  /* ---------- Für die App: eigene Verbindungen anzeigen und trennen (Firebase-ID-Token) ---------- */
  async function connections(req, res) {
    res.set('Cache-Control', 'no-store');
    const u = await deps.verifyFirebase(String(req.headers.authorization || '').replace(/^Bearer\s+/i, '')).catch(() => null);
    if (!u) return err(res, 401, 'unauthorized', 'nicht angemeldet');
    const L = (await S.where('mcp_families', 'uid', u.uid)).filter(x => !x.data.revoked && x.data.maxExp > now());
    if (req.method === 'POST') {
      const id = (req.body || {}).id, all = (req.body || {}).all === true;
      for (const x of L) if (all || x.id === id) await revokeFamily(x.id, 'app');
      return res.json({ ok: true });
    }
    res.json({ connections: L.map(x => ({ id: x.id, created: x.data.created, lastUsed: x.data.lastUsed })) });
  }

  const badOk = ip => lim.bad(ip);   // Begrenzung für Anfragen mit ungültigem Token (Kosten)
  return { prm, asm, badOk, register, authorize, googleCallback, complete, token, revoke, verifyAccess, connections };
}
module.exports = { oauth };
