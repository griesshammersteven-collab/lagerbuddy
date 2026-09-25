'use strict';
/* ---------- Lager: Lagerplätze, Ein-/Ausbuchen und Bestand je Lagerplatz ----------
   Jede Buchung ist eine Bewegung { id, ts, lagerplatz, richtung: ein|aus, quelle, artikel, bez, charge, menge (gesamt),
   gebinde (Anzahl), einheit, picker, pick_id }. Der Bestand je Lagerplatz ist die Summe (ein minus aus).
   Mit Server: Bewegungen warten in bew.offen, bis lb_buchen sie hat (offline gesammelt, doppelt gesendet zählt einmal);
   angezeigt wird der Serverbestand (lb_bestand) plus die noch wartenden. Ohne Server liegt alles in bew.alle.
   Wo gebucht wird: in der Pickliste (Umlagern: Ausbuchen aus dem Lagerplatz zählt als gepickt, Einbuchen am Ziel
   extra) und im Modus "Lager" (z. B. Wareneingang vom Lieferanten einbuchen). */
const KEY_BEW = 'lagerbuddy_bewegungen_v1';
const KEY_BESTAND = 'lagerbuddy_bestand_v1'; // letzter Serverstand, damit der Bestand auch offline zu sehen ist
const rund3 = n => Math.round(n * 1000) / 1000;

function loadBew() {
  try {
    const v = JSON.parse(localStorage.getItem(KEY_BEW));
    if (v && Array.isArray(v.offen) && Array.isArray(v.alle)) return v;
  } catch {}
  return { offen: [], alle: [] };
}
let bew = loadBew();
function saveBew() {
  try { localStorage.setItem(KEY_BEW, JSON.stringify(bew)); return true; }
  catch { toast('Handyspeicher voll: Lagerbuchung konnte nicht gespeichert werden.'); return false; }
}
let bestandServer = null;
try { const v = JSON.parse(localStorage.getItem(KEY_BESTAND)); if (Array.isArray(v)) bestandServer = v; } catch {}
let lagerZuletzt = null; // im Modus "Lager": zuletzt benutzter Lagerplatz und Richtung (mehrere Gebinde ins selbe Regal)

/* ---------- Bestand ---------- */
const bKey = b => [b.lagerplatz, normArt(b.artikel), normCharge(b.charge || ''), b.einheit].join('|');
function bestand() {
  const map = new Map();
  const add = (b, sign, zeit) => {
    const k = bKey(b);
    const e = map.get(k) || { lagerplatz: b.lagerplatz, artikel: normArt(b.artikel), charge: b.charge || '', einheit: b.einheit, bez: '', menge: 0, gebinde: 0, zuletzt: 0 };
    e.menge = rund3(e.menge + sign * Number(b.menge)); e.gebinde += sign * Number(b.gebinde);
    if (b.bez && !e.bez) e.bez = b.bez;
    e.zuletzt = Math.max(e.zuletzt, zeit || 0);
    map.set(k, e);
  };
  const sign = b => (b.richtung === 'ein' ? 1 : -1);
  if (SYNC_ON) {
    for (const r of bestandServer || []) add(r, 1, Date.parse(r.zuletzt)); // vom Server schon saldiert
    for (const b of bew.offen) add(b, sign(b), b.ts);
  } else for (const b of bew.alle) add(b, sign(b), b.ts);
  return [...map.values()].filter(e => Math.abs(e.menge) > 0.0005)
    .sort((a, b) => a.lagerplatz.localeCompare(b.lagerplatz, 'de', { numeric: true }) || a.artikel.localeCompare(b.artikel));
}
const bestandBekannt = () => !SYNC_ON || bestandServer !== null;
const bestandVon = b => bestand().find(e => bKey(e) === bKey(b))?.menge || 0;

// Neue Bewegung speichern (mit Server: im Hintergrund übertragen). Rückgabe: Hinweis für den Toast, wenn beim
// Ausbuchen laut Bestand zu wenig am Lagerplatz lag (bucht trotzdem -- ohne Inventur ist der Anfangsbestand unbekannt).
function lagerBewegung(b) {
  const m = { id: `${b.ts}-${picker || 'x'}-${Math.random().toString(36).slice(2, 8)}`, ...b,
    artikel: normArt(b.artikel), bez: (b.bez || '').slice(0, 200), charge: (b.charge || '').trim(), menge: rund3(b.menge), picker: b.picker || picker || '' };
  let hinweis = '';
  if (m.richtung === 'aus' && bestandBekannt()) {
    const da = bestandVon(m);
    if (da < m.menge - 0.0005) hinweis = ` · Hinweis: laut Bestand lagen an ${m.lagerplatz} nur ${fmtN(Math.max(0, da))} ${m.einheit}`;
  }
  if (SYNC_ON) bew.offen.push(m); else bew.alle.push(m);
  saveBew();
  if (SYNC_ON) setTimeout(push, 0);
  if (mode === 'lager') renderLager();
  return hinweis;
}

// Wartende Bewegungen an den Server (aus pushNow in app.js). Offline wirft rpc -> pushNow meldet "Offline".
async function pushBewegungen() {
  if (!SYNC_ON || !lager || !bew.offen.length) return;
  while (bew.offen.length) {
    const teil = bew.offen.slice(0, 200);
    try {
      await rpc('lb_buchen', { lager, buchungen: teil.map(({ id, ts, lagerplatz, artikel, bez, charge, menge, gebinde, einheit, richtung, quelle, pick_id, picker }) =>
        ({ id, ts, lagerplatz, artikel, bez, charge, menge, gebinde, einheit, richtung, quelle, pick_id: pick_id || '', picker })) });
    } catch (err) {
      if (err.kind !== 'daten') throw err;
      toast('Lagerbuchung vom Server abgelehnt: ' + err.message); // nicht endlos wiederholen
    }
    const ids = new Set(teil.map(b => b.id));
    bew.offen = bew.offen.filter(b => !ids.has(b.id));
    saveBew();
  }
  ladeBestand();
}
async function ladeBestand() {
  if (!SYNC_ON || !lager) { if (mode === 'lager') renderLager(); return; }
  try {
    const rows = await rpc('lb_bestand', { lager });
    bestandServer = rows.map(r => ({ ...r, menge: Number(r.menge), gebinde: Number(r.gebinde) }));
    try { localStorage.setItem(KEY_BESTAND, JSON.stringify(bestandServer)); } catch {}
  } catch (err) { syncFailed(err); }
  if (mode === 'lager') renderLager();
}

/* ---------- Ansicht "Lager" ---------- */
function renderLager() {
  const st = $('lagerSync');
  st.hidden = !SYNC_ON;
  if (SYNC_ON) {
    const n = bew.offen.length;
    st.className = 'sync-state' + (syncErr || n ? ' warn' : '');
    st.textContent = syncErr === 'offline' ? `Offline – ${n ? n + ' Buchung(en) warten auf Netz' : 'zeigt den letzten Stand'}`
      : n ? `Wird übertragen … (${n})` : bestandServer ? '✓ Bestand aktuell' : 'Bestand wird geladen …';
  }
  const q = $('bestandSuche').value.trim().toUpperCase();
  const alle = bestand(), rows = q ? alle.filter(e => [e.lagerplatz, e.artikel, e.charge, e.bez].some(t => String(t).toUpperCase().includes(q))) : alle;
  const plaetze = new Map();
  for (const e of rows) { if (!plaetze.has(e.lagerplatz)) plaetze.set(e.lagerplatz, []); plaetze.get(e.lagerplatz).push(e); }
  $('bestandList').replaceChildren(...[...plaetze].map(([lp, items]) => {
    const li = document.createElement('li'); li.className = 'card';
    const h = document.createElement('div'); h.className = 'lp-head'; h.textContent = lp;
    li.append(h);
    for (const e of items) {
      const it = document.createElement('div'); it.className = 'lp-item' + (e.menge < 0 ? ' neg' : '');
      const links = document.createElement('div');
      const n = document.createElement('div'); n.className = 'nums'; n.textContent = e.artikel + (e.bez ? ' · ' + e.bez : '');
      const s = document.createElement('div'); s.className = 'sub'; s.textContent = e.charge ? 'Charge ' + e.charge : 'ohne Charge';
      links.append(n, s);
      if (e.menge < 0) { const w = document.createElement('div'); w.className = 'lp-warn'; w.textContent = 'Mehr aus- als eingebucht – Bestand prüfen'; links.append(w); }
      const rechts = document.createElement('div'); rechts.className = 'lp-menge';
      rechts.textContent = `${fmtN(e.menge)} ${e.einheit}`;
      const g = document.createElement('div'); g.className = 'sub'; g.textContent = `${fmtN(e.gebinde)} Gebinde`;
      rechts.append(g);
      it.append(links, rechts);
      li.append(it);
    }
    return li;
  }));
  $('bestandCount').textContent = plaetze.size ? `(${plaetze.size} ${plaetze.size === 1 ? 'Lagerplatz' : 'Lagerplätze'})` : '';
  $('bestandLeer').hidden = !!rows.length;
  $('bestandLeer').textContent = q && alle.length ? 'Nichts gefunden.' : 'Noch nichts eingebucht.';
  $('bestandExport').hidden = role !== 'master';
}
$('bestandSuche').addEventListener('input', () => renderLager());

/* ---------- Formular: Lagerplatz und Ein/Aus ---------- */
// Vorschlag beim Öffnen: in der Pickliste der Platz der letzten Buchung dieser Position, im Modus Lager der zuletzt benutzte
function lpVorschlag(r) {
  let v = null;
  if (mode === 'pick' && pick) {
    const a = normArt(r.artikel), l = [currentPickLine(), ...pick.lines].find(x => x && normArt(x.artikel) === a);
    const s = l && [...l.scans].reverse().find(x => x.lagerplatz);
    if (s) v = { lp: s.lagerplatz, richtung: s.richtung || 'aus' };
  } else if (mode === 'lager') v = lagerZuletzt;
  $('lpCode').value = v?.lp || '';
  for (const el of document.getElementsByName('richtung')) el.checked = el.value === v?.richtung;
  $('t-lp').className = 'tag' + (v ? ' ok' : ''); $('t-lp').textContent = v ? 'gemerkt' : '';
}
$('lpCode').addEventListener('input', () => { $('t-lp').className = 'tag'; $('t-lp').textContent = ''; });
function lpWert() {
  const roh = $('lpCode').value.trim();
  if (!roh) { toast('Bitte den Lagerplatz scannen oder eintippen (z. B. H3.01.01.00.01).'); $('lpCode').focus(); return ''; }
  const [lp] = findLagerplatz(roh);
  if (!lp) { toast(`Lagerplatz „${roh}“ passt nicht zum Schema H3.01.01.00.01.`); $('lpCode').focus(); return ''; }
  $('lpCode').value = lp;
  return lp;
}
function richtungWert() {
  const r = document.querySelector('input[name=richtung]:checked')?.value || '';
  if (!r) toast('Bitte „Ausbuchen“ oder „Einbuchen“ wählen.');
  return r;
}

// Lagerplatz vom Foto: erst Barcode (Code 128, notfalls Code 39), sonst der Text darunter. Der Text wird zuerst ohne
// Barcode-Balken gelesen (mit Balken liest Tesseract nichts), dann das ganze Bild (Foto nur vom Text).
// Mehrere Lagerplätze im Bild (ganzes Etikettenblatt): der in der Bildmitte -- dorthin zielt man.
async function leseLagerplatz(canvas) {
  const mitte = (x, y) => Math.hypot(x - canvas.width / 2, y - canvas.height / 2);
  const naechster = t => t.sort((a, b) => a.d - b.d)[0].lp;
  let codes = [];
  try { codes = await readCodes(canvas, ['Code128', 'Code39'], 12); } catch (err) { console.warn(err); }
  const ausCode = codes.flatMap(c => findLagerplatz(c.text).map(lp => ({ lp, d: mitte((c.left + c.right) / 2, (c.top + c.bottom) / 2) })));
  if (ausCode.length) return { lp: naechster(ausCode), quelle: 'aus Barcode' };
  setBusy(true, 'Lagerplatz: Text wird gelesen …');
  const worker = await getTessWorker();
  await worker.setParameters({ tessedit_pageseg_mode: '11' }); // verstreute Textstücke statt Seitenlayout
  try {
    for (const bild of [() => ohneBalken(canvas), () => canvas]) {
      const b = bild();
      try {
        const r = await withTimeout(worker.recognize(b), 60000, 'Texterkennung hat zu lange gedauert');
        const t = r.data.lines.flatMap(l => findLagerplatz(l.text).map(lp => ({ lp, d: mitte((l.bbox.x0 + l.bbox.x1) / 2, (l.bbox.y0 + l.bbox.y1) / 2) })));
        if (t.length) return { lp: naechster(t), quelle: 'aus Text – bitte prüfen' };
      } finally { if (b !== canvas) { b.width = 0; b.height = 0; } }
    }
  } finally { await worker.setParameters({ tessedit_pageseg_mode: '3' }); } // Etiketten lesen weiter mit Seitenlayout
  return null;
}
function ohneBalken(canvas) {
  const w = canvas.width, h = canvas.height, id = canvas.getContext('2d').getImageData(0, 0, w, h);
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  c.getContext('2d').putImageData(new ImageData(stripBars(id.data, w, h), w, h), 0, 0);
  return c;
}
$('lpCam').onchange = async ev => {
  const f = ev.target.files[0]; ev.target.value = '';
  if (!f || busy) return;
  if (f.size > 30 * 1024 * 1024) { toast('Foto ist zu groß (über 30 MB).'); return; }
  setBusy(true, 'Lagerplatz wird gelesen …');
  let canvas;
  try {
    canvas = await toCanvas(f, 2000);
    const r = await leseLagerplatz(canvas);
    if (r) {
      $('lpCode').value = r.lp;
      $('t-lp').className = 'tag ' + (r.quelle === 'aus Barcode' ? 'ok' : 'check'); $('t-lp').textContent = r.quelle;
    } else toast('Kein Lagerplatz erkannt. Bitte näher ans Etikett oder die Nummer eintippen.');
  } catch (err) {
    console.error(err); toast('Foto konnte nicht gelesen werden. Bitte nochmal versuchen.');
  } finally {
    setBusy(false);
    if (canvas) { canvas.width = 0; canvas.height = 0; }
  }
};

/* ---------- Buchen ---------- */
// Pickliste, Einbuchen am Ziel: Position über Artikel (und Charge) finden -- Reihenfolge und BA-Prüfung gelten nur
// fürs Picken. Gezählt wird "eingelagert", gepickt bleibt, wie es ist.
function einPick(e, lp) {
  const a = normArt(e.artikel);
  const passend = pick.lines.filter(l => normArt(l.artikel) === a);
  const line = passend.find(l => !l.charge || normCharge(l.charge) === normCharge(e.charge)) || passend[0];
  if (line.einheit !== e.einheit) { toast(`Falsche Einheit: für diesen Artikel wird ${line.einheit} erwartet.`); return; }
  if (line.charge && normCharge(line.charge) !== normCharge(e.charge) &&
      !confirm(`Falsche Charge? Erwartet ${line.charge}, erfasst ${e.charge || '–'}. Trotzdem einbuchen?`)) return;
  const scanned = formScan, manuell = !scanned?.code;
  if (role !== 'master') {
    if (!scanned) { toast('In der Pickliste wird jedes Gebinde gescannt: bitte das Etikett fotografieren.'); return; }
    if (!scanned.code) { toast('Artikel-Barcode nicht erkannt. Bitte das Etikett nochmal scharf fotografieren.'); return; }
  }
  if (scanned && picks.some(p => p.lines.some(l => l.scans.some(x => x.fp === scanned.fp)))) {
    toast('Dieses Foto wurde schon gebucht. Jedes Gebinde einzeln fotografieren.'); return;
  }
  const anzahl = anzahlWert(), zahl = x => x.anzahl || 1;
  const ausG = line.scans.filter(x => x.richtung !== 'ein').reduce((s, x) => s + zahl(x), 0);
  const einG = line.scans.filter(x => x.richtung === 'ein').reduce((s, x) => s + zahl(x), 0);
  if (einG + anzahl > ausG && !confirm(`Mehr einbuchen als ausgebucht? Ausgebucht: ${ausG} Gebinde, eingelagert: ${einG}, jetzt: ${anzahl}. Trotzdem einbuchen?`)) return;
  if (anzahl > 1 && !confirm(`${anzahl} gleiche Gebinde à ${fmtN(e.menge)} ${e.einheit} an ${lp} einbuchen?\n\n` +
    `Gebucht auf ${picker}. Mit OK bestätigen Sie, alle ${anzahl} Gebinde geprüft zu haben.`)) return;
  const scan = { ts: e.ts, menge: e.menge, charge: e.charge, picker: e.picker, ...(anzahl > 1 ? { anzahl } : {}),
    ...(scanned ? { fp: scanned.fp } : {}), ...(manuell ? { manuell: true } : {}), lagerplatz: lp, richtung: 'ein' };
  if (!commit(pick.id, { t: 'scan', lid: line.lid, scan })) return;
  lagerBewegung({ ts: e.ts, lagerplatz: lp, richtung: 'ein', quelle: 'pickliste', pick_id: pick.id, artikel: line.artikel,
    bez: line.bez || e.bez1 || '', charge: e.charge || line.charge || '', menge: e.menge * anzahl, gebinde: anzahl, einheit: line.einheit, picker: e.picker });
  renderPick(); closeForm();
  toast(`Eingelagert: ${anzahl > 1 ? anzahl + ' × ' : ''}${fmtN(e.menge)} ${e.einheit} ${e.artikel} an ${lp} (${einG + anzahl} von ${ausG} Gebinden)`);
}

// Modus "Lager": Wareneingang einbuchen oder frei ausbuchen, ohne Pickliste
function lagerBuchen(e) {
  const lp = lpWert(); if (!lp) return;
  const richtung = richtungWert(); if (!richtung) return;
  const anzahl = anzahlWert(), rein = richtung === 'ein';
  if (!e.charge && !confirm('Die Charge ist leer. Trotzdem buchen?')) return;
  if (anzahl > 1 && !confirm(`${anzahl} gleiche Gebinde à ${fmtN(e.menge)} ${e.einheit} ${rein ? 'an' : 'aus'} ${lp} ${rein ? 'einbuchen' : 'ausbuchen'}?\n\n` +
    `Gebucht auf ${picker}. Mit OK bestätigen Sie, alle ${anzahl} Gebinde geprüft zu haben.`)) return;
  const hinweis = lagerBewegung({ ts: e.ts, lagerplatz: lp, richtung, quelle: rein ? 'wareneingang' : 'lager', artikel: e.artikel,
    bez: [e.bez1, e.bez2].filter(Boolean).join(' '), charge: e.charge, menge: e.menge * anzahl, gebinde: anzahl, einheit: e.einheit, picker: e.picker });
  lagerZuletzt = { lp, richtung };
  merken(e.artikel, e.menge, e.einheit);
  closeForm(); renderLager();
  toast(`${rein ? 'Eingebucht' : 'Ausgebucht'}: ${anzahl > 1 ? anzahl + ' × ' : ''}${fmtN(e.menge)} ${e.einheit} ${e.artikel} ${rein ? 'an' : 'aus'} ${lp}` + hinweis);
}

/* ---------- Excel: Bestand und Buchungen (Teamleiter) ---------- */
$('bestandExport').onclick = async () => {
  if (role !== 'master') { toast('Nur Teamleiter können den Bestand exportieren.'); return; }
  try {
    await loadScript('xlsx.mini.min.js');
    await ladeBestand();
    let liste = [];
    if (SYNC_ON) {
      try { liste = await rpc('lb_bewegungen_liste', { lager, anzahl: 10000 }); }
      catch { toast('Buchungen konnten nicht geladen werden – nur der Bestand wird exportiert.'); }
      liste = [...bew.offen.slice().reverse(), ...liste.map(b => ({ ...b, ts: Date.parse(b.ts), menge: Number(b.menge) }))];
    } else liste = bew.alle.slice().reverse();
    const dt = ts => (ts ? new Date(ts).toLocaleString('de-DE') : '');
    const quelle = { pickliste: 'Pickliste', wareneingang: 'Wareneingang', lager: 'Lager' };
    const b1 = [['Bestand je Lagerplatz', `Stand ${dt(Date.now())}, exportiert von ${picker}`], [],
      ['Lagerplatz', 'Artikelnummer', 'Bezeichnung', 'Charge', 'Menge', 'Einheit', 'Gebinde', 'Letzte Buchung'],
      ...bestand().map(e => [e.lagerplatz, e.artikel, e.bez, e.charge, e.menge, e.einheit, e.gebinde, dt(e.zuletzt)])];
    const b2 = [['Zeitpunkt', 'Lagerplatz', 'Ein/Aus', 'Artikelnummer', 'Bezeichnung', 'Charge', 'Gebinde', 'Menge', 'Einheit', 'Quelle', 'Picker'],
      ...liste.map(b => [dt(b.ts), b.lagerplatz, b.richtung === 'ein' ? 'eingebucht' : 'ausgebucht', b.artikel, b.bez || '', b.charge || '',
        b.gebinde, b.menge, b.einheit, quelle[b.quelle] || b.quelle, b.picker || ''])];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, textSheet(b1, [18, 18, 30, 16, 10, 8, 9, 20]), 'Bestand');
    XLSX.utils.book_append_sheet(wb, textSheet(b2, [20, 18, 12, 18, 30, 16, 9, 10, 8, 14, 10]), 'Buchungen');
    await saveWorkbook(wb, `Bestand_${stamp()}.xlsx`);
  } catch (err) {
    console.error(err); toast('Export fehlgeschlagen. Bitte nochmal versuchen.');
  }
};
