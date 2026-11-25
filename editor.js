/* Reise bearbeiten: Grunddaten, Stationen (verschieben, einfügen, löschen) und Tipps je Station.
   Gearbeitet wird an einem Entwurf; erst „Speichern“ schreibt die Reise (tripSave) und nummeriert
   eure Einträge, Ausflüge, Abendessen-Ausnahmen und Dateien passend um (dayRemap). Danach lädt die App neu. */
(function () {
  let E = null, ORIG = [], dirty = false, J = null;
  const KINDS = [['kreuzfahrt', '🚢 Kreuzfahrt'], ['roadtrip', '🚗 Roadtrip'], ['staedtereise', '🏙 Städtereise'], ['rundreise', '🧳 Rundreise']];
  const ARR = [['plane', '✈️ Flugzeug'], ['car', '🚗 Auto'], ['train', '🚆 Zug'], ['bus', '🚌 Bus'], ['none', '– keine Anreise zeigen']];
  const VEH = [['ship', '🚢 Schiff'], ['car', '🚗 Auto'], ['camper', '🚐 Wohnmobil'], ['train', '🚆 Zug'], ['bus', '🚌 Bus'], ['suitcase', '🧳 Koffer']];
  const cruise = () => E.t.kind === 'kreuzfahrt' || !!E.t.ship;
  const addD = (s, n) => { const d = new Date(s + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const wd = s => new Date(s + 'T12:00:00Z').toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit', timeZone: 'UTC' }).replace('.,', '.');
  const clone = o => JSON.parse(JSON.stringify(o));
  const kmOf = (a, b, c, d) => +(6371 * Math.hypot((d - b) * Math.PI / 180 * Math.cos((a + c) * Math.PI / 360), (c - a) * Math.PI / 180)).toFixed(1);
  const tipIc = q => (TIPC[q.t] || TIPC.sight)[1];
  const keepScroll = fn => { const d = $('#dlg'), y = d ? d.scrollTop : 0; fn(); requestAnimationFrame(() => { const e = $('#dlg'); if (e) e.scrollTop = y; }); };

  async function open() {
    try { const { j, t } = await tripLoadJson(); J = j; const ports = clone(j.ports || []);
      ports.forEach(p => { if (!p.sid) p.sid = 's' + p.day; if (p.kind !== 'sea' && !p.pois) p.pois = []; (p.pois || []).forEach((q, i) => { if (!q.id) q.id = 't' + p.day + '_' + i; }); });
      ORIG = ports.map(p => ({ sid: p.sid, day: p.day, lat: p.lat, lon: p.lon }));
      E = { t: { title: t.title || '', kind: t.kind || '', start: t.start || ports[0].date, operator: t.operator || '', arrival: t.arrival || 'plane', vehicle: t.vehicle || '', ship: t.ship || null }, ports };
      dirty = false; dlgReturn = null; main();
    } catch (e) { infoToast('Reise konnte nicht geladen werden: ' + (e.message || e.code || e), 'OK', () => {}); }
  }
  function label(p) {
    if (p.kind === 'sea') return ['🌊', 'Seetag', ''];
    const ic = p.kind === 'start' ? '🚢' : p.kind === 'end' ? '🏁' : cruise() ? '⚓' : '📍', n = (p.pois || []).length;
    return [ic, p.name || 'ohne Ort', [cruise() && p.kind === 'port' && /\d/.test(p.times || '') ? p.times : p.kind === 'start' ? (cruise() ? 'Einschiffung' : 'Start') : p.kind === 'end' ? (cruise() ? 'Ausschiffung' : 'Ende') : '', n ? 'Tipps ' + n : ''].filter(Boolean).join(' · ')];
  }

  /* Hauptseite */
  function main() {
    openSheet(`<div class="hd"><h3 style="margin:0">Reise bearbeiten</h3><button class="x" data-close aria-label="Schließen">✕</button></div>
      <form class="sform" id="edg" style="margin-top:0">
      <label>Titel<input name="title" maxlength="60" value="${esc(E.t.title)}"></label>
      <label>Art der Reise</label><div class="wzch">${KINDS.map(([k, n]) => `<button type="button" class="chip" data-k="${k}" aria-pressed="${E.t.kind === k}">${n}</button>`).join('')}</div>
      <div class="two"><label>Erster Tag<input type="date" name="start" value="${esc(E.t.start)}"></label><label>Letzter Tag<input type="date" disabled value="${esc(addD(E.t.start, E.ports.length - 1))}"></label></div>
      <label style="${cruise() ? '' : 'display:none'}">Veranstalter / Reederei<input name="operator" maxlength="30" value="${esc(E.t.operator)}"></label>
      <div class="two"><label>Anreise<select name="arrival">${ARR.map(([k, n]) => `<option value="${k}" ${E.t.arrival === k ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
      <label>Unterwegs mit<select name="vehicle"><option value="">automatisch</option>${VEH.map(([k, n]) => `<option value="${k}" ${E.t.vehicle === k ? 'selected' : ''}>${n}</option>`).join('')}</select></label></div></form>
      <h4 class="edh4">An- und Abreise</h4>
      <p class="src" style="margin:-2px 0 4px">Wird sofort beim Speichern im jeweiligen Fenster übernommen.</p>
      ${['out', 'back'].map(k => `<button type="button" class="wzday" data-etv="${k}"><span class="wzt">${k === 'out' ? 'Hin' : 'Zurück'}</span><span class="wzn"><b>${TRV[k] ? (TVM[TRV[k].mode] || TVM.plane)[0] + ' ' + esc(((TRV[k].segs || [])[0] || {}).f ? plTxt(TRV[k].segs[0].f) + ' → ' + plTxt(TRV[k].segs[TRV[k].segs.length - 1].t) : 'unvollständig') : 'noch nicht eingetragen'}</b><small>${TRV[k] && (TRV[k].segs || [])[0] ? esc(fmtDate(TRV[k].segs[0].dd || '') + ' ' + (TRV[k].segs[0].dt || '')) : 'Flug, Zug, Auto oder Bus'}</small></span><span class="wzgo">›</span></button>`).join('')}
      <h4 class="edh4">Stationen (${E.ports.length})</h4>
      <div id="edl">${E.ports.map((p, i) => { const [ic, n, sub] = label(p);
        return `<div class="edrow" data-i="${i}"><span class="edhd" aria-label="Verschieben" title="Ziehen zum Verschieben">≡</span><button type="button" class="wzday" data-st="${i}"><span class="wzt">Tag ${i + 1}<small>${esc(wd(addD(E.t.start, i)))}</small></span><span class="wzn"><b>${ic} ${esc(n)}</b>${sub ? `<small>${esc(sub)}</small>` : ''}</span><span class="wzgo">›</span></button></div>`; }).join('')}</div>
      <div class="acts" style="margin:8px 0 4px"><button class="lnk" id="edadd">+ Station einfügen</button></div>
      <p class="src" style="margin:4px 0 0">Kachel gedrückt halten (oder am ≡ ziehen) zum Verschieben. Das Datum ergibt sich aus der Reihenfolge, eure Einträge wandern mit ihrer Station mit.</p>
      <p class="src" id="edm" style="margin:6px 0 0">${navigator.onLine === false ? '📴 Offline: Änderungen werden hochgeladen, sobald Internet da ist. Ändert ihr gleichzeitig dieselbe Reise, gilt die letzte Änderung.' : ''}</p>
      <details class="kul setg" style="margin-top:18px"><summary><span class="sgt"><b>🗑 Reise löschen</b><small>z. B. eine Testreise</small></span></summary><div class="sgb">
        <p class="src" style="margin:2px 0 8px">Löscht die Reise mit allen gemeinsamen Einträgen, Listen und Quizpunkten – für alle Mitreisenden. Hochgeladene Dateien bleiben im Speicher. Das kann man nicht rückgängig machen.</p>
        <button class="chip del" id="edkill" style="margin-left:0">„${esc(E.t.title)}“ endgültig löschen</button></div></details>
      <div class="btns bar"><button class="chip btn" id="edsave">${dirty ? 'Speichern' : 'Fertig'}</button>${dirty ? '<button class="chip" id="edx">Abbrechen</button>' : ''}</div>`, d => {
      asPage();
      const f = d.querySelector('#edg'), mark = () => { if (dirty) return; dirty = true; const b = d.querySelector('#edsave'); b.textContent = 'Speichern'; if (!d.querySelector('#edx')) { b.insertAdjacentHTML('afterend', '<button class="chip" id="edx">Abbrechen</button>'); d.querySelector('#edx').onclick = () => { if (confirm('Änderungen verwerfen?')) closeDlg(); }; } };
      f.addEventListener('input', () => { E.t.title = f.title.value.trim(); E.t.operator = f.operator.value.trim(); E.t.arrival = f.arrival.value; E.t.vehicle = f.vehicle.value; mark(); });
      f.start.onchange = () => { if (f.start.value) { E.t.start = f.start.value; dirty = true; keepScroll(main); } };
      f.addEventListener('change', e => { if (e.target.name !== 'start') { E.t.arrival = f.arrival.value; E.t.vehicle = f.vehicle.value; mark(); } });
      d.querySelectorAll('[data-k]').forEach(b => b.onclick = () => { E.t.kind = b.dataset.k; dirty = true; keepScroll(main); });
      d.querySelectorAll('[data-st]').forEach(b => b.onclick = () => { if (Date.now() - blockClick < 400) return; subOpen(() => keepScroll(main), () => station(+b.dataset.st)); });
      d.querySelectorAll('[data-etv]').forEach(b => b.onclick = () => subOpen(() => keepScroll(main), () => tvDlg(b.dataset.etv)));
      d.querySelector('#edadd').onclick = () => subOpen(() => keepScroll(main), () => station(E.ports.length, true));
      { const ex = d.querySelector('#edx'); if (ex) ex.onclick = () => { if (!dirty || confirm('Änderungen verwerfen?')) closeDlg(); }; }
      d.querySelector('#edsave').onclick = () => dirty ? save() : closeDlg();
      d.querySelector('#edkill').onclick = async () => { if (!confirm(`Reise „${E.t.title}“ wirklich löschen?\nDas betrifft alle Mitreisenden und kann nicht rückgängig gemacht werden.`)) return;
        if (window.__TEST_TRIP) { window.__DELETED = 1; return; }
        const L = (await window.__listTrips().catch(() => [])).filter(x => x.id !== TRIP_ID);
        if (!L.length) return infoToast('Das ist die einzige Reise – zuerst eine andere anlegen.', 'OK', () => {});
        const m = d.querySelector('#edm'); m.textContent = 'Wird gelöscht …';
        try { await tripDelete(L[0].id); try { localStorage.setItem('rp-trip', L[0].id); } catch (e) {} m.textContent = 'Gelöscht, wird neu geladen …'; setTimeout(() => location.reload(), 600); }
        catch (e) { m.className = 'src bad'; m.textContent = 'Löschen fehlgeschlagen: ' + (e.message || e.code || e); } };
      drag(d.querySelector('#edl'));
    });
  }
  /* Stationen verschieben: Kachel gedrückt halten (oder sofort am ≡) und ziehen; am Rand scrollt die Liste mit */
  let blockClick = 0;
  function drag(list) {
    const box = $('#dlg'); let pd = null, L = null, tmr = 0, raf = 0;
    const lift = () => { const el = pd.el, r = el.getBoundingClientRect(); L = { el, id: pd.id, off: pd.y - r.top, y: pd.y }; pd = null;
      el.classList.add('lift'); try { navigator.vibrate && navigator.vibrate(15); } catch (x) {} loop(); };
    const place = () => { const el = L.el, sib = [...list.children].filter(x => x !== el);
      const before = sib.find(x => { const r = x.getBoundingClientRect(); return L.y < r.top + r.height / 2; });
      if (before) { if (el.nextElementSibling !== before) before.before(el); } else if (sib.length) { const last = sib[sib.length - 1]; if (last.nextElementSibling !== el) last.after(el); }
      el.style.transform = ''; const base = el.getBoundingClientRect().top; el.style.transform = `translateY(${L.y - L.off - base}px)`; };
    // Automatisch scrollen, solange der Finger am oberen/unteren Rand des Fensters steht
    const loop = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(function step() { if (!L) return;
      const r = box.getBoundingClientRect(), m = 70; let v = 0;
      if (L.y < r.top + m) v = -Math.ceil((r.top + m - L.y) / 5); else if (L.y > r.bottom - m) v = Math.ceil((L.y - (r.bottom - m)) / 5);
      if (v) { const y0 = box.scrollTop; box.scrollTop += Math.max(-18, Math.min(18, v)); if (box.scrollTop !== y0) place(); }
      raf = requestAnimationFrame(step); }); };
    list.querySelectorAll('.edrow').forEach(row => {
      row.addEventListener('pointerdown', e => { if (e.button > 0 || L) return; pd = { el: row, x: e.clientX, y: e.clientY, id: e.pointerId }; clearTimeout(tmr);
        if (e.target.closest('.edhd')) { e.preventDefault(); lift(); } else tmr = setTimeout(() => { if (pd) lift(); }, 400); });
    });
    const move = e => { if (pd && e.pointerId === pd.id && Math.hypot(e.clientX - pd.x, e.clientY - pd.y) > 8) { clearTimeout(tmr); pd = null; }
      if (!L || e.pointerId !== L.id) return; e.preventDefault(); L.y = e.clientY; place(); };
    const end = e => { clearTimeout(tmr); pd = null; if (!L || e.pointerId !== L.id) return; const el = L.el; L = null; cancelAnimationFrame(raf);
      el.classList.remove('lift'); el.style.transform = ''; blockClick = Date.now();
      const order = [...list.children].map(x => +x.dataset.i); if (order.some((v, k) => v !== k)) { const P = order.map(k => E.ports[k]); E.ports.splice(0, E.ports.length, ...P); dirty = true; } keepScroll(main); };
    const tm = e => { if (L) e.preventDefault(); };
    document.addEventListener('pointermove', move, { passive: false }); document.addEventListener('pointerup', end); document.addEventListener('pointercancel', end);
    document.addEventListener('touchmove', tm, { passive: false });
    list.addEventListener('contextmenu', e => e.preventDefault());
    // beim nächsten Neuzeichnen alte Listener entfernen
    const off = () => { document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', end); document.removeEventListener('pointercancel', end); document.removeEventListener('touchmove', tm); };
    if (drag.off) drag.off(); drag.off = off;
  }

  /* Eine Station */
  function station(i, isNew) {
    const t = isNew ? { sid: 'n' + Date.now().toString(36), kind: 'port', name: '', times: '', text: '', pois: [], ex: [], fact: [], tips: [], tr: [] } : clone(E.ports[i]); t.pois = t.pois || [];
    const m = /(\d{1,2}:\d{2})\D+(\d{1,2}:\d{2})/.exec(t.times || ''); let t1 = m ? m[1] : '', t2 = m ? m[2] : '', pos = i, res = [], tmr = 0;
    const render = () => {
      const n = E.ports.length + (isNew ? 1 : 0), canSea = cruise() && !(t.kind === 'start' || t.kind === 'end');
      openSheet(`<div class="hd"><h3 style="margin:0">${isNew ? 'Neue Station' : 'Tag ' + (i + 1) + ' · ' + esc(t.name || 'Seetag')}<small class="hds">${esc(E.t.title)}</small></h3><button class="x" data-close aria-label="Zurück">✕</button></div>
        <form class="sform" id="eds" style="margin-top:0">
        ${canSea ? `<label>Art</label><div class="wzch"><button type="button" class="chip" data-kk="port" aria-pressed="${t.kind !== 'sea'}">⚓ Hafen</button><button type="button" class="chip" data-kk="sea" aria-pressed="${t.kind === 'sea'}">🌊 Seetag</button></div>` : ''}
        <label>Position<select name="pos">${Array.from({ length: n }, (_, k) => `<option value="${k}" ${k === pos ? 'selected' : ''}>Tag ${k + 1} · ${esc(wd(addD(E.t.start, k)))}</option>`).join('')}</select></label>
        <div id="edpl" style="${t.kind === 'sea' ? 'display:none' : ''}"><label>${cruise() ? 'Hafen' : 'Ort'}</label><div class="sfield" style="margin:4px 0 0"><svg class="sfi" viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg><input id="edq" type="search" autocomplete="off" value="${esc(t.name || '')}" placeholder="Ort suchen"></div>
          <div class="acts" style="margin:6px 0 0"><button type="button" class="lnk" id="edpick">📍 Auf der Karte wählen</button></div><div id="edsel">${t.lat != null ? `<p class="src" style="margin:6px 0 0">📍 <b>${esc(t.name)}</b>${t.land ? ' · ' + esc(t.land) : ''} ✓</p>` : ''}</div><div id="edres"></div></div>
        <div class="two" style="${cruise() && t.kind === 'port' ? '' : 'display:none'}"><label>Ankunft<input type="time" name="t1" value="${esc(t1)}"></label><label>Ablegen<input type="time" name="t2" value="${esc(t2)}"></label></div>
        ${cruise() && (t.kind === 'start' || t.kind === 'end') ? embFormHTML(t.kind, t.emb) : ''}
        <label>Beschreibung (optional)<textarea name="text" maxlength="600" placeholder="Kurz zum Ort, z. B. Hotel, Treffpunkt">${esc(t.text || '')}</textarea></label></form>
        ${t.kind === 'sea' ? '' : `<h4 class="edh4">Tipps (${t.pois.length})</h4>${t.pois.map((q, k) => `<button type="button" class="edtip" data-q="${k}"><span class="badge ic" style="--c:${CAT[tipCat(q)].c}">${tipIc(q)}</span><span class="wzn"><b>${esc(q.n)}</b><small>${esc([(TYPES[q.t] || TYPES.sight)[0], q.km != null ? String(q.km).replace('.', ',') + ' km' : ''].filter(Boolean).join(' · '))}</small></span><span class="wzgo">›</span></button>`).join('')}
        <div class="acts" style="margin:8px 0"><button class="lnk" id="edtadd">+ Tipp hinzufügen</button></div>`}
        <p class="src bad" id="edm" style="margin:0"></p>
        <div class="btns bar"><button class="chip btn" id="edok">Übernehmen</button><button class="chip" id="edcx">Abbrechen</button>${isNew ? '' : '<button class="chip del" id="eddel">Station löschen</button>'}</div>`, d => {
        asPage();
        const f = d.querySelector('#eds'), q = d.querySelector('#edq'), rs = d.querySelector('#edres');
        const keep = () => { t.text = f.text.value.trim(); pos = +f.pos.value; if (f.t1) { t1 = f.t1.value; t2 = f.t2.value; } const em = embRead(f, t.kind); if (em !== undefined) { if (em) t.emb = em; else delete t.emb; } };
        const list = () => { rs.innerHTML = res.msg ? `<p class="src" style="margin:6px 0 0">${esc(res.msg)}</p>` : res.map((x, k) => `<button type="button" class="plres" data-r="${k}"><b>${esc(x.name)}</b><small>${esc(x.addr)}</small></button>`).join('');
          rs.querySelectorAll('[data-r]').forEach(b => b.onclick = () => { const x = res[+b.dataset.r]; keep(); Object.assign(t, { name: x.name, lat: x.lat, lon: x.lon, land: x.country || t.land || '' }); res = []; render(); }); };
        if (q) q.oninput = () => { clearTimeout(tmr); tmr = setTimeout(async () => { const v = q.value.trim(); if (v.length < 3) { res = []; return list(); }
          res = await placeSearchAny(v, t.lat != null ? t : null); if (!res.length && !res.msg) res.msg = res.offline ? 'Offline-Suche kennt nur Städte und Orte – „Auf der Karte wählen“.' : 'Nichts gefunden – anders schreiben.'; list(); }, 450); };
        const pk = d.querySelector('#edpick'); if (pk) pk.onclick = () => { keep(); subOpen(render, () => pickOnMap(t.lat != null ? t : (E.ports[i - 1] || E.ports[i + 1] || {}), r => { Object.assign(t, { name: r.name, lat: r.lat, lon: r.lon, land: r.country || t.land || '' }); res = []; })); };
        d.querySelectorAll('[data-kk]').forEach(b => b.onclick = () => { keep(); t.kind = b.dataset.kk; render(); });
        d.querySelectorAll('[data-q]').forEach(b => b.onclick = () => { keep(); subOpen(render, () => tip(t, +b.dataset.q)); });
        const ta = d.querySelector('#edtadd'); if (ta) ta.onclick = () => { keep(); if (t.lat == null) return d.querySelector('#edm').textContent = 'Bitte zuerst den Ort festlegen.'; subOpen(render, () => tip(t, -1)); };
        d.querySelector('#edcx').onclick = () => history.back();
        d.querySelector('#edok').onclick = () => { keep(); if (t.kind !== 'sea' && t.lat == null) return d.querySelector('#edm').textContent = 'Bitte einen Ort aus der Liste wählen.';
          if (t.kind === 'sea') { t.name = 'Seetag'; delete t.lat; delete t.lon; t.land = ''; t.times = ''; }
          else if (cruise() && t.kind === 'port') t.times = t1 && t2 ? t1 + '–' + t2 : '';
          if (!isNew) E.ports.splice(i, 1); E.ports.splice(Math.min(pos, E.ports.length), 0, t); dirty = true; history.back(); };
        const dl = d.querySelector('#eddel'); if (dl) dl.onclick = () => { if (E.ports.length < 2) return d.querySelector('#edm').textContent = 'Die letzte Station kann nicht gelöscht werden.';
          const was = E.ports.splice(i, 1)[0]; dirty = true; history.back();
          setTimeout(() => undoToast(`Station „${was.name || 'Seetag'}“ entfernt (wird erst mit „Speichern“ übernommen).`, () => { E.ports.splice(i, 0, was); keepScroll(main); }), 120); };
      });
    };
    render();
  }

  /* Ein Tipp */
  function tip(t, k) {
    const q = k < 0 ? { id: 't' + Date.now().toString(36), n: '', t: 'sight', w: 'walk', d: '' } : clone(t.pois[k]);
    let res = [], tmr = 0;
    const render = () => openSheet(`<div class="hd"><h3 style="margin:0">${k < 0 ? 'Neuer Tipp' : esc(q.n)}<small class="hds">${esc(t.name || '')}</small></h3><button class="x" data-close aria-label="Zurück">✕</button></div>
      <form class="sform" id="edt" style="margin-top:0">
      <label>Name<input name="n" maxlength="80" value="${esc(q.n)}" placeholder="z. B. Altstadt, Strand, Museum"></label>
      <label>Art</label><div class="wzch">${Object.keys(TYPES).map(x => `<button type="button" class="chip" data-tt="${x}" aria-pressed="${q.t === x}">${(TIPC[x] || TIPC.sight)[1]} ${TYPES[x][0]}</button>`).join('')}</div>
      <label>Lage</label><div class="sfield" style="margin:4px 0 0"><svg class="sfi" viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg><input id="edq" type="search" autocomplete="off" placeholder="Ort suchen"></div>
      <div class="acts" style="margin:6px 0 0"><button type="button" class="lnk" id="edpick">📍 Auf der Karte wählen</button></div><div>${q.lat != null ? `<p class="src" style="margin:6px 0 0">📍 gesetzt · ${String(kmOf(t.lat, t.lon, q.lat, q.lon)).replace('.', ',')} km ${CRUISE ? 'vom Hafen' : 'vom Ort'} ✓</p>` : ''}</div><div id="edres"></div>
      <label>Anfahrt</label><div class="wzch">${Object.keys(WALK).map(x => `<button type="button" class="chip" data-ww="${x}" aria-pressed="${q.w === x}">${esc(V(WALK[x][0]))}</button>`).join('')}</div>
      <label>Beschreibung<textarea name="d" maxlength="600">${esc(q.d || '')}</textarea></label>
      <label>Öffnungszeiten (optional)<input name="o" maxlength="60" value="${esc((q.g && q.g.o) || '')}" placeholder="z. B. tgl. 9–17"></label></form>
      <p class="src bad" id="edm" style="margin:0"></p>
      <div class="btns bar"><button class="chip btn" id="edok">Übernehmen</button><button class="chip" id="edcx">Abbrechen</button>${k < 0 ? '' : '<button class="chip del" id="eddel">Tipp löschen</button>'}</div>`, d => {
      asPage();
      const f = d.querySelector('#edt'), qi = d.querySelector('#edq'), rs = d.querySelector('#edres');
      const keep = () => { q.n = f.n.value.trim(); q.d = f.d.value.trim(); q.g = q.g || {}; q.g.o = f.o.value.trim(); };
      qi.oninput = () => { clearTimeout(tmr); tmr = setTimeout(async () => { const v = qi.value.trim(); if (v.length < 3) { rs.innerHTML = ''; return; }
        res = await placeSearchAny(v, t);
        rs.innerHTML = res.length ? res.map((x, j) => `<button type="button" class="plres" data-r="${j}"><b>${esc(x.name)}</b><small>${esc(x.addr)}</small></button>`).join('') : '<p class="src" style="margin:6px 0 0">Nichts gefunden.</p>';
        rs.querySelectorAll('[data-r]').forEach(b => b.onclick = () => { const x = res[+b.dataset.r]; keep(); q.lat = x.lat; q.lon = x.lon; if (!q.n) q.n = x.name; render(); }); }, 450); };
      d.querySelectorAll('[data-tt]').forEach(b => b.onclick = () => { keep(); q.t = b.dataset.tt; render(); });
      d.querySelector('#edpick').onclick = () => { keep(); subOpen(render, () => pickOnMap(q.lat != null ? q : t, r => { q.lat = r.lat; q.lon = r.lon; if (!q.n) q.n = r.name; })); };
      d.querySelectorAll('[data-ww]').forEach(b => b.onclick = () => { keep(); q.w = b.dataset.ww; render(); });
      d.querySelector('#edcx').onclick = () => history.back();
      d.querySelector('#edok').onclick = () => { keep(); const m = d.querySelector('#edm');
        if (!q.n) return m.textContent = 'Bitte einen Namen eingeben.'; if (q.lat == null) return m.textContent = 'Bitte die Lage über die Suche festlegen.';
        q.km = kmOf(t.lat, t.lon, q.lat, q.lon);
        const g = q.g || {}, mode = q.w === 'walk' ? 'walk' : q.w === 'tour' ? 'tour' : 'taxi';
        q.g = { m: mode, t: Math.max(5, Math.round(mode === 'walk' ? q.km * 13 : q.km * 2.5 + 8)), s: g.s || 60, c: g.c != null ? g.c : 0, u: g.u || '€', o: g.o || '', f: g.f != null ? g.f : null, v: 0, n: g.n || '' };
        if (k < 0) t.pois.push(q); else t.pois[k] = q; history.back(); };
      const dl = d.querySelector('#eddel'); if (dl) dl.onclick = () => { const was = t.pois.splice(k, 1)[0]; history.back();
        setTimeout(() => undoToast(`Tipp „${was.n}“ entfernt.`, () => { t.pois.splice(k, 0, was); }), 120); };
    });
    render();
  }

  /* Speichern */
  async function save() {
    const P = E.ports, n = P.length, cr = cruise();
    P.forEach((p, i) => { p.day = i + 1; p.date = addD(E.t.start, i);
      if (cr) { if (p.kind !== 'sea') p.kind = i === 0 ? 'start' : i === n - 1 ? 'end' : (p.kind === 'start' || p.kind === 'end' ? 'port' : p.kind); }
      else if (p.kind === 'sea' || p.kind === 'start' || p.kind === 'end') { if (p.kind !== 'sea') p.kind = 'port'; } });
    const M = {}; ORIG.forEach(o => { const j = P.findIndex(p => p.sid === o.sid); M[o.day] = j >= 0 ? j + 1 : null; });
    const gone = ORIG.filter(o => !M[o.day]), moved = ORIG.filter(o => M[o.day] && M[o.day] !== o.day).length;
    const lost = gone.reduce((a, o) => a + ((plan[o.day] || []).length) + Object.keys(picks).filter(k => picks[k] && k.split(':')[0] == o.day).length, 0);
    if (gone.length || moved) { const msg = [moved ? moved + ' Station(en) verschoben – eure Einträge wandern mit.' : '', gone.length ? gone.length + ' Station(en) gelöscht' + (lost ? ' – dabei gehen ' + lost + ' Einträge/Ausflüge verloren.' : '.') : ''].filter(Boolean).join('\n');
      if (!confirm(msg + '\n\nSpeichern?')) return; }
    const m = $('#edm'), b = $('#edsave'); if (b) b.disabled = true; if (m) { m.className = 'src'; m.textContent = 'Wird gespeichert …'; }
    // Kartenpositionen: mit eigener Karte neu berechnen, sonst erzeugt die App sie beim Laden
    const own = J && J.maps && J.maps.ov;
    P.forEach(p => { if (p.lat == null) { delete p.ox; delete p.oy; return; }
      if (own) { const o = ORIG.find(x => x.sid === p.sid); if (!o || o.lat !== p.lat || o.lon !== p.lon || p.ox == null) { const xy = llxy(p.lat, p.lon); p.ox = +xy[0].toFixed(1); p.oy = +xy[1].toFixed(1); p.ompp = +mpu(xy[1]).toFixed(2); } }
      else { delete p.ox; delete p.oy; delete p.ompp; }
      (p.pois || []).forEach(q => { if (q.lat == null) return; if (own) { if (q.ox == null) { const xy = llxy(q.lat, q.lon); q.ox = +xy[0].toFixed(2); q.oy = +xy[1].toFixed(2); } } else { delete q.ox; delete q.oy; } }); });
    let how = 'ok';
    try {
      how = await tripSave((j, u) => { j.ports = P;
        if (j.route && j.route.legs) { const st = P.filter(p => p.kind !== 'sea').map(p => p.day);
          j.route.legs = j.route.legs.map(L => ({ ...L, a: M[L.a], b: M[L.b] })).filter(L => L.a && L.b && st.indexOf(L.b) === st.indexOf(L.a) + 1);
          const sea = {}; Object.entries(j.route.sea || {}).forEach(([d, v]) => { if (M[d]) sea[M[d]] = v; }); j.route.sea = sea; }
        Object.assign(u, { title: E.t.title || TRIP.title, kind: E.t.kind, start: E.t.start, end: addD(E.t.start, n - 1), arrival: E.t.arrival, vehicle: E.t.vehicle || null });
        if (E.t.operator) u.operator = E.t.operator; });
    } catch (e) { if (b) b.disabled = false; if (m) { m.className = 'src bad'; m.textContent = 'Speichern fehlgeschlagen: ' + (e.message || e.code || e); } return; }
    // eure Einträge umnummerieren; Einträge zu gelöschten Tipps entfernen
    planTipFix(); D.ports.splice(0, D.ports.length, ...P); dayRemap(M);
    Object.keys(plan).forEach(d => { const ids = new Set(((P[d - 1] || {}).pois || []).map(q => q.id)); plan[d] = (plan[d] || []).filter(s => s.x || !s.ti || ids.has(s.ti)); });
    savePlan(); dirty = false;
    if (m) m.textContent = how === 'offline' ? 'Ohne Internet gespeichert – wird hochgeladen, sobald Netz da ist. Wird neu geladen …' : 'Gespeichert, wird neu geladen …';
    try { if (window.__dropCopy) await window.__dropCopy(TRIP_ID); } catch (e) {}
    setTimeout(() => { if (window.__TEST_TRIP) { window.__EDIT_DONE = 1; return; } location.reload(); }, 900);
  }
  window.EDIT = { open, _E: () => E, _save: save };
})();
