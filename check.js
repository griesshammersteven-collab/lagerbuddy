/* Regressionstests für parse.js ohne Browser: node check.js */
'use strict';
const assert = require('assert');
const { picklistGridFromWords, parsePicklist } = require('./parse.js');

let failed = 0;
const test = (name, fn) => {
  try { fn(); console.log('ok  ', name); }
  catch (err) { failed++; console.log('FAIL', name, '\n    ', err.message); }
};

// Echte Tesseract-Ausgabe (tesseract.js 5, PSM 11) einer schräg fotografierten Druck-Pickliste
const schraeg = require('./test/ocr-pickliste-schraeg.json');
const expected = [
  ['10006349PFL', '1446028', 225, 'kg'],
  ['10006349PFL', '1446031', 75, 'kg'],
  ['91100023', 'KSM-ORG-25-51432', 8, 'kg'], // "S1432" als "51432" gelesen: das korrigiert der Teamleiter
  ['91000451', '500912', 24, 'Stück'],
  ['91200077', '0001446099', 12.5, 'kg'],
];
const check = p => {
  assert.deepStrictEqual(p.lines.map(l => [l.artikel, l.charge, l.required, l.einheit]), expected);
  assert.strictEqual(p.von, 'B4'); assert.strictEqual(p.nach, 'Bühl');
};

test('Foto: Überschrift als "[Artikeinummer" gelesen', () => {
  const grid = picklistGridFromWords(schraeg.lines, schraeg.width);
  check(parsePicklist(grid, grid));
});

test('Foto: Überschriften gar nicht gelesen -> Spalten aus dem Inhalt', () => {
  const lines = schraeg.lines.map(l => ({ words: l.words.filter(w => !/tike|Charge|Lot|Menge|best/.test(w.text)) }));
  const grid = picklistGridFromWords(lines, schraeg.width);
  check(parsePicklist(grid, grid));
});

// Echtes Handyfoto 24.09.2026 (Standbild aus der Bildschirmaufnahme, auf 3000 px skaliert wie in der App):
// Spalte BA-Nr. links, zweizeiliger Kopf, Werte zentriert in der Zelle, Menge "61.000" = 61 000 Stück,
// Bezeichnung "120ml.braunglas" beginnt mit Ziffern
const echt = require('./test/ocr-pickliste-echt.json');
test('Echtes Foto: zentrierte Werte, BA-Nr.-Spalte, Tausenderpunkt', () => {
  const grid = picklistGridFromWords(echt.lines, echt.width);
  const p = parsePicklist(grid, grid);
  assert.deepStrictEqual(p.lines.map(l => [l.artikel, l.bez, l.charge, l.required, l.einheit]),
    [['931000136000', '120ml.braunglas', '', 61000, 'Stück']]);
  assert.deepStrictEqual(p.lines.map(l => [l.ba, l.kunde]), [['29991', '']], 'BA-Nr. erkannt, Kunde leer');
  assert.strictEqual(p.skipped, 0);
  assert.strictEqual(p.von, 'B4'); assert.strictEqual(p.nach, 'Bühl');
});

// Dasselbe Foto als ganzer Bildschirm: OCR-Rauschen "EN" in der blauen Kopfzeile über der Artikelspalte
const ganz = require('./test/ocr-pickliste-echt-ganz.json');
test('Echtes Foto: Rauschen in der Kopfzeile setzt keine falsche Spaltengrenze', () => {
  const grid = picklistGridFromWords(ganz.lines, ganz.width);
  const p = parsePicklist(grid, grid);
  assert.deepStrictEqual(p.lines.map(l => [l.artikel, l.bez, l.charge, l.required, l.einheit]),
    [['931000136000', '120ml.braunglas', '', 61000, 'Stück']]);
});

// Blatt quer fotografiert (24.09.2026), nach dem Drehen: viele leere Zeilen, darunter Fußzeile
// "erstellt von: …" / "Version: 001/19.08" -- landete sonst als Charge und in der Bezeichnung
const quer = require('./test/ocr-pickliste-quer.json');
test('Echtes Foto quer: Fußzeile unter der Tabelle gehört nicht zur Position', () => {
  const grid = picklistGridFromWords(quer.lines, quer.width);
  const p = parsePicklist(grid, grid);
  assert.deepStrictEqual(p.lines.map(l => [l.artikel, l.bez, l.charge, l.required, l.einheit]),
    [['931000136000', '120ml.braunglas', '', 61000, 'Stück']]);
});

// Weit weg, 5° schief, starkes JPEG: "‘Charge" kam mit 32 % Sicherheit -- ohne diese Überschrift begann die
// Charge-Spalte erst bei "/Lot" und die Chargen rutschten in die Artikelspalte
const weit = require('./test/ocr-pickliste-weit.json');
test('Echtes Foto quer und ganzer Bildschirm: BA-Nr. erkannt', () => {
  for (const f of [quer, ganz]) {
    const grid = picklistGridFromWords(f.lines, f.width);
    assert.strictEqual(parsePicklist(grid, grid).lines[0].ba, '29991');
  }
});

test('Excel: BA-Nr. in der Artikelzeile, Kunde darunter; ohne Spalte leer', () => {
  const raw = [['Pickliste B4 -> Bühl'], ['BA-Nr.', 'Artikelnummer', 'Charge / Lot', 'Menge'], ['Kunde', 'Bezeichnung', '', 'best.'],
    ['29991', '10006349PFL', '1446028', '225 kg'], ['Müller GmbH', 'Kakaobutter', 'GEKÜHLTE WARE', ''],
    ['', '91000451', '500912', '24'], ['', 'Zucker fein', '', '']];
  const p = parsePicklist(raw);
  assert.deepStrictEqual(p.lines.map(l => [l.artikel, l.ba, l.kunde, l.bez, l.hinweis]),
    [['10006349PFL', '29991', 'Müller GmbH', 'Kakaobutter', 'GEKÜHLTE WARE'], ['91000451', '', '', 'Zucker fein', '']]);
  const eigene = parsePicklist([['BA-Nr.', 'Kunde', 'Artikelnummer', 'Menge'], ['30012', 'Hofmann', '93100023', '8 kg']]);
  assert.deepStrictEqual([eigene.lines[0].ba, eigene.lines[0].kunde], ['30012', 'Hofmann'], 'Kunde als eigene Spalte');
  const ohne = parsePicklist([['Artikelnummer', 'Menge'], ['93100023', '8 kg']]);
  assert.deepStrictEqual([ohne.lines[0].ba, ohne.lines[0].kunde], ['', ''], 'ohne Spalte leer');
});

test('Foto weit weg: unsichere Überschrift bestimmt trotzdem die Spalte', () => {
  const grid = picklistGridFromWords(weit.lines, weit.width);
  const p = parsePicklist(grid, grid);
  const byArt = Object.fromEntries(p.lines.map(l => [l.artikel + '/' + l.required, l.charge]));
  assert.strictEqual(byArt['10006349PFL/225'], '1446028');
  assert.strictEqual(byArt['10006349PFL/75'], '1446031');
  assert.strictEqual(byArt['91000451/24'], '500912');
  assert.ok(!p.lines.some(l => /^\d{6,7}$/.test(l.artikel) && l.artikel.startsWith('14')), 'keine Charge als Artikelnummer');
});

test('Mengen: deutscher Tausenderpunkt und Dezimalkomma', () => {
  const q = t => parsePicklist([['Artikelnummer', 'Menge'], ['91100023', t]]).lines[0].required;
  assert.deepStrictEqual(['61.000', '1.250,5', '12,5', '12.5', '8 kg', '24'].map(q), [61000, 1250.5, 12.5, 12.5, 8, 24]);
});

test('Bezeichnung mit Ziffern vorne ("120ml.braunglas") ist keine Artikelnummer', () => {
  const p = parsePicklist([['Artikelnummer', 'Menge'], ['931000136000', '5'], ['120ml.braunglas', ''], ['250 g Dose', '']]);
  assert.deepStrictEqual(p.lines.map(l => [l.artikel, l.bez]), [['931000136000', '120ml.braunglas']]);
});

test('Foto ohne Tabelle (z. B. Etikett) -> keine Pickliste', () => {
  const lines = [{ words: [{ text: 'Kakaobutter', confidence: 90, bbox: { x0: 10, y0: 10, x1: 200, y1: 40 } }] },
    { words: [{ text: '10006349', confidence: 90, bbox: { x0: 10, y0: 60, x1: 200, y1: 90 } }] }];
  assert.deepStrictEqual(picklistGridFromWords(lines, 1000), []);
});

// ---------- Picklisten-Operationen (picks.js) ----------
const { applyOp } = require('./picks.js');
const base = () => ({ id: 'p1', name: 'L', fuer: 'AA', lines: [
  { lid: 'a', artikel: '100', charge: 'C1', required: 50, einheit: 'kg', picked: 0, scans: [] },
  { lid: 'b', artikel: '200', charge: 'C2', required: 2, einheit: 'Stück', picked: 0, scans: [] }] });
const run = (d, ops) => ops.reduce(applyOp, d);

test('Buchung ist idempotent (Serverantwort verloren, Operation doppelt)', () => {
  const op = { t: 'scan', lid: 'a', scan: { ts: 1, menge: 25, picker: 'AA' } };
  const d = run(base(), [op, op]);
  assert.strictEqual(d.lines[0].picked, 25);
  assert.strictEqual(d.lines[0].scans.length, 1);
});

test('Konflikt: Picker bucht offline, Teamleiter korrigiert Charge -> beides bleibt', () => {
  const server = run(base(), [{ t: 'feld', lid: 'a', key: 'charge', v: 'C1-KORR' }]); // Teamleiter war schneller
  const merged = run(server, [{ t: 'scan', lid: 'a', scan: { ts: 2, menge: 25, picker: 'AA' } }]); // Picker neu angewendet
  assert.strictEqual(merged.lines[0].charge, 'C1-KORR');
  assert.strictEqual(merged.lines[0].picked, 25);
});

test('Operationen treffen die Zeile über lid, nicht über die Position', () => {
  const d = base(); d.lines.reverse();
  assert.strictEqual(run(d, [{ t: 'skip', lid: 'b', skipped: { von: 'AA' } }]).lines[0].skipped.von, 'AA');
});

test('Ersetzen behält die Zuteilung und hebt eine Freigabe auf', () => {
  const d = run(base(), [{ t: 'freigabe', freigabe: { von: 'MD' } },
    { t: 'ersetzen', data: { name: 'Neu', fuer: 'XX', lines: [{ lid: 'z', artikel: '9', required: 1, picked: 0, scans: [] }] } }]);
  assert.strictEqual(d.fuer, 'AA'); assert.strictEqual(d.name, 'Neu'); assert.strictEqual(d.freigabe, undefined);
  assert.strictEqual(d.lines.length, 1);
});

test('Nach "weg" verfallen weitere Änderungen, "neu" ist idempotent', () => {
  assert.strictEqual(run(base(), [{ t: 'weg' }, { t: 'fuer', fuer: 'DR' }]), null);
  assert.strictEqual(run(base(), [{ t: 'neu', doc: { name: 'anders', lines: [] } }]).name, 'L');
});

test('Eingabedaten werden nicht verändert', () => {
  const d = base(), before = JSON.stringify(d);
  applyOp(d, { t: 'scan', lid: 'a', scan: { ts: 3, menge: 1, picker: 'AA' } });
  assert.strictEqual(JSON.stringify(d), before);
});

test('Kommamengen ohne Gleitkomma-Rest', () => {
  const d = run(base(), [0.1, 0.2].map((m, i) => ({ t: 'scan', lid: 'a', scan: { ts: 10 + i, menge: m, picker: 'AA' } })));
  assert.strictEqual(d.lines[0].picked, 0.3);
});

test('Sammelbuchung: 14 gleiche Gebinde in einer Buchung, idempotent', () => {
  const op = { t: 'scan', lid: 'a', scan: { ts: 50, menge: 2.5, anzahl: 14, picker: 'AA' } };
  const d = run(base(), [op, op]);
  assert.strictEqual(d.lines[0].picked, 35);
  assert.strictEqual(d.lines[0].scans.length, 1);
});

test('Eingaben im deutschen Format: Komma, Tausenderpunkt, Einheit', () => {
  const { parseDe } = require('./parse.js');
  const want = { '25': 25, '12,5': 12.5, '1.000': 1000, '1.000,5': 1000.5, '12.5': 12.5, '25 kg': 25, '24 Stk': 24, '0,5': 0.5 };
  for (const [k, v] of Object.entries(want)) assert.strictEqual(parseDe(k), v, k);
  for (const k of ['', 'abc', '-3', '1,2,3']) assert.ok(Number.isNaN(parseDe(k)), k);
});

test('Kaputte Picklisten vom Server werden erkannt', () => {
  const { gueltig } = require('./picks.js');
  assert.ok(gueltig(base()));
  for (const d of [null, [], { lines: {} }, { lines: [null] }, { lines: [{ artikel: 'X' }] },
    { lines: [{ lid: 'a', artikel: 'X', required: 1, picked: 0, scans: [null] }] },
    { lines: [{ lid: 'a', artikel: 'X', required: '1', picked: 0, scans: [] }] }]) assert.ok(!gueltig(d), JSON.stringify(d));
});

if (failed) { console.log(`\n${failed} Test(s) fehlgeschlagen`); process.exit(1); }
