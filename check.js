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

if (failed) { console.log(`\n${failed} Test(s) fehlgeschlagen`); process.exit(1); }
