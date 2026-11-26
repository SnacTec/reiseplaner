/* MCP-Server (Claude-Konnektor) als Express-App. Wird in functions/index.js als Function „mcp“ bereitgestellt.
 * Protokoll: Streamable HTTP, zustandslos, JSON-Antworten (MCP 2025-03-26 … 2025-11-25). Nur Werkzeuge (tools).
 * Abhängigkeiten werden übergeben (deps), damit alles ohne Firebase getestet werden kann (functions/test/mcp.test.js). */
'use strict';
const express = require('express');
const C = require('./config');
const U = require('./util');
const { oauth } = require('./oauth');
const { reader } = require('./data');
const { TOOLS, ctxOf, checkArgs } = require('./tools');

function createApp(deps) {
  const log = deps.log || ((...a) => console.log('mcp', ...a));
  deps.log = log;
  const O = oauth(deps), R = reader(deps.store), now = deps.now || Date.now;
  const app = express();
  app.disable('x-powered-by'); app.set('trust proxy', false);
  // Grundschutz: nur unser Host, Sicherheits-Header, Not-Aus
  let ctl = { at: 0, on: true };
  app.use(async (req, res, next) => {
    res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https://claude.ai; frame-ancestors 'none'; base-uri 'none'",
      'Strict-Transport-Security': 'max-age=31536000' });
    if (!deps.testHost && String(req.headers.host || '').toLowerCase() !== C.HOST) return res.status(421).json({ error: 'falscher Host' });
    if (process.env.MCP_ENABLED === '0') return res.status(503).json({ error: 'abgeschaltet' });
    if (Math.abs((deps.ctlNow || Date.now)() - ctl.at) > 30e3) { const s = await deps.store.get('mcp_ctl/state').catch(() => null); ctl = { at: (deps.ctlNow || Date.now)(), on: !(s && s.enabled === false) }; }
    if (!ctl.on) return res.status(503).json({ error: 'abgeschaltet' });
    next();
  });
  const small = { limit: '32kb' };
  const anthropicOnly = (req, res, next) => {
    const ip = U.clientIp(req), ok = C.ANTHROPIC_NETS.some(n => U.inCidr(ip, n));
    if (!ok) { if (process.env.MCP_IP_ENFORCE === '1') return res.status(403).json({ error: 'nicht erlaubt' }); log('ip-fremd', ip.replace(/\.\d+$/, '.x')); }
    next();
  };
  const json = (res, o) => res.set('Cache-Control', 'no-store').json(o);

  /* Metadaten (RFC 9728 / RFC 8414) */
  app.get(['/.well-known/oauth-protected-resource/mcp', '/.well-known/oauth-protected-resource'], (req, res) => json(res, O.prm));
  app.get('/.well-known/oauth-authorization-server', (req, res) => json(res, O.asm));
  app.post('/register', express.json(small), (req, res) => O.register(req, res).catch(e => fail(res, e)));
  app.get('/authorize', (req, res) => O.authorize(req, res).catch(e => fail(res, e)));
  app.get('/google/callback', (req, res) => O.googleCallback(req, res).catch(e => fail(res, e)));
  app.post('/authorize/complete', express.urlencoded({ extended: false, ...small }), (req, res) => O.complete(req, res).catch(e => fail(res, e)));
  app.post('/token', anthropicOnly, express.urlencoded({ extended: false, ...small }), express.json(small), (req, res) => O.token(req, res).catch(e => fail(res, e)));
  app.post('/revoke', express.urlencoded({ extended: false, ...small }), express.json(small), (req, res) => O.revoke(req, res).catch(e => fail(res, e)));
  // für die Reise-App (Einstellungen → Konto): eigene Verbindungen anzeigen/trennen
  const cors = (req, res, next) => { if (req.headers.origin === 'https://snactec.github.io') res.set({ 'Access-Control-Allow-Origin': 'https://snactec.github.io', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Allow-Methods': 'GET, POST', Vary: 'Origin' }); if (req.method === 'OPTIONS') return res.status(204).end(); next(); };
  app.options('/connections', cors);
  app.all('/connections', cors, express.json(small), (req, res) => O.connections(req, res).catch(e => fail(res, e)));

  /* ---------- MCP ---------- */
  const unauth = (res, bad) => res.status(401).set('WWW-Authenticate', `Bearer resource_metadata="${C.BASE}/.well-known/oauth-protected-resource/mcp", scope="reise.lesen"${bad ? ', error="invalid_token"' : ''}`).json({ error: 'unauthorized' });
  const hours = new Map();
  app.get('/mcp', (req, res) => res.status(405).set('Allow', 'POST').end());
  app.delete('/mcp', (req, res) => res.status(405).set('Allow', 'POST').end());
  app.post('/mcp', anthropicOnly, express.json({ limit: '64kb' }), async (req, res) => {
    try {
      const tok = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      if (!tok) return unauth(res, false);
      const who = await O.verifyAccess(tok); if (!who) return unauth(res, true);
      const msgs = Array.isArray(req.body) ? req.body : [req.body], out = [];
      for (const m of msgs) { const r = await handle(m, who); if (r) out.push(r); }
      if (!out.length) return res.status(202).end();
      res.set('Cache-Control', 'no-store').json(Array.isArray(req.body) ? out : out[0]);
    } catch (e) { fail(res, e); }
  });

  async function handle(m, who) {
    if (!m || m.jsonrpc !== '2.0' || typeof m.method !== 'string') return m && m.id != null ? rpcErr(m.id, -32600, 'Ungültige Anfrage') : null;
    if (m.id == null) return null;   // Benachrichtigung (z. B. notifications/initialized)
    const id = m.id, p = m.params || {};
    switch (m.method) {
      case 'initialize': { const v = C.PROTOCOLS.includes(p.protocolVersion) ? p.protocolVersion : C.PROTOCOLS[0];
        return ok(id, { protocolVersion: v, capabilities: { tools: { listChanged: false } }, serverInfo: { ...C.SERVER, title: 'Reiseplaner' } }); }
      case 'ping': return ok(id, {});
      case 'tools/list': return ok(id, { tools: TOOLS.map(t => ({ name: t.name, title: t.title, description: t.description, inputSchema: t.inputSchema, annotations: { title: t.title, readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } })) });
      case 'tools/call': {
        const t = TOOLS.find(x => x.name === p.name); if (!t) return rpcErr(id, -32602, 'Unbekanntes Werkzeug');
        const bad = checkArgs(t, p.arguments); if (bad) return ok(id, { content: [{ type: 'text', text: bad }], isError: true });
        if (!rate(who.uid)) return ok(id, { content: [{ type: 'text', text: 'Zu viele Anfragen – bitte etwas später erneut.' }], isError: true });
        const trip = await O.activeTrip();
        if (!await O.isMember(trip, who.uid)) return ok(id, { content: [{ type: 'text', text: 'Kein Zugriff auf die aktuelle Reise.' }], isError: true });
        const v = await R.load(trip), X = ctxOf(v, now()), t0 = Date.now();
        let text; try { text = t.run(v, X, p.arguments || {}); } catch (e) { log('werkzeug-fehler', t.name, e && e.message); return ok(id, { content: [{ type: 'text', text: 'Interner Fehler beim Lesen des Reiseplans.' }], isError: true }); }
        log('werkzeug', t.name, who.uid.slice(0, 6), Date.now() - t0 + 'ms');
        deps.store.incr('mcp_rate/' + who.uid + '_' + new Date(now()).toISOString().slice(0, 10), 'n', 1).catch(() => {});
        return ok(id, { content: [{ type: 'text', text: text.slice(0, 20000) }], isError: false });
      }
      default: return rpcErr(id, -32601, 'Methode nicht unterstützt');
    }
  }
  const ok = (id, result) => ({ jsonrpc: '2.0', id, result });
  const rpcErr = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });
  function rate(uid) {   // je Instanz: Stunde und Tag
    const t = now(), a = (hours.get(uid) || []).filter(x => t - x < 864e5); a.push(t); hours.set(uid, a);
    return a.filter(x => t - x < 3600e3).length <= C.LIMITS.perHour && a.length <= C.LIMITS.perDay;
  }
  // Fehler protokollieren ohne Anfrage-Inhalte (Codes, Tokens)
  function fail(res, e) { log('fehler', String(e && e.message || e).slice(0, 200)); if (!res.headersSent) res.status(500).json({ error: 'server_error' }); }
  app.use((req, res) => res.status(404).json({ error: 'not_found' }));
  // z. B. ungültiges JSON oder zu große Anfrage: knappe Antwort ohne Details
  app.use((e, req, res, next) => { if (res.headersSent) return next(e); res.status(e.status && e.status < 500 ? e.status : 500).json({ error: e.status && e.status < 500 ? 'invalid_request' : 'server_error' }); });
  return app;
}
module.exports = { createApp };
