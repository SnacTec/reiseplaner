/* Reise-Assistent: neue Reise in drei Schritten anlegen (Grunddaten → Stationen → fertig).
   Wird erst beim Öffnen geladen (wizOpen in app.js) und nutzt die Hilfsfunktionen der App.
   Der halbfertige Stand liegt auf dem Gerät (rp-wiz), damit nichts verloren geht. */
(function () {
  const KINDS = [['kreuzfahrt', '🚢', 'Kreuzfahrt'], ['roadtrip', '🚗', 'Roadtrip'], ['staedtereise', '🏙', 'Städtereise'], ['rundreise', '🧳', 'Rundreise']];
  const ARR = [['plane', '✈️ Flugzeug'], ['car', '🚗 Auto'], ['train', '🚆 Zug'], ['bus', '🚌 Bus'], ['none', '– keine Anreise zeigen']];
  const VEH = [['ship', '🚢 Schiff'], ['car', '🚗 Auto'], ['camper', '🚐 Wohnmobil'], ['train', '🚆 Zug'], ['bus', '🚌 Bus'], ['suitcase', '🧳 Koffer']];
  const defVeh = k => k === 'kreuzfahrt' ? 'ship' : k === 'roadtrip' ? 'car' : 'suitcase';
  const KEY = 'rp-wiz', MAXD = 60;
  let W = null, WORLD = null;
  const load = () => { try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) { return null; } };
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(W)); } catch (e) {} };
  const addD = (s, n) => { const d = new Date(s + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const nDays = () => W.start && W.end && W.end >= W.start ? Math.round((new Date(W.end + 'T12:00:00Z') - new Date(W.start + 'T12:00:00Z')) / 864e5) + 1 : 0;
  const cruise = () => W.kind === 'kreuzfahrt';
  const wd = s => new Date(s + 'T12:00:00Z').toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit', timeZone: 'UTC' }).replace('.,', '.');
  function syncDays() { const n = Math.min(MAXD, nDays()), old = W.days || []; W.days = []; for (let i = 0; i < n; i++) W.days.push({ ...(old[i] || {}), date: addD(W.start, i) }); }
  function kindOf(i) { const d = W.days[i]; if (!cruise()) return 'port'; if (i === 0) return 'start'; if (i === W.days.length - 1) return 'end'; return d.sea ? 'sea' : 'port'; }
  const ready = i => kindOf(i) === 'sea' || W.days[i].lat != null;
  function label(i) {
    const d = W.days[i], k = kindOf(i);
    if (k === 'sea') return ['🌊', 'Seetag', ''];
    if (d.lat == null) return ['❔', 'noch offen', 'Ort festlegen', 1];
    const ic = k === 'start' ? '🚢' : k === 'end' ? '🏁' : cruise() ? '⚓' : d.same ? '↺' : '📍';
    const sub = k === 'start' ? 'Einschiffung' : k === 'end' ? 'Ausschiffung' : cruise() ? (d.t1 && d.t2 ? d.t1 + '–' + d.t2 : 'Liegezeit noch offen') : d.same ? 'wie Vortag' : 'Übernachtung';
    return [ic, d.name, sub + (d.land ? ' · ' + d.land : '')];
  }
  const steps = (n, t) => `<div class="wzst">${[1, 2, 3].map(i => `<i class="${i <= n ? 'on' : ''}"></i>`).join('')}</div><p class="src" style="margin:0 0 12px">Schritt ${n} von 3 · ${t}</p>`;
  const page = (html, bind) => { openSheet(`<div class="hd"><h3 style="margin:0">Neue Reise</h3><button class="x" data-close aria-label="Schließen">✕</button></div>` + html, bind); asPage(); };

  /* Schritt 1: Grunddaten */
  function step1() {
    page(steps(1, 'Grunddaten') + `<form class="sform" id="wz1" style="margin-top:0">
      <label>Titel<input name="title" maxlength="60" required value="${esc(W.title || '')}" placeholder="z. B. Kalifornien-Roadtrip"></label>
      <label>Art der Reise</label><div class="wzch" role="group" aria-label="Art der Reise">${KINDS.map(([k, i, n]) => `<button type="button" class="chip" data-k="${k}" aria-pressed="${W.kind === k}">${i} ${n}</button>`).join('')}</div>
      <div class="two"><label>Erster Tag<input type="date" name="start" required value="${esc(W.start || '')}"></label><label>Letzter Tag<input type="date" name="end" required value="${esc(W.end || '')}"></label></div>
      <p class="src" id="wzn" style="margin:-4px 0 0"></p>
      <label id="wzop" style="${cruise() ? '' : 'display:none'}">Veranstalter / Reederei (optional)<input name="operator" maxlength="30" value="${esc(W.operator || '')}" placeholder="z. B. AIDA, TUI Cruises"></label>
      <label>Anreise<select name="arrival">${ARR.map(([k, n]) => `<option value="${k}" ${W.arrival === k ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
      <label>Unterwegs mit<select name="vehicle">${VEH.map(([k, n]) => `<option value="${k}" ${W.vehicle === k ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
      <p class="src bad" id="wzm" style="margin:0"></p>
      <div class="btns bar"><button class="chip btn" type="submit">Weiter ›</button><button class="chip" type="button" data-close>Abbrechen</button></div></form>`, d => {
      const f = d.querySelector('#wz1'), n = d.querySelector('#wzn');
      const upd = () => { W.title = f.title.value.trim(); W.start = f.start.value; W.end = f.end.value; W.operator = f.operator.value.trim(); W.arrival = f.arrival.value; W.vehicle = f.vehicle.value;
        const k = nDays(); n.textContent = k ? (k > MAXD ? `Höchstens ${MAXD} Tage.` : `${k} Tage. Die Tage legt die App im nächsten Schritt an.`) : ''; save(); };
      f.addEventListener('input', upd); f.addEventListener('change', upd); upd();
      d.querySelectorAll('[data-k]').forEach(b => b.onclick = () => { const was = W.kind; W.kind = b.dataset.k; if (f.vehicle.value === defVeh(was)) f.vehicle.value = defVeh(W.kind);
        d.querySelectorAll('[data-k]').forEach(x => x.setAttribute('aria-pressed', x === b)); d.querySelector('#wzop').style.display = cruise() ? '' : 'none'; upd(); });
      f.onsubmit = ev => { ev.preventDefault(); upd(); const m = d.querySelector('#wzm');
        if (!W.title) return m.textContent = 'Bitte einen Titel eingeben.';
        if (!W.kind) return m.textContent = 'Bitte die Art der Reise wählen.';
        if (!nDays()) return m.textContent = 'Bitte ersten und letzten Tag prüfen.';
        if (nDays() > MAXD) return m.textContent = `Höchstens ${MAXD} Tage.`;
        syncDays(); save(); subOpen(step1, step2); };
    });
  }

  /* Schritt 2: Stationen */
  function step2() {
    const open = W.days.filter((d, i) => !ready(i)).length;
    page(steps(2, 'Stationen') + `<p class="src" style="margin:0 0 6px">Tag antippen, um den Ort festzulegen.${cruise() ? ' Seetage einfach als „Seetag“ markieren.' : ' „Wie Vortag“ für mehrere Nächte am selben Ort.'}</p>
      <div class="wzdays">${W.days.map((d, i) => { const [ic, nm, sub, warn] = label(i);
        return `<button type="button" class="wzday" data-d="${i}"><span class="wzt">Tag ${i + 1}<small>${esc(wd(d.date))}</small></span><span class="wzn"><b>${ic} ${esc(nm)}</b>${sub ? `<small class="${warn ? 'warn' : ''}">${esc(sub)}</small>` : ''}</span><span class="wzgo">›</span></button>`; }).join('')}</div>
      <p class="src ${open ? 'bad' : ''}" style="margin:10px 0 0">${open ? `Noch ${open} ${open > 1 ? 'Tage' : 'Tag'} ohne Ort.` : 'Alle Tage haben einen Ort.'}</p>
      <div class="btns bar"><button class="chip btn" id="wznx" ${open ? 'disabled' : ''}>Weiter ›</button><button class="chip" id="wzbk">‹ Zurück</button></div>`, d => {
      d.querySelectorAll('[data-d]').forEach(b => b.onclick = () => subOpen(step2, () => dayPage(+b.dataset.d)));
      d.querySelector('#wznx').onclick = () => subOpen(step2, step3);
      d.querySelector('#wzbk').onclick = () => history.back();
    });
  }

  /* Ein Tag: Art, Ort, Zeiten */
  function dayPage(i, draft) {
    const t = draft || { ...W.days[i] }, k0 = kindOf(i), prev = (() => { for (let j = i - 1; j >= 0; j--) if (W.days[j].lat != null) return W.days[j]; return null; })();
    let res = [], tmr = 0;
    const kinds = cruise() ? (k0 === 'start' || k0 === 'end' ? [] : [['port', '⚓ Hafen'], ['sea', '🌊 Seetag']]) : (prev ? [['port', '📍 Station'], ['same', '↺ Wie Vortag']] : []);
    const cur = () => t.sea ? 'sea' : t.same ? 'same' : 'port';
    openSheet(`<div class="hd"><h3 style="margin:0">Tag ${i + 1} · ${esc(wd(t.date))}<small class="hds">${k0 === 'start' ? 'Einschiffung' : k0 === 'end' ? 'Ausschiffung' : esc(W.title)}</small></h3><button class="x" data-close aria-label="Zurück">✕</button></div>
      <form class="sform" id="wzd" style="margin-top:0">
      ${kinds.length ? `<label>Was ist an diesem Tag?</label><div class="wzch">${kinds.map(([k, n]) => `<button type="button" class="chip" data-kk="${k}" aria-pressed="${cur() === k}">${n}</button>`).join('')}</div>` : ''}
      <div id="wzpl"><label>${cruise() ? 'Hafen' : 'Ort'}</label><div class="sfield" style="margin:4px 0 0"><svg class="sfi" viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg><input id="wzq" type="search" autocomplete="off" placeholder="Ort suchen" value="${esc(t.name || '')}"></div>
        <div id="wzsel"></div><div id="wzres"></div><div class="acts" style="margin:6px 0 0"><button type="button" class="lnk" id="wzpick">📍 Auf der Karte wählen</button></div></div>
      <div class="two" id="wztm" style="${cruise() && k0 === 'port' && !t.sea ? '' : 'display:none'}"><label>Ankunft<input type="time" name="t1" value="${esc(t.t1 || '')}"></label><label>Ablegen<input type="time" name="t2" value="${esc(t.t2 || '')}"></label></div>
      ${cruise() && (k0 === 'start' || k0 === 'end') ? embFormHTML(k0, t.emb) : ''}
      <label>Notiz (optional)<input name="note" maxlength="160" value="${esc(t.note || '')}" placeholder="${cruise() ? 'z. B. Tenderhafen' : 'z. B. Hotel, Campingplatz'}"></label>
      <p class="src bad" id="wzm" style="margin:0"></p>
      <div class="btns bar"><button class="chip btn" type="submit">Übernehmen</button><button class="chip" type="button" id="wzx">Abbrechen</button></div></form>`, d => {
      asPage();
      const f = d.querySelector('#wzd'), q = d.querySelector('#wzq'), rs = d.querySelector('#wzres'), sl = d.querySelector('#wzsel'), pl = d.querySelector('#wzpl');
      const draw = () => {
        pl.style.display = t.sea || t.same ? 'none' : ''; d.querySelector('#wztm').style.display = cruise() && k0 === 'port' && !t.sea ? '' : 'none';
        sl.innerHTML = !t.same && t.lat != null ? `<p class="src" style="margin:6px 0 0">📍 <b>${esc(t.name)}</b>${t.land ? ' · ' + esc(t.land) : ''} ✓</p>` : '';
        rs.innerHTML = res.msg ? `<p class="src" style="margin:6px 0 0">${esc(res.msg)}</p>` : res.map((x, j) => `<button type="button" class="plres" data-r="${j}"><b>${esc(x.name)}</b><small>${esc(x.addr)}</small></button>`).join('');
        rs.querySelectorAll('[data-r]').forEach(b => b.onclick = () => { const x = res[+b.dataset.r]; Object.assign(t, { name: x.name, lat: x.lat, lon: x.lon, land: x.country || '', same: false, sea: false }); q.value = x.name; res = []; draw(); });
        const sm = d.querySelector('#wzsame'); if (sm) sm.remove();
        if (t.same && prev) pl.insertAdjacentHTML('afterend', `<p class="src" id="wzsame" style="margin:0">↺ Gleicher Ort wie am Vortag: <b>${esc(prev.name)}</b></p>`);
      };
      const find = async () => { const v = q.value.trim(); if (v.length < 3) { res = []; draw(); return; }
        res = await placeSearchAny(v, prev && prev.lat != null ? prev : null);
        if (!res.length && !res.msg) res.msg = res.offline ? 'Offline-Suche kennt nur Städte und Orte. Fehlt er? „Auf der Karte wählen“.' : 'Nichts gefunden – anders schreiben (z. B. mit Land).';
        draw(); if (res.offline && res.length) rs.insertAdjacentHTML('afterbegin', '<p class="src" style="margin:6px 0 0">📴 Offline-Suche (Ortsliste von GeoNames): nur Städte und Orte</p>'); };
      q.oninput = () => { clearTimeout(tmr); tmr = setTimeout(find, 450); };
      d.querySelectorAll('[data-kk]').forEach(b => b.onclick = () => { const k = b.dataset.kk; t.sea = k === 'sea'; t.same = k === 'same';
        if (t.same && prev) Object.assign(t, { name: prev.name, lat: prev.lat, lon: prev.lon, land: prev.land });
        d.querySelectorAll('[data-kk]').forEach(x => x.setAttribute('aria-pressed', x === b)); draw(); });
      draw(); if (!t.name && !t.sea && !t.same) setTimeout(() => q.focus(), 120);
      d.querySelector('#wzx').onclick = () => history.back();
      d.querySelector('#wzpick').onclick = () => { t.note = f.note.value.trim(); if (f.t1) { t.t1 = f.t1.value; t.t2 = f.t2.value; }
        subOpen(() => dayPage(i, t), () => pickOnMap(t.lat != null ? t : prev, r => Object.assign(t, { name: r.name, lat: r.lat, lon: r.lon, land: r.country || '', same: false, sea: false }))); };
      f.onsubmit = ev => { ev.preventDefault(); t.t1 = f.t1.value; t.t2 = f.t2.value; t.note = f.note.value.trim(); { const em = embRead(f, k0); if (em !== undefined) { if (em) t.emb = em; else delete t.emb; } }
        if (!t.sea && t.lat == null) return d.querySelector('#wzm').textContent = 'Bitte einen Ort aus der Liste wählen.';
        if (t.sea) { delete t.lat; delete t.lon; delete t.name; delete t.land; }
        W.days[i] = t; save(); history.back(); };
    });
  }

  /* Schritt 3: Vorschau und anlegen */
  async function world() { if (WORLD) return WORLD;
    if (!window.RP_MAPGEN) await new Promise((ok, no) => { const s = document.createElement('script'); s.src = 'mapgen.js'; s.onload = ok; s.onerror = no; document.head.appendChild(s); });
    WORLD = await (await fetch('world.json')).json(); return WORLD; }
  function draftPorts() {
    return W.days.map((d, i) => { const k = kindOf(i), p = { day: i + 1, date: d.date, kind: k, name: k === 'sea' ? 'Seetag' : d.name, land: k === 'sea' ? '' : d.land || '',
      times: k === 'port' && cruise() ? (d.t1 && d.t2 ? d.t1 + '–' + d.t2 : '') : k === 'start' ? 'Einschiffung' : k === 'end' ? 'Rückkehr' : '',
      text: d.note || (k === 'sea' ? 'Seetag.' : ''), pois: [], ex: [], tips: [], tr: [] };
      if (d.emb && (k === 'start' || k === 'end')) p.emb = d.emb;
      if (k !== 'sea') { p.lat = d.lat; p.lon = d.lon; } return p; });
  }
  async function previewSvg(el) {
    try { const wdat = await world(), D = { ports: draftPorts() }; RP_MAPGEN(D, wdat); const m = D.maps.ov, P = D.ports.filter(p => p.ox != null);
      let route = ''; P.forEach((p, i) => { route += (i ? 'L' : 'M') + p.ox + ',' + p.oy; });
      const grp = []; P.forEach(p => { const g = grp.find(x => Math.hypot(x.ox - p.ox, x.oy - p.oy) < 4); if (g) g.d.push(p.day); else grp.push({ ox: p.ox, oy: p.oy, d: [p.day] }); });
      const r = m.W / 70;
      el.innerHTML = `<svg viewBox="0 0 ${m.W} ${m.H}" style="display:block;width:100%;height:240px;background:var(--sea)" aria-label="Vorschau der Strecke"><path d="${m.land}" class="land"/>
        <path d="${route}" fill="none" stroke="#d9604a" stroke-width="${r / 3}" stroke-dasharray="${r} ${r * 0.8}"/>
        ${grp.map(g => `<circle cx="${g.ox}" cy="${g.oy}" r="${r}" fill="#1f8a4c" stroke="#fff" stroke-width="${r / 4}"/><text x="${g.ox}" y="${g.oy}" dy="0.35em" text-anchor="middle" fill="#fff" font-size="${r * 1.05}" font-weight="700">${g.d[0]}</text>`).join('')}</svg>`;
    } catch (e) { el.innerHTML = '<p class="src" style="padding:12px">Kartenvorschau gerade nicht möglich.</p>'; }
  }
  function step3() {
    const P = draftPorts(), st = new Set(P.filter(p => p.kind !== 'sea').map(p => p.name)).size, sea = P.filter(p => p.kind === 'sea').length;
    page(steps(3, 'Fertig') + `<div class="wzmap" id="wzmap"><p class="src" style="padding:12px">Karte wird erstellt …</p></div>
      <p style="margin:0 0 4px;font:700 17px var(--head)">${esc(W.title)}</p>
      <p class="src" style="margin:0 0 10px">${esc(fmtD(W.start))} – ${esc(fmtD(W.end))} · ${P.length} Tage · ${st} ${cruise() ? (st > 1 ? 'Häfen' : 'Hafen') : (st > 1 ? 'Orte' : 'Ort')}${sea ? ' · ' + sea + ' ' + (sea > 1 ? 'Seetage' : 'Seetag') : ''}</p>
      <ul class="tips" style="margin:0 0 10px"><li>Karte und Route erstellt die App automatisch (auch offline).</li><li>Zeitzone und Wetter ergeben sich aus den Orten.</li><li>Tipps, Ausflüge und Quiz kann man später ergänzen.</li></ul>
      <label class="osmsw" style="margin:0 0 10px"><input type="checkbox" id="wzopen" checked> Danach auf diesem Gerät öffnen</label>
      <p class="src" id="wzm" style="margin:0"></p>
      <div class="btns bar"><button class="chip btn" id="wzgo">Reise anlegen</button><button class="chip" id="wzbk">‹ Zurück</button></div>`, d => {
      previewSvg(d.querySelector('#wzmap'));
      d.querySelector('#wzbk').onclick = () => history.back();
      d.querySelector('#wzgo').onclick = async () => { const b = d.querySelector('#wzgo'), m = d.querySelector('#wzm'); b.disabled = true;
        try { m.className = 'src'; m.textContent = 'Wird vorbereitet …'; const o = await build(P); m.textContent = 'Reise wird angelegt …';
          const how = await window.__createTrip(o, d.querySelector('#wzopen').checked);
          if (how === 'offline') infoToast('Ohne Internet angelegt – wird automatisch hochgeladen, sobald Netz da ist.', 'OK', () => {}); try { localStorage.removeItem(KEY); } catch (e) {}
          if (d.querySelector('#wzopen').checked) { m.textContent = 'Fertig, wird geöffnet …'; setTimeout(() => location.reload(), 500); }
          else { closeDlg(); infoToast(`Reise „${W.title}“ angelegt. Zu finden unter Einstellungen → Reisen.`, 'OK', () => {}); }
        } catch (e) { b.disabled = false; m.className = 'src bad'; m.textContent = 'Fehler: ' + (e.message || e.code || e); } };
    });
  }
  const fmtD = s => s ? s.split('-').reverse().join('.') : '';
  /* Zeitzone je Ort – offline aus den Koordinaten (tzlookup), Verschiebung am Reisedatum rechnet der Browser */
  async function tzs(P) { const out = {}; for (const p of P) if (p.lat != null) out[p.day] = await tzAt(p.lat, p.lon, p.date); return out; }
  async function build(P) {
    const tz = await tzs(P); let last = null;
    P.forEach(p => { if (tz[p.day] != null) last = tz[p.day]; p.tz = last != null ? last : (tz[Object.keys(tz)[0]] || 0); });
    const lands = {}; P.forEach(p => { if (p.land) lands[p.land] = (lands[p.land] || 0) + 1; });
    const region = Object.keys(lands).sort((a, b) => lands[b] - lands[a])[0] || '';
    const slug = (W.title.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ß/g, 'ss').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'reise') + '-' + W.start.slice(0, 4);
    let id = slug; try { const ex = new Set((await Promise.race([window.__listTrips(), new Promise((_, no) => setTimeout(() => no(0), 5000))])).map(t => t.id)); let n = 2; while (ex.has(id)) id = slug + '-' + n++; } catch (e) {}
    const trip = { title: W.title, kind: W.kind, start: W.start, end: W.end, ship: null, tz: P[0].tz, region, arrival: W.arrival || 'plane', vehicle: W.vehicle || defVeh(W.kind) };
    if (cruise() && W.operator) trip.operator = W.operator;
    return { format: 'reiseplaner-trip-1', id, trip, data: { ports: P, maps: {}, kul: { L: {}, P: {} }, quiz: [], info: {}, notes: [] } };
  }

  window.WIZ = { open() {
    const old = load();
    if (old && old.title && confirm(`Angefangene Reise „${old.title}“ weiter bearbeiten?\n(Abbrechen = neu beginnen)`)) W = old;
    else W = { title: '', kind: '', start: '', end: '', arrival: 'plane', vehicle: '', days: [] };
    if (!W.vehicle) W.vehicle = defVeh(W.kind);
    if (!window.__createTrip) return infoToast('Neue Reisen gehen nur mit Anmeldung.', 'OK', () => {});
    dlgReturn = null; step1();
  }, _state: () => W, _build: build, _ports: draftPorts };
})();
