/* Einstellungen des MCP-Servers (Claude-Konnektor). Keine Geheimnisse hier – die kommen aus dem Secret Manager:
 *   MCP_PEPPER          langer Zufallswert (Schlüssel für die Token-Hashes; neu setzen = alle Verbindungen sofort ungültig)
 *   MCP_ALLOWED_EMAILS  freigegebene Google-Konten, kommagetrennt (nicht im Repository!)
 *   MCP_GOOGLE_SECRET   Client-Secret des Google-OAuth-Clients für die Anmeldung
 * Nicht geheim (functions/.env): MCP_GOOGLE_CLIENT_ID, optional MCP_BASE_URL, MCP_IP_ENFORCE.
 * Plan und Begründungen: docs/MCP-PLAN.md */
'use strict';
// Feste Adresse der Function (Cloud Run, Projektnummer = messagingSenderId aus firebase-config.js)
const BASE = (process.env.MCP_BASE_URL || 'https://mcp-97052290110.europe-west3.run.app').replace(/\/+$/, '').toLowerCase();
module.exports = {
  BASE,
  RESOURCE: BASE + '/mcp',
  HOST: new URL(BASE).host,
  // Rücksprungadressen von Claude (claude.com ist von Anthropic angekündigt)
  CLAUDE_REDIRECTS: ['https://claude.ai/api/mcp/auth_callback', 'https://claude.com/api/mcp/auth_callback'],
  FIXED_CLIENT_ID: 'reiseplaner-claude',
  SCOPES: ['reise.lesen', 'offline_access'],
  // Lebensdauern in Millisekunden
  TTL: { pending: 10 * 60e3, code: 60e3, access: 3600e3, refresh: 30 * 864e5, family: 90 * 864e5, authAge: 5 * 60e3, grace: 60e3, client: 90 * 864e5, clientUnused: 3600e3 },
  LIMITS: { perHour: 120, perDay: 600, maxClients: 20, registerPerHour: 20, authPerHour: 60, badPerHour: 300 },
  // Ausgehende Adressen von Anthropic (Stand 11/2026, vor Aktivierung prüfen); MCP_IP_ENFORCE=1 sperrt andere, sonst nur Protokoll
  ANTHROPIC_NETS: ['160.79.104.0/21', '153.61.208.0/20'],
  PROTOCOLS: ['2025-11-25', '2025-06-18', '2025-03-26'],
  SERVER: { name: 'reiseplaner', version: '1.0.0' },
};
