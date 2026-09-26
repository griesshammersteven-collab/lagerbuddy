'use strict';
/* LagerBuddy: Etikett fotografieren -> Barcodes + Text lokal auf dem Handy lesen -> Liste -> Excel.
   Alle Bibliotheken liegen in vendor/, kein Foto verlässt das Gerät. Nur Picklisten (Positionen, Zuteilung,
   Buchungen) werden über Supabase zwischen den Handys abgeglichen, wenn SYNC unten eingerichtet ist. */
const APP_VERSION = '2026-09-26.1'; // bei JEDER Veröffentlichung erhöhen, genauso wie ?v= in index.html
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
const KEY_GEBINDE = 'lagerbuddy_gebinde_v1'; // gemerkte Menge/Einheit je Artikel: { ARTIKEL: { menge, einheit, ts } }
// Supabase-Projekt, über das die Handys ihre Picklisten abgleichen (Einrichtung: supabase/ANLEITUNG.md).
// Der Schlüssel ist der öffentliche "publishable"/"anon"-Schlüssel -- geschützt wird über den Lager-Code.
// Leer = kein Abgleich, Picklisten bleiben nur auf diesem Handy.
const SYNC = window.__testSync || { url: 'https://wmrecedjrfsqrbufgipz.supabase.co', key: 'sb_publishable_DMJFGsMnLTLspy4ETD1BKg_Xg-R4W2U' };
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
let tourDemo = []; // Beispiel-Picklisten, solange der Rundgang läuft (tour.js)
let picker = '', role = ''; // erst nach der Auswahl am Zugangs-Gate gültig, siehe ganz unten
let rang = '', bereiche = []; // picker | admin | hauptadmin, und welche Teile der App die Person sieht (Team, unten)
let mode = 'scan'; // 'scan' (freie Liste), 'pick' (Pickliste), 'lager' (Bestand) oder 'team' (Verwaltung, team.js)
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
  catch { toast('Nicht gespeichert: Der Speicher des Handys ist voll. Bitte Teamleiter informieren.'); return false; }
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
  } catch { toast('Nicht gespeichert: Der Speicher des Handys ist voll. Bitte Teamleiter informieren.'); return false; }
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
  picks.push(...tourDemo); // Beispiel-Picklisten, nur während des Rundgangs (tour.js), nie gespeichert oder übertragen
  pick = picks.find(p => p.id === openId) || null;
}
// Jede Änderung an einer Pickliste läuft hier durch: merken, speichern, im Hintergrund zum Server schicken.
function commit(id, op) {
  if (tourDemo.some(p => p.id === id)) return false; // Beispiel-Liste des Rundgangs: nichts buchen
  const snap = JSON.stringify(sync);
  sync.pending.push({ id, op });
  if (!SYNC_ON) foldLocal();
  if (!saveSync()) { sync = JSON.parse(snap); return false; }
  recompute();
  if (SYNC_ON) setTimeout(push, 0);
  return true;
}

let toastT;
// Anzeigedauer nach Länge (4 bis 12 s), damit auch lange Hinweise lesbar sind; Antippen schließt.
// Gleicher Text wie eben: erst leeren, dann setzen, sonst sagen Screenreader ihn kein zweites Mal an.
function toast(msg, { form = true } = {}) { // form: false = Meldung aus dem Abgleich, gehört nicht in den Formular-Hinweis
  const t = $('toast');
  // Formular offen: Hinweis zusätzlich über dem Buchen-Knopf stehen lassen (role=alert), bis weiter getippt wird
  const imForm = form && !$('form').hidden;
  if (imForm) { $('formFehler').textContent = msg; $('formFehler').hidden = false; }
  t.setAttribute('aria-hidden', String(imForm)); // sonst doppelt vorgelesen
  if (t.textContent === msg) { t.textContent = ''; requestAnimationFrame(() => { t.textContent = msg; }); } else t.textContent = msg;
  t.classList.add('on');
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('on'), Math.min(12000, Math.max(4000, msg.length * 70)));
}
// Jeder Tipp schließt den Hinweis und geht trotzdem durch (der Toast liegt sonst über „Gebinde buchen“)
document.addEventListener('pointerdown', () => { clearTimeout(toastT); $('toast').classList.remove('on'); }, true);
// Weich scrollen nur, wenn das System keine reduzierte Bewegung wünscht
const glatt = () => (matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth');
// Hintergrund für Tastatur und Screenreader sperren, solange Anmeldung oder Rundgang offen sind
function sperren(an) { for (const sel of ['header', 'main', '#bar']) document.querySelector(sel).inert = an; }

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
const TL_OPS = ['fuer', 'freigabe', 'weg', 'ersetzen'];
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
        // Nur Teamleiter-Änderungen (umteilen, freigeben, verwerfen, neu einlesen) abgelehnt, weil inzwischen ein
        // Picker angemeldet ist: genau die verwerfen, die Buchungen der Picker im selben Stapel aber behalten.
        const tlOps = err.kind === 'teamleiter' ? batch.filter(p => TL_OPS.includes(p.op.t)) : [];
        if (tlOps.length && tlOps.length < batch.length) {
          sync.pending = sync.pending.filter(p => !tlOps.includes(p));
          toast('Teamleiter-Änderung nicht gespeichert: Sie sind nicht mehr als Teamleiter angemeldet. Buchungen werden weiter übertragen.', { form: false });
          saveSync(); changed = true;
          continue;
        }
        toast(`Der Server hat die Änderung abgelehnt: ${err.message}. Bitte Teamleiter informieren.`, { form: false }); // nicht endlos wiederholen, Änderung verfällt
        res = { ok: true };
      }
      // Kaputter Stand auf dem Server (am Server vorbei geschrieben): nicht übernehmen und nicht endlos neu versuchen
      if (res?.row && !res.row.geloescht && !gueltig(res.row.doc)) { toast('Pickliste auf dem Server ist beschädigt. Ihre Änderung wurde nicht gespeichert. Bitte Teamleiter informieren.', { form: false }); res = { ok: true }; }
      // Antwort kann nach einem parallelen Abgleich eintreffen, der schon Neueres geholt hat: nicht zurückdrehen
      if (res?.row && res.row.rev >= (sync.base[id]?.rev || 0)) sync.base[id] = fromRow(res.row);
      if (!res || res.ok) sync.pending = sync.pending.filter(p => !batch.includes(p));
      saveSync(); changed = true;
    }
    if (typeof pushBewegungen === 'function') await pushBewegungen(); // Ein-/Ausbuchungen je Lagerplatz (lager.js)
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
    if (!r.geloescht && !gueltig(r.doc)) { console.warn('Pickliste übergangen, ungültig:', r.id); continue; } // legt sonst alle Handys lahm
    if (!sync.base[r.id] || r.rev > sync.base[r.id].rev) { sync.base[r.id] = fromRow(r); changed = true; }
    if (!sync.seit || r.geaendert > sync.seit) sync.seit = r.geaendert;
  }
  saveSync();
  if (changed) {
    recompute();
    if (wasOpen && !pick) { openId = null; toast('Diese Pickliste wurde vom Teamleiter verworfen.', { form: false }); }
    else if (pick && !sichtbar(pick)) { openId = null; toast(`Diese Pickliste wurde an ${pick.fuer} umgeteilt.`, { form: false }); pick = null; }
    const neu = visiblePicks().filter(p => !before.has(p.id) && !pickDone(p) && role !== 'master');
    if (neu.length && picker) toast(`Neue Pickliste für ${picker}: ${neu[0].name}`, { form: false });
    renderPickSafe();
  }
  renderSyncState();
}
async function syncNow(full) { await push(); await pull(full); ladeTeam(full); }

// alle 5 s in der Pickliste, sonst alle 30 s; nur mit sichtbarer App und angemeldetem Nutzer
let lastSync = 0;
setInterval(() => {
  if (!SYNC_ON || !lager || !picker || document.visibilityState !== 'visible' || tourDemo.length) return;
  if (mode !== 'pick' && Date.now() - lastSync < 30000) return;
  lastSync = Date.now(); syncNow(false);
  if (mode === 'lager') ladeBestand(); // Buchungen der anderen Handys
}, 5000);
window.addEventListener('online', () => { if (picker) syncNow(false); });

function renderSyncState() {
  const el = $('syncState');
  el.hidden = !SYNC_ON;
  if (!SYNC_ON) return;
  const n = sync.pending.length + (typeof bew === 'undefined' ? 0 : bew.offen.length), warten = n === 1 ? '1 Änderung wartet' : `${n} Änderungen warten`;
  el.className = 'sync-state' + (syncErr || n ? ' warn' : '');
  el.textContent = syncErr === 'offline' ? `Offline: ${n ? warten + ' auf Internet' : 'zeigt den letzten Stand'}`
    : syncErr === 'zugang' ? 'Lager-Code ungültig. Bitte neu anmelden.'
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
    edit.setAttribute('aria-label', `Eintrag bearbeiten: Artikel ${e.artikel || '–'}, Charge ${e.charge || '–'}`);
    edit.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>';
    edit.onclick = entry.onclick;
    const nums = document.createElement('div'); nums.className = 'nums';
    nums.append(e.artikel || '–', ' · Charge ');
    const b = document.createElement('b'); b.textContent = e.charge || '–'; nums.append(b);
    const del = document.createElement('button');
    del.className = 'del'; del.type = 'button';
    del.setAttribute('aria-label', `Eintrag löschen: Artikel ${e.artikel || '–'}, Charge ${e.charge || '–'}`);
    del.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>';
    del.onclick = () => {
      if (!confirm(`Eintrag löschen? Artikel ${e.artikel || '–'}, Charge ${e.charge || '–'}`)) return;
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
  for (const [id, k] of [['modeScan', 'scan'], ['modePick', 'pick'], ['modeLager', 'lager']]) {
    $(id).classList.toggle('active', m === k);
    $(id).setAttribute('aria-pressed', String(m === k));
  }
  $('freeListView').hidden = m !== 'scan';
  $('pickView').hidden = m !== 'pick';
  $('lagerView').hidden = m !== 'lager';
  $('teamView').hidden = m !== 'team';
  $('teamBtn').classList.toggle('active', m === 'team');
  $('teamBtn').setAttribute('aria-pressed', String(m === 'team'));
  document.title = { scan: 'Erfassen', pick: 'Pickliste', lager: 'Lager', team: 'Team verwalten' }[m] + ' · LagerBuddy';
  $('exportBar').hidden = m !== 'scan';
  $('pickBar').hidden = true; // im Pickliste-Modus entscheidet renderPick
  if (m === 'pick') { renderPick(); return; }
  if (m === 'team') { $('scan').hidden = true; renderTeam(); return; }
  // Erfassen und Lager: Wareneingang kommt mit fremden Etiketten (oft ohne unsere Barcodes) -- Galerie/von Hand für alle
  $('scan').hidden = false; $('galBtn').hidden = $('manual').hidden = false;
  $('camText').textContent = m === 'lager' ? 'Gebinde ein- oder ausbuchen' : 'Etikett fotografieren';
  if (m === 'lager') { renderLager(); ladeBestand(); }
}
$('modeScan').onclick = () => setMode('scan');
$('modePick').onclick = () => setMode('pick');
$('modeLager').onclick = () => setMode('lager');

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
  for (const p of team) if (p.aktiv) opts.push(new Option(p.kuerzel, p.kuerzel));
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
    b.onclick = () => openPick(picks.find(x => x.id === p.id) || null); // nach einem Abgleich gibt es p neu
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
  $('pickBanner').className = 'card pick-banner' + (complete ? ' done' : needsFreigabe ? ' warn' : '');
  $('pickBanner').textContent = missing === 0 ? '✓ Pickliste vollständig. Aufgabe erledigt.'
    : pick.freigabe ? `✓ Pickliste abgeschlossen: freigegeben von ${pick.freigabe.von}, ${fehlen}`
    : needsFreigabe ? `Übersprungen: ${fehlen}. Ein Teamleiter muss freigeben.`
    : `${done} von ${total} Positionen fertig`;
  $('pickApprove').hidden = !(needsFreigabe && role === 'master');
  $('pickExport').hidden = !(role === 'master' && pickDone(pick)); // fertige Liste: Teamleiter lädt das Ergebnis herunter
  $('pickName').textContent = pick.name + (pick.fuer ? ' · für ' + pick.fuer : '');
  $('pickFuerEditRow').hidden = role !== 'master';
  if (role === 'master') fillPickerSelect($('pickFuerEdit'), pick.fuer, pick.fuer ? '' : 'nicht zugeteilt');
  $('pickVon').value = pick.von || ''; $('pickNach').value = pick.nach || '';
  $('pickList').replaceChildren(...pick.lines.map((l, i) => {
    const li = document.createElement('li');
    const isDone = l.picked >= l.required;
    li.className = 'card pick-line' + (isDone ? ' done' : l === cur ? ' current' : ' waiting') + (!isDone && l.skipped ? ' skipped' : '');
    if (l === cur) li.setAttribute('aria-current', 'step');
    if (l === cur) {
      const now = document.createElement('div'); now.className = 'pick-now';
      now.textContent = l.skipped ? `Übersprungen · Position ${i + 1}: nachholen oder vom Teamleiter freigeben lassen` : `Jetzt buchen · Position ${i + 1} von ${total}`;
      li.append(now);
    }
    const head = document.createElement('div'); head.className = 'nums';
    head.textContent = l.artikel + (l.bez ? ' · ' + l.bez : '');
    const prog = document.createElement('div'); prog.className = 'sub';
    const geb = gebindeCount(l.required, l.gebinde);
    prog.textContent = (l.charge ? `Charge ${l.charge} · ` : '') + `${fmtN(l.picked)} / ${fmtN(l.required)} ${l.einheit}` +
      (geb ? ` · ca.\u00a0${fmtN(geb)}\u00a0Gebinde je ${fmtN(l.gebinde)}\u00a0${l.einheit}` : '');
    const zahl = x => x.anzahl || 1, aus = l.scans.filter(x => x.richtung !== 'ein'), auto = aus.filter(x => !x.manuell);
    const nScan = auto.reduce((s, x) => s + zahl(x), 0), nHand = aus.filter(x => x.manuell).reduce((s, x) => s + zahl(x), 0);
    const nEin = l.scans.filter(x => x.richtung === 'ein').reduce((s, x) => s + zahl(x), 0);
    const sammel = auto.filter(x => x.anzahl > 1), nBest = sammel.reduce((s, x) => s + x.anzahl - 1, 0);
    const count = document.createElement('div'); count.className = 'sub pick-count';
    count.textContent = (geb ? `Gebinde gescannt: ${nScan} von ${fmtN(geb)}` : `Gebinde gescannt: ${nScan}`) +
      (nBest ? ` · davon ${nBest} per Sammelbuchung (${[...new Set(sammel.map(x => x.picker || '–'))].join(', ')})` : '') +
      (nHand ? ` · ${nHand}× von Hand (Teamleiter)` : '') + (nEin ? ` · eingebucht: ${nEin}` : '');
    li.append(head, prog, count);
    if (l.hinweis) { const n = document.createElement('div'); n.className = 'sub pick-note'; n.textContent = l.hinweis; li.append(n); }
    li.append(baBlock(l, i, l === cur && !isDone));
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
    gebInput.type = 'text'; gebInput.inputMode = 'decimal'; gebInput.placeholder = 'leer';
    gebInput.value = l.gebinde ? String(l.gebinde).replace('.', ',') : '';
    gebInput.setAttribute('aria-label', `Gebindegröße für ${l.artikel}`);
    // steht sie einmal fest, ändert sie nur der Teamleiter -- sonst ließe sich "ein Scan = ein Gebinde" aushebeln
    gebInput.readOnly = !!l.gebinde && role !== 'master';
    gebInput.onchange = () => {
      const v = parseDe(gebInput.value);
      commit(pick.id, { t: 'feld', lid: l.lid, key: 'gebinde', v: v > 0 ? v : null });
      if (v > 0) merken(l.artikel, v, l.einheit, true);
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
// BA-Nr. (= Kunde) je Position: kommt aus dem Foto/Excel (darf leer sein), der Picker prüft sie gegen den Auftrag und
// bestätigt mit "Geprüft" -- vor dem ersten Gebinde der Position. Wer als Picker etwas einträgt, hat damit geprüft;
// ändert der Teamleiter, muss der Picker neu prüfen. Wer geprüft hat, steht an der Position und im Excel.
function baBlock(l, i, istDran) {
  const box = document.createElement('div');
  box.className = 'pick-ba' + (l.baOk ? ' ok' : '');
  const kopf = document.createElement('div'); kopf.className = 'pick-ba-head';
  const titel = document.createElement('span'); titel.textContent = 'BA-Nr. (Kunde)';
  const stand = document.createElement('span');
  stand.textContent = l.baOk ? `✓ geprüft von ${l.baOk.von || '–'}` : 'bitte prüfen';
  kopf.append(titel, stand); box.append(kopf);
  if (role === 'master' || istDran) {
    const grid = document.createElement('div'); grid.className = 'pick-ba-grid';
    const feld = (label, key) => { // Überschrift steht schon im Kasten, das Feld braucht keine zweite
      const lab = document.createElement('label');
      const inp = document.createElement('input');
      inp.type = 'text'; inp.spellcheck = false; inp.maxLength = 60; inp.value = l[key] || ''; inp.placeholder = 'leer';
      inp.setAttribute('aria-label', `${label} für Position ${i + 1} (${l.artikel})`);
      inp.onchange = () => setBaFeld(l, key, inp.value);
      lab.append(inp);
      return lab;
    };
    grid.append(feld('BA-Nr. (Kunde)', 'ba'));
    box.append(grid);
    if (!l.baOk) {
      const ok = document.createElement('button');
      ok.type = 'button'; ok.className = 'btn pick-ba-ok'; ok.textContent = '✓ Geprüft';
      ok.onclick = () => { baGeprueft(l); renderPick(); $('cam').focus({ preventScroll: true }); };
      box.append(ok);
    }
  } else {
    const t = document.createElement('div'); t.className = 'pick-ba-text';
    t.textContent = `BA-Nr.: ${l.ba || 'noch leer'}`;
    box.append(t);
  }
  return box;
}
const baGeprueft = l => commit(pick.id, { t: 'feld', lid: l.lid, key: 'baOk', v: { von: picker, ts: Date.now() } });
function setBaFeld(l, key, raw) {
  const v = raw.trim().replace(/\s+/g, ' ').slice(0, 60);
  if ((l[key] || '') === v) return;
  commit(pick.id, { t: 'feld', lid: l.lid, key, v });
  if (role === 'master') commit(pick.id, { t: 'feld', lid: l.lid, key: 'baOk', v: null }); // Picker prüft neu
  else baGeprueft(l); // selbst eingetragen = geprüft
  renderPick();
}
// Vor dem ersten Gebinde einer Position: BA-Nr. bestätigen lassen (OK = geprüft, auf das eigene Kürzel)
function baBestaetigen(l) {
  if (l.baOk) return true;
  if (!confirm(`BA-Nr. (Kunde) prüfen\nPosition ${pick.lines.indexOf(l) + 1} · ${l.artikel}\nBA-Nr.: ${l.ba || '(leer)'}\n\n` +
    `Stimmt sie mit dem Auftrag überein?\nOK = ja, geprüft (${picker})\nAbbrechen = erst bei der Position korrigieren`)) return false;
  return baGeprueft(l);
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
  if (role !== 'master') { toast('Nur Teamleiter können Positionen ändern.'); renderPick(); return; }
  let v = raw.trim().replace(/\s+/g, ' ');
  if (key === 'artikel') {
    v = v.replace(/\s+/g, '');
    if (!v) { toast('Die Artikelnummer darf nicht leer sein.'); renderPick(); return; }
  }
  if (key === 'required') {
    v = parseDe(v);
    if (!(v > 0)) { toast('Bitte eine Menge größer 0 eintragen.'); renderPick(); return; }
  }
  commit(pick.id, { t: 'feld', lid: l.lid, key, v });
  renderPick();
}
$('pickApprove').onclick = () => {
  if (role !== 'master') { toast('Nur Teamleiter können freigeben.'); return; }
  const open = pick.lines.filter(l => l.picked < l.required);
  if (!confirm(`Pickliste freigeben, obwohl ${open.length === 1 ? '1 Position fehlt' : open.length + ' Positionen fehlen'}?\n` +
    open.map(l => `${l.artikel}${l.charge ? ' · Charge ' + l.charge : ''}: ${fmtN(l.picked)} / ${fmtN(l.required)} ${l.einheit}`).join('\n') +
    '\n\nDie Pickliste wird damit abgeschlossen.')) return;
  commit(pick.id, { t: 'freigabe', freigabe: { von: picker, ts: Date.now() } });
  renderPick();
};
function addPick(e) {
  const lines = pick?.lines || [];
  const line = currentPickLine();
  const sameArt = l => normArt(l.artikel) === normArt(e.artikel);
  if (!lines.some(sameArt)) { toast('Dieser Artikel steht nicht auf der Pickliste.'); return; }
  // Umlagern: Ausbuchen = aus dem Lagerplatz holen (zählt als gepickt), Einbuchen = am Ziel einlagern (eigener Zähler)
  const lp = lpWert(); if (!lp) return; // der Reihe nach: erst Lagerplatz, dann Ein/Aus -- ein Hinweis zur Zeit
  const richtung = richtungWert(); if (!richtung) return;
  if (richtung === 'ein') { einPick(e, lp); return; }
  if (!line) { toast(pick.freigabe ? 'Die Pickliste ist schon freigegeben und abgeschlossen.' : 'Die Pickliste ist schon vollständig.'); return; }
  const nochmal = `Bitte der Reihe nach: zuerst ${line.artikel}${line.charge ? ' · Charge ' + line.charge : ''} buchen.`;
  if (!sameArt(line)) { toast(nochmal); return; }
  if (line.charge && normCharge(line.charge) !== normCharge(e.charge)) {
    // gleicher Artikel, aber die Charge einer späteren Position -> nicht vorziehen
    if (lines.some(l => l !== line && sameArt(l) && l.charge && normCharge(l.charge) === normCharge(e.charge))) { toast(nochmal); return; }
    if (!confirm(`Charge passt nicht zur Position.\nErwartet: ${line.charge}\nErfasst: ${e.charge || '(leer)'}\n\nOK = trotzdem buchen\nAbbrechen = nicht buchen`)) return;
  }
  if (line.einheit !== e.einheit) { toast(`Falsche Einheit: für diesen Artikel wird ${line.einheit} erwartet.`); return; }
  if (!baBestaetigen(line)) return;
  // Gebinde-Pflicht: Picker buchen jedes Gebinde einzeln per Etikett-Scan (Artikel-Barcode muss erkannt sein).
  // Von Hand bucht nur der Teamleiter, als Notfall bei unlesbarem Etikett -- das bleibt an der Buchung sichtbar.
  const scanned = formScan, manuell = !scanned?.code;
  if (role !== 'master') {
    if (!scanned) { toast('In der Pickliste wird jedes Gebinde gescannt: bitte das Etikett fotografieren.'); return; }
    if (!scanned.code) { toast('Barcode nicht erkannt. Etikett noch einmal scharf fotografieren. Geht es nicht, bucht der Teamleiter von Hand.'); return; }
    if (line.gebinde && e.menge > line.gebinde + 0.001) {
      toast(`Ein Scan ist ein Gebinde: höchstens ${fmtN(line.gebinde)} ${line.einheit}. Weitere Gebinde einzeln scannen.`); return;
    }
  }
  if (scanned && picks.some(p => p.lines.some(l => l.scans.some(x => x.fp === scanned.fp)))) {
    toast('Dieses Foto wurde schon gebucht. Jedes Gebinde einzeln fotografieren.'); return;
  }
  // Gebindegröße: die der Position, sonst die gemerkte aus früheren Listen -- für die gelten dieselben Prüfungen
  // (Anbruch-Rückfrage, Sammelbuchung nur mit vollen Gebinden), und wer sie für falsch hält, korrigiert sie an der Position.
  const geb = line.gebinde || (formVorschlag?.einheit === line.einheit && formVorschlag.geb) || 0;
  const korrigieren = line.gebinde ? '' : ' Stimmt die gemerkte Gebindegröße nicht, bei der Position unter „Gebindegröße“ korrigieren.';
  const anzahl = anzahlWert();
  if (anzahl > 1) {
    const offen = Math.round((line.required - line.picked) * 1000) / 1000;
    if (geb && Math.abs(e.menge - geb) > 0.001) {
      toast(`Mehrere Gebinde auf einmal nur mit vollen Gebinden (${fmtN(geb)} ${line.einheit}). Einen Anbruch einzeln scannen.${korrigieren}`); return;
    }
    if (anzahl * e.menge > offen + 0.001) {
      toast(`Offen sind nur noch ${fmtN(offen)} ${line.einheit}: höchstens ${Math.floor((offen + 0.001) / e.menge)} Gebinde.`); return;
    }
    const summe = Math.round(anzahl * e.menge * 1000) / 1000;
    if (!confirm(`${anzahl} gleiche Gebinde je ${fmtN(e.menge)} ${e.einheit} = ${fmtN(summe)} ${e.einheit} als gepickt bestätigen?\n\n` +
      `Gebucht auf ${picker}. Mit OK bestätigen Sie, alle ${anzahl} Gebinde geprüft zu haben (Artikel, Charge, Menge).`)) return;
  }
  // Gebindegröße bekannt und Menge weicht ab -> Anbruch oder vertippt: einmal nachfragen statt stillschweigend buchen.
  // Nicht beim letzten Gebinde, wenn genau der vorgeschlagene Rest der Position gebucht wird.
  const rest = Math.round((line.required - line.picked) * 1000) / 1000;
  // (nur mit Gebindegröße an der Position: eine bloß gemerkte könnte vertippt sein, dann lieber einmal nachfragen)
  const istRest = !!line.gebinde && e.menge < geb && Math.abs(e.menge - rest) < 0.001;
  if (geb && Math.abs(e.menge - geb) > 0.001 && !istRest &&
      !confirm((e.menge < geb
        ? `Weniger als ein volles Gebinde (Anbruch).\nVolles Gebinde: ${fmtN(geb)} ${line.einheit}\nErfasst: ${fmtN(e.menge)} ${e.einheit}\n\nOK = so buchen\nAbbrechen = Menge ändern`
        : `Mehr als ein volles Gebinde.\nVolles Gebinde: ${fmtN(geb)} ${line.einheit}\nErfasst: ${fmtN(e.menge)} ${e.einheit}\n\nOK = trotzdem buchen\nAbbrechen = Menge ändern`) +
        (korrigieren ? '\n\n' + korrigieren.trim() : ''))) return;
  const scan = { ts: e.ts, menge: e.menge, charge: e.charge, picker: e.picker, ...(anzahl > 1 ? { anzahl } : {}),
    ...(scanned ? { fp: scanned.fp } : {}), ...(manuell ? { manuell: true } : {}), lagerplatz: lp, richtung: 'aus' };
  if (!commit(pick.id, { t: 'scan', lid: line.lid, scan })) return;
  const bestandHinweis = lagerBewegung({ ts: e.ts, lagerplatz: lp, richtung: 'aus', quelle: 'pickliste', pick_id: pick.id, artikel: line.artikel,
    bez: line.bez || e.bez1 || '', charge: e.charge || line.charge || '', menge: e.menge * anzahl, gebinde: anzahl, einheit: line.einheit, picker: e.picker });
  // Gebindegröße noch unbekannt: das erste gescannte Gebinde legt sie fest, ab dann gilt "ein Scan = ein Gebinde".
  // War eine Größe gemerkt (anderes Handy/andere Liste) und das erste Gebinde ist ein Anbruch, gilt die gemerkte.
  const vollGeb = geb && e.menge <= geb ? geb : e.menge;
  if (!line.gebinde && !manuell) commit(pick.id, { t: 'feld', lid: line.lid, key: 'gebinde', v: vollGeb });
  if (!manuell) merken(line.artikel, line.gebinde || vollGeb, line.einheit, true); // an der Position festgelegt: gilt
  const l = pick.lines.find(x => x.lid === line.lid);
  renderPick(); closeForm();
  toast((l.picked >= l.required
    ? `Fertig: ${e.artikel} (${fmtN(l.picked)}/${fmtN(l.required)} ${l.einheit})`
    : `Gebucht: ${anzahl > 1 ? anzahl + ' × ' : ''}${fmtN(e.menge)} ${e.einheit} für ${e.artikel} (${fmtN(l.picked)}/${fmtN(l.required)})`) +
    ` · aus ${lp}` + bestandHinweis);
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
  toast(`Pickliste geladen: ${lines.length === 1 ? '1 Position' : lines.length + ' Positionen'}` + (role === 'master' && p.fuer ? ` für ${p.fuer}.` : '.') + (skipped ? ` ${skipped === 1 ? '1 Zeile' : skipped + ' Zeilen'} ohne Menge übersprungen.` : '') + (hinweis || ''));
}
async function loadPicklistFile(file, target) {
  if (!file) return;
  if (role !== 'master') { toast('Nur Teamleiter können eine Pickliste aus Excel laden.'); return; } // Knöpfe sind zwar schon versteckt, hier zusätzlich abgesichert
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
    // Blatt quer oder kopfüber fotografiert: Tesseract richtet nur leichte Schräglagen aus, keine 90°/180°.
    // Die Schriftrichtung verrät, ob das Blatt quer liegt; welche der zwei Drehungen stimmt, entscheidet die
    // Texterkennung selbst (die richtige ergibt eine Pickliste). Höchstens zwei Durchläufe.
    // Viertel im Uhrzeigersinn: quer -> erst 270° (Kopf zeigt meist nach rechts), dann 90°; sonst 0°, dann 180°.
    const versuche = verticalTextScore(img.data, canvas.width, canvas.height) > 0.8 ? [3, 1] : [0, 2];
    const worker = await getTessWorker();
    // PSM 11 = verstreute Textstücke statt Seitenlayout: eine Tabelle ist kein Fließtext
    await worker.setParameters({ tessedit_pageseg_mode: '11' });
    // Erfolg = eine gültige Pickliste kommt heraus, nicht nur irgendein Raster: in falscher Lage liest Tesseract
    // Kauderwelsch, das zufällig nach Tabelle aussehen kann (Test kopfüber)
    let parsed = null, fehler = null;
    try {
      for (const q of versuche) {
        if (q) setBusy(true, q === 2 ? 'Pickliste steht kopf. Sie wird gedreht …' : 'Pickliste liegt quer. Sie wird gedreht …');
        const cv = q ? rotateQuarter(canvas, q) : canvas;
        try {
          const r = await withTimeout(worker.recognize(cv, { rotateAuto: true }), 120000, 'Texterkennung hat zu lange gedauert');
          const grid = picklistGridFromWords(r.data.lines, cv.width);
          if (grid.length) parsed = parsePicklist(grid, grid);
        } catch (err) { if (!err?.userMessage) throw err; fehler = err; } // erwartbar (keine Menge-Spalte …): nächste Lage
        finally { if (cv !== canvas) cv.width = cv.height = 0; }
        if (parsed) break;
      }
    } finally { await worker.setParameters({ tessedit_pageseg_mode: '3' }); } // Etiketten lesen weiter mit Seitenlayout
    if (!parsed) throw fehler || pickErr('Keine Pickliste im Foto erkannt. Bitte die ganze Tabelle scharf und bei gutem Licht fotografieren.');
    applyParsedPicklist(parsed, file.name, target,
      ' Bitte jede Zeile unten prüfen: Fotos liest die App nicht so sicher wie Excel.');
  } catch (err) {
    if (!err?.userMessage) console.error(err);
    toast(err?.userMessage || (err instanceof Error && err.message.length < 120) ? err.message : 'Foto konnte nicht gelesen werden.');
  } finally {
    setBusy(false);
    if (canvas) { canvas.width = 0; canvas.height = 0; }
  }
}
// Bild um q Viertel im Uhrzeigersinn drehen (Blatt quer oder kopfüber fotografiert)
function rotateQuarter(c, q) {
  const out = document.createElement('canvas');
  [out.width, out.height] = q % 2 ? [c.height, c.width] : [c.width, c.height];
  const ctx = out.getContext('2d');
  ctx.translate(out.width / 2, out.height / 2); ctx.rotate(q * Math.PI / 2);
  ctx.drawImage(c, -c.width / 2, -c.height / 2);
  return out;
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
  if (role !== 'master') { toast('Nur Teamleiter können die Pickliste verwerfen.'); return; }
  if (!pick || !confirm('Pickliste verwerfen? Sie verschwindet auf allen Handys, der Fortschritt geht verloren.')) return;
  if (commit(pick.id, { t: 'weg' })) openPick(null);
};

/* ---------- Formular ---------- */
/* ---------- Menge pro Gebinde merken ---------- */
// Beim Scannen soll nur noch "Gebinde buchen" getippt werden: Menge und Einheit kommen aus dem Gedächtnis und
// müssen nur bei einem Anbruch geändert werden. Quellen, in dieser Reihenfolge:
//  1. Pickliste: Gebindegröße der Position (gleicht sich über alle Handys ab), Einheit immer aus der Liste
//  2. dieses Handy: zuletzt gebuchtes volles Gebinde des Artikels (auch im Modus "Erfassen")
//  3. andere Picklisten mit demselben Artikel (kommen über den Abgleich von den anderen Handys)
// Letztes Gebinde einer Position: ist der Rest kleiner als ein Gebinde, wird der Rest vorgeschlagen.
function loadGebinde() { try { const v = JSON.parse(localStorage.getItem(KEY_GEBINDE)); return v && typeof v === 'object' ? v : {}; } catch { return {}; } }
let gebindeMem = loadGebinde();
function gemerkt(artikel, einheit) {
  const a = normArt(artikel);
  if (!a) return null;
  const m = gebindeMem[a];
  if (m && m.menge > 0 && (!einheit || m.einheit === einheit)) return m;
  const aus = picks.flatMap(p => p.lines.filter(l => normArt(l.artikel) === a && l.gebinde > 0 && (!einheit || l.einheit === einheit))
    .map(l => ({ menge: l.gebinde, einheit: l.einheit, ts: p.importedAt || 0 }))).sort((x, y) => y.ts - x.ts)[0];
  return aus || null;
}
// Nur volle Gebinde merken: ein Anbruch (weniger als die gemerkte Größe) überschreibt nichts. Außer die Größe ist an
// einer Position festgelegt (fest = true, z. B. vom Teamleiter korrigiert): Sonst bliebe ein einmal vertipptes
// "250 statt 25" für immer auf dem Handy gemerkt.
function merken(artikel, menge, einheit, fest = false) {
  const a = normArt(artikel), alt = gebindeMem[a];
  if (!a || !(menge > 0) || (!fest && alt && alt.einheit === einheit && menge < alt.menge - 0.001)) return;
  gebindeMem[a] = { menge, einheit, ts: Date.now() };
  try { localStorage.setItem(KEY_GEBINDE, JSON.stringify(gebindeMem)); } catch {}
}
// { menge?, einheit, geb?, quelle: 'gebinde' | 'rest' | 'gemerkt' } oder null
function mengeVorschlag(artikel) {
  const a = normArt(artikel);
  if (!a) return null;
  if (mode === 'pick' && pick) {
    const cur = currentPickLine();
    const l = cur && normArt(cur.artikel) === a ? cur : pick.lines.find(x => normArt(x.artikel) === a && x.picked < x.required);
    if (l) {
      const geb = l.gebinde || gemerkt(a, l.einheit)?.menge;
      if (!geb) return { einheit: l.einheit };
      const rest = Math.round((l.required - l.picked) * 1000) / 1000;
      return rest > 0 && rest < geb - 0.001 ? { menge: rest, einheit: l.einheit, geb, quelle: 'rest' } : { menge: geb, einheit: l.einheit, geb, quelle: 'gebinde' };
    }
  }
  const m = gemerkt(a);
  return m ? { menge: m.menge, einheit: m.einheit, geb: m.menge, quelle: 'gemerkt' } : null;
}
let formVorschlag = null, mengeVonHand = false;
function fillMenge(r, einheitBehalten = false) {
  formVorschlag = mengeVorschlag(r.artikel);
  const v = formVorschlag;
  const menge = typeof r.menge === 'number' ? r.menge : v?.menge;
  $('menge').value = menge > 0 ? String(menge).replace('.', ',') : '';
  const einheit = r.einheit || v?.einheit;
  if (einheit || !einheitBehalten) for (const el of document.getElementsByName('einheit')) el.checked = el.value === einheit;
  mengeVonHand = false;
  renderMengeTag();
}
function renderMengeTag() {
  const v = formVorschlag, t = $('t-menge'), m = parseDe($('menge').value);
  let cls = '', txt = '';
  if (v?.geb && m > 0) {
    if (v.quelle === 'rest' && Math.abs(m - v.menge) < 0.001) { cls = 'check'; txt = 'Rest der Position'; }
    else if (Math.abs(m - v.geb) < 0.001) { cls = 'ok'; txt = 'gemerkt'; }
    else if (m < v.geb) { cls = 'check'; txt = `Anbruch · voll: ${fmtN(v.geb)}`; }
    else { cls = 'check'; txt = `mehr als 1 Gebinde (${fmtN(v.geb)})`; }
  }
  t.className = 'tag ' + cls; t.textContent = txt;
}
$('menge').addEventListener('input', () => { mengeVonHand = true; renderMengeTag(); });
// Artikelnummer von Hand eingetippt/korrigiert: Vorschlag nachziehen, solange die Menge nicht selbst geändert wurde
$('artikel').addEventListener('input', () => { if (!mengeVonHand && editIdx === null) fillMenge({ artikel: $('artikel').value }, true); });

/* ---------- Mehrere gleiche Gebinde auf einmal (Sammelbuchung) ---------- */
// Ein Gebinde wird gescannt (belegt Artikel und Charge per Barcode), weitere gleiche bestätigt der Picker mit der
// Anzahl -- statt 14-mal zu scannen. Die Buchung trägt Picker und Uhrzeit: passt etwas nicht, ist klar, wer bestätigt hat.
function anzahlWert() { const n = parseInt($('anzahl').value, 10); return n > 0 ? n : 1; }
function anzahlMax() { // so viele volle Gebinde passen noch in die offene Menge der aktuellen Position
  const l = currentPickLine(), m = parseDe($('menge').value);
  if (!l || !(m > 0) || normArt(l.artikel) !== normArt($('artikel').value)) return 0;
  return Math.floor((l.required - l.picked + 0.001) / m);
}
function renderAnzahl() {
  if ($('anzahlRow').hidden) return;
  const max = anzahlMax(), n = anzahlWert();
  $('anzAlle').hidden = max < 2;
  $('anzAlle').textContent = `Alle ${max}`;
  $('anzAlle').setAttribute('aria-label', `Alle ${max} offenen Gebinde`);
  $('t-anzahl').className = 'tag' + (n > 1 ? ' check' : '');
  $('t-anzahl').textContent = n > 1 ? 'Sammelbuchung' : '';
  $('formSubmit').textContent = n > 1 ? `${n} Gebinde buchen` : 'Gebinde buchen';
}
const setAnzahl = n => { $('anzahl').value = String(Math.max(1, n)); renderAnzahl(); };
$('anzMinus').onclick = () => setAnzahl(anzahlWert() - 1);
$('anzPlus').onclick = () => setAnzahl(anzahlWert() + 1);
$('anzAlle').onclick = () => setAnzahl(anzahlMax());
for (const id of ['anzahl', 'menge', 'artikel']) $(id).addEventListener('input', renderAnzahl);

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
  if (idx === null) fillMenge(r);
  else { // Eintrag bearbeiten: gespeicherte Werte zeigen, nichts vorschlagen
    formVorschlag = null; mengeVonHand = true;
    $('menge').value = typeof r.menge === 'number' ? String(r.menge).replace('.', ',') : '';
    for (const el of document.getElementsByName('einheit')) el.checked = el.value === r.einheit;
    renderMengeTag();
  }
  $('anzahlRow').hidden = !((mode === 'pick' || mode === 'lager') && idx === null);
  const lpModus = (mode === 'pick' || mode === 'lager') && idx === null; // Pickliste/Lager: Lagerplatz + Ein/Aus Pflicht
  $('lpRow').hidden = $('richtungRow').hidden = !lpModus;
  $('lpFreiRow').hidden = lpModus;
  if (lpModus) lpVorschlag(r);
  $('anzahl').value = '1';
  $('lagerplatz').value = r.lagerplatz || (mode === 'pick' && pick ? [pick.von, pick.nach].filter(Boolean).join(' → ') : '');
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = file ? URL.createObjectURL(file) : null;
  $('preview').hidden = !file;
  if (file) $('preview').src = previewUrl; else $('preview').removeAttribute('src');
  $('form').hidden = false; $('scan').hidden = true; $('bar').hidden = true; $('modeSwitch').hidden = true;
  renderAnzahl();
  formGeaendert = false; $('formFehler').hidden = true;
  for (const el of $('form').querySelectorAll('[aria-invalid]')) el.removeAttribute('aria-invalid');
  $('form').scrollIntoView({ behavior: glatt(), block: 'start' });
  $('form').focus({ preventScroll: true });
}
// Von Hand getippt? Dann vor dem Verwerfen einmal nachfragen (ein bloß fotografiertes Etikett verwirft man ohne Rückfrage)
let formGeaendert = false;
$('form').addEventListener('input', ev => { formGeaendert = true; $('formFehler').hidden = true; ev.target.removeAttribute?.('aria-invalid'); });
$('form').addEventListener('change', () => { $('formFehler').hidden = true; });
function closeForm() {
  $('form').hidden = true; $('scan').hidden = false; $('bar').hidden = false; $('modeSwitch').hidden = !modiSichtbar();
  editIdx = null;
  if (previewUrl) { URL.revokeObjectURL(previewUrl); previewUrl = null; }
  $('preview').removeAttribute('src');
  if (mode === 'pick') renderPick(); // ohne geöffnete Pickliste bleibt der Etikett-Leser versteckt
  (!$('scan').hidden ? $('cam') : $('pickBanner')).focus({ preventScroll: true });
}

$('form').onsubmit = ev => {
  ev.preventDefault();
  const e = { ts: Date.now() };
  for (const f of FIELDS) e[f] = $(f).value.trim().replace(/\s+/g, ' ');
  if (!e.artikel) { toast('Bitte eine Artikelnummer eintragen.'); $('artikel').setAttribute('aria-invalid', 'true'); $('artikel').focus(); return; }
  const menge = parseDe($('menge').value); // deutsches Format ("12,5", "1.000"), type=number kennt nur den Punkt
  if (!(menge > 0)) { toast('Bitte die Menge pro Gebinde eintragen.'); $('menge').focus(); return; }
  const einheit = document.querySelector('input[name=einheit]:checked')?.value;
  if (!einheit) { toast('Bitte Stück oder kg auswählen.'); document.querySelector('input[name=einheit]').focus(); return; }
  e.menge = menge; e.einheit = einheit;
  e.lagerplatz = $('lagerplatz').value.trim();
  if (picker) e.picker = picker;
  const lc = labelCheckState();
  if (lc.kind === 'bad' && !confirm(`Etikettfarbe passt nicht: Artikel ${e.artikel} braucht ein ${LABEL_ADJ[lc.need]} Etikett, erkannt wurde ${lc.got}. Trotzdem übernehmen?`)) return;
  if (lc.kind === 'ok' || lc.kind === 'bad') e.etikett = lc.got; // erkannte Farbe mitschreiben
  const idx = editIdx;
  if (idx === null && mode === 'pick') { addPick(e); return; }
  if (idx === null && mode === 'lager') { lagerBuchen(e); return; }
  if (!e.charge && !confirm(idx !== null ? 'Die Charge ist leer. Trotzdem speichern?' : 'Die Charge ist leer. Trotzdem hinzufügen?')) return;
  if (list.some((x, j) => j !== idx && x.artikel === e.artikel && x.charge === e.charge) &&
      !confirm('Artikel und Charge sind schon in der Liste. Trotzdem noch einmal hinzufügen?')) return;
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
  merken(e.artikel, e.menge, e.einheit);
  render(); closeForm(); toast('Hinzugefügt.');
};
$('cancel').onclick = () => { if (!formGeaendert || confirm('Eingaben verwerfen? Sie werden nicht gespeichert.\n\nOK = verwerfen\nAbbrechen = weiter bearbeiten')) closeForm(); };
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
async function readCodes(canvas, formats = ['Code39'], max = 4) {
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
    res = await ZXingWASM.readBarcodes(img, { formats, tryHarder: true, maxNumberOfSymbols: max });
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
    info: `Etikett muss ${up} sein. Bitte prüfen.`,
    unsure: `Etikettfarbe nicht sicher erkannt. Sie muss ${up} sein, bitte prüfen.`,
    ok: `✓ Etikett ${s.need}: passt.`,
    bad: `Achtung: Dieser Artikel braucht ein ${LABEL_ADJ[s.need]?.toUpperCase()} Etikett. Erkannt: ${s.got}.`,
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
    toast('Das Foto konnte nicht gelesen werden. Bitte noch einmal versuchen.');
  } finally {
    setBusy(false);
    if (canvas) { canvas.width = 0; canvas.height = 0; } // iOS begrenzt den Canvas-Speicher, sonst schlagen spätere Scans fehl
  }
}
$('camBtn').addEventListener('click', ev => {
  const l = mode === 'pick' && pick && $('form').hidden ? currentPickLine() : null;
  if (!l || l.baOk) return;
  const geprueft = baBestaetigen(l);
  renderPick(); // "geprüft von …" gleich zeigen bzw. Feld zum Korrigieren
  if (!geprueft) { ev.preventDefault(); document.querySelector('.pick-line.current .pick-ba input')?.focus(); }
});
for (const id of ['cam', 'gal']) $(id).onchange = ev => { const f = ev.target.files[0]; ev.target.value = ''; scan(f); };

/* ---------- Export ---------- */
// Tabelle als Excel-Blatt: IDs/Text bleiben Text (führende Nullen, keine Formeln), Mengen bleiben echte Zahlen
function textSheet(rows, widths) {
  const ws = XLSX.utils.aoa_to_sheet(rows);
  for (const k in ws) if (k[0] !== '!' && ws[k].t === 's') ws[k].z = '@';
  ws['!cols'] = widths.map(wch => ({ wch }));
  return ws;
}
async function saveWorkbook(wb, name) {
  const buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
  const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const f = new File([blob], name, { type: blob.type });
  if (navigator.canShare && navigator.canShare({ files: [f] })) {
    // iPhone im Homescreen-Modus kann einen Download sonst verschlucken; über die Teilen-Funktion "Sichern" geht immer
    try { await navigator.share({ files: [f] }); return; }
    catch (err) { if (err.name === 'AbortError') return; }
  }
  // Download selbst auslösen: XLSX.writeFile nimmt bei Safari-Kennung einen Weg ohne Dateinamen ("download")
  const url = URL.createObjectURL(blob), a = document.createElement('a');
  a.href = url; a.download = name; a.hidden = true;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
const stamp = (d = new Date(), p = n => String(n).padStart(2, '0')) => `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;

$('export').onclick = async () => {
  try {
    await loadScript('xlsx.mini.min.js');
    const rows = [['Artikelnummer', 'Bezeichnung 1', 'Bezeichnung 2', 'Charge', 'Menge', 'Einheit', 'Lagerplatz', 'Erfasst am', 'Erfasst von'],
      ...list.map(e => [e.artikel, e.bez1, e.bez2, e.charge, e.menge ?? '', e.einheit ?? '', e.lagerplatz ?? '', new Date(e.ts).toLocaleString('de-DE'), e.picker ?? ''])];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, textSheet(rows, [16, 34, 34, 14, 10, 8, 16, 20, 16]), 'Erfassung');
    await saveWorkbook(wb, `LagerBuddy_${stamp()}.xlsx`);
  } catch (err) {
    console.error(err); toast('Export fehlgeschlagen. Bitte noch einmal versuchen.');
  }
};

// Fertige Pickliste für den Teamleiter: Blatt "Pickliste" (Kopf + Soll/Ist je Position) und Blatt "Buchungen"
// (jedes Gebinde mit gescannter Charge, Picker und Uhrzeit -- für Warenwirtschaft und Chargenrückverfolgung).
async function exportPick(p) {
  if (role !== 'master') { toast('Nur Teamleiter können Picklisten exportieren.'); return; }
  try {
    await loadScript('xlsx.mini.min.js');
    const dt = ts => (ts ? new Date(ts).toLocaleString('de-DE') : '');
    const r3 = n => Math.round(n * 1000) / 1000;
    const status = l => (l.picked >= l.required ? 'vollständig' : l.skipped ? 'übersprungen, freigegeben' : 'fehlt, freigegeben');
    const titel = p.name.split(' · ')[0]; // ohne Dateinamen des Fotos
    const kopf = [
      ['Pickliste', titel],
      ['Route', [p.von, p.nach].filter(Boolean).join(' -> ')],
      ['Picker', p.fuer || 'nicht zugeteilt'],
      ['Geladen', `${dt(p.importedAt)}${p.geladenVon ? ' von ' + p.geladenVon : ''}`],
      ['Status', p.freigabe ? `abgeschlossen, fehlende Positionen freigegeben von ${p.freigabe.von} am ${dt(p.freigabe.ts)}` : 'vollständig gepickt'],
      ['Exportiert', `${dt(Date.now())} von ${picker}`],
      [],
      ['Pos.', 'BA-Nr. (Kunde)', 'Artikelnummer', 'Bezeichnung', 'Charge', 'Menge soll', 'Menge gepickt', 'Differenz', 'Einheit', 'Gebindegröße',
        'Gebinde gescannt', 'davon per Sammelbuchung bestätigt', 'Gebinde von Hand', 'Status', 'BA-Nr. geprüft', 'Hinweis', 'Gebinde eingelagert'],
      ...p.lines.map((l, i) => {
        const aus = l.scans.filter(x => x.richtung !== 'ein'), auto = aus.filter(x => !x.manuell);
        const ein = l.scans.filter(x => x.richtung === 'ein').reduce((s, x) => s + (x.anzahl || 1), 0);
        return [i + 1, l.ba || '', l.artikel, l.bez || '', l.charge || '', l.required, r3(l.picked), r3(l.picked - l.required), l.einheit, l.gebinde ?? '',
          auto.reduce((s, x) => s + (x.anzahl || 1), 0), auto.reduce((s, x) => s + (x.anzahl || 1) - 1, 0), aus.filter(x => x.manuell).reduce((s, x) => s + (x.anzahl || 1), 0),
          status(l), l.baOk ? `${l.baOk.von || '–'}, ${dt(l.baOk.ts)}` : 'nicht geprüft', l.hinweis || '', ein];
      }),
    ];
    const art = x => (x.manuell ? 'von Hand' : x.anzahl > 1 ? `Sammelbuchung: 1 gescannt, ${x.anzahl - 1} vom Picker bestätigt` : 'Scan');
    const buchungen = [['Pos.', 'BA-Nr. (Kunde)', 'Artikelnummer', 'Charge soll', 'Charge gescannt', 'Gebinde', 'Menge je Gebinde', 'Menge gesamt', 'Einheit',
      'Picker', 'Zeitpunkt', 'Buchung', 'Lagerplatz', 'Ein/Aus'],
      ...p.lines.flatMap((l, i) => l.scans.map(x => ({ l, i, x }))).sort((a, b) => a.x.ts - b.x.ts)
        .map(({ l, i, x }) => [i + 1, l.ba || '', l.artikel, l.charge || '', x.charge || '', x.anzahl || 1, x.menge, r3(x.menge * (x.anzahl || 1)), l.einheit,
          x.picker || '', dt(x.ts), art(x), x.lagerplatz || '', x.richtung === 'ein' ? 'eingebucht' : x.lagerplatz ? 'ausgebucht' : ''])];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, textSheet(kopf, [16, 16, 18, 30, 16, 11, 13, 10, 8, 13, 15, 18, 15, 24, 22, 20, 12]), 'Pickliste');
    XLSX.utils.book_append_sheet(wb, textSheet(buchungen, [6, 16, 18, 16, 16, 8, 15, 13, 8, 10, 20, 44, 18, 12]), 'Buchungen');
    // Dateiname nur ASCII: Umlaute machen Ärger in Windows-Freigaben, Mail-Anhängen und beim Download selbst
    const slug = t => t.replace(/->|→/g, ' ').replace(/[äöüÄÖÜß]/g, c => ({ ä: 'ae', ö: 'oe', ü: 'ue', Ä: 'Ae', Ö: 'Oe', Ü: 'Ue', ß: 'ss' })[c])
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^A-Za-z0-9-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60);
    await saveWorkbook(wb, `${slug(titel) || 'Pickliste'}${p.fuer && slug(p.fuer) ? '_' + slug(p.fuer) : ''}_${stamp()}.xlsx`);
  } catch (err) {
    console.error(err); toast('Export fehlgeschlagen. Bitte noch einmal versuchen.');
  }
}
$('pickExport').onclick = () => pick && exportPick(pick);
$('clear').onclick = () => {
  if (!confirm(`Alle ${list.length} Einträge löschen? Das lässt sich nicht rückgängig machen. Vorher als Excel herunterladen.`)) return;
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
    // auch auf dem Anmeldebildschirm zeigen: der liegt über allem, der Hinweis in der App war dahinter unsichtbar
    if (v && v !== APP_VERSION) $('update').hidden = $('gateUpd').hidden = false;
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
$('updBtn').onclick = $('gateUpd').onclick = applyUpdate;
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') setTimeout(checkUpdate, 1500); });
$('ver').textContent = $('gateVer').textContent = 'Version ' + APP_VERSION;
if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) navigator.serviceWorker.register('sw.js').catch(() => {});

/* ---------- Zugang: wer nutzt das Handy gerade? ---------- */
// Bei JEDEM Öffnen der App muss ein Kürzel gewählt werden -- gedacht für Lagerhandys, die reihum genutzt
// werden, nicht für ein privates Gerät mit dauerhaftem Login. Die Teamleiter-Kürzel brauchen zusätzlich ein
// Passwort; das schaltet die Pickliste-Verwaltung frei (laden, zuteilen, freigeben, verwerfen).
// Mit Server (SYNC): Das Handy wird einmal mit dem Lager-Code eingerichtet, Teamleiter-Passwörter prüft der
// Server, und er lehnt Umteilen/Freigeben/Verwerfen ohne gültiges Teamleiter-Passwort ab.
// Ohne Server: alles nur im Browser (Passwort Kürzel + "4567"), kein Schutz gegen jemanden, der den Quelltext liest.
// Wer sich anmelden darf, pflegt der Hauptadmin in der App (Team verwalten, team.js); mit Server liegt die Liste in
// lb_personen und wird hier zwischengespeichert, damit das Gate auch offline die richtigen Kürzel zeigt.
const PICKERS = ['AA', 'DR', 'SB', 'UB', 'RW']; // Startbestand, bis die Teamliste da ist (mit Server: supabase/setup.sql)
const MASTERS = ['CMue', 'MD']; // der erste ist Hauptadmin
const KEY_TEAM = 'lagerbuddy_team_v1';
const BEREICHE = [ // [Bereich, Anzeige, Knopf, Modus]
  ['erfassen', 'Erfassen', 'modeScan', 'scan'], ['pickliste', 'Pickliste', 'modePick', 'pick'], ['lager', 'Lager', 'modeLager', 'lager']];
const ALLE_BEREICHE = BEREICHE.map(b => b[0]);
const ROLLEN = { picker: 'Picker', admin: 'Teamleiter', hauptadmin: 'Hauptadmin' };
const startTeam = () => [...MASTERS, ...PICKERS].map((k, i) => ({
  kuerzel: k, name: '', rolle: i === 0 ? 'hauptadmin' : i < MASTERS.length ? 'admin' : 'picker', bereiche: ALLE_BEREICHE, aktiv: true }));
// nur Einträge in der erwarteten Form übernehmen (Cache oder Server)
const teamOk = t => Array.isArray(t) && t.length > 0 && t.every(p => p && typeof p.kuerzel === 'string' && ROLLEN[p.rolle]
  && Array.isArray(p.bereiche) && typeof p.aktiv === 'boolean');
let team = (() => { try { const t = JSON.parse(localStorage.getItem(KEY_TEAM)); if (teamOk(t)) return t; } catch {} return startTeam(); })();
const person = k => team.find(p => p.kuerzel === k);
function teamSpeichern() { try { localStorage.setItem(KEY_TEAM, JSON.stringify(team)); } catch {} }
let teamGeladen = 0;
async function ladeTeam(jetzt) {
  if (!SYNC_ON || !lager || (!jetzt && Date.now() - teamGeladen < 60000)) return;
  teamGeladen = Date.now();
  try {
    const t = await rpc('lb_personen_liste', { lager });
    if (!teamOk(t) || JSON.stringify(t) === JSON.stringify(team)) return;
    team = t; teamSpeichern(); teamGeaendert();
  } catch (err) { if (err.kind === 'zugang') lagerUngueltig(); }
}
// Teamliste hat sich geändert: Gate neu, und wer gerade angemeldet ist, bekommt seine neuen Bereiche -- oder muss
// sich neu anmelden, wenn er deaktiviert wurde oder eine andere Rolle hat.
function teamGeaendert() {
  buildGate();
  if (!picker || !$('gate').hidden) return;
  const p = person(picker);
  if (!p || !p.aktiv || (p.rolle === 'picker') !== (role !== 'master')) {
    toast('Ihr Zugang wurde geändert. Bitte neu anmelden.');
    tlAuth = null; picker = ''; role = ''; rang = '';
    showGate(); return;
  }
  rang = p.rolle; bereiche = p.bereiche;
  applyRoleUI();
  if (mode === 'team') renderTeam();
}
const erlaubt = m => m === 'team' ? rang === 'hauptadmin' : BEREICHE.some(b => b[3] === m && bereiche.includes(b[0]));
const modiSichtbar = () => PICK_ENABLED && BEREICHE.filter(b => bereiche.includes(b[0])).length > 1;
// Nur die Bereiche der Person als Knöpfe; ist der aktuelle Modus nicht (mehr) erlaubt, zum ersten erlaubten
function applyBereiche() {
  const an = BEREICHE.filter(b => bereiche.includes(b[0]));
  for (const b of BEREICHE) $(b[2]).hidden = !bereiche.includes(b[0]);
  $('modeSwitch').dataset.n = an.length;
  if ($('form').hidden) $('modeSwitch').hidden = !modiSichtbar();
  $('teamBtn').hidden = rang !== 'hauptadmin';
  if (!erlaubt(mode)) { if (!$('form').hidden) closeForm(); setMode(an[0]?.[3] || 'scan'); }
}
const LOCK_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>';

function showGate() {
  const einrichten = SYNC_ON && !lager;
  $('lagerForm').hidden = !einrichten;
  $('gateWho').hidden = einrichten;
  $('gate').hidden = false;
  sperren(true);
  document.title = 'Anmelden · LagerBuddy';
  closeTlForm();
  if (einrichten) setTimeout(() => $('lagerCode').focus(), 50);
  else { $('gateTitel').focus({ preventScroll: true }); ladeTeam(true); }
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
    if (!(await rpc('lb_pruefen', { lager: code }))) { toast('Lager-Code stimmt nicht. Bitte prüfen und neu eingeben.'); return; }
    lager = code; $('lagerCode').value = '';
    try { localStorage.setItem(KEY_LAGER, code); } catch {}
    showGate();
  } catch { toast('Keine Verbindung zum Server. Zum Einrichten braucht das Handy einmal Internet.'); }
  finally { $('lagerBtn').disabled = false; }
};

// Picker mit zugeteilter offener Pickliste landen direkt dort (bei genau einer gleich in der Liste)
function landen() {
  const open = role === 'master' || !erlaubt('pick') ? [] : visiblePicks().filter(p => !pickDone(p));
  if (!open.length) return false;
  setMode('pick');
  if (open.length === 1) openPick(open[0]);
  toast(open.length === 1 ? `Pickliste für ${picker}: ${open[0].name}` : `${open.length} Picklisten für ${picker}`);
  return true;
}
let landenNachTour = false;
// info: { rolle, bereiche } vom Server (Admins) -- sonst aus der Teamliste
function login(code, r, info) {
  const p = person(code);
  picker = code; role = r; landenNachTour = false;
  rang = info?.rolle || p?.rolle || (r === 'master' ? 'admin' : 'picker');
  bereiche = (info?.bereiche || p?.bereiche || ALLE_BEREICHE).filter(b => ALLE_BEREICHE.includes(b));
  if (!bereiche.length) bereiche = ALLE_BEREICHE;
  if (r !== 'master') tlAuth = null;
  $('gate').hidden = true;
  sperren(false);
  if (!$('form').hidden) closeForm(); // halb erfasstes Etikett gehört dem vorherigen Nutzer
  openId = null; pick = null;
  if (mode === 'team') setMode('scan'); // Verwaltung nie für den nächsten offen lassen
  renderPicker(); applyRoleUI(); setMode(mode); // setzt auch den Seitentitel
  const gelandet = landen();
  (document.querySelector('#modeSwitch:not([hidden]) .mode-btn.active') || $('pickerBtn')).focus({ preventScroll: true });
  // frisch vom Server holen; war lokal noch nichts da, danach nochmal schauen
  if (SYNC_ON && lager) syncNow(true).then(() => {
    if (gelandet || picker !== code || pick) return;
    if (tourDemo.length) landenNachTour = true; else landen(); // läuft der Rundgang gerade, danach (tour.js)
  });
  if (typeof tourAuto === 'function') tourAuto(); // beim ersten Mal pro Kürzel und Handy: Rundgang (tour.js)
}
// Teamleiter-Passwort im eigenen Feld statt prompt(): Fehler sichtbar direkt darunter (ein Hinweis hinter dem
// Anmeldebildschirm war unsichtbar, "es passiert nichts"), Großbuchstaben-Tastatur, und iOS kann das Passwort im
// Schlüsselbund sichern und später selbst ausfüllen -- kein Abtippen/Kopieren mehr (beim Kopieren fehlte das letzte Zeichen).
let tlCode = null;
function loginMaster(code) {
  tlCode = code;
  for (const b of $('gateMasters').children) b.classList.toggle('active', b.dataset.k === code);
  $('tlLabel').textContent = `Passwort für ${code}`;
  $('tlUser').value = $('pwUser').value = code;
  $('tlPw').value = ''; $('tlErr').hidden = true;
  $('pwForm').hidden = true; $('tlForm').hidden = false;
  setTimeout(() => $('tlPw').focus(), 50);
}
function closeTlForm() {
  tlCode = null; pwWechsel = null;
  $('tlForm').hidden = $('pwForm').hidden = true;
  $('tlPw').value = $('pwNeu').value = $('pwNeu2').value = '';
  for (const b of $('gateMasters').children) b.classList.remove('active');
}
function tlFehler(msg) { $('tlErr').textContent = msg; $('tlErr').hidden = false; $('tlPw').setAttribute('aria-invalid', 'true'); $('tlPw').select(); }
$('tlPw').addEventListener('input', () => $('tlPw').removeAttribute('aria-invalid'));
$('tlCancel').onclick = $('pwCancel').onclick = () => {
  const k = tlCode; closeTlForm();
  (document.querySelector(`#gateMasters button[data-k="${k}"]`) || $('gateTitel')).focus();
};
// Anmelden mit Rolle und Bereichen; lb_anmelden fehlt nur, solange die Datenbank noch den alten Stand hat
async function anmelden(code, pw) {
  try { return await rpc('lb_anmelden', { lager, kuerzel: code, pw }); }
  catch (err) {
    if (err.kind !== 'server' || !/lb_anmelden/.test(err.message)) throw err;
    return { ok: !!(await rpc('lb_teamleiter', { lager, kuerzel: code, pw })) };
  }
}
$('tlForm').onsubmit = async ev => {
  ev.preventDefault();
  const code = tlCode, pw = $('tlPw').value;
  if (!code || !pw.trim()) return;
  if (!SYNC_ON) { if (pw.trim() === code + '4567') { closeTlForm(); login(code, 'master'); } else tlFehler('Falsches Passwort.'); return; }
  $('tlBtn').disabled = true;
  try {
    const res = await anmelden(code, pw);
    if (tlCode !== code || $('gate').hidden) return; // während der Prüfung abgebrochen oder ein Picker hat sich angemeldet
    if (!res?.ok) { tlFehler('Falsches Passwort. Groß-/Kleinschreibung und Bindestriche sind egal.'); return; }
    if (res.muss_aendern) { pwWechselStart(code, pw, res); return; }
    tlAuth = { kuerzel: code, pw };
    closeTlForm();
    login(code, 'master', res);
  } catch (err) {
    if (err.kind === 'zugang') { closeTlForm(); lagerUngueltig(); }
    else tlFehler('Keine Verbindung zum Server. Bitte Internet prüfen und noch einmal „Anmelden“ tippen.');
  } finally { $('tlBtn').disabled = false; }
};
// Nach Anlegen oder Zurücksetzen durch den Hauptadmin: Startpasswort gilt nur für die erste Anmeldung
let pwWechsel = null; // { code, alt, info }
const pwNorm = s => String(s).replace(/[^0-9A-Za-z]/g, '').toUpperCase(); // wie lb_norm auf dem Server
function pwWechselStart(code, alt, info) {
  pwWechsel = { code, alt, info };
  $('tlForm').hidden = true; $('pwForm').hidden = false; $('pwErr').hidden = true;
  $('pwLabel').textContent = `Eigenes Passwort für ${code} festlegen`;
  setTimeout(() => $('pwNeu').focus(), 50);
}
function pwFehler(msg) { $('pwErr').textContent = msg; $('pwErr').hidden = false; }
$('pwForm').onsubmit = async ev => {
  ev.preventDefault();
  const w = pwWechsel, neu = $('pwNeu').value;
  if (!w) return;
  if (pwNorm(neu).length < 8) { pwFehler('Mindestens 8 Buchstaben oder Ziffern.'); return; }
  if (pwNorm(neu) !== pwNorm($('pwNeu2').value)) { pwFehler('Die beiden Eingaben stimmen nicht überein.'); return; }
  if (pwNorm(neu) === pwNorm(w.alt)) { pwFehler('Bitte ein anderes Passwort als das Startpasswort wählen.'); return; }
  $('pwBtn').disabled = true;
  try {
    await rpc('lb_passwort_aendern', { lager, kuerzel: w.code, alt: w.alt, neu });
    if (pwWechsel !== w || $('gate').hidden) return;
    tlAuth = { kuerzel: w.code, pw: neu };
    closeTlForm();
    login(w.code, 'master', w.info);
    toast('Passwort gespeichert. Ab jetzt mit dem neuen anmelden.');
  } catch (err) {
    if (err.kind === 'zugang') { closeTlForm(); lagerUngueltig(); }
    else pwFehler(err.kind === 'server' ? 'Keine Verbindung zum Server.' : err.message);
  } finally { $('pwBtn').disabled = false; }
};
function buildGate() {
  const mk = (p, master) => {
    const b = document.createElement('button');
    b.className = 'btn' + (master ? ' gate-master' : ''); b.type = 'button';
    b.dataset.k = p.kuerzel;
    if (p.name) b.title = p.name;
    if (master) b.innerHTML = LOCK_ICON;
    b.append(p.kuerzel);
    b.onclick = () => master ? loginMaster(p.kuerzel) : login(p.kuerzel, 'picker');
    return b;
  };
  const aktiv = team.filter(p => p.aktiv);
  $('gatePickers').replaceChildren(...aktiv.filter(p => p.rolle === 'picker').map(p => mk(p, false)));
  $('gateMasters').replaceChildren(...aktiv.filter(p => p.rolle !== 'picker').map(p => mk(p, true)));
  if (tlCode && !person(tlCode)?.aktiv) closeTlForm(); // gerade deaktiviert
  else if (tlCode) for (const b of $('gateMasters').children) b.classList.toggle('active', b.dataset.k === tlCode);
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
  applyBereiche();
  if (mode === 'pick') renderPick(); // Charge-Felder/Freigabe-Knopf/Picker-Auswahl/untere Leiste hängen an der Rolle
}
buildGate();
if (!SYNC_ON) { foldLocal(); if (Object.keys(sync.base).length) saveSync(); } // Altbestand ohne Server gleich übernehmen
recompute();
showGate();
if (window.__testLogin) login(window.__testLogin.code, window.__testLogin.role); // nur für die Testsuite, siehe fixtures.mjs

$('modeSwitch').hidden = !modiSichtbar();
render();
setTimeout(checkUpdate, 1500);
