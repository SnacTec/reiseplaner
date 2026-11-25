// Übersichtskarte für Reisen ohne eigene Karte (z. B. mit dem Assistenten angelegt):
// Ausschnitt aus den Stationen, Küsten aus world.json (Natural Earth 1:50m, gemeinfrei), Länder-Namen auf Deutsch.
// Setzt D.maps.ov sowie ox/oy/ompp der Stationen und ox/oy/km der Tipps. Detailkarten kommen aus den Online-Kacheln.
window.RP_MAPGEN = function (D, WD) {
  const rad = Math.PI / 180, my = la => Math.log(Math.tan(Math.PI / 4 + la * rad / 2));
  const P = (D.ports || []).filter(p => p.lat != null && p.lon != null);
  const lats = P.length ? P.map(p => p.lat) : [0], lons = P.length ? P.map(p => p.lon) : [0];
  let lo0 = Math.min(...lons), lo1 = Math.max(...lons), la0 = Math.min(...lats), la1 = Math.max(...lats);
  const pad = (a, b) => Math.max((b - a) * 0.18, 0.6);
  { const p1 = pad(lo0, lo1), p2 = pad(la0, la1); lo0 -= p1; lo1 += p1; la0 = Math.max(-80, la0 - p2); la1 = Math.min(80, la1 + p2); }
  let sx = (lo1 - lo0) * rad, y0 = my(la0), y1 = my(la1), sy = y1 - y0;
  if (sy / sx < 0.5) { const c = (y0 + y1) / 2; sy = sx * 0.5; y0 = c - sy / 2; y1 = c + sy / 2; }
  if (sy / sx > 1.25) { const c = (lo0 + lo1) / 2; sx = sy / 1.25; lo0 = c - sx / rad / 2; lo1 = c + sx / rad / 2; }
  const W = 1600, k = W / sx, H = Math.round(sy * k), tx = -lo0 * rad * k, ty = y1 * k;
  const X = lo => tx + k * lo * rad, Y = la => ty - k * my(Math.max(-85, Math.min(85, la)));
  // Küsten: nur Ringe in der Nähe des Ausschnitts, Punkte unter 0,35 Einheiten Abstand weglassen
  const q = WD.q, bx0 = -W / 2, bx1 = 1.5 * W, by0 = -H / 2, by1 = 1.5 * H; let d = '';
  for (const r of WD.r) {
    let x = 0, y = 0, minx = 1e9, maxx = -1e9, miny = 1e9, maxy = -1e9; const pts = [];
    for (let i = 0; i < r.length; i += 2) { x += r[i]; y += r[i + 1]; const px = X(x / q), py = Y(y / q); pts.push(px, py);
      if (px < minx) minx = px; if (px > maxx) maxx = px; if (py < miny) miny = py; if (py > maxy) maxy = py; }
    if (maxx < bx0 || minx > bx1 || maxy < by0 || miny > by1 || (maxx - minx < 0.4 && maxy - miny < 0.4)) continue;
    let lx = null, ly = null, s = '';
    for (let i = 0; i < pts.length; i += 2) { const px = pts[i], py = pts[i + 1];
      if (lx != null && Math.abs(px - lx) < 0.35 && Math.abs(py - ly) < 0.35 && i < pts.length - 2) continue;
      s += (lx == null ? 'M' : 'L') + px.toFixed(1) + ',' + py.toFixed(1); lx = px; ly = py; }
    d += s + 'Z';
  }
  // Länder-Namen (Schwerpunkt des größten Landesteils), nur im Ausschnitt und groß genug
  let dn = null; try { dn = new Intl.DisplayNames(['de'], { type: 'region' }); } catch (e) {}
  const labels = [], aMin = Math.pow((lo1 - lo0) / 40, 2);
  for (const [a2, lo, la, ar] of WD.c) { const x = X(lo), y = Y(la);
    if (x < 30 || x > W - 30 || y < 20 || y > H - 20 || ar < aMin) continue;
    let n = a2; try { n = dn ? dn.of(a2) : a2; } catch (e) {}
    labels.push([n.replace('Dominikanische Republik', 'Dominikanische Rep.'), Math.round(x), Math.round(y)]); }
  D.maps = D.maps || {}; D.maps.ov = { W, H, land: d, k, tx, ty, labels, gen: 1 };
  const mpu = la => 6371008 * Math.cos(la * rad) / k;
  const km = (a, b, c, e) => 6371 * Math.hypot((e - b) * rad * Math.cos((a + c) * rad / 2), (c - a) * rad);
  (D.ports || []).forEach(p => {
    if (p.lat == null) return; p.ox = +X(p.lon).toFixed(1); p.oy = +Y(p.lat).toFixed(1); p.ompp = +mpu(p.lat).toFixed(2);
    if (p.map && !D.maps[p.map]) delete p.map;
    (p.pois || []).forEach(o => { if (o.lat == null) return; o.ox = +X(o.lon).toFixed(2); o.oy = +Y(o.lat).toFixed(2); if (o.km == null) o.km = +km(p.lat, p.lon, o.lat, o.lon).toFixed(1); });
  });
  return D;
};
