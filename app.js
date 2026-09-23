'use strict';
/* LagerBuddy: Etikett fotografieren -> Barcodes + Text lokal auf dem Handy lesen -> Liste -> Excel.
   Alle Bibliotheken liegen in vendor/, kein Bild und keine Nummer verlässt das Gerät. */
const LOCAL = new URL('vendor/', location.href).href;
const KEY = 'lagerbuddy_v1';
const KEY_PICK = 'lagerbuddy_pick_v1';
const FIELDS = ['artikel', 'bez1', 'bez2', 'charge'];
const fmtN = n => n.toLocaleString('de-DE');
// Pickliste ist noch nicht freigegeben: nur beim lokalen Testen sichtbar, auf der Live-Seite ausgeblendet.
// Zum Freischalten diese Zeile auf true setzen.
const PICK_ENABLED = ['localhost', '127.0.0.1'].includes(location.hostname);
const CODE_OK = /^[0-9A-Z][0-9A-Z\-. $\/+%]{0,39}$/; // Code39-Zeichensatz, Länge gedeckelt gegen Unsinn auf einem manipulierten Etikett
const $ = id => document.getElementById(id);

try { navigator.storage?.persist?.(); } catch {} // hilft gegen Löschen durch den Browser nach längerer Nichtnutzung

let list = load();
let pick = loadPick();
let mode = 'scan'; // 'scan' (freie Liste) oder 'pick' (Pickliste)
let busy = false;
let editIdx = null; // Index des Listeneintrags, der gerade bearbeitet wird
let previewUrl = null;

function load() {
  try {
    const v = JSON.parse(localStorage.getItem(KEY));
    return Array.isArray(v) ? v.filter(e => e && typeof e === 'object' && typeof e.ts === 'number') : [];
  } catch { return []; }
}
function save() {
  try { localStorage.setItem(KEY, JSON.stringify(list)); return true; }
  catch { toast('Speichern fehlgeschlagen. Ist der Speicher voll?'); return false; }
}
function loadPick() {
  try {
    const v = JSON.parse(localStorage.getItem(KEY_PICK));
    return v && typeof v === 'object' && Array.isArray(v.lines) ? v : null;
  } catch { return null; }
}
function savePick() {
  try { localStorage.setItem(KEY_PICK, JSON.stringify(pick)); return true; }
  catch { toast('Speichern fehlgeschlagen. Ist der Speicher voll?'); return false; }
}

let toastT;
function toast(msg) {
  const t = $('toast'); t.textContent = msg; t.classList.add('on');
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('on'), 3200);
}

const scripts = {};
function loadScript(path) {
  return scripts[path] || (scripts[path] = new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = LOCAL + path; s.onload = res;
    s.onerror = () => { delete scripts[path]; rej(new Error('Laden fehlgeschlagen: ' + path)); };
    document.head.appendChild(s);
  }));
}
function withTimeout(promise, ms, msg) {
  return Promise.race([promise, new Promise((_, rej) => setTimeout(() => rej(new Error(msg)), ms))]);
}

/* ---------- Liste ---------- */
function render() {
  const ul = $('list');
  ul.replaceChildren(...list.map((e, i) => {
    const li = document.createElement('li'); li.className = 'card';
    const entry = document.createElement('button');
    entry.className = 'entry'; entry.type = 'button';
    entry.setAttribute('aria-label', `Eintrag bearbeiten: ${e.artikel || '–'} / ${e.charge || '–'}`);
    entry.onclick = () => showForm(e, null, i);
    const nums = document.createElement('div'); nums.className = 'nums';
    nums.append(e.artikel || '–', ' · Charge ');
    const b = document.createElement('b'); b.textContent = e.charge || '–'; nums.append(b);
    const del = document.createElement('button');
    del.className = 'del'; del.type = 'button';
    del.setAttribute('aria-label', `Eintrag löschen: ${e.artikel || '–'} / ${e.charge || '–'}`);
    del.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>';
    del.onclick = () => {
      if (!confirm(`Eintrag ${e.artikel} / ${e.charge} löschen?`)) return;
      const removed = list.splice(i, 1);
      if (!save()) { list.splice(i, 0, ...removed); return; }
      render();
    };
    entry.append(nums);
    const mengeText = typeof e.menge === 'number' ? `${e.menge.toLocaleString('de-DE')} ${e.einheit}` : '';
    for (const t of [e.bez1, e.bez2, mengeText, new Date(e.ts).toLocaleString('de-DE')]) {
      if (!t) continue;
      const d = document.createElement('div'); d.className = 'sub'; d.textContent = t; entry.append(d);
    }
    li.append(entry, del);
    return li;
  }).reverse());
  $('count').textContent = list.length ? `(${list.length})` : '';
  $('empty').hidden = list.length > 0;
  $('export').disabled = $('clear').disabled = !list.length;
}

/* ---------- Modus (Erfassen / Pickliste) ---------- */
function setMode(m) {
  mode = m;
  $('modeScan').classList.toggle('active', m === 'scan');
  $('modeScan').setAttribute('aria-pressed', String(m === 'scan'));
  $('modePick').classList.toggle('active', m === 'pick');
  $('modePick').setAttribute('aria-pressed', String(m === 'pick'));
  $('freeListView').hidden = m !== 'scan';
  $('pickView').hidden = m !== 'pick';
  $('exportBar').hidden = m !== 'scan';
  $('pickBar').hidden = m !== 'pick';
  if (m === 'pick') renderPick();
}
$('modeScan').onclick = () => setMode('scan');
$('modePick').onclick = () => setMode('pick');

/* ---------- Pickliste ---------- */
function renderPick() {
  const has = pick && pick.lines.length > 0;
  $('pickEmpty').hidden = !!has;
  $('pickBody').hidden = !has;
  if (!has) return;
  const total = pick.lines.length;
  const done = pick.lines.filter(l => l.picked >= l.required).length;
  const complete = done === total;
  $('pickBanner').className = 'card pick-banner' + (complete ? ' done' : '');
  $('pickBanner').textContent = complete ? '✓ Pickliste vollständig – Aufgabe erledigt' : `${done} von ${total} Artikeln fertig`;
  $('pickName').textContent = pick.name;
  $('pickList').replaceChildren(...pick.lines.map(l => {
    const li = document.createElement('li'); li.className = 'card pick-line' + (l.picked >= l.required ? ' done' : '');
    const head = document.createElement('div'); head.className = 'nums';
    head.textContent = l.artikel + (l.bez ? ' · ' + l.bez : '');
    const prog = document.createElement('div'); prog.className = 'sub';
    prog.textContent = `${fmtN(l.picked)} / ${fmtN(l.required)} ${l.einheit}`;
    li.append(head, prog);
    return li;
  }));
}
function addPick(e) {
  const line = pick?.lines.find(l => l.artikel === e.artikel);
  if (!line) { toast('Dieser Artikel steht nicht auf der Pickliste.'); return; }
  if (line.einheit !== e.einheit) { toast(`Falsche Einheit: für diesen Artikel wird ${line.einheit} erwartet.`); return; }
  const before = line.picked;
  line.picked += e.menge;
  line.scans.push({ ts: e.ts, menge: e.menge, charge: e.charge });
  if (!savePick()) { line.picked = before; line.scans.pop(); return; }
  renderPick(); closeForm();
  toast(line.picked >= line.required
    ? `Fertig: ${e.artikel} (${fmtN(line.picked)}/${fmtN(line.required)} ${line.einheit})`
    : `Gebucht: ${fmtN(e.menge)} ${e.einheit} für ${e.artikel} (${fmtN(line.picked)}/${fmtN(line.required)})`);
}
async function loadPicklistFile(file) {
  if (!file) return;
  try {
    await loadScript('xlsx.mini.min.js');
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, { type: 'array' });
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '' });
    const lines = parsePicklist(rows);
    pick = { name: file.name, importedAt: Date.now(), lines };
    if (!savePick()) { pick = null; return; }
    renderPick();
    toast(`Pickliste geladen: ${lines.length} Artikel.`);
  } catch (err) {
    console.error(err);
    toast(err instanceof Error && err.message.length < 120 ? err.message : 'Excel-Datei konnte nicht gelesen werden.');
  }
}
$('pickChoose').onclick = () => $('pickFile').click();
$('pickReplace').onclick = () => $('pickFile').click();
$('pickFile').onchange = ev => { const f = ev.target.files[0]; ev.target.value = ''; loadPicklistFile(f); };
$('pickClear').onclick = () => {
  if (!confirm('Pickliste verwerfen? Der Fortschritt geht verloren.')) return;
  pick = null;
  try { localStorage.removeItem(KEY_PICK); } catch {}
  renderPick();
};

/* ---------- Formular ---------- */
function showForm(r, file, idx = null) {
  editIdx = idx;
  $('formSubmit').textContent = idx !== null ? 'Änderung speichern' : mode === 'pick' ? 'Für Pickliste buchen' : 'Zur Liste hinzufügen';
  for (const f of FIELDS) {
    $(f).value = r[f] || '';
    const fromCode = (f === 'artikel' && r.artikelCode) || (f === 'charge' && r.chargeCode);
    const t = $('t-' + f);
    t.className = file ? 'tag ' + (fromCode ? 'ok' : 'check') : 'tag';
    t.textContent = file ? (fromCode ? 'aus Barcode' : 'bitte prüfen') : '';
  }
  $('menge').value = typeof r.menge === 'number' ? String(r.menge).replace('.', ',') : '';
  for (const el of document.getElementsByName('einheit')) el.checked = el.value === r.einheit;
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = file ? URL.createObjectURL(file) : null;
  $('preview').hidden = !file;
  if (file) $('preview').src = previewUrl; else $('preview').removeAttribute('src');
  $('form').hidden = false; $('scan').hidden = true; $('bar').hidden = true; $('modeSwitch').hidden = true;
  $('form').scrollIntoView({ behavior: 'smooth', block: 'start' });
}
function closeForm() {
  $('form').hidden = true; $('scan').hidden = false; $('bar').hidden = false; $('modeSwitch').hidden = !PICK_ENABLED;
  editIdx = null;
  if (previewUrl) { URL.revokeObjectURL(previewUrl); previewUrl = null; }
  $('preview').removeAttribute('src');
}

$('form').onsubmit = ev => {
  ev.preventDefault();
  const e = { ts: Date.now() };
  for (const f of FIELDS) e[f] = $(f).value.trim().replace(/\s+/g, ' ');
  if (!e.artikel) { toast('Bitte eine Artikelnummer eintragen.'); $('artikel').focus(); return; }
  const menge = parseFloat($('menge').value.trim().replace(',', '.')); // deutsches Komma zulassen, type=number kennt nur den Punkt
  if (!(menge > 0)) { toast('Bitte die Menge pro Gebinde eintragen.'); $('menge').focus(); return; }
  const einheit = document.querySelector('input[name=einheit]:checked')?.value;
  if (!einheit) { toast('Bitte Stück oder kg auswählen.'); return; }
  e.menge = menge; e.einheit = einheit;
  const idx = editIdx;
  if (idx === null && mode === 'pick') { addPick(e); return; }
  if (!e.charge && !confirm(idx !== null ? 'Die Charge ist leer. Trotzdem speichern?' : 'Die Charge ist leer. Trotzdem hinzufügen?')) return;
  if (list.some((x, j) => j !== idx && x.artikel === e.artikel && x.charge === e.charge) &&
      !confirm('Artikel und Charge sind schon in der Liste. Trotzdem nochmal hinzufügen?')) return;
  if (idx !== null) {
    const old = list[idx];
    list[idx] = { ...e, ts: old.ts, geaendert: e.ts }; // Erfassungszeit bleibt, Änderung wird vermerkt
    if (!save()) { list[idx] = old; return; }
    render(); closeForm(); toast('Geändert.');
    return;
  }
  list.push(e);
  if (!save()) { list.pop(); return; }
  render(); closeForm(); toast('Hinzugefügt.');
};
$('cancel').onclick = closeForm;
$('manual').onclick = () => showForm({}, null);

/* ---------- Scan ---------- */
function setBusy(on, msg) {
  busy = on;
  $('busy').hidden = !on;
  if (msg) $('busymsg').textContent = msg;
  for (const id of ['cam', 'gal', 'manual']) $(id).disabled = on;
  $('camBtn').style.opacity = $('galBtn').style.opacity = on ? .45 : '';
}

async function toCanvas(file) {
  const bmp = await createImageBitmap(file); // dreht Handyfotos anhand der EXIF-Lage richtig
  const k = Math.min(1, 2000 / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close && bmp.close();
  return c;
}

let zxPrepared = false;
async function readCodes(canvas) {
  await loadScript('zxing/zxing-reader.js');
  if (!zxPrepared) {
    ZXingWASM.prepareZXingModule({ overrides: { locateFile: (p, pre) => p.endsWith('.wasm') ? LOCAL + 'zxing/' + p : pre + p } });
    zxPrepared = true;
  }
  const img = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
  let res;
  try {
    // formats: 'Code39' -- diese Etiketten nutzen nur Code39; das vermeidet auch, dass ein EAN auf dem
    // Karton daneben versehentlich als Artikel- oder Chargennummer gelesen wird
    res = await ZXingWASM.readBarcodes(img, { formats: ['Code39'], tryHarder: true, maxNumberOfSymbols: 4 });
  } catch (err) {
    ZXingWASM.purgeZXingModule(); zxPrepared = false; // Modul bleibt nach einem Ladefehler sonst für die Sitzung kaputt
    throw err;
  }
  return res.filter(b => b.isValid && b.text && CODE_OK.test(b.text.trim()))
    .map(b => {
      const ys = [b.position.topLeft.y, b.position.topRight.y, b.position.bottomLeft.y, b.position.bottomRight.y];
      return { text: b.text.trim(), top: Math.min(...ys), bottom: Math.max(...ys) };
    })
    .sort((a, b) => a.top - b.top);
}

let tessWorker = null;
async function getTessWorker() {
  if (tessWorker) return tessWorker;
  await loadScript('tesseract/tesseract.min.js');
  setBusy(true, 'Texterkennung wird geladen (nur beim ersten Mal) …');
  const p = Tesseract.createWorker('deu', 1, {
    workerPath: LOCAL + 'tesseract/worker.min.js', corePath: LOCAL + 'tesseract/core', langPath: LOCAL + 'tesseract/lang',
    logger: m => { if (busy && m.status === 'recognizing text') $('busymsg').textContent = `Text wird gelesen … ${Math.round(m.progress * 100)} %`; },
  });
  try { tessWorker = await withTimeout(p, 45000, 'Texterkennung konnte nicht geladen werden'); }
  catch (err) { tessWorker = null; throw err; }
  return tessWorker;
}

async function ocrLines(canvas, codes) {
  // Mit beiden Barcodes nur den Streifen dazwischen lesen: dort stehen die Bezeichnungen, der Rest ist Folie und Karton
  let src = canvas, cropped = false;
  if (codes.length >= 2) {
    const y0 = Math.round(Math.max(0, codes[0].bottom));
    const y1 = Math.round(Math.min(canvas.height, codes[codes.length - 1].top));
    const h = y1 - y0;
    if (h > 20) {
      src = document.createElement('canvas'); src.width = canvas.width; src.height = h;
      src.getContext('2d').drawImage(canvas, 0, y0, canvas.width, h, 0, 0, canvas.width, h);
      cropped = true;
    }
  }
  const worker = await getTessWorker();
  try {
    const r = await withTimeout(worker.recognize(src), 90000, 'Texterkennung hat zu lange gedauert');
    return r.data.lines
      .slice().sort((a, b) => a.bbox.y0 - b.bbox.y0) // Tesseract liefert Zeilen blockweise, nicht immer von oben nach unten
      .map(l => ({ text: cleanLine(l.words), conf: l.confidence }))
      .filter(l => l.text);
  } catch (err) {
    try { await worker.terminate(); } catch {}
    tessWorker = null; // nächster Scan lädt einen frischen Worker statt an einem kaputten hängenzubleiben
    throw err;
  } finally {
    if (cropped) { src.width = 0; src.height = 0; }
  }
}

async function scan(file) {
  if (!file || busy) return;
  if (file.size > 30 * 1024 * 1024) { toast('Foto ist zu groß (über 30 MB). Bitte erneut aufnehmen.'); return; }
  setBusy(true, 'Barcodes werden gelesen …');
  let canvas;
  try {
    canvas = await toCanvas(file);
    let codes = [];
    try { codes = await readCodes(canvas); } catch (err) { console.warn(err); }
    let lines = [];
    try { setBusy(true, 'Text wird gelesen …'); lines = await ocrLines(canvas, codes); } catch (err) { console.warn(err); }
    const r = parseLabel(lines, codes.map(c => c.text));
    showForm(r, file);
    if (!codes.length) toast('Kein Barcode erkannt. Bitte alle Felder prüfen.');
  } catch (err) {
    console.error(err);
    toast('Das Foto konnte nicht gelesen werden. Bitte nochmal versuchen.');
  } finally {
    setBusy(false);
    if (canvas) { canvas.width = 0; canvas.height = 0; } // iOS begrenzt den Canvas-Speicher, sonst schlagen spätere Scans fehl
  }
}
for (const id of ['cam', 'gal']) $(id).onchange = ev => { const f = ev.target.files[0]; ev.target.value = ''; scan(f); };

/* ---------- Export ---------- */
$('export').onclick = async () => {
  try {
    await loadScript('xlsx.mini.min.js');
    const rows = [['Artikelnummer', 'Bezeichnung 1', 'Bezeichnung 2', 'Charge', 'Menge', 'Einheit', 'Erfasst am'],
      ...list.map(e => [e.artikel, e.bez1, e.bez2, e.charge, e.menge ?? '', e.einheit ?? '', new Date(e.ts).toLocaleString('de-DE')])];
    const ws = XLSX.utils.aoa_to_sheet(rows); // IDs/Text bleiben Text (führende Nullen, keine Formeln), Menge bleibt eine echte Zahl
    for (const k in ws) if (k[0] !== '!' && ws[k].t === 's') ws[k].z = '@';
    ws['!cols'] = [{ wch: 16 }, { wch: 34 }, { wch: 34 }, { wch: 14 }, { wch: 10 }, { wch: 8 }, { wch: 20 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Erfassung');
    const d = new Date(), p = n => String(n).padStart(2, '0');
    const name = `LagerBuddy_${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}.xlsx`;
    const buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
    const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const f = new File([blob], name, { type: blob.type });
    if (navigator.canShare && navigator.canShare({ files: [f] })) {
      // iPhone im Homescreen-Modus kann einen Download sonst verschlucken; über die Teilen-Funktion "Sichern" geht immer
      try { await navigator.share({ files: [f] }); return; }
      catch (err) { if (err.name === 'AbortError') return; }
    }
    XLSX.writeFile(wb, name);
  } catch (err) {
    console.error(err); toast('Export fehlgeschlagen. Bitte nochmal versuchen.');
  }
};
$('clear').onclick = () => {
  if (!confirm(`Alle ${list.length} Einträge löschen? Vorher herunterladen nicht vergessen.`)) return;
  list = []; save(); render();
};

$('modeSwitch').hidden = !PICK_ENABLED;
render();
