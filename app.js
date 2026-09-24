'use strict';
/* LagerBuddy: Etikett fotografieren -> Barcodes + Text lokal auf dem Handy lesen -> Liste -> Excel.
   Alle Bibliotheken liegen in vendor/, kein Foto verlässt das Gerät. Nur Picklisten (Positionen, Zuteilung,
   Buchungen) werden über Supabase zwischen den Handys abgeglichen, wenn SYNC unten eingerichtet ist. */
const APP_VERSION = '2026-09-24.3'; // bei JEDER Veröffentlichung erhöhen, genauso wie ?v= in index.html
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
const KEY_PICK = 'lagerbuddy_pick_v1'; // alt: genau eine Pickliste
const KEY_PICKS = 'lagerbuddy_picks_v1'; // alt: mehrere Picklisten, nur auf diesem Handy
const KEY_SYNC = 'lagerbuddy_picks_v2'; // { base, pending, seit }, siehe "Abgleich" unten
const KEY_LAGER = 'lagerbuddy_lager'; // Lager-Code dieses Handys (einmal eingeben)
// Supabase-Projekt, über das die Handys ihre Picklisten abgleichen (Einrichtung: supabase/ANLEITUNG.md).
// Der Schlüssel ist der öffentliche "publishable"/"anon"-Schlüssel -- geschützt wird über den Lager-Code.
// Leer = kein Abgleich, Picklisten bleiben nur auf diesem Handy.
const SYNC = window.__testSync || { url: '', key: '' };
const SYNC_ON = !!(SYNC.url && SYNC.key);
const FIELDS = ['artikel', 'bez1', 'bez2', 'charge'];
const fmtN = n => n.toLocaleString('de-DE');
const PICK_ENABLED = true;
const CODE_OK = /^[0-9A-Z][0-9A-Z\-. $\/+%]{0,39}$/; // Code39-Zeichensatz, Länge gedeckelt gegen Unsinn auf einem manipulierten Etikett
const $ = id => document.getElementById(id);
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

try { navigator.storage?.persist?.(); } catch {} // hilft gegen Löschen durch den Browser nach längerer Nichtnutzung

let list = load();
let sync = loadSync();
let picks = []; // aktueller Stand aller Picklisten = Serverstand + eigene, noch nicht übertragene Änderungen
let openId = null; // id der geöffneten Pickliste, null = Übersicht
let pick = null; // die geöffnete Pickliste aus picks (nach jedem recompute neu gesetzt)
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
/* ---------- Abgleich der Picklisten zwischen den Handys ----------
   sync.base: letzter bekannter Serverstand je Liste { doc, rev, geloescht }
   sync.pending: eigene Änderungen als Operationen (picks.js), die der Server noch nicht bestätigt hat
   Angezeigt wird immer base + pending. Ohne Server (SYNC leer) wandern Änderungen sofort in base. */
function loadSync() {
  try {
    const v = JSON.parse(localStorage.getItem(KEY_SYNC));
    if (v && typeof v.base === 'object' && Array.isArray(v.pending)) return v;
  } catch {}
  // Stände von vor dem Abgleich übernehmen: als neue Listen, die beim nächsten Abgleich hochgeladen werden
  const s = { base: {}, pending: [], seit: '' };
  let old = [];
  try { old = JSON.parse(localStorage.getItem(KEY_PICKS)); if (!Array.isArray(old)) old = []; } catch {}
  try { const one = JSON.parse(localStorage.getItem(KEY_PICK)); if (!old.length && one) old = [{ fuer: '', ...one }]; } catch {}
  for (const p of old.filter(p => p && typeof p === 'object' && Array.isArray(p.lines))) {
    const doc = withLineIds({ ...p, id: p.id || newId(), fuer: p.fuer || '' }, newId);
    for (const l of doc.lines) { l.scans = l.scans || []; l.picked = l.picked || 0; }
    s.pending.push({ id: doc.id, op: { t: 'neu', doc } });
  }
  return s;
}
function saveSync() {
  try {
    localStorage.setItem(KEY_SYNC, JSON.stringify(sync));
    localStorage.removeItem(KEY_PICKS); localStorage.removeItem(KEY_PICK); // erst nach erfolgreichem Speichern im neuen Format
    return true;
  } catch { toast('Speichern fehlgeschlagen. Ist der Speicher voll?'); return false; }
}
function foldLocal() { // ohne Server: Änderungen sofort in den eigenen Stand übernehmen
  for (const { id, op } of sync.pending) {
    const b = sync.base[id], doc = applyOp(b && !b.geloescht ? b.doc : null, op);
    if (doc) sync.base[id] = { doc, rev: (b?.rev || 0) + 1 }; else delete sync.base[id];
  }
  sync.pending = [];
}
function recompute() {
  const docs = new Map();
  for (const [id, b] of Object.entries(sync.base)) if (!b.geloescht) docs.set(id, b.doc);
  for (const { id, op } of sync.pending) docs.set(id, applyOp(docs.get(id) ?? null, op));
  picks = [...docs].filter(([, d]) => d).map(([id, d]) => ({ ...d, id }));
  pick = picks.find(p => p.id === openId) || null;
}
// Jede Änderung an einer Pickliste läuft hier durch: merken, speichern, im Hintergrund zum Server schicken.
function commit(id, op) {
  const snap = JSON.stringify(sync);
  sync.pending.push({ id, op });
  if (!SYNC_ON) foldLocal();
  if (!saveSync()) { sync = JSON.parse(snap); return false; }
  recompute();
  if (SYNC_ON) setTimeout(push, 0);
  return true;
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

/* ---------- Server (Supabase-RPCs aus supabase/setup.sql) ---------- */
let lager = ''; try { lager = localStorage.getItem(KEY_LAGER) || ''; } catch {}
let tlAuth = null; // { kuerzel, pw } nach Teamleiter-Anmeldung, nur im Arbeitsspeicher -- der Server prüft es bei jeder Änderung
let syncErr = ''; // '' | 'offline' | 'zugang'
async function rpc(fn, args) {
  const headers = { apikey: SYNC.key, 'Content-Type': 'application/json' };
  if (/^eyJ/.test(SYNC.key)) headers.Authorization = 'Bearer ' + SYNC.key; // älterer "anon"-Schlüssel (JWT)
  const r = await withTimeout(fetch(`${SYNC.url}/rest/v1/rpc/${fn}`, { method: 'POST', headers, body: JSON.stringify(args), cache: 'no-store' }),
    15000, 'Server antwortet nicht');
  const body = await r.json().catch(() => null);
  if (!r.ok) {
    const m = String(body?.message || 'HTTP ' + r.status), kind = (m.match(/^lb_(zugang|teamleiter|daten)\b/) || [])[1] || 'server';
    throw Object.assign(new Error(m.replace(/^lb_\w+: /, '')), { kind });
  }
  return body;
}
const tlArgs = () => ({ tl_kuerzel: tlAuth?.kuerzel ?? null, tl_pw: tlAuth?.pw ?? null });
const fromRow = r => ({ doc: r.doc, rev: r.rev, geloescht: r.geloescht });
function syncFailed(err) {
  syncErr = err?.kind === 'zugang' ? 'zugang' : 'offline';
  if (err?.kind === 'zugang') lagerUngueltig();
  else if (err?.kind === 'server') console.warn(err);
}

// Eigene Änderungen hochladen. Konflikt (ein anderes Handy war schneller): der Server schickt seinen Stand,
// die eigenen Operationen werden darauf neu angewendet und nochmal gesendet.
let pushing = null;
function push() {
  if (!SYNC_ON || !lager) return Promise.resolve();
  // .finally läuft immer asynchron, also nach der Zuweisung -- eine async-Funktion ohne await wäre sonst schon
  // fertig, bevor "pushing" gesetzt ist, und würde für immer als "läuft noch" hängen bleiben
  if (!pushing) pushing = pushNow().finally(() => { pushing = null; });
  return pushing;
}
async function pushNow() {
  let changed = false;
  try {
    for (let guard = 0; sync.pending.length && guard < 50; guard++) {
      const id = sync.pending[0].id, batch = sync.pending.filter(p => p.id === id);
      const b = sync.base[id];
      let doc = b && !b.geloescht ? b.doc : null;
      for (const { op } of batch) doc = applyOp(doc, op);
      let res = null;
      try {
        if (doc) res = await rpc('lb_speichern', { lager, id, doc, basis: b?.rev || 0, ...tlArgs() });
        else if (b && !b.geloescht) res = await rpc('lb_loeschen', { lager, id, ...tlArgs() });
      } catch (err) {
        if (err.kind !== 'teamleiter' && err.kind !== 'daten') throw err;
        toast('Vom Server abgelehnt: ' + err.message); // nicht endlos wiederholen, Änderung verfällt
        res = { ok: true };
      }
      if (res?.row) sync.base[id] = fromRow(res.row);
      if (!res || res.ok) sync.pending = sync.pending.filter(p => !batch.includes(p));
      saveSync(); changed = true;
    }
    syncErr = '';
  } catch (err) { syncFailed(err); }
  finally {
    if (changed) { recompute(); renderPickSafe(); }
    renderSyncState();
  }
}

// Änderungen der anderen Handys holen: seit dem letzten Abgleich (Server gibt 2 Min. Überlappung dazu),
// ohne "seit" alles -- dann fliegen auch Listen raus, die es auf dem Server nicht mehr gibt.
async function pull(full) {
  if (!SYNC_ON || !lager) return;
  let rows;
  try { rows = await rpc('lb_liste', { lager, seit: full || !sync.seit ? null : sync.seit }); }
  catch (err) { syncFailed(err); renderSyncState(); return; }
  syncErr = '';
  const before = new Set(picks.map(p => p.id)), wasOpen = openId;
  let changed = false;
  if (full || !sync.seit) {
    const ids = new Set(rows.map(r => r.id));
    for (const id of Object.keys(sync.base)) if (!ids.has(id)) { delete sync.base[id]; changed = true; }
  }
  for (const r of rows) {
    if (!sync.base[r.id] || r.rev > sync.base[r.id].rev) { sync.base[r.id] = fromRow(r); changed = true; }
    if (!sync.seit || r.geaendert > sync.seit) sync.seit = r.geaendert;
  }
  saveSync();
  if (changed) {
    recompute();
    if (wasOpen && !pick) { openId = null; toast('Diese Pickliste wurde vom Teamleiter verworfen.'); }
    else if (pick && !sichtbar(pick)) { openId = null; toast(`Diese Pickliste wurde an ${pick.fuer} umgeteilt.`); pick = null; }
    const neu = visiblePicks().filter(p => !before.has(p.id) && !pickDone(p) && role !== 'master');
    if (neu.length && picker) toast(`Neue Pickliste für ${picker}: ${neu[0].name}`);
    renderPickSafe();
  }
  renderSyncState();
}
async function syncNow(full) { await push(); await pull(full); }

// alle 5 s in der Pickliste, sonst alle 30 s; nur mit sichtbarer App und angemeldetem Nutzer
let lastSync = 0;
setInterval(() => {
  if (!SYNC_ON || !lager || !picker || document.visibilityState !== 'visible') return;
  if (mode !== 'pick' && Date.now() - lastSync < 30000) return;
  lastSync = Date.now(); syncNow(false);
}, 5000);
window.addEventListener('online', () => { if (picker) syncNow(false); });

function renderSyncState() {
  const el = $('syncState');
  el.hidden = !SYNC_ON;
  if (!SYNC_ON) return;
  const n = sync.pending.length, warten = n === 1 ? '1 Änderung wartet' : `${n} Änderungen warten`;
  el.className = 'sync-state' + (syncErr || n ? ' warn' : '');
  el.textContent = syncErr === 'offline' ? `Offline – ${n ? warten + ' auf Netz' : 'zeigt den letzten Stand'}`
    : syncErr === 'zugang' ? 'Lager-Code ungültig – bitte neu anmelden'
    : n ? `Wird übertragen … (${warten})` : '✓ Mit allen Handys abgeglichen';
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
  $('pickBar').hidden = true; // im Pickliste-Modus entscheidet renderPick
  if (m === 'pick') renderPick();
  else { $('scan').hidden = false; $('galBtn').hidden = $('manual').hidden = false; $('camText').textContent = 'Etikett fotografieren'; }
}
$('modeScan').onclick = () => setMode('scan');
$('modePick').onclick = () => setMode('pick');

/* ---------- Pickliste ---------- */
// Teamleiter lädt eine Pickliste und teilt sie einem Picker zu; der Picker sieht nach seiner Anmeldung nur die
// eigenen Listen. Alles liegt in localStorage dieses Handys -- Zuteilen und Abarbeiten klappt also nur auf
// demselben (geteilten) Lagerhandy, nicht über mehrere Geräte hinweg.
const pickDone = p => !!p.freigabe || p.lines.every(l => l.picked >= l.required);
const sichtbar = p => role === 'master' || !p.fuer || p.fuer === picker;
const visiblePicks = () => picks.filter(sichtbar)
  .sort((a, b) => pickDone(a) - pickDone(b) || b.importedAt - a.importedAt); // offene zuerst, neueste oben
function openPick(p) {
  openId = p?.id ?? null; pick = p || null;
  renderPick();
  window.scrollTo({ top: 0 });
}
function fillPickerSelect(sel, value, placeholder) {
  const opts = [];
  if (placeholder) { const o = new Option(placeholder, ''); o.disabled = true; opts.push(o); }
  for (const c of [...PICKERS, ...MASTERS]) opts.push(new Option(c, c));
  if (value && !opts.some(o => o.value === value)) opts.push(new Option(value, value)); // Kürzel, das es nicht mehr gibt
  sel.replaceChildren(...opts);
  sel.value = value || '';
}
function renderPickOverview() {
  const vis = visiblePicks(), isMaster = role === 'master';
  $('pickCardsHead').hidden = !vis.length;
  $('pickNone').hidden = !!vis.length || isMaster;
  $('pickCards').replaceChildren(...vis.map(p => {
    const li = document.createElement('li'); li.className = 'card' + (pickDone(p) ? ' done' : '');
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'entry';
    const done = p.lines.filter(l => l.picked >= l.required).length;
    const head = document.createElement('div'); head.className = 'nums';
    head.textContent = (pickDone(p) ? '✓ ' : '') + p.name;
    const sub = document.createElement('div'); sub.className = 'sub';
    sub.textContent = [p.fuer ? 'für ' + p.fuer : 'nicht zugeteilt', `${done} von ${p.lines.length} fertig`,
      new Date(p.importedAt).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' })].join(' · ');
    b.append(head, sub);
    b.onclick = () => openPick(p);
    li.append(b);
    return li;
  }));
  $('pickFuerRow').hidden = !isMaster;
  if (isMaster && !$('pickFuer').options.length) fillPickerSelect($('pickFuer'), '', 'Picker auswählen …');
}
// Abgleich im Hintergrund: nicht neu zeichnen, während jemand in der Pickliste tippt (Eingabe wäre weg) --
// dann erst, wenn das Feld verlassen wird.
let renderLater = false;
function renderPickSafe() {
  if (mode !== 'pick') return;
  const a = document.activeElement;
  if (a && $('pickView').contains(a) && /^(INPUT|SELECT)$/.test(a.tagName)) { renderLater = true; return; }
  renderPick();
}
$('pickView').addEventListener('focusout', () => { if (renderLater) { renderLater = false; setTimeout(renderPickSafe, 0); } });
function renderPick() {
  if (pick && (!picks.includes(pick) || !sichtbar(pick))) { pick = null; openId = null; } // verworfen oder umgeteilt
  renderSyncState();
  $('pickOverview').hidden = !!pick;
  $('pickBody').hidden = !pick;
  // ohne geöffnete Liste gibt es nichts zu buchen (sonst landet die Seite im Etikett-Leser); bei offenem Formular sowieso zu
  $('scan').hidden = !pick || !$('form').hidden;
  $('pickBar').hidden = mode !== 'pick' || role !== 'master' || !pick;
  // Picker scannen jedes Gebinde mit der Kamera: kein "Manuell erfassen", keine Galerie (dasselbe Foto nochmal)
  $('galBtn').hidden = $('manual').hidden = role !== 'master';
  $('camText').textContent = 'Gebinde scannen';
  if (!pick) { renderPickOverview(); return; }
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
  $('pickName').textContent = pick.name + (pick.fuer ? ' · für ' + pick.fuer : '');
  $('pickFuerEditRow').hidden = role !== 'master';
  if (role === 'master') fillPickerSelect($('pickFuerEdit'), pick.fuer, pick.fuer ? '' : 'nicht zugeteilt');
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
    const nScan = l.scans.filter(x => !x.manuell).length, nHand = l.scans.length - nScan;
    const count = document.createElement('div'); count.className = 'sub pick-count';
    count.textContent = (geb ? `Gebinde gescannt: ${nScan} von ${fmtN(geb)}` : `Gebinde gescannt: ${nScan}`) +
      (nHand ? ` · ${nHand}× von Hand (Teamleiter)` : '');
    li.append(head, prog, count);
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
      commit(pick.id, { t: 'feld', lid: l.lid, key: 'gebinde', v: v > 0 ? v : null });
      renderPick();
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
  commit(pick.id, { t: 'skip', lid: l.lid, skipped: { von: picker, ts: Date.now() } });
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
  commit(pick.id, { t: 'feld', lid: l.lid, key, v });
  renderPick();
}
$('pickApprove').onclick = () => {
  if (role !== 'master') { toast('Nur CMue oder MD können freigeben.'); return; }
  const open = pick.lines.filter(l => l.picked < l.required);
  if (!confirm(`Pickliste freigeben, obwohl ${open.length === 1 ? '1 Position fehlt' : open.length + ' Positionen fehlen'}?\n` +
    open.map(l => `${l.artikel}${l.charge ? ' · Charge ' + l.charge : ''}: ${fmtN(l.picked)} / ${fmtN(l.required)} ${l.einheit}`).join('\n'))) return;
  commit(pick.id, { t: 'freigabe', freigabe: { von: picker, ts: Date.now() } });
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
  // Gebinde-Pflicht: Picker buchen jedes Gebinde einzeln per Etikett-Scan (Artikel-Barcode muss erkannt sein).
  // Von Hand bucht nur der Teamleiter, als Notfall bei unlesbarem Etikett -- das bleibt an der Buchung sichtbar.
  const scanned = formScan, manuell = !scanned?.code;
  if (role !== 'master') {
    if (!scanned) { toast('In der Pickliste wird jedes Gebinde gescannt: bitte das Etikett fotografieren.'); return; }
    if (!scanned.code) { toast('Artikel-Barcode nicht erkannt. Bitte das Etikett nochmal scharf fotografieren – ohne Barcode bucht nur der Teamleiter von Hand.'); return; }
    if (line.gebinde && e.menge > line.gebinde + 0.001) {
      toast(`Ein Scan ist ein Gebinde: höchstens ${fmtN(line.gebinde)} ${line.einheit}. Weitere Gebinde einzeln scannen.`); return;
    }
  }
  if (scanned && picks.some(p => p.lines.some(l => l.scans.some(x => x.fp === scanned.fp)))) {
    toast('Dieses Foto wurde schon gebucht. Jedes Gebinde einzeln fotografieren.'); return;
  }
  // Gebindegröße bekannt (aus Liste oder von Hand eingetragen) und Menge weicht ab -> vermutlich falsches/angebrochenes
  // Gebinde erwischt oder vertippt, lieber einmal nachfragen statt stillschweigend falsch buchen
  if (line.gebinde && Math.abs(e.menge - line.gebinde) > 0.001 &&
      !confirm(`Falsche Menge? Ein Gebinde hat laut Liste ${fmtN(line.gebinde)} ${line.einheit}, erfasst wurden ${fmtN(e.menge)} ${e.einheit}. Trotzdem buchen?`)) return;
  const scan = { ts: e.ts, menge: e.menge, charge: e.charge, picker: e.picker, ...(scanned ? { fp: scanned.fp } : {}), ...(manuell ? { manuell: true } : {}) };
  if (!commit(pick.id, { t: 'scan', lid: line.lid, scan })) return;
  // Gebindegröße noch unbekannt: das erste gescannte Gebinde legt sie fest, ab dann gilt "ein Scan = ein Gebinde"
  if (!line.gebinde && !manuell) commit(pick.id, { t: 'feld', lid: line.lid, key: 'gebinde', v: e.menge });
  const l = pick.lines.find(x => x.lid === line.lid);
  renderPick(); closeForm();
  toast(l.picked >= l.required
    ? `Fertig: ${e.artikel} (${fmtN(l.picked)}/${fmtN(l.required)} ${l.einheit})`
    : `Gebucht: ${fmtN(e.menge)} ${e.einheit} für ${e.artikel} (${fmtN(l.picked)}/${fmtN(l.required)})`);
}
// target: { replaceId } = Positionen dieser Liste ersetzen (Zuteilung bleibt), sonst neue Liste für target.fuer
function applyParsedPicklist({ title, von, nach, lines, skipped }, sourceName, target, hinweis) {
  const data = withLineIds({ name: title ? `${title} · ${sourceName}` : sourceName, von, nach, importedAt: Date.now(), lines }, newId);
  // Liste während der Texterkennung verworfen: dann eben neu anlegen, mit derselben Zuteilung
  const replace = target.replaceId && picks.some(p => p.id === target.replaceId);
  const id = replace ? target.replaceId : newId();
  if (!commit(id, replace ? { t: 'ersetzen', data } : { t: 'neu', doc: { id, fuer: target.fuer || '', geladenVon: picker, ...data } })) return;
  if (!replace) $('pickFuer').value = ''; // nächste Liste bewusst neu zuteilen statt aus Versehen demselben Picker
  const p = picks.find(x => x.id === id);
  openPick(p);
  toast(`Pickliste geladen: ${lines.length} Artikel` + (role === 'master' && p.fuer ? ` für ${p.fuer}.` : '.') + (skipped ? ` ${skipped} Zeile(n) ohne Menge übersprungen.` : '') + (hinweis || ''));
}
async function loadPicklistFile(file, target) {
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
    applyParsedPicklist(parsePicklist(raw, fmt), file.name, target);
  } catch (err) {
    if (!err?.userMessage) console.error(err);
    toast(err instanceof Error && err.message.length < 120 ? err.message : 'Excel-Datei konnte nicht gelesen werden.');
  }
}
// Pickliste vom Papier fotografieren: Texterkennung liest die ganze Seite, die x-Position jedes Worts
// verrät die Tabellenspalte (picklistGridFromWords), danach läuft dieselbe Auswertung wie beim Excel-Import.
// Weniger zuverlässig als die Excel-Datei -- am Ende steht deshalb ein deutlicher Prüfhinweis.
async function loadPicklistPhoto(file, target) {
  // Für alle offen (nicht nur Teamleiter): die gedruckte Liste landet oft direkt beim Picker, ohne
  // vorher digital beim Teamleiter vorbeizukommen. Nur die Excel-Datei bleibt Teamleiter-only.
  if (!file || busy) return;
  if (file.size > 30 * 1024 * 1024) { toast('Foto ist zu groß (über 30 MB). Bitte erneut aufnehmen.'); return; }
  setBusy(true, 'Pickliste wird gelesen …');
  let canvas;
  try {
    canvas = deskew(await toCanvas(file, 3000)); // mehr Auflösung als beim Etikett: kleine Schrift über die ganze Seite
    const ctx = canvas.getContext('2d');
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    img.data.set(stripTableLines(img.data, canvas.width, canvas.height));
    ctx.putImageData(img, 0, 0);
    const worker = await getTessWorker();
    // PSM 11 = verstreute Textstücke statt Seitenlayout: eine Tabelle ist kein Fließtext
    await worker.setParameters({ tessedit_pageseg_mode: '11' });
    let r;
    try { r = await withTimeout(worker.recognize(canvas, { rotateAuto: true }), 120000, 'Texterkennung hat zu lange gedauert'); }
    finally { await worker.setParameters({ tessedit_pageseg_mode: '3' }); } // Etiketten lesen weiter mit Seitenlayout
    const grid = picklistGridFromWords(r.data.lines, canvas.width);
    if (!grid.length) throw pickErr('Keine Pickliste im Foto erkannt. Bitte die ganze Tabelle gerade von oben und bei gutem Licht fotografieren.');
    applyParsedPicklist(parsePicklist(grid, grid), file.name, target,
      ' Bitte die Zeilen unten prüfen – von einem Foto liest die App nicht so zuverlässig wie aus Excel.');
  } catch (err) {
    if (!err?.userMessage) console.error(err);
    toast(err?.userMessage || (err instanceof Error && err.message.length < 120) ? err.message : 'Foto konnte nicht gelesen werden.');
  } finally {
    setBusy(false);
    if (canvas) { canvas.width = 0; canvas.height = 0; }
  }
}
// Schräg gehaltenes Handy: Blatt gerade drehen, sonst erkennt stripTableLines die Tabellenlinien nicht mehr
// als Linien (Test: 5° schief -> Striche als "1" in Chargen/Artikelnummern). Winkel aus einem kleinen Vorschaubild.
function deskew(c) {
  const k = 600 / Math.max(c.width, c.height), s = document.createElement('canvas');
  s.width = Math.round(c.width * k); s.height = Math.round(c.height * k);
  s.getContext('2d').drawImage(c, 0, 0, s.width, s.height);
  const deg = skewAngle(s.getContext('2d').getImageData(0, 0, s.width, s.height).data, s.width, s.height);
  s.width = s.height = 0;
  if (Math.abs(deg) < 0.3) return c;
  const a = deg * Math.PI / 180, cos = Math.abs(Math.cos(a)), sin = Math.abs(Math.sin(a));
  const out = document.createElement('canvas');
  out.width = Math.round(c.width * cos + c.height * sin); out.height = Math.round(c.width * sin + c.height * cos);
  const ctx = out.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, out.width, out.height);
  ctx.translate(out.width / 2, out.height / 2); ctx.rotate(-a);
  ctx.drawImage(c, -c.width / 2, -c.height / 2);
  c.width = c.height = 0; // iOS: Canvas-Speicher sofort freigeben
  return out;
}
// Lagerplatz: von Excel-Titel vorbelegt ("Pickliste B4 -> Bühl"), hier jederzeit nachtragbar/korrigierbar
function savePickRoute() {
  if (!pick) return;
  commit(pick.id, { t: 'route', von: $('pickVon').value.trim(), nach: $('pickNach').value.trim() });
}
$('pickVon').addEventListener('change', savePickRoute);
$('pickNach').addEventListener('change', savePickRoute);
// Ziel beim Antippen festhalten (Datei-Dialog kommt erst später zurück): neue Liste für wen, oder welche ersetzen.
// Teamleiter müssen vorher einen Picker auswählen, ein Picker bekommt seine selbst fotografierte Liste selbst.
let pickTarget = null;
function newPickTarget() {
  if (role !== 'master') return { fuer: picker };
  const fuer = $('pickFuer').value;
  $('pickFuerRow').classList.toggle('missing', !fuer);
  if (!fuer) { toast('Bitte zuerst den Picker auswählen, der die Liste abarbeiten soll.'); $('pickFuer').focus(); return null; }
  return { fuer };
}
function choose(input, target) { if (target) { pickTarget = target; $(input).click(); } }
$('pickChoose').onclick = () => choose('pickFile', newPickTarget());
$('pickReplace').onclick = () => choose('pickFile', pick && { replaceId: pick.id, fuer: pick.fuer });
$('pickPhotoChoose').onclick = () => choose('pickCam', newPickTarget());
$('pickPhotoReplace').onclick = () => choose('pickCam', pick && { replaceId: pick.id, fuer: pick.fuer });
$('pickGalBtn').onclick = ev => { // <label> öffnet die Galerie selbst -- nur ohne Picker-Auswahl abfangen
  if (ev.target === $('pickGal')) return;
  const t = newPickTarget();
  if (t) pickTarget = t; else ev.preventDefault();
};
$('pickFuer').onchange = () => $('pickFuerRow').classList.remove('missing');
$('pickFile').onchange = ev => { const f = ev.target.files[0]; ev.target.value = ''; if (pickTarget) loadPicklistFile(f, pickTarget); };
$('pickCam').onchange = $('pickGal').onchange = ev => { const f = ev.target.files[0]; ev.target.value = ''; if (pickTarget) loadPicklistPhoto(f, pickTarget); };
$('pickFuerEdit').onchange = () => {
  if (role !== 'master' || !pick) return;
  const fuer = $('pickFuerEdit').value;
  if (commit(pick.id, { t: 'fuer', fuer })) toast(`Pickliste ist jetzt ${fuer} zugeteilt.`);
  renderPick();
};
$('pickBack').onclick = () => openPick(null);
$('pickClear').onclick = () => {
  if (role !== 'master') { toast('Nur CMue oder MD können die Pickliste verwerfen.'); return; }
  if (!pick || !confirm('Pickliste verwerfen? Der Fortschritt geht verloren.')) return;
  if (commit(pick.id, { t: 'weg' })) openPick(null);
};

/* ---------- Formular ---------- */
// Herkunft des Formulars: Etikett-Foto (mit/ohne erkannten Artikel-Barcode, Fingerabdruck der Datei) oder von Hand
let formScan = null;
function showForm(r, file, idx = null) {
  editIdx = idx;
  formScan = file ? { code: !!r.artikelCode, fp: `${file.name}|${file.size}|${file.lastModified}` } : null;
  $('formSubmit').textContent = idx !== null ? 'Änderung speichern' : mode === 'pick' ? 'Gebinde buchen' : 'Zur Liste hinzufügen';
  // Picker buchen in der Pickliste genau das, was der Barcode sagt -- nicht überschreibbar
  const lock = !!file && idx === null && mode === 'pick' && role !== 'master';
  for (const f of FIELDS) {
    $(f).value = r[f] || '';
    const fromCode = (f === 'artikel' && r.artikelCode) || (f === 'charge' && r.chargeCode);
    $(f).readOnly = !!(lock && fromCode);
    const t = $('t-' + f);
    t.className = file ? 'tag ' + (fromCode ? 'ok' : 'check') : 'tag';
    t.textContent = file ? (fromCode ? (lock ? 'aus Barcode · fest' : 'aus Barcode') : 'bitte prüfen') : '';
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
  if (mode === 'pick') renderPick(); // ohne geöffnete Pickliste bleibt der Etikett-Leser versteckt
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
// Bei JEDEM Öffnen der App muss ein Kürzel gewählt werden -- gedacht für Lagerhandys, die reihum genutzt
// werden, nicht für ein privates Gerät mit dauerhaftem Login. Die Teamleiter-Kürzel brauchen zusätzlich ein
// Passwort; das schaltet die Pickliste-Verwaltung frei (laden, zuteilen, freigeben, verwerfen).
// Mit Server (SYNC): Das Handy wird einmal mit dem Lager-Code eingerichtet, Teamleiter-Passwörter prüft der
// Server, und er lehnt Umteilen/Freigeben/Verwerfen ohne gültiges Teamleiter-Passwort ab.
// Ohne Server: alles nur im Browser (Passwort Kürzel + "4567"), kein Schutz gegen jemanden, der den Quelltext liest.
const PICKERS = ['AA', 'DR', 'SB']; // weitere Kürzel folgen
const MASTERS = ['CMue', 'MD']; // mit Server: Passwort in supabase/zugang.sql, sonst Kürzel + "4567"
const LOCK_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>';

function showGate() {
  const einrichten = SYNC_ON && !lager;
  $('lagerForm').hidden = !einrichten;
  $('gateWho').hidden = einrichten;
  $('gate').hidden = false;
  if (einrichten) setTimeout(() => $('lagerCode').focus(), 50);
}
function lagerUngueltig() {
  if (!lager) return;
  lager = ''; tlAuth = null;
  try { localStorage.removeItem(KEY_LAGER); } catch {}
  toast('Der Lager-Code gilt nicht mehr. Bitte neu eingeben.');
  showGate();
}
$('lagerForm').onsubmit = async ev => {
  ev.preventDefault();
  const code = $('lagerCode').value.trim();
  if (!code) return;
  $('lagerBtn').disabled = true;
  try {
    if (!(await rpc('lb_pruefen', { lager: code }))) { toast('Lager-Code falsch.'); return; }
    lager = code; $('lagerCode').value = '';
    try { localStorage.setItem(KEY_LAGER, code); } catch {}
    showGate();
  } catch { toast('Zum Einrichten braucht das Handy einmal Netz.'); }
  finally { $('lagerBtn').disabled = false; }
};

// Picker mit zugeteilter offener Pickliste landen direkt dort (bei genau einer gleich in der Liste)
function landen() {
  const open = role === 'master' ? [] : visiblePicks().filter(p => !pickDone(p));
  if (!open.length) return false;
  setMode('pick');
  if (open.length === 1) openPick(open[0]);
  toast(open.length === 1 ? `Pickliste für ${picker}: ${open[0].name}` : `${open.length} Picklisten für ${picker}`);
  return true;
}
function login(code, r) {
  picker = code; role = r;
  if (r !== 'master') tlAuth = null;
  $('gate').hidden = true;
  if (!$('form').hidden) closeForm(); // halb erfasstes Etikett gehört dem vorherigen Nutzer
  openId = null; pick = null;
  renderPicker(); applyRoleUI();
  const gelandet = landen();
  // frisch vom Server holen; war lokal noch nichts da, danach nochmal schauen
  if (SYNC_ON && lager) syncNow(true).then(() => { if (!gelandet && picker === code && !pick) landen(); });
}
async function loginMaster(code) {
  const pw = prompt(`Passwort für ${code}:`);
  if (pw === null) return; // abgebrochen, Gate bleibt offen
  if (!SYNC_ON) { if (pw === code + '4567') login(code, 'master'); else toast('Falsches Passwort.'); return; }
  try {
    if (!(await rpc('lb_teamleiter', { lager, kuerzel: code, pw }))) { toast('Falsches Passwort.'); return; }
    tlAuth = { kuerzel: code, pw };
    login(code, 'master');
  } catch (err) {
    if (err.kind === 'zugang') lagerUngueltig(); else toast('Die Teamleiter-Anmeldung braucht Netz. Bitte gleich nochmal versuchen.');
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
$('pickerBtn').onclick = showGate; // Gerät an jemand anderen weitergeben
// Master-only: Pickliste per EXCEL laden/ersetzen, und verwerfen. Per FOTO laden/ersetzen ist für alle offen
// (die gedruckte Liste landet oft direkt beim Picker). Scannen/Picken/Export bleiben ohnehin für alle offen.
function applyRoleUI() {
  const isMaster = role === 'master';
  for (const id of ['pickChoose', 'pickReplace', 'pickClear']) $(id).hidden = !isMaster;
  $('pickHintMaster').hidden = !isMaster;
  if (mode === 'pick') renderPick(); // Charge-Felder/Freigabe-Knopf/Picker-Auswahl/untere Leiste hängen an der Rolle
}
buildGate();
if (!SYNC_ON) { foldLocal(); if (Object.keys(sync.base).length) saveSync(); } // Altbestand ohne Server gleich übernehmen
recompute();
showGate();
if (window.__testLogin) login(window.__testLogin.code, window.__testLogin.role); // nur für die Testsuite, siehe fixtures.mjs

$('modeSwitch').hidden = !PICK_ENABLED;
render();
setTimeout(checkUpdate, 1500);
