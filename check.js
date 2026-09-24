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

if (failed) { console.log(`\n${failed} Test(s) fehlgeschlagen`); process.exit(1); }
