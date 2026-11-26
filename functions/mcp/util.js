/* Hilfsfunktionen: Zufallswerte, Hashes, Cookies, IP-Bereiche, Texte säubern. */
'use strict';
const crypto = require('crypto');

const rand = (n = 32) => crypto.randomBytes(n).toString('base64url');
const sha256b64u = s => crypto.createHash('sha256').update(s).digest('base64url');
// Token/Code/Kennungen werden nur als HMAC gespeichert (Schlüssel = MCP_PEPPER)
const hmac = (pepper, s) => crypto.createHmac('sha256', pepper).update(String(s)).digest('hex');
const safeEq = (a, b) => { a = Buffer.from(String(a)); b = Buffer.from(String(b)); return a.length === b.length && crypto.timingSafeEqual(a, b); };

function cookies(req) {
  const o = {}; String(req.headers.cookie || '').split(';').forEach(c => { const i = c.indexOf('='); if (i > 0) o[c.slice(0, i).trim()] = decodeURIComponent(c.slice(i + 1).trim()); });
  return o;
}
const COOKIE = '__Host-mcp_req';
const setCookie = (res, v, maxAgeS) => res.append('Set-Cookie', `${COOKIE}=${encodeURIComponent(v)}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${maxAgeS}`);

/* IPv4 in CIDR (IPv6-Absender passen nie – vor MCP_IP_ENFORCE=1 im Protokoll prüfen) */
function inCidr(ip, cidr) {
  const [net, bits] = cidr.split('/'), toN = a => a.split('.').reduce((n, x) => (n << 8) + (+x), 0) >>> 0;
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(ip)) return false;
  const m = bits === '0' ? 0 : (~0 << (32 - +bits)) >>> 0; return (toN(ip) & m) === (toN(net) & m);
}
/* Absender-IP: Cloud Run hängt die echte Adresse hinten an X-Forwarded-For an (vorne kann der Absender selbst etwas eintragen).
 * Annahme gilt für die direkte run.app-Adresse ohne Load Balancer; vor MCP_IP_ENFORCE=1 im Protokoll prüfen. */
function clientIp(req) {
  const x = String(req.headers['x-forwarded-for'] || '').split(',').map(s => s.trim()).filter(Boolean);
  const ip = x.length ? x[x.length - 1] : (req.socket && req.socket.remoteAddress) || '';
  return ip.replace(/^::ffff:/, '');
}

/* Text aus den Reisedaten für die KI: Steuerzeichen raus, Länge begrenzen */
const clean = (s, n = 200) => { s = String(s == null ? '' : s).replace(/[\u0000-\u0008\u000b-\u001f\u007f\u00ad\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff\u{E0000}-\u{E007F}]/gu, '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const canon = u => String(u || '').trim().toLowerCase().replace(/\/+$/, '');

module.exports = { rand, sha256b64u, hmac, safeEq, cookies, COOKIE, setCookie, inCidr, clientIp, clean, esc, canon };
