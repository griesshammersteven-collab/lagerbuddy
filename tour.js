'use strict';
/* ---------- Rundgang: Schritt für Schritt durch die App, getrennt für Picker und Teamleiter ----------
   Läuft auf Beispiel-Picklisten (tourDemo in app.js): die tauchen nur während des Rundgangs auf, werden nie
   gespeichert oder übertragen, und Buchungen darauf lehnt commit() ab. Die Überblendung fängt alle Tipps ab,
   bedient wird nur der Rundgang selbst. Danach stellt er Modus und geöffnete Liste wieder her.
   Startet von selbst beim ersten Anmelden eines Kürzels auf diesem Handy, sonst über das "?" oben. */
const KEY_TOUR = 'lagerbuddy_tour_v1'; // { KÜRZEL: Zeitpunkt } -- wer den Rundgang auf diesem Handy schon gesehen hat

function tourGesehen() { try { const v = JSON.parse(localStorage.getItem(KEY_TOUR)); return v && typeof v === 'object' ? v : {}; } catch { return {}; } }
function tourMerken() {
  if (!picker) return;
  try { localStorage.setItem(KEY_TOUR, JSON.stringify({ ...tourGesehen(), [picker]: Date.now() })); } catch {}
}

// Beispieldaten: eine Liste mitten in der Arbeit, eine mit übersprungener Ware, eine fertige
function tourDaten(fuer, master) {
  const t = Date.now(), s = (min, menge, von, extra) => ({ ts: t - min * 60000, menge, charge: '', picker: von, fp: 'tour' + min, ...extra });
  const offen = { id: 'tour-a', name: 'Beispiel · Pickliste B4 → Bühl', von: 'B4', nach: 'Bühl', fuer, importedAt: t, lines: [
    { lid: 'a1', artikel: '931000136000', bez: '120ml Braunglas', charge: 'L2409', ba: '29991', baOk: { von: fuer, ts: t - 15 * 60000 },
      required: 3000, einheit: 'Stück', gebinde: 1000, picked: 3000,
      scans: [s(14, 1000, fuer), s(12, 1000, fuer, { anzahl: 2 })] },
    { lid: 'a2', artikel: '0001446028', bez: 'Kakaobutter', charge: 'K24-117', ba: '29992', required: 350, einheit: 'kg', gebinde: 25, picked: 25,
      scans: [s(9, 25, fuer)] },
    { lid: 'a3', artikel: '93100023', bez: 'Sheabutter', charge: 'S0815', ba: '', required: 60, einheit: 'kg', picked: 0, scans: [] }] };
  if (!master) return [offen];
  const uebersprungen = { id: 'tour-c', name: 'Beispiel · Pickliste Kühlhaus → Linie 2', von: 'KH', nach: 'L2', fuer: 'SB', importedAt: t - 3600000, lines: [
    { lid: 'c1', artikel: '94000451', bez: 'Etiketten 50×30', charge: 'E77', required: 200, einheit: 'Stück', gebinde: 100, picked: 200, scans: [s(70, 100, 'SB', { anzahl: 2 })] },
    { lid: 'c2', artikel: '93100077', bez: 'Kokosöl', charge: 'KO-3', required: 40, einheit: 'kg', picked: 0, scans: [], skipped: { von: 'SB', ts: t - 3000000 } }] };
  const fertig = { id: 'tour-b', name: 'Beispiel · Pickliste Wareneingang → Produktion', von: 'WE', nach: 'PROD', fuer: 'DR', importedAt: t - 7200000, lines: [
    { lid: 'b1', artikel: '93100023', bez: 'Sheabutter', charge: 'S0815', required: 75, einheit: 'kg', gebinde: 25, picked: 75, scans: [s(110, 25, 'DR', { anzahl: 3 })] },
    { lid: 'b2', artikel: '94000451', bez: 'Etiketten 50×30', charge: 'E78', required: 100, einheit: 'Stück', gebinde: 100, picked: 100, scans: [s(100, 100, 'DR')] }] };
  return [offen, uebersprungen, fertig];
}

// Ansichten, die ein Schritt braucht -- jeder Schritt stellt seine her, damit auch "Zurück" stimmt
// Ohne Bereich Pickliste (Team verwalten) zeigt der Rundgang nur die allgemeinen Schritte (immer: true)
const tourUebersicht = () => { if (!$('form').hidden) closeForm(); if (erlaubt('pick')) { setMode('pick'); openPick(null); } };
const tourListe = id => { if (!$('form').hidden) closeForm(); setMode('pick'); openPick(picks.find(p => p.id === id) || null); };
function tourFormular() {
  tourListe('tour-a');
  showForm({ artikel: '0001446028', bez1: 'Kakaobutter', charge: 'K24-117', menge: 25, einheit: 'kg' }, null);
  $('t-menge').className = 'tag ok'; $('t-menge').textContent = 'gemerkt';
  $('anzahl').value = '13'; renderAnzahl();
}

const TOUR_PICKER = [
  { immer: true, titel: n => `Hallo ${n}!`, text: 'In einer Minute zeigt Ihnen dieser Rundgang, wie Sie mit LagerBuddy picken. Er nutzt eine Beispiel-Liste, gebucht wird nichts.' },
  { ziel: '#pickerBtn', immer: true, vor: tourUebersicht, titel: 'Ihr Kürzel', text: 'Hier steht, wer angemeldet ist. Schichtende oder Handy weitergeben: antippen und das nächste Kürzel wählen.' },
  { ziel: '#pickCards', vor: tourUebersicht, titel: 'Ihre Picklisten', text: 'Hier landen die Listen, die Ihnen der Teamleiter zuteilt, mit Fortschritt. Ist genau eine offen, öffnet die App sie beim Anmelden direkt.' },
  { ziel: '.pick-line.current', vor: () => tourListe('tour-a'), titel: 'Immer der Reihe nach', text: 'Grün umrandet ist die Position, die jetzt dran ist: Artikel, Charge und Menge. Erledigte werden grün, der Rest wartet.' },
  { ziel: '.pick-line.current .pick-ba', vor: () => tourListe('tour-a'), titel: 'BA-Nr. prüfen', text: 'Die BA-Nr. steht für den Kunden. Vor dem ersten Gebinde gleichen Sie sie mit dem Auftrag ab, korrigieren bei Bedarf und bestätigen mit „Geprüft“. Die Prüfung steht mit Ihrem Kürzel im Excel.' },
  { ziel: '#camBtn', vor: () => tourListe('tour-a'), titel: 'Gebinde scannen', text: 'Das Etikett jedes Gebindes fotografieren. Die App liest Artikel und Charge per Barcode und schlägt sofort Alarm, wenn etwas nicht zur Position passt.' },
  { ziel: '.f:has(#menge)', vor: tourFormular, titel: 'Die App merkt sich die Menge', text: 'Beim ersten Gebinde geben Sie Menge und Einheit ein, danach ist beides vorausgefüllt. Nur bei einem Anbruch anpassen.' },
  { ziel: '#anzahlRow', vor: tourFormular, titel: 'Viele gleiche Gebinde? Einmal scannen', text: 'Ein Gebinde scannen, bei der Anzahl „Alle“ tippen, bestätigen – fertig. Die Sammelbuchung läuft auf Ihr Kürzel: Mit OK bestätigen Sie, alle Gebinde geprüft zu haben.' },
  { ziel: '#lpRow', vor: tourFormular, titel: 'Lagerplatz und Ein/Aus', text: 'Dann den Lagerplatz scannen (Barcode oder die Nummer darunter) und wählen: „Ausbuchen“ beim Holen aus dem Regal, „Einbuchen“ beim Einlagern am Ziel. Der Bestand je Lagerplatz rechnet mit.' },
  { ziel: '.pick-skip-btn', vor: () => tourListe('tour-a'), titel: 'Ware nicht da?', text: 'Position überspringen und mit der nächsten weitermachen. Am Ende gibt der Teamleiter die fehlende Ware frei.' },
  { ziel: '#syncState', nur: () => SYNC_ON, vor: () => tourListe('tour-a'), titel: 'Immer abgeglichen', text: 'Jede Buchung geht sofort an den Teamleiter. Kein Netz? Die App sammelt die Buchungen und schickt sie nach.' },
  { ziel: '#tourBtn', immer: true, vor: tourUebersicht, titel: 'Fragen?', text: 'Diesen Rundgang starten Sie jederzeit wieder über das Fragezeichen. Viel Erfolg beim Picken!' },
];
const TOUR_MASTER = [
  { immer: true, titel: n => `Willkommen, ${n}!`, text: 'Als Teamleiter verteilen Sie die Picklisten und behalten den Überblick. Der Rundgang zeigt Beispiel-Listen, Ihre echten Listen bleiben unberührt.' },
  { ziel: '#pickerBtn', immer: true, vor: tourUebersicht, titel: 'Teamleiter-Anmeldung', text: 'Grüner Rahmen = Teamleiter-Rechte. Antippen, um sich abzumelden oder das Handy weiterzugeben.' },
  { ziel: '#modeSwitch', nur: () => modiSichtbar(), vor: tourUebersicht, titel: 'Ihre Bereiche', text: 'Pickliste: Aufträge verteilen und verfolgen. Erfassen: freie Liste, z. B. für Inventur, mit Excel-Download. Lager: Bestand je Lagerplatz.' },
  { ziel: '#pickFuerRow', vor: tourUebersicht, titel: '1. Picker auswählen', text: 'Für wen ist die Liste? Nur dieser Picker sieht sie auf seinem Handy.' },
  { ziel: '#pickPhotoChoose', vor: tourUebersicht, titel: '2. Pickliste fotografieren', text: 'Die gedruckte Liste abfotografieren – die Texterkennung liest Artikelnummer, Bezeichnung, Charge und Menge, auch schräg oder im Querformat.' },
  { ziel: '#pickChoose', vor: tourUebersicht, titel: 'Oder direkt aus Excel', text: 'Die Excel-Datei aus dem ERP geht auch: ohne Texterkennung, ohne Lesefehler.' },
  { ziel: '#pickCards', vor: tourUebersicht, titel: 'Alle Listen im Blick', text: 'Jede Pickliste mit Picker und Fortschritt, live von allen Handys. Offene oben, erledigte mit Haken.' },
  { ziel: '#pickFuerEditRow', vor: () => tourListe('tour-a'), titel: 'Umteilen', text: 'Picker krank oder in der Pause? Liste einem anderen zuteilen – sie wandert sofort auf dessen Handy.' },
  { ziel: '.pick-line.current .pick-edit', vor: () => tourListe('tour-a'), titel: 'Prüfen und korrigieren', text: 'Nach dem Foto-Import kurz gegenchecken: Artikelnummer, Charge und Menge ändern nur Teamleiter. Die BA-Nr. bestätigt der Picker vor dem Picken.' },
  { ziel: '.pick-line.done .pick-count', vor: () => tourListe('tour-a'), titel: 'Jedes Gebinde nachvollziehbar', text: 'Wie viele Gebinde gescannt wurden, wie viele per Sammelbuchung bestätigt (mit Kürzel des Pickers) und was von Hand gebucht wurde.' },
  { ziel: '#pickApprove', vor: () => tourListe('tour-c'), titel: 'Fehlende Ware freigeben', text: 'Hat ein Picker Positionen übersprungen, weil die Ware fehlt, geben Sie sie hier frei und schließen die Liste ab.' },
  { ziel: '#pickExport', vor: () => tourListe('tour-b'), titel: 'Ergebnis als Excel', text: 'Fertige Listen als Excel: Soll und Ist je Position plus jede Buchung mit Picker, Charge und Uhrzeit.' },
  { ziel: '#bar', vor: () => tourListe('tour-b'), titel: 'Ersetzen oder verwerfen', text: 'Liste per Excel neu einlesen oder ganz verwerfen – das dürfen nur Teamleiter.' },
  { ziel: '#syncState', nur: () => SYNC_ON, vor: () => tourListe('tour-a'), titel: 'Live mit allen Handys', text: 'Alle Handys gleichen sich alle paar Sekunden ab. Umteilen, Freigeben und Verwerfen prüft der Server über Ihr Teamleiter-Passwort.' },
  { ziel: '#modeLager', immer: true, nur: () => erlaubt('lager'), vor: tourUebersicht, titel: 'Lager und Bestand', text: 'Hier sehen Sie den Bestand je Lagerplatz, buchen Wareneingang vom Lieferanten ein und laden Bestand und alle Buchungen als Excel herunter.' },
  { ziel: '#teamBtn', immer: true, nur: () => rang === 'hauptadmin', vor: tourUebersicht, titel: 'Team verwalten', text: 'Nur für Sie als Hauptadmin: Picker und Teamleiter anlegen, Bereiche zuweisen, Personen deaktivieren und Teamleiter-Passwörter zurücksetzen.' },
  { ziel: '#tourBtn', immer: true, vor: tourUebersicht, titel: 'Jederzeit wieder', text: 'Über das Fragezeichen starten Sie diesen Rundgang erneut. Die Picker haben ihren eigenen.' },
];

let tour = null; // { schritte, i, vorher: { mode, openId, y }, timer }
function tourStart() {
  if (tour || !picker) return;
  // Halb erfasstes Etikett oder laufende Texterkennung nicht wegwerfen
  if (busy || !$('form').hidden) { toast('Bitte zuerst das Etikett fertig buchen oder verwerfen, dann den Rundgang starten.'); return; }
  const schritte = (role === 'master' ? TOUR_MASTER : TOUR_PICKER).filter(s => (!s.nur || s.nur()) && (s.immer || erlaubt('pick')));
  tour = { schritte, i: 0, vorher: { mode, openId, y: window.scrollY } };
  tourDemo = role === 'master' ? tourDaten('AA', true) : tourDaten(picker, false); // Teamleiter sehen Listen ihrer Picker
  recompute();
  $('toast').classList.remove('on'); // Hinweis vom Anmelden würde über der Karte liegen
  $('tour').hidden = false;
  document.body.classList.add('touring');
  tour.timer = setInterval(tourPlatzieren, 400); // Liste kann neu gezeichnet werden (Abgleich), dann Ziel neu suchen
  tourZeigen();
  $('tourNext').focus();
}
function tourEnde() {
  if (!tour) return;
  const { vorher, timer } = tour;
  clearInterval(timer); tour = null;
  tourMerken();
  $('tour').hidden = true;
  document.body.classList.remove('touring');
  tourDemo = [];
  if (!$('form').hidden) closeForm();
  openId = vorher.openId; recompute();
  setMode(vorher.mode);
  window.scrollTo({ top: vorher.y });
  // Beim ersten Anmelden kam die zugeteilte Liste erst während des Rundgangs vom Server: jetzt hinführen
  if (landenNachTour) { landenNachTour = false; if (!pick) landen(); }
}
function tourZeigen() {
  const s = tour.schritte[tour.i], n = tour.schritte.length;
  s.vor?.();
  $('tourStep').textContent = `${tour.i + 1} / ${n}`;
  $('tourTitle').textContent = typeof s.titel === 'function' ? s.titel(picker) : s.titel;
  $('tourText').textContent = s.text;
  $('tourPrev').hidden = tour.i === 0;
  $('tourNext').textContent = tour.i === n - 1 ? 'Fertig' : 'Weiter';
  $('tourSkip').hidden = tour.i === n - 1;
  tourPlatzieren(); // Karte zuerst setzen: ihre Höhe bestimmt, wie viel Platz das Ziel hat
  const el = tourZiel();
  if (el) { // Ziel in den freien Bereich über der Karte schieben (zentriert, zu hohe Ziele oben bündig)
    const r = el.getBoundingClientRect(), frei = window.innerHeight - $('tourCard').offsetHeight - 40;
    window.scrollBy({ top: r.top - (r.height < frei ? 16 + (frei - r.height) / 2 : 16), behavior: 'instant' });
  }
  tourPlatzieren();
}
function tourZiel() {
  const sel = tour?.schritte[tour.i].ziel, el = sel && document.querySelector(sel);
  return el && el.getClientRects().length ? el : null;
}
function tourPlatzieren() {
  if (!tour) return;
  const el = tourZiel(), spot = $('tourSpot'), card = $('tourCard'), vh = window.innerHeight;
  card.classList.remove('oben', 'unten', 'mitte');
  if (!el) { // Begrüßung: kein Ziel, alles abgedunkelt, Karte in der Mitte
    Object.assign(spot.style, { left: '50%', top: '50%', width: '0px', height: '0px' });
    spot.classList.add('leer'); card.classList.add('mitte');
    return;
  }
  const r = el.getBoundingClientRect(), pad = 6, h = card.offsetHeight + 24;
  // Karte unten, außer das Ziel steckt dort und oben ist Platz (z. B. die feste Leiste am unteren Rand)
  const oben = r.bottom > vh - h && r.top > h;
  card.classList.add(oben ? 'oben' : 'unten');
  // Lichtkegel auf den sichtbaren Teil neben der Karte begrenzen
  const top = Math.max(r.top - pad, oben ? h : 4), bottom = Math.min(r.bottom + pad, oben ? vh - 4 : vh - h);
  spot.classList.remove('leer');
  Object.assign(spot.style, { left: r.left - pad + 'px', top: top + 'px', width: r.width + 2 * pad + 'px', height: Math.max(0, bottom - top) + 'px' });
}
function tourAuto() {
  if (navigator.webdriver || tourGesehen()[picker]) return; // automatisierte Tests: nie von selbst
  setTimeout(() => { if (picker && $('gate').hidden) tourStart(); }, 700);
}
$('tourBtn').onclick = tourStart;
$('tourNext').onclick = () => { if (tour.i < tour.schritte.length - 1) { tour.i++; tourZeigen(); } else tourEnde(); };
$('tourPrev').onclick = () => { if (tour.i > 0) { tour.i--; tourZeigen(); } };
$('tourSkip').onclick = tourEnde;
document.addEventListener('keydown', ev => {
  if (!tour) return;
  if (ev.key === 'Escape') tourEnde();
  else if (ev.key === 'ArrowRight') $('tourNext').click();
  else if (ev.key === 'ArrowLeft' && tour.i > 0) $('tourPrev').click();
});
window.addEventListener('resize', tourPlatzieren);
window.addEventListener('scroll', tourPlatzieren, { passive: true });
