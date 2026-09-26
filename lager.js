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
  catch { toast('Nicht gespeichert: Der Speicher des Handys ist voll. Bitte Teamleiter informieren.'); return false; }
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
      toast(`Der Server hat die Lagerbuchung abgelehnt: ${err.message}. Bitte Teamleiter informieren.`, { form: false }); // nicht endlos wiederholen
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
    st.textContent = syncErr === 'offline' ? `Offline: ${n ? (n === 1 ? '1 Buchung wartet' : n + ' Buchungen warten') + ' auf Internet' : 'zeigt den letzten Stand'}`
      : n ? `Wird übertragen … (${n})` : bestandServer ? '✓ Bestand aktuell' : 'Bestand wird geladen …';
  }
  const q = $('bestandSuche').value.trim();
  const alle = bestand(), rows = gefiltert(alle);
  const plaetze = new Map();
  for (const e of rows) { if (!plaetze.has(e.lagerplatz)) plaetze.set(e.lagerplatz, []); plaetze.get(e.lagerplatz).push(e); }
  $('bestandList').replaceChildren(...[...plaetze].map(([lp, items]) => {
    const li = document.createElement('li'); li.className = 'card';
    const h = document.createElement('div'); h.className = 'lp-head'; h.textContent = lp;
    li.append(h);
    for (const e of items) {
      const it = document.createElement('button'); it.type = 'button'; it.className = 'lp-btn' + (e.menge < 0 ? ' neg' : '');
      it.setAttribute('aria-label', `${e.lagerplatz}: ${e.artikel}${e.charge ? ', Charge ' + e.charge : ''}, ${fmtN(e.menge)} ${e.einheit}. Entnehmen, umlagern oder ausbuchen`);
      it.dataset.k = bKey(e); it.onclick = () => dtOeffnen(e);
      const links = document.createElement('div');
      const n = document.createElement('div'); n.className = 'nums'; n.textContent = e.artikel + (e.bez ? ' · ' + e.bez : '');
      const s = document.createElement('div'); s.className = 'sub'; s.textContent = e.charge ? 'Charge ' + e.charge : 'ohne Charge';
      links.append(n, s);
      if (e.menge < 0) { const w = document.createElement('div'); w.className = 'lp-warn'; w.textContent = 'Mehr aus- als eingebucht. Bestand prüfen.'; links.append(w); }
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
  $('bestandLoeschen').hidden = role !== 'master' || !rows.length;
  $('bestandLoeschen').textContent = q ? `Angezeigten Bestand löschen (${rows.length})` : 'Gesamten Bestand löschen';
  dtAktualisieren();
}
// Bestandszeilen, die zur Suche passen (Lagerplatz, Artikel, Charge oder Bezeichnung)
function gefiltert(alle = bestand()) {
  const q = $('bestandSuche').value.trim().toUpperCase();
  return q ? alle.filter(e => [e.lagerplatz, e.artikel, e.charge, e.bez].some(t => String(t).toUpperCase().includes(q))) : alle;
}

/* ---------- Bestand löschen (nur Teamleiter und Hauptadmin) ----------
   Gelöscht wird nicht in der Datenbank, sondern per Gegenbuchung "Korrektur" auf null: Der Bestand verschwindet,
   im Export bleibt nachvollziehbar, wer wann was gelöscht hat. Läuft offline wie jede andere Buchung. */
function bestandLoeschen(eintraege) {
  const ts = Date.now(); let n = 0;
  for (const e of eintraege) {
    if (Math.abs(e.menge) < 0.0005) continue;
    const aus = e.menge > 0; // negativer Bestand (mehr aus- als eingebucht) wird per Einbuchung ausgeglichen
    lagerBewegung({ ts: ts + n, lagerplatz: e.lagerplatz, richtung: aus ? 'aus' : 'ein', quelle: 'korrektur', artikel: e.artikel, bez: e.bez,
      charge: e.charge, menge: Math.abs(e.menge), gebinde: Math.max(0, Math.round(aus ? e.gebinde : -e.gebinde)), einheit: e.einheit, picker });
    n++;
  }
  return n;
}
$('dtLoeschen').onclick = () => {
  if (!dt || role !== 'master') return;
  const e = dt.e;
  if (!confirm(`Diesen Bestand löschen?\n${e.lagerplatz} · ${e.artikel}${e.charge ? ', Charge ' + e.charge : ''}\n${fmtN(e.menge)} ${e.einheit}, ${fmtN(e.gebinde)} Gebinde\n\n` +
    `Gebucht wird eine Korrektur auf ${picker}, im Export nachvollziehbar.\nOK = löschen\nAbbrechen = behalten`)) return;
  bestandLoeschen([e]); dtSchliessen(); renderLager();
  toast(`Bestand gelöscht: ${e.artikel} an ${e.lagerplatz} (${fmtN(e.menge)} ${e.einheit}).`);
};
$('bestandLoeschen').onclick = () => {
  if (role !== 'master') return;
  const rows = gefiltert(); if (!rows.length) return;
  const q = $('bestandSuche').value.trim(), plaetze = new Set(rows.map(e => e.lagerplatz)).size;
  const was = q ? `alle ${rows.length} angezeigten Einträge (Suche „${q}“) an ${plaetze} ${plaetze === 1 ? 'Lagerplatz' : 'Lagerplätzen'}`
    : `den GESAMTEN Bestand: ${rows.length} Einträge an ${plaetze} ${plaetze === 1 ? 'Lagerplatz' : 'Lagerplätzen'}`;
  const antwort = prompt(`Wirklich ${was} löschen?\n\nGebucht wird je Eintrag eine Korrektur auf ${picker}, im Export nachvollziehbar.\nZum Bestätigen LÖSCHEN eintippen.`);
  if (antwort === null) return;
  if (antwort.trim().toUpperCase() !== 'LÖSCHEN') { toast('Nicht gelöscht: Zum Bestätigen bitte LÖSCHEN eintippen.'); return; }
  if (dt) dtSchliessen();
  const n = bestandLoeschen(rows); renderLager();
  toast(`${n === 1 ? '1 Eintrag' : n + ' Einträge'} gelöscht (Korrektur auf ${picker}).`);
};
$('bestandSuche').addEventListener('input', () => renderLager());

/* ---------- Bestand antippen: für eine Pickliste entnehmen, umlagern oder ausbuchen ----------
   Der Picker steht am Regal und bedient von dort offene Picklisten. Aus dem Bestand heraus gilt die Reihenfolge der
   Pickliste nicht (sie ist eine Laufweg-Empfehlung, keine Prüfung). Geprüft wird trotzdem: Ein Gebinde wird gescannt,
   Artikel-Barcode und Charge müssen zu dieser Bestandszeile passen. Weitere gleiche Gebinde bestätigt man mit der
   Anzahl (wie die Sammelbuchung, gebucht auf das eigene Kürzel). Mehr als laut Bestand: Hinweis, kein Verbot. */
let dt = null; // { k: Schlüssel der Bestandszeile, e: Bestandszeile, von: Kürzel }
const dtAktion = () => document.querySelector('input[name=dtAktion]:checked')?.value || '';
const dtPos = () => document.querySelector('input[name=dtPos]:checked')?.value || '';
const proGebinde = e => (e.gebinde > 0 && e.menge > 0 ? rund3(e.menge / e.gebinde) : 0);
// Offene Positionen sichtbarer Picklisten mit diesem Artikel (und dieser Charge, wenn die Position eine vorgibt)
function passendePositionen(e) {
  if (role !== 'master' && !erlaubt('pick')) return [];
  return picks.filter(p => sichtbar(p) && !p.freigabe && !tourDemo.some(t => t.id === p.id))
    .flatMap(p => p.lines.map((l, i) => ({ p, l, i })))
    .filter(({ l }) => l.picked < l.required - 0.0005 && normArt(l.artikel) === e.artikel && l.einheit === e.einheit
      && (!l.charge || normCharge(l.charge) === normCharge(e.charge)));
}
function dtFehler(msg) { $('dtFehler').textContent = msg; $('dtFehler').hidden = !msg; }
function dtOeffnen(e) {
  if (busy || !$('form').hidden) { toast('Bitte zuerst das offene Etikett fertig buchen oder verwerfen.'); return; }
  dt = { k: bKey(e), e, von: picker };
  for (const r of document.getElementsByName('dtAktion')) r.checked = false;
  $('dtZiel').value = ''; dtFehler('');
  $('dtPlatz').textContent = e.lagerplatz;
  $('dtTitel').textContent = e.artikel + (e.bez ? ' · ' + e.bez : '');
  const pos = passendePositionen(e);
  $('dtPickOpt').hidden = !pos.length; $('dtKeinePick').hidden = !!pos.length;
  if (pos.length) document.querySelector('input[name=dtAktion][value=pick]').checked = true; // der häufigste Fall
  $('dtPicks').replaceChildren(...pos.map(({ p, l, i }, j) => {
    const lab = document.createElement('label'); lab.className = 'btn';
    const r = document.createElement('input'); r.className = 'file'; r.type = 'radio'; r.name = 'dtPos'; r.value = `${p.id}|${l.lid}`; r.checked = j === 0;
    const fehlt = rund3(l.required - l.picked);
    lab.append(r, `${p.name} · Pos. ${i + 1}${p.fuer ? ' · für ' + p.fuer : ''} · fehlt ${fmtN(fehlt)} ${l.einheit}`);
    return lab;
  }));
  dtInfo(); dtModus();
  $('dtLoeschen').hidden = role !== 'master';
  $('lpDetail').hidden = false;
  $('lpDetail').scrollIntoView({ behavior: glatt(), block: 'start' });
  $('dtTitel').focus({ preventScroll: true });
}
function dtSchliessen() {
  if (!dt) return;
  const k = dt.k; dt = null;
  $('lpDetail').hidden = true;
  [...document.querySelectorAll('#bestandList .lp-btn')].find(b => b.dataset.k === k)?.focus({ preventScroll: true });
}
function dtInfo() {
  const e = dt.e, g = proGebinde(e);
  $('dtInfo').textContent = `${e.charge ? 'Charge ' + e.charge : 'ohne Charge'} · Bestand ${fmtN(e.menge)} ${e.einheit}, ${fmtN(e.gebinde)} Gebinde${g ? ` (je ${fmtN(g)} ${e.einheit})` : ''}`;
  const auch = bestand().filter(x => x.lagerplatz !== e.lagerplatz && x.artikel === e.artikel && x.einheit === e.einheit
    && normCharge(x.charge) === normCharge(e.charge) && x.menge > 0);
  $('dtAuch').hidden = !auch.length;
  $('dtAuch').textContent = auch.length ? 'Dieselbe Charge liegt auch an: ' + auch.map(x => `${x.lagerplatz} (${fmtN(x.menge)} ${x.einheit})`).join(', ') : '';
}
// Bestand hat sich geändert (Abgleich, eigene Buchung): Zahlen nachziehen, bei Kürzel-Wechsel schließen
function dtAktualisieren() {
  if (!dt) return;
  if (dt.von !== picker || mode !== 'lager') { dtSchliessen(); return; }
  const neu = bestand().find(x => bKey(x) === dt.k);
  if (neu) dt.e = neu;
  dtInfo(); dtAnzHinweis();
}
// Vorbelegte Anzahl: was der Position fehlt (volle Gebinde), höchstens was laut Bestand da liegt
function dtVorschlag() {
  const e = dt.e, a = dtAktion();
  const da = Math.max(1, Math.round(e.gebinde) || 1);
  if (a !== 'pick') return da;
  const z = dtZeile(); if (!z) return 1;
  const g = z.l.gebinde || proGebinde(e);
  const fehltG = g ? Math.floor((z.l.required - z.l.picked + 0.001) / g) : 1;
  return Math.max(1, Math.min(fehltG || 1, da));
}
function dtZeile() {
  const [pid, lid] = dtPos().split('|');
  const p = picks.find(x => x.id === pid), l = p?.lines.find(x => x.lid === lid);
  return p && l ? { p, l, i: p.lines.indexOf(l) } : null;
}
function dtModus() {
  const a = dtAktion();
  $('dtPickRow').hidden = a !== 'pick';
  $('dtZielRow').hidden = a !== 'umlagern';
  $('dtAnzRow').hidden = !a;
  $('dtScanText').textContent = { pick: 'Gebinde scannen und entnehmen', umlagern: 'Gebinde scannen und umlagern', aus: 'Gebinde scannen und ausbuchen' }[a] || 'Gebinde scannen und buchen';
  $('dtAnz').value = String(dtVorschlag());
  dtFehler(''); dtAnzHinweis();
}
const dtAnzahl = () => { const n = parseInt($('dtAnz').value, 10); return n > 0 ? n : 1; };
function dtAnzHinweis() {
  if (!dt) return;
  const n = dtAnzahl(), da = Math.round(dt.e.gebinde);
  $('dtAnzHint').textContent = n > da ? `Laut Bestand liegen hier nur ${fmtN(Math.max(0, da))} Gebinde. Gebucht wird trotzdem.` : `Laut Bestand: ${fmtN(da)} Gebinde.`;
  $('dtAnzHint').className = 'pick-hint' + (n > da ? ' pick-note' : '');
}
for (const r of document.getElementsByName('dtAktion')) r.onchange = dtModus;
$('dtPicks').addEventListener('change', () => { $('dtAnz').value = String(dtVorschlag()); dtAnzHinweis(); });
$('dtMinus').onclick = () => { $('dtAnz').value = String(Math.max(1, dtAnzahl() - 1)); dtAnzHinweis(); };
$('dtPlus').onclick = () => { $('dtAnz').value = String(dtAnzahl() + 1); dtAnzHinweis(); };
$('dtAnz').addEventListener('input', dtAnzHinweis);
$('dtZu').onclick = dtSchliessen;
$('dtZiel').addEventListener('input', () => dtFehler(''));
// Vor dem Öffnen der Kamera prüfen, ob alles gewählt ist (danach ist der Picker schon beim Fotografieren)
$('dtScanBtn').addEventListener('click', ev => {
  if (ev.target === $('dtCam')) return;
  const a = dtAktion();
  let fehler = '';
  if (!a) fehler = 'Bitte zuerst wählen: entnehmen, umlagern oder ausbuchen.';
  else if (a === 'pick' && !dtZeile()) fehler = 'Bitte die Position wählen.';
  else if (a === 'umlagern') {
    const [z] = findLagerplatz($('dtZiel').value);
    if (!z) fehler = 'Bitte den Ziel-Lagerplatz scannen oder eintippen (z. B. H3.01.01.00.01).';
    else if (z === dt.e.lagerplatz) fehler = 'Ziel und Herkunft sind derselbe Lagerplatz.';
  }
  if (fehler) { ev.preventDefault(); dtFehler(fehler); }
});
$('dtZielCam').onchange = async ev => {
  const f = ev.target.files[0]; ev.target.value = '';
  if (!f || busy) return;
  setBusy(true, 'Lagerplatz wird gelesen …');
  let canvas;
  try {
    canvas = await toCanvas(f, 2000);
    const r = await leseLagerplatz(canvas);
    if (r) { $('dtZiel').value = r.lp; dtFehler(''); } else toast('Kein Lagerplatz erkannt. Näher herangehen und neu scannen oder die Nummer eintippen.');
  } catch (err) { console.error(err); toast('Foto konnte nicht gelesen werden. Bitte noch einmal versuchen.'); }
  finally { setBusy(false); if (canvas) { canvas.width = 0; canvas.height = 0; } }
};
$('dtCam').onchange = async ev => {
  const f = ev.target.files[0]; ev.target.value = '';
  if (!f || busy || !dt) return;
  if (f.size > 30 * 1024 * 1024) { toast('Foto ist zu groß (über 30 MB). Bitte erneut aufnehmen.'); return; }
  setBusy(true, 'Barcodes werden gelesen …');
  let canvas, r = null;
  try {
    canvas = await toCanvas(f);
    let codes = [];
    try { codes = await readCodes(canvas); } catch (err) { console.warn(err); }
    let lines = [];
    try { setBusy(true, 'Text wird gelesen …'); lines = await ocrLines(canvas, codes); } catch (err) { console.warn(err); }
    r = parseLabel(lines, codes.map(c => c.text));
  } catch (err) { console.error(err); toast('Das Foto konnte nicht gelesen werden. Bitte noch einmal versuchen.'); }
  finally { setBusy(false); if (canvas) { canvas.width = 0; canvas.height = 0; } }
  if (r && dt) dtBuchen(r, `${f.name}|${f.size}|${f.lastModified}`);
};
function dtBuchen(r, fp) {
  const e = dt.e, a = dtAktion(), n = dtAnzahl(), ts = Date.now();
  // Scan-Pflicht: Artikel per Barcode, Charge passend zur Bestandszeile
  if (!r.artikelCode) { dtFehler('Barcode nicht erkannt. Etikett noch einmal scharf fotografieren.'); return; }
  if (normArt(r.artikel) !== e.artikel || (e.charge && normCharge(r.charge) !== normCharge(e.charge))) {
    dtFehler(`Das gescannte Gebinde passt nicht zu diesem Bestand.\nErwartet: ${e.artikel}${e.charge ? ', Charge ' + e.charge : ''}\nGescannt: ${r.artikel || '?'}${r.charge ? ', Charge ' + r.charge : ''}`);
    return;
  }
  const charge = e.charge || r.charge || '';
  const g = proGebinde(e) || gemerkt(e.artikel, e.einheit)?.menge || 0;
  const zuWenig = n > Math.round(e.gebinde) ? `\nHinweis: Laut Bestand liegen an ${e.lagerplatz} nur ${fmtN(Math.max(0, Math.round(e.gebinde)))} Gebinde.` : '';
  const geprueft = n > 1 ? `alle ${n} Gebinde` : 'das Gebinde';
  if (a === 'pick') {
    const z = dtZeile();
    if (!z || z.p.freigabe || z.l.picked >= z.l.required - 0.0005) { dtFehler('Diese Position ist inzwischen erledigt.'); return; }
    const { p, l, i } = z;
    if (picks.some(x => x.lines.some(y => y.scans.some(s => s.fp === fp)))) { dtFehler('Dieses Foto wurde schon gebucht. Bitte ein Gebinde neu fotografieren.'); return; }
    const geb = l.gebinde || g;
    if (!geb) { dtFehler('Die Gebindegröße ist unbekannt. Bitte das erste Gebinde in der Pickliste buchen.'); return; }
    const offen = rund3(l.required - l.picked);
    let menge = geb;
    if (n * geb > offen + 0.001) {
      if (n > 1) { dtFehler(`Offen sind nur noch ${fmtN(offen)} ${l.einheit}: höchstens ${Math.max(1, Math.floor((offen + 0.001) / geb))} Gebinde.`); return; }
      menge = offen; // letztes Gebinde nur teilweise (Anbruch)
    }
    if (!l.baOk) {
      if (!confirm(`BA-Nr. (Kunde) prüfen\n${p.name} · Position ${i + 1} · ${l.artikel}\nBA-Nr.: ${l.ba || '(leer)'}\n\nStimmt sie mit dem Auftrag überein?\nOK = ja, geprüft (${picker})\nAbbrechen = nicht buchen`)) return;
      commit(p.id, { t: 'feld', lid: l.lid, key: 'baOk', v: { von: picker, ts } });
    }
    if (!confirm(`${n} ${n > 1 ? 'Gebinde' : 'Gebinde'} je ${fmtN(menge)} ${l.einheit} = ${fmtN(rund3(n * menge))} ${l.einheit} aus ${e.lagerplatz} entnehmen?\n` +
      `Für: ${p.name}, Position ${i + 1}${menge < geb - 0.001 ? ' (Anbruch)' : ''}\n\nGebucht auf ${picker}. Mit OK bestätigen Sie, ${geprueft} geprüft zu haben (Artikel, Charge, Menge).${zuWenig}`)) return;
    const scan = { ts, menge, charge, picker, ...(n > 1 ? { anzahl: n } : {}), fp, lagerplatz: e.lagerplatz, richtung: 'aus', ausBestand: true };
    if (!commit(p.id, { t: 'scan', lid: l.lid, scan })) return;
    if (!l.gebinde && menge === geb) commit(p.id, { t: 'feld', lid: l.lid, key: 'gebinde', v: geb });
    const hinweis = lagerBewegung({ ts, lagerplatz: e.lagerplatz, richtung: 'aus', quelle: 'pickliste', pick_id: p.id, artikel: l.artikel,
      bez: l.bez || e.bez, charge, menge: rund3(n * menge), gebinde: n, einheit: l.einheit, picker });
    merken(l.artikel, geb, l.einheit);
    dtSchliessen(); renderLager();
    toast(`Entnommen: ${n > 1 ? n + ' × ' : ''}${fmtN(menge)} ${l.einheit} ${l.artikel} aus ${e.lagerplatz} für ${p.name}, Position ${i + 1}` + hinweis);
    return;
  }
  if (!g) { dtFehler('Die Menge je Gebinde ist unbekannt. Bitte über „Gebinde ein- oder ausbuchen“ mit Menge buchen.'); return; }
  const menge = rund3(n * g);
  if (a === 'umlagern') {
    const [ziel] = findLagerplatz($('dtZiel').value);
    if (!ziel || ziel === e.lagerplatz) { dtFehler('Bitte einen anderen Ziel-Lagerplatz wählen.'); return; }
    if (!confirm(`${n} Gebinde je ${fmtN(g)} ${e.einheit} = ${fmtN(menge)} ${e.einheit} umlagern?\nVon ${e.lagerplatz} nach ${ziel}\n\nGebucht auf ${picker}. Mit OK bestätigen Sie, ${geprueft} geprüft zu haben.${zuWenig}`)) return;
    const b = { lagerplatz: e.lagerplatz, quelle: 'lager', artikel: e.artikel, bez: e.bez, charge, menge, gebinde: n, einheit: e.einheit, picker };
    const hinweis = lagerBewegung({ ...b, ts, richtung: 'aus' });
    lagerBewegung({ ...b, ts: ts + 1, lagerplatz: ziel, richtung: 'ein' });
    dtSchliessen(); renderLager();
    toast(`Umgelagert: ${n > 1 ? n + ' × ' : ''}${fmtN(g)} ${e.einheit} ${e.artikel} von ${e.lagerplatz} nach ${ziel}` + hinweis);
    return;
  }
  if (!confirm(`${n} Gebinde je ${fmtN(g)} ${e.einheit} = ${fmtN(menge)} ${e.einheit} aus ${e.lagerplatz} ausbuchen?\n\nGebucht auf ${picker}. Mit OK bestätigen Sie, ${geprueft} geprüft zu haben.${zuWenig}`)) return;
  const hinweis = lagerBewegung({ ts, lagerplatz: e.lagerplatz, richtung: 'aus', quelle: 'lager', artikel: e.artikel, bez: e.bez, charge, menge, gebinde: n, einheit: e.einheit, picker });
  dtSchliessen(); renderLager();
  toast(`Ausgebucht: ${n > 1 ? n + ' × ' : ''}${fmtN(g)} ${e.einheit} ${e.artikel} aus ${e.lagerplatz}` + hinweis);
}

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
  if (!roh) { toast('Bitte den Lagerplatz scannen oder eintippen (z. B. H3.01.01.00.01).'); $('lpCode').setAttribute('aria-invalid', 'true'); $('lpCode').focus(); return ''; }
  const [lp] = findLagerplatz(roh);
  if (!lp) { toast(`„${roh}“ ist kein gültiger Lagerplatz. Richtig ist z. B. H3.01.01.00.01.`); $('lpCode').setAttribute('aria-invalid', 'true'); $('lpCode').focus(); return ''; }
  $('lpCode').value = lp;
  return lp;
}
function richtungWert() {
  const r = document.querySelector('input[name=richtung]:checked')?.value || '';
  if (!r) { toast('Bitte „Ausbuchen“ oder „Einbuchen“ wählen.'); document.querySelector('input[name=richtung]').focus(); }
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
        if (t.length) return { lp: naechster(t), quelle: 'aus Text, bitte prüfen' };
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
    } else toast('Kein Lagerplatz erkannt. Näher herangehen und neu scannen oder die Nummer eintippen.');
  } catch (err) {
    console.error(err); toast('Foto konnte nicht gelesen werden. Bitte noch einmal versuchen.');
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
      !confirm(`Charge passt nicht zur Position.\nErwartet: ${line.charge}\nErfasst: ${e.charge || '(leer)'}\n\nOK = trotzdem einbuchen\nAbbrechen = nicht einbuchen`)) return;
  const scanned = formScan, manuell = !scanned?.code;
  if (role !== 'master') {
    if (!scanned) { toast('In der Pickliste wird jedes Gebinde gescannt: bitte das Etikett fotografieren.'); return; }
    if (!scanned.code) { toast('Barcode nicht erkannt. Etikett noch einmal scharf fotografieren.'); return; }
  }
  if (scanned && picks.some(p => p.lines.some(l => l.scans.some(x => x.fp === scanned.fp)))) {
    toast('Dieses Foto wurde schon gebucht. Jedes Gebinde einzeln fotografieren.'); return;
  }
  const anzahl = anzahlWert(), zahl = x => x.anzahl || 1;
  const ausG = line.scans.filter(x => x.richtung !== 'ein').reduce((s, x) => s + zahl(x), 0);
  const einG = line.scans.filter(x => x.richtung === 'ein').reduce((s, x) => s + zahl(x), 0);
  if (einG + anzahl > ausG && !confirm(`Mehr Gebinde einbuchen, als ausgebucht wurden.\nAusgebucht: ${ausG} · schon eingebucht: ${einG} · jetzt: ${anzahl}\n\nOK = trotzdem einbuchen\nAbbrechen = nicht einbuchen`)) return;
  if (anzahl > 1 && !confirm(`${anzahl} gleiche Gebinde je ${fmtN(e.menge)} ${e.einheit} an ${lp} einbuchen?\n\n` +
    `Gebucht auf ${picker}. Mit OK bestätigen Sie, alle ${anzahl} Gebinde geprüft zu haben.`)) return;
  const scan = { ts: e.ts, menge: e.menge, charge: e.charge, picker: e.picker, ...(anzahl > 1 ? { anzahl } : {}),
    ...(scanned ? { fp: scanned.fp } : {}), ...(manuell ? { manuell: true } : {}), lagerplatz: lp, richtung: 'ein' };
  if (!commit(pick.id, { t: 'scan', lid: line.lid, scan })) return;
  lagerBewegung({ ts: e.ts, lagerplatz: lp, richtung: 'ein', quelle: 'pickliste', pick_id: pick.id, artikel: line.artikel,
    bez: line.bez || e.bez1 || '', charge: e.charge || line.charge || '', menge: e.menge * anzahl, gebinde: anzahl, einheit: line.einheit, picker: e.picker });
  renderPick(); closeForm();
  toast(`Eingebucht: ${anzahl > 1 ? anzahl + ' × ' : ''}${fmtN(e.menge)} ${e.einheit} ${e.artikel} an ${lp} (${einG + anzahl} von ${ausG} Gebinden)`);
}

// Modus "Lager": Wareneingang einbuchen oder frei ausbuchen, ohne Pickliste
function lagerBuchen(e) {
  const lp = lpWert(); if (!lp) return;
  const richtung = richtungWert(); if (!richtung) return;
  const anzahl = anzahlWert(), rein = richtung === 'ein';
  if (!e.charge && !confirm('Die Charge ist leer. Trotzdem buchen?')) return;
  if (anzahl > 1 && !confirm(`${anzahl} gleiche Gebinde je ${fmtN(e.menge)} ${e.einheit} ${rein ? 'an' : 'aus'} ${lp} ${rein ? 'einbuchen' : 'ausbuchen'}?\n\n` +
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
      catch { toast('Buchungen konnten nicht geladen werden. Exportiert wird nur der Bestand.'); }
      liste = [...bew.offen.slice().reverse(), ...liste.map(b => ({ ...b, ts: Date.parse(b.ts), menge: Number(b.menge) }))];
    } else liste = bew.alle.slice().reverse();
    const dt = ts => (ts ? new Date(ts).toLocaleString('de-DE') : '');
    const quelle = { pickliste: 'Pickliste', wareneingang: 'Wareneingang', lager: 'Lager', korrektur: 'Korrektur (Bestand gelöscht)' };
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
    console.error(err); toast('Export fehlgeschlagen. Bitte noch einmal versuchen.');
  }
};
