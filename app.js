'use strict';
/* LagerBuddy: Etikett fotografieren -> Barcodes + Text lokal auf dem Handy lesen -> Liste -> Excel.
   Alle Bibliotheken liegen in vendor/, kein Bild und keine Nummer verlässt das Gerät. */
const APP_VERSION = '2026-09-23.16'; // bei JEDER Veröffentlichung erhöhen, genauso wie ?v= in index.html
// Alte index.html (CDN/Offline-Speicher) mit neuerem app.js-Inhalt: dann fehlen Knöpfe und der Start bricht ab.
// Einmal frisch laden (eindeutige URL geht am CDN vorbei), bevor irgendetwas verdrahtet wird.
{
  const v = (document.currentScript?.src.match(/[?&]v=([\w.-]+)/) || [])[1];
  if (v && v !== APP_VERSION && !/[?&]frisch=/.test(location.search)) { // nur einmal, keine Schleife
    location.replace(location.pathname + '?frisch=' + Date.now());
    throw new Error('Versionsmix, lade frisch');
  }
}
const LOCAL = new URL('vendor/', location.href).href;
const KEY = 'lagerbuddy_v1';
const KEY_PICK = 'lagerbuddy_pick_v1';
const FIELDS = ['artikel', 'bez1', 'bez2', 'charge'];
const fmtN = n => n.toLocaleString('de-DE');
const PICK_ENABLED = true;
const CODE_OK = /^[0-9A-Z][0-9A-Z\-. $\/+%]{0,39}$/; // Code39-Zeichensatz, Länge gedeckelt gegen Unsinn auf einem manipulierten Etikett
const $ = id => document.getElementById(id);

try { navigator.storage?.persist?.(); } catch {} // hilft gegen Löschen durch den Browser nach längerer Nichtnutzung

let list = load();
let pick = loadPick();
let picker = '', role = ''; // erst nach der Auswahl am Zugangs-Gate gültig, siehe ganz unten
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
    entry.onclick = () => showForm(e, null, i);
    const edit = document.createElement('button');
    edit.className = 'del edit'; edit.type = 'button';
    edit.setAttribute('aria-label', `Eintrag bearbeiten: ${e.artikel || '–'} / ${e.charge || '–'}`);
    edit.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>';
    edit.onclick = entry.onclick;
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
    const wannWer = new Date(e.ts).toLocaleString('de-DE') + (e.picker ? ' · ' + e.picker : '');
    for (const t of [e.bez1, e.bez2, mengeText, e.lagerplatz ? 'Lagerplatz ' + e.lagerplatz : '', wannWer]) {
      if (!t) continue;
      const d = document.createElement('div'); d.className = 'sub'; d.textContent = t; entry.append(d);
    }
    li.append(entry, edit, del);
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
  $('pickBar').hidden = m !== 'pick' || role !== 'master';
  if (m === 'pick') renderPick(); else $('scan').hidden = false;
}
$('modeScan').onclick = () => setMode('scan');
$('modePick').onclick = () => setMode('pick');

/* ---------- Pickliste ---------- */
function renderPick() {
  const has = pick && pick.lines.length > 0;
  $('pickEmpty').hidden = !!has;
  $('pickBody').hidden = !has;
  $('scan').hidden = !has; // ohne Liste gibt es nur "Pickliste fotografieren" -- sonst landet die ganze Seite im Etikett-Leser
  if (!has) return;
  const total = pick.lines.length;
  const done = pick.lines.filter(l => l.picked >= l.required).length;
  const missing = total - done;
  const needsFreigabe = pickNeedsFreigabe();
  const complete = missing === 0 || !!pick.freigabe;
  const cur = currentPickLine();
  const fehlen = missing === 1 ? '1 Position fehlt' : `${missing} Positionen fehlen`;
  $('pickBanner').className = 'card pick-banner' + (complete ? ' done' : '');
  $('pickBanner').textContent = missing === 0 ? '✓ Pickliste vollständig – Aufgabe erledigt'
    : pick.freigabe ? `✓ Pickliste abgeschlossen – freigegeben von ${pick.freigabe.von}, ${fehlen}`
    : needsFreigabe ? `Übersprungen: ${fehlen} – Freigabe durch Teamleiter (CMue oder MD) nötig`
    : `${done} von ${total} Artikeln fertig`;
  $('pickApprove').hidden = !(needsFreigabe && role === 'master');
  $('pickName').textContent = pick.name;
  $('pickVon').value = pick.von || ''; $('pickNach').value = pick.nach || '';
  $('pickList').replaceChildren(...pick.lines.map((l, i) => {
    const li = document.createElement('li');
    const isDone = l.picked >= l.required;
    li.className = 'card pick-line' + (isDone ? ' done' : l === cur ? ' current' : ' waiting') + (!isDone && l.skipped ? ' skipped' : '');
    if (l === cur) {
      const now = document.createElement('div'); now.className = 'pick-now';
      now.textContent = l.skipped ? `Übersprungen · Position ${i + 1} – nachholen oder vom Teamleiter freigeben lassen` : `Jetzt buchen · Position ${i + 1} von ${total}`;
      li.append(now);
    }
    const head = document.createElement('div'); head.className = 'nums';
    head.textContent = l.artikel + (l.bez ? ' · ' + l.bez : '');
    const prog = document.createElement('div'); prog.className = 'sub';
    const geb = gebindeCount(l.required, l.gebinde);
    prog.textContent = (l.charge ? `Charge ${l.charge} · ` : '') + `${fmtN(l.picked)} / ${fmtN(l.required)} ${l.einheit}` +
      (geb ? ` · ≈ ${fmtN(geb)} Gebinde à ${fmtN(l.gebinde)} ${l.einheit}` : '');
    li.append(head, prog);
    if (l.hinweis) { const n = document.createElement('div'); n.className = 'sub pick-note'; n.textContent = l.hinweis; li.append(n); }
    if (!isDone && l.skipped) { const s = document.createElement('div'); s.className = 'sub pick-skip'; s.textContent = `Übersprungen von ${l.skipped.von || '–'}`; li.append(s); }

    // Artikelnummer/Charge/Menge korrigieren (v. a. nach dem Foto-Import) darf nur der Teamleiter
    if (role === 'master') {
      const edit = document.createElement('div'); edit.className = 'pick-edit';
      const field = (label, key, value, aria, numeric) => {
        const lab = document.createElement('label'); lab.append(label);
        const inp = document.createElement('input');
        inp.type = 'text'; inp.spellcheck = false; inp.maxLength = 64; inp.value = value;
        if (numeric) inp.inputMode = 'decimal'; else inp.autocapitalize = 'characters';
        inp.setAttribute('aria-label', aria);
        inp.onchange = () => setPickField(l, key, inp.value);
        lab.append(inp);
        return lab;
      };
      edit.append(
        field('Artikelnummer', 'artikel', l.artikel, `Artikelnummer für Position ${i + 1}`),
        field('Charge', 'charge', l.charge || '', `Charge für Position ${i + 1} (${l.artikel})`),
        field(`Menge (${l.einheit})`, 'required', String(l.required).replace('.', ','), `Menge für Position ${i + 1} (${l.artikel})`, true));
      li.append(edit);
    }

    // Gebindegröße steht selten schon auf der Liste -- hier einmal eintragen, dann rechnet die App mit
    const gebRow = document.createElement('div'); gebRow.className = 'sub pick-gebinde';
    gebRow.append('Gebindegröße ');
    const gebInput = document.createElement('input');
    gebInput.type = 'text'; gebInput.inputMode = 'decimal'; gebInput.placeholder = 'z. B. 25';
    gebInput.value = l.gebinde ? String(l.gebinde).replace('.', ',') : '';
    gebInput.setAttribute('aria-label', `Gebindegröße für ${l.artikel}`);
    gebInput.onchange = () => {
      const v = parseFloat(gebInput.value.trim().replace(',', '.'));
      l.gebinde = v > 0 ? v : undefined;
      savePick(); renderPick();
    };
    gebRow.append(gebInput, ' ' + l.einheit + ' pro Gebinde');
    li.append(gebRow);

    if (l === cur && !l.skipped) {
      const skip = document.createElement('button');
      skip.type = 'button'; skip.className = 'btn pick-skip-btn'; skip.textContent = 'Position überspringen';
      skip.onclick = () => skipPick(l, i);
      li.append(skip);
    }
    return li;
  }));
}
// Positionen werden strikt der Reihe nach gebucht: immer die erste offene, die nicht übersprungen wurde.
// Sind nur noch übersprungene offen, dürfen die nachgeholt werden -- bis ein Teamleiter die Liste freigibt.
function currentPickLine() {
  if (!pick || pick.freigabe) return undefined;
  const open = pick.lines.filter(l => l.picked < l.required);
  return open.find(l => !l.skipped) || open[0];
}
function pickNeedsFreigabe() {
  const open = (pick?.lines || []).filter(l => l.picked < l.required);
  return !pick?.freigabe && open.length > 0 && open.every(l => l.skipped);
}
function skipPick(l, i) {
  if (!confirm(`Position ${i + 1} (${l.artikel}${l.charge ? ' · Charge ' + l.charge : ''}) überspringen? Am Ende muss ein Teamleiter die fehlende Ware freigeben.`)) return;
  l.skipped = { von: picker, ts: Date.now() };
  if (!savePick()) { delete l.skipped; return; }
  renderPick();
}
function setPickField(l, key, raw) {
  if (role !== 'master') { toast('Nur CMue oder MD können Positionen ändern.'); renderPick(); return; }
  let v = raw.trim().replace(/\s+/g, ' ');
  if (key === 'artikel') {
    v = v.replace(/\s+/g, '');
    if (!v) { toast('Die Artikelnummer darf nicht leer sein.'); renderPick(); return; }
  }
  if (key === 'required') {
    v = parseFloat(v.replace(',', '.'));
    if (!(v > 0)) { toast('Bitte eine Menge größer 0 eintragen.'); renderPick(); return; }
  }
  const before = l[key];
  l[key] = v;
  if (!savePick()) l[key] = before;
  renderPick();
}
$('pickApprove').onclick = () => {
  if (role !== 'master') { toast('Nur CMue oder MD können freigeben.'); return; }
  const open = pick.lines.filter(l => l.picked < l.required);
  if (!confirm(`Pickliste freigeben, obwohl ${open.length === 1 ? '1 Position fehlt' : open.length + ' Positionen fehlen'}?\n` +
    open.map(l => `${l.artikel}${l.charge ? ' · Charge ' + l.charge : ''}: ${fmtN(l.picked)} / ${fmtN(l.required)} ${l.einheit}`).join('\n'))) return;
  pick.freigabe = { von: picker, ts: Date.now() };
  if (!savePick()) { delete pick.freigabe; return; }
  renderPick();
};
function addPick(e) {
  const lines = pick?.lines || [];
  const line = currentPickLine();
  const sameArt = l => normArt(l.artikel) === normArt(e.artikel);
  if (!lines.some(sameArt)) { toast('Dieser Artikel steht nicht auf der Pickliste.'); return; }
  if (!line) { toast(pick.freigabe ? 'Die Pickliste ist schon freigegeben und abgeschlossen.' : 'Die Pickliste ist schon vollständig.'); return; }
  const nochmal = `Bitte der Reihe nach: zuerst ${line.artikel}${line.charge ? ' · Charge ' + line.charge : ''} buchen.`;
  if (!sameArt(line)) { toast(nochmal); return; }
  if (line.charge && normCharge(line.charge) !== normCharge(e.charge)) {
    // gleicher Artikel, aber die Charge einer späteren Position -> nicht vorziehen
    if (lines.some(l => l !== line && sameArt(l) && l.charge && normCharge(l.charge) === normCharge(e.charge))) { toast(nochmal); return; }
    if (!confirm(`Falsche Charge? Erwartet ${line.charge}, erfasst ${e.charge || '–'}. Trotzdem buchen?`)) return;
  }
  if (line.einheit !== e.einheit) { toast(`Falsche Einheit: für diesen Artikel wird ${line.einheit} erwartet.`); return; }
  // Gebindegröße bekannt (aus Liste oder von Hand eingetragen) und Menge weicht ab -> vermutlich falsches/angebrochenes
  // Gebinde erwischt oder vertippt, lieber einmal nachfragen statt stillschweigend falsch buchen
  if (line.gebinde && Math.abs(e.menge - line.gebinde) > 0.001 &&
      !confirm(`Falsche Menge? Ein Gebinde hat laut Liste ${fmtN(line.gebinde)} ${line.einheit}, erfasst wurden ${fmtN(e.menge)} ${e.einheit}. Trotzdem buchen?`)) return;
  const before = line.picked;
  line.picked += e.menge;
  line.scans.push({ ts: e.ts, menge: e.menge, charge: e.charge, picker: e.picker });
  if (!savePick()) { line.picked = before; line.scans.pop(); return; }
  renderPick(); closeForm();
  toast(line.picked >= line.required
    ? `Fertig: ${e.artikel} (${fmtN(line.picked)}/${fmtN(line.required)} ${line.einheit})`
    : `Gebucht: ${fmtN(e.menge)} ${e.einheit} für ${e.artikel} (${fmtN(line.picked)}/${fmtN(line.required)})`);
}
function applyParsedPicklist({ title, von, nach, lines, skipped }, sourceName, hinweis) {
  pick = { name: title ? `${title} · ${sourceName}` : sourceName, von, nach, importedAt: Date.now(), lines };
  if (!savePick()) { pick = null; return; }
  renderPick();
  toast(`Pickliste geladen: ${lines.length} Artikel.` + (skipped ? ` ${skipped} Zeile(n) ohne Menge übersprungen.` : '') + (hinweis || ''));
}
async function loadPicklistFile(file) {
  if (!file) return;
  if (role !== 'master') { toast('Nur CMue oder MD können eine Pickliste laden.'); return; } // Knöpfe sind zwar schon versteckt, hier zusätzlich abgesichert
  try {
    await loadScript('xlsx.mini.min.js');
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, { type: 'array' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    // roh (Zahlen) und formatiert (Text wie "8 kg", führende Nullen) nebeneinander, gleiche Zeilen
    const raw = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '', blankrows: true });
    const fmt = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: '', blankrows: true });
    applyParsedPicklist(parsePicklist(raw, fmt), file.name);
  } catch (err) {
    if (!err?.userMessage) console.error(err);
    toast(err instanceof Error && err.message.length < 120 ? err.message : 'Excel-Datei konnte nicht gelesen werden.');
  }
}
// Pickliste vom Papier fotografieren: Texterkennung liest die ganze Seite, die x-Position jedes Worts
// verrät die Tabellenspalte (picklistGridFromWords), danach läuft dieselbe Auswertung wie beim Excel-Import.
// Weniger zuverlässig als die Excel-Datei -- am Ende steht deshalb ein deutlicher Prüfhinweis.
async function loadPicklistPhoto(file) {
  // Für alle offen (nicht nur Teamleiter): die gedruckte Liste landet oft direkt beim Picker, ohne
  // vorher digital beim Teamleiter vorbeizukommen. Nur die Excel-Datei bleibt Teamleiter-only.
  if (!file || busy) return;
  if (file.size > 30 * 1024 * 1024) { toast('Foto ist zu groß (über 30 MB). Bitte erneut aufnehmen.'); return; }
  setBusy(true, 'Pickliste wird gelesen …');
  let canvas;
  try {
    canvas = await toCanvas(file, 3000); // mehr Auflösung als beim Etikett: kleine Schrift über die ganze Seite
    const worker = await getTessWorker();
    const r = await withTimeout(worker.recognize(canvas), 120000, 'Texterkennung hat zu lange gedauert');
    const grid = picklistGridFromWords(r.data.lines, canvas.width);
    applyParsedPicklist(parsePicklist(grid, grid), file.name,
      ' Bitte die Zeilen unten prüfen – von einem Foto liest die App nicht so zuverlässig wie aus Excel.');
  } catch (err) {
    if (!err?.userMessage) console.error(err);
    toast(err instanceof Error && err.message.length < 120 ? err.message : 'Foto konnte nicht gelesen werden.');
  } finally {
    setBusy(false);
    if (canvas) { canvas.width = 0; canvas.height = 0; }
  }
}
// Lagerplatz: von Excel-Titel vorbelegt ("Pickliste B4 -> Bühl"), hier jederzeit nachtragbar/korrigierbar
function savePickRoute() {
  if (!pick) return;
  pick.von = $('pickVon').value.trim(); pick.nach = $('pickNach').value.trim();
  savePick();
}
$('pickVon').addEventListener('change', savePickRoute);
$('pickNach').addEventListener('change', savePickRoute);
$('pickChoose').onclick = () => $('pickFile').click();
$('pickReplace').onclick = () => $('pickFile').click();
$('pickFile').onchange = ev => { const f = ev.target.files[0]; ev.target.value = ''; loadPicklistFile(f); };
$('pickPhotoChoose').onclick = () => $('pickCam').click();
$('pickPhotoReplace').onclick = () => $('pickCam').click();
$('pickCam').onchange = $('pickGal').onchange = ev => { const f = ev.target.files[0]; ev.target.value = ''; loadPicklistPhoto(f); };
$('pickClear').onclick = () => {
  if (role !== 'master') { toast('Nur CMue oder MD können die Pickliste verwerfen.'); return; }
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
  formHasPhoto = !!file; formLabelColor = file ? r.labelColor || null : null;
  renderLabelCheck();
  $('menge').value = typeof r.menge === 'number' ? String(r.menge).replace('.', ',') : '';
  for (const el of document.getElementsByName('einheit')) el.checked = el.value === r.einheit;
  $('lagerplatz').value = r.lagerplatz || (mode === 'pick' && pick ? [pick.von, pick.nach].filter(Boolean).join(' → ') : '');
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
  e.lagerplatz = $('lagerplatz').value.trim();
  if (picker) e.picker = picker;
  const lc = labelCheckState();
  if (lc.kind === 'bad' && !confirm(`Etikettfarbe passt nicht: Artikel ${e.artikel} braucht ein ${LABEL_ADJ[lc.need]} Etikett, erkannt wurde ${lc.got}. Trotzdem übernehmen?`)) return;
  if (lc.kind === 'ok' || lc.kind === 'bad') e.etikett = lc.got; // erkannte Farbe mitschreiben
  const idx = editIdx;
  if (idx === null && mode === 'pick') { addPick(e); return; }
  if (!e.charge && !confirm(idx !== null ? 'Die Charge ist leer. Trotzdem speichern?' : 'Die Charge ist leer. Trotzdem hinzufügen?')) return;
  if (list.some((x, j) => j !== idx && x.artikel === e.artikel && x.charge === e.charge) &&
      !confirm('Artikel und Charge sind schon in der Liste. Trotzdem nochmal hinzufügen?')) return;
  if (idx !== null) {
    const old = list[idx];
    // Erfassungszeit, erkannte Etikettfarbe und ursprünglicher Erfasser bleiben; wer geändert hat, wird zusätzlich vermerkt
    list[idx] = { etikett: old.etikett, ...e, ts: old.ts, picker: old.picker, geaendert: e.ts, geaendertVon: picker || undefined };
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

async function toCanvas(file, maxDim = 2000) {
  const bmp = await createImageBitmap(file); // dreht Handyfotos anhand der EXIF-Lage richtig
  const k = Math.min(1, maxDim / Math.max(bmp.width, bmp.height));
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
      const p = b.position, ys = [p.topLeft.y, p.topRight.y, p.bottomLeft.y, p.bottomRight.y], xs = [p.topLeft.x, p.topRight.x, p.bottomLeft.x, p.bottomRight.x];
      return { text: b.text.trim(), top: Math.min(...ys), bottom: Math.max(...ys), left: Math.min(...xs), right: Math.max(...xs) };
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

// Papierfarbe rund um die Barcodes stichprobenartig lesen (ohne Barcode: Bildmitte, dorthin zielt man).
function sampleLabel(canvas, codes) {
  let x0, x1, y0, y1;
  if (codes.length) {
    x0 = Math.min(...codes.map(c => c.left)); x1 = Math.max(...codes.map(c => c.right));
    y0 = Math.min(...codes.map(c => c.top)); y1 = Math.max(...codes.map(c => c.bottom));
    const w = x1 - x0, h = Math.max(y1 - y0, w * 0.3);
    x0 -= w * 0.15; x1 += w * 0.15; y0 -= h * 0.15; y1 += h * 0.15;
  } else {
    x0 = canvas.width * 0.3; x1 = canvas.width * 0.7; y0 = canvas.height * 0.3; y1 = canvas.height * 0.7;
  }
  x0 = Math.max(0, Math.round(x0)); y0 = Math.max(0, Math.round(y0));
  x1 = Math.min(canvas.width, Math.round(x1)); y1 = Math.min(canvas.height, Math.round(y1));
  if (x1 - x0 < 10 || y1 - y0 < 10) return [];
  const N = 80, c = document.createElement('canvas'); c.width = c.height = N;
  const ctx = c.getContext('2d');
  ctx.imageSmoothingEnabled = false; // echte Einzelpixel statt Mischwerte aus Strichen und Papier
  ctx.drawImage(canvas, x0, y0, x1 - x0, y1 - y0, 0, 0, N, N);
  const d = ctx.getImageData(0, 0, N, N).data, px = [];
  for (let i = 0; i < d.length; i += 4) px.push([d[i], d[i + 1], d[i + 2]]);
  c.width = c.height = 0;
  return px;
}

// Hinweis im Formular: passt die erkannte Etikettfarbe zur Pflichtfarbe des Artikels?
const LABEL_ADJ = { weiß: 'weißes', gelb: 'gelbes', orange: 'orangenes' };
let formLabelColor = null; // erkannte Farbe des aktuellen Fotos (null = kein Foto oder unsicher)
let formHasPhoto = false;
function labelCheckState() {
  const need = requiredLabelColor($('artikel').value);
  if (!need) return { kind: 'none' };
  if (!formHasPhoto) return { kind: 'info', need };
  if (!formLabelColor) return { kind: 'unsure', need };
  return { kind: formLabelColor === need ? 'ok' : 'bad', need, got: formLabelColor };
}
function renderLabelCheck() {
  const s = labelCheckState(), el = $('labelCheck');
  el.hidden = s.kind === 'none';
  el.className = 'label-check ' + s.kind;
  const up = s.need?.toUpperCase();
  el.textContent = {
    none: '',
    info: `Etikett muss ${up} sein – bitte prüfen.`,
    unsure: `Etikettfarbe nicht sicher erkannt – muss ${up} sein, bitte prüfen.`,
    ok: `✓ Etikett ${s.need} – passt.`,
    bad: `Achtung: Dieser Artikel braucht ein ${LABEL_ADJ[s.need]?.toUpperCase()} Etikett – erkannt: ${s.got}.`,
  }[s.kind];
}
$('artikel').addEventListener('input', renderLabelCheck);

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
    let r = parseLabel(lines, codes.map(c => c.text));
    try { r.labelColor = classifyLabelColor(sampleLabel(canvas, codes)); } catch (err) { console.warn(err); }
    if (mode === 'pick' && pick) r = applyPicklist(r, codes.map(c => c.text), pick.lines);
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
    const rows = [['Artikelnummer', 'Bezeichnung 1', 'Bezeichnung 2', 'Charge', 'Menge', 'Einheit', 'Lagerplatz', 'Erfasst am', 'Erfasst von'],
      ...list.map(e => [e.artikel, e.bez1, e.bez2, e.charge, e.menge ?? '', e.einheit ?? '', e.lagerplatz ?? '', new Date(e.ts).toLocaleString('de-DE'), e.picker ?? ''])];
    const ws = XLSX.utils.aoa_to_sheet(rows); // IDs/Text bleiben Text (führende Nullen, keine Formeln), Menge bleibt eine echte Zahl
    for (const k in ws) if (k[0] !== '!' && ws[k].t === 's') ws[k].z = '@';
    ws['!cols'] = [{ wch: 16 }, { wch: 34 }, { wch: 34 }, { wch: 14 }, { wch: 10 }, { wch: 8 }, { wch: 16 }, { wch: 20 }, { wch: 16 }];
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

/* ---------- Update-Hinweis (wie MeinMoney) ---------- */
// Die App startet aus dem Service-Worker-Cache. Im Hintergrund wird geprüft, ob online eine neuere Version liegt
// (index.html verrät sie per app.js?v=...). Dann erscheint "Neue Version verfügbar" mit Knopf.
let lastUpdCheck = 0;
async function checkUpdate() {
  if (Date.now() - lastUpdCheck < 10 * 60 * 1000 || !navigator.onLine) return;
  lastUpdCheck = Date.now();
  try {
    const r = await fetch('index.html?nocache=' + Date.now(), { cache: 'no-store' });
    if (!r.ok) return;
    const v = ((await r.text()).match(/app\.js\?v=([\w.-]+)/) || [])[1];
    if (v && v !== APP_VERSION) $('update').hidden = false;
  } catch {}
}
async function applyUpdate() {
  try {
    // frische Seite direkt in den Cache legen, sonst zeigt der Service Worker beim Neuladen noch die alte
    const fresh = await fetch('index.html?nocache=' + Date.now(), { cache: 'no-store' });
    if ('caches' in window && fresh.ok) {
      for (const k of (await caches.keys()).filter(x => x.startsWith('lagerbuddy-'))) { // beim SW-Wechsel kurz zwei Stände
        const c = await caches.open(k);
        await c.put(new Request(new URL('index.html', location.href)), fresh.clone());
        await c.put(new Request(new URL('./', location.href)), fresh.clone());
      }
    }
  } catch {}
  location.reload();
}
$('updBtn').onclick = applyUpdate;
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') setTimeout(checkUpdate, 1500); });
$('ver').textContent = 'v' + APP_VERSION;
if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) navigator.serviceWorker.register('sw.js').catch(() => {});

/* ---------- Zugang: wer nutzt das Handy gerade? ---------- */
// Bei JEDEM Öffnen der App muss ein Kürzel gewählt werden -- gedacht für ein geteiltes Lagerhandy, das
// reihum genutzt wird, nicht für ein privates Gerät mit dauerhaftem Login. Die zwei Teamleiter-Kürzel
// brauchen zusätzlich ein Passwort (Kürzel + "4567"); das schaltet die Pickliste-Verwaltung frei
// (Excel/Foto laden, ersetzen, verwerfen). Picker ohne Passwort können weiter scannen/picken/exportieren.
// Das läuft komplett im Browser -- kein Server, kein Schutz gegen jemanden, der den Quelltext liest oder
// localStorage im Gerät ausliest. Für echte Zugriffskontrolle bräuchte es ein Backend.
const PICKERS = ['AA', 'DR', 'SB']; // weitere Kürzel folgen
const MASTERS = ['CMue', 'MD']; // Passwort je Kürzel: Kürzel + "4567"
const LOCK_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>';

function login(code, r) {
  picker = code; role = r;
  $('gate').hidden = true;
  renderPicker(); applyRoleUI();
}
function loginMaster(code) {
  for (let i = 0; i < 3; i++) {
    const pw = prompt(`Passwort für ${code}:`);
    if (pw === null) return; // abgebrochen, Gate bleibt offen
    if (pw === code + '4567') { login(code, 'master'); return; }
    toast('Falsches Passwort.');
  }
}
function buildGate() {
  const mk = (code, master) => {
    const b = document.createElement('button');
    b.className = 'btn' + (master ? ' gate-master' : ''); b.type = 'button';
    if (master) b.innerHTML = LOCK_ICON;
    b.append(code);
    b.onclick = () => master ? loginMaster(code) : login(code, 'picker');
    return b;
  };
  $('gatePickers').replaceChildren(...PICKERS.map(c => mk(c, false)));
  $('gateMasters').replaceChildren(...MASTERS.map(c => mk(c, true)));
}
function renderPicker() {
  $('pickerBtn').textContent = picker;
  $('pickerBtn').classList.toggle('is-master', role === 'master');
}
$('pickerBtn').onclick = () => { $('gate').hidden = false; }; // Gerät an jemand anderen weitergeben
// Master-only: Pickliste per EXCEL laden/ersetzen, und verwerfen. Per FOTO laden/ersetzen ist für alle offen
// (die gedruckte Liste landet oft direkt beim Picker). Scannen/Picken/Export bleiben ohnehin für alle offen.
function applyRoleUI() {
  const isMaster = role === 'master';
  for (const id of ['pickChoose', 'pickReplace', 'pickClear']) $(id).hidden = !isMaster;
  $('pickHintMaster').hidden = !isMaster;
  $('pickBar').hidden = mode !== 'pick' || !isMaster;
  if (mode === 'pick') renderPick(); // Charge-Felder/Freigabe-Knopf hängen an der Rolle
}
buildGate();
if (window.__testLogin) login(window.__testLogin.code, window.__testLogin.role); // nur für die Testsuite, siehe fixtures.mjs

$('modeSwitch').hidden = !PICK_ENABLED;
render();
setTimeout(checkUpdate, 1500);
