/* Etikett auswerten. Reine Funktionen ohne Browser, Test: node check.js */

// Tesseract-Zeile -> sauberer Text. Kurze, unsichere Wörter am Rand sind meist Folienreflexe.
function cleanLine(words) {
  const w = words.slice();
  // Anteil echter Buchstaben/Ziffern: eine reine Zahl bleibt auch bei schlechter Erkennung stehen
  // (Barcode bestätigt sie ohnehin), ein Symbol-Fragment wie "{7=" fliegt auch bei einem Treffertext raus.
  const alnumRatio = t => (t.match(/[\p{L}\p{N}]/gu) || []).length / t.length;
  const junk = x => x.confidence < 50 && (x.text.length <= 2 || alnumRatio(x.text) < 0.5);
  while (w.length && junk(w[0])) w.shift();
  while (w.length && junk(w[w.length - 1])) w.pop();
  return w.map(x => x.text).join(' ')
    .replace(/(\d)\s*m[iIıl1|!](?!\p{L})/gu, '$1 ml') // "400 mi"/"400 mI"/"400 m!" -> "400 ml"
    .replace(/^[^\p{L}\p{N}(]+|[^\p{L}\p{N})%]+$/gu, '') // Rand aufräumen, aber ) und % am Ende stehen lassen
    .trim();
}

// lines: [{text, conf}] von oben nach unten, codes: rohe Barcode-Inhalte (Reihenfolge egal).
// Aufbau des Etiketts: Artikelnummer (Barcode oben), Bezeichnung 1, Bezeichnung 2, Charge (Barcode unten), Fußzeilen.
function parseLabel(lines, codes) {
  const r = { artikel: '', bez1: '', bez2: '', charge: '', artikelCode: false, chargeCode: false };
  // OCR-tolerant: "MH0", "L5-Nr", "WE Menge" etc. werden auch bei Lesefehlern erkannt
  const footer = /M\s*H\s*[DO0]|L\s*[S5]\W*N\s*r|Lager\s*[:.]?|W\s*E[\s-]*Menge|Bestell/i;
  const codeSet = new Set(codes);
  const bez = [];
  for (const { text, conf } of lines) {
    if (footer.test(text)) break;
    const merged = text.replace(/(\d)\s+(?=\d)/g, '$1'); // OCR trennt lange Nummern manchmal mit Leerzeichen: "931000 099000"
    const num = (merged.match(/\d{4,}/) || [])[0];
    if (num && codeSet.has(num)) { if (bez.length) break; continue; } // die Barcode-Zahl selbst ist nie eine Bezeichnung
    const isText = conf >= 60 && /\p{L}{3,}/u.test(text);
    if (!bez.length && !r.artikel && num && num.length >= 8 && !isText) r.artikel = num;
    else if (isText && bez.length < 2) bez.push(text);
    else if (bez.length && num && !r.charge) { r.charge = num; break; }
  }
  [r.bez1 = '', r.bez2 = ''] = bez;

  // Barcodes sind zuverlässiger als Texterkennung und gewinnen immer. Der Inhalt entscheidet,
  // nicht die Position im Bild: die Artikelnummer hat auf diesem Etikett mehr Ziffern als die
  // Charge, das funktioniert daher auch bei doppelt gelesenen, vertauschten oder fehlenden Codes.
  // ponytail: wenn drei Codes gefunden werden, gewinnt einfach der erste, der zur jeweiligen
  // Ziffernlänge passt -- bei einem dritten echten Code39-Etikett im Bild kann das danebenliegen.
  // Hauptschutz ist ohnehin die Formatbeschränkung auf Code39 in app.js (blendet fremde
  // Karton-Barcodes wie EAN meist schon vorher aus). Upgrade bei Bedarf: Codes anhand ihrer
  // Position im Bild filtern, nicht nur anhand des Inhalts.
  const uniq = [...new Set(codes)];
  const art = uniq.find(c => c.length >= 8);
  const charge = uniq.find(c => c !== art && c.length < 8);
  if (art) { r.artikel = art; r.artikelCode = true; }
  if (charge) { r.charge = charge; r.chargeCode = true; }
  return r;
}

// Kopfzeile einer hochgeladenen Pickliste tolerant erkennen (Groß/Klein, Leerzeichen/Bindestrich egal).
function findCol(headers, names) {
  const norm = h => String(h).toLowerCase().replace(/[^a-zäöüß0-9]/g, '');
  const set = new Set(names.map(norm));
  return headers.find(h => set.has(norm(h)));
}

// rows: XLSX.utils.sheet_to_json(sheet, {defval:''}) -- ein Objekt pro Zeile, Schlüssel = Kopfzeile.
// Erwartet eine Artikelnummer-Spalte plus entweder Menge+Einheit (wie der eigene Export) oder
// getrennte Spalten Anzahl (Stück) / Gewicht (kg). Wirft eine Error mit deutschem Text bei Problemen.
function parsePicklist(rows) {
  if (!rows.length) throw new Error('Die Excel-Datei enthält keine Zeilen.');
  const headers = Object.keys(rows[0]);
  const colArt = findCol(headers, ['artikelnummer', 'artikel', 'artikelnr', 'artnr', 'artikel-nr']);
  const colMenge = findCol(headers, ['menge', 'mengeprogebinde']);
  const colEinheit = findCol(headers, ['einheit', 'me']);
  const colAnzahl = findCol(headers, ['anzahl', 'stück', 'stueck']);
  const colGewicht = findCol(headers, ['gewicht', 'gewichtkg']);
  const colBez = findCol(headers, ['bezeichnung1', 'bezeichnung']);
  if (!colArt) throw new Error('Spalte "Artikelnummer" nicht gefunden.');
  if (!colMenge && !colAnzahl && !colGewicht) throw new Error('Spalte "Menge", "Anzahl" oder "Gewicht" nicht gefunden.');

  const num = v => parseFloat(String(v).replace(',', '.'));
  const filled = v => String(v ?? '').trim() !== '';
  const lines = [];
  for (const row of rows) {
    const artikel = String(row[colArt] ?? '').trim();
    if (!artikel) continue;
    let required, einheit;
    if (colMenge && filled(row[colMenge])) {
      required = num(row[colMenge]);
      einheit = /kg/i.test(String(row[colEinheit] ?? '')) ? 'kg' : 'Stück';
    } else if (colAnzahl && filled(row[colAnzahl])) {
      required = num(row[colAnzahl]); einheit = 'Stück';
    } else if (colGewicht && filled(row[colGewicht])) {
      required = num(row[colGewicht]); einheit = 'kg';
    } else continue; // Zeile ohne Menge überspringen
    if (!(required > 0)) continue;
    lines.push({ artikel, bez: colBez ? String(row[colBez] ?? '').trim() : '', required, einheit, picked: 0, scans: [] });
  }
  if (!lines.length) throw new Error('Keine gültige Zeile mit Artikelnummer und Menge gefunden.');
  return lines;
}

if (typeof module !== 'undefined') module.exports = { cleanLine, parseLabel, parsePicklist };
