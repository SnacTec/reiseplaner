/* Seiten der Anmeldung (vom Server ausgeliefert, ohne Skripte). Sicherheits-Header setzt app.js. */
'use strict';
const { esc } = require('./util');

const shell = (title, body) => `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer"><title>${esc(title)}</title><style>
:root{--bg:#f6efe0;--panel:#fff;--ink:#13222c;--muted:#566874;--line:#e6dcc3;--accent:#0b7d96;--danger:#d6452a}
@media (prefers-color-scheme:dark){:root{--bg:#0e1920;--panel:#15242d;--ink:#e5eef2;--muted:#9bb0bc;--line:#26404d;--accent:#4fc0dc;--danger:#ff6a49}}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;display:flex;justify-content:center;padding:24px 16px}
.c{max-width:440px;width:100%;background:var(--panel);border:1px solid var(--line);border-radius:16px;padding:22px}
h1{font-size:20px;margin:0 0 12px}p{margin:0 0 12px}.m{color:var(--muted);font-size:14px}.w{background:color-mix(in srgb,var(--danger) 10%,var(--panel));border-radius:10px;padding:10px 12px;font-size:14px}
ul{padding-left:20px;margin:0 0 12px}fieldset.r{border:1px solid var(--line);border-radius:12px;padding:8px 12px 10px;margin:0 0 12px}legend{font-weight:600;font-size:14px;padding:0 4px}fieldset.r label{display:block;padding:6px 0}fieldset.r small{display:block;color:var(--muted);font-size:13px;margin:2px 0 0 24px}li{margin:2px 0}.b{display:flex;gap:10px;margin-top:16px}
button{font:600 16px system-ui,sans-serif;border-radius:999px;padding:11px 20px;border:1px solid var(--line);background:var(--bg);color:var(--ink);cursor:pointer}
button.p{background:var(--accent);border-color:var(--accent);color:#fff}
</style></head><body><main class="c">${body}</main></body></html>`;

const error = msg => shell('Reiseplaner – Anmeldung', `<h1>Reiseplaner</h1><p>${esc(msg)}</p><p class="m">Du kannst dieses Fenster schließen.</p>`);

const consent = ({ id, csrf, email, client, trip }) => shell('Reiseplaner – Zugriff erlauben', `<h1>Zugriff erlauben?</h1>
<p><b>${esc(client)}</b> möchte auf deinen Reiseplan zugreifen.</p>
<ul><li>Angemeldet als <b>${esc(email)}</b></li><li>Reise: ${esc(trip)} (immer die in der App aktuelle Reise)</li>
<li>Lesen: Tage, Orte, Zeiten, Einträge (mit Notizen), Ausflüge, Abendessen, Tipps, gemeinsame ToDos, Dateinamen der Mappe</li>
<li>Nie: Sitzplätze, Buchungsnummern, Kabinen-/Tischnummer, Adressen, eure Namen und E-Mail-Adressen, Dateiinhalte, private Listen</li></ul>
<form method="post" action="/authorize/complete"><input type="hidden" name="req" value="${esc(id)}"><input type="hidden" name="csrf" value="${esc(csrf)}">
<fieldset class="r"><legend>Was darf Claude?</legend>
<label><input type="radio" name="access" value="read" checked> <b>Nur lesen</b></label>
<label><input type="radio" name="access" value="write"> <b>Lesen und eintragen</b><small>Einträge im Tagesplan anlegen/ändern, gemeinsame ToDos, Abendessen, Ausflugswahl. Jede Änderung ist in der App mit 🤖 markiert und lässt sich rückgängig machen. Nie: Reisen löschen, Stationen, An-/Abreise, Dateien.</small></label></fieldset>
<p class="w">Nur fortfahren, wenn du <b>gerade selbst</b> in Claude auf „Verbinden“ getippt hast.</p>
<p class="m">Was Claude liest, landet in deinem Claude-Verlauf bei Anthropic. Trennen jederzeit in Claude oder in der Reise-App (Einstellungen → Konto).</p>
<div class="b"><button class="p" name="decision" value="allow" type="submit">Erlauben</button><button name="decision" value="deny" type="submit">Ablehnen</button></div></form>`);

module.exports = { error, consent };
