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
  // OCR-tolerant: "MH0", "L5-Nr", "WE Menge" etc. werden auch bei Lesefehlern erkannt -- Ende UNSERES Etiketts, danach abbrechen
  const footer = /M\s*H\s*[DO0]|L\s*[S5]\W*N\s*r|Lager\s*[:.]?|W\s*E[\s-]*Menge|Bestell/i;
  // Fremdes Lieferanten-Etikett (oft zusätzlich auf dem Gebinde) auf Englisch: nur diese eine Zeile
  // überspringen, nicht abbrechen -- unser eigenes Etikett kann im Foto trotzdem noch folgen.
  const foreign = /BATCH|NET\s*WEIGH|GROSS\s*WEIGH|MFG\s*DA|EXP\s*DA|MADE\s+IN|COUNTRY\s+OF|STORAGE/i;
  const codeSet = new Set(codes);
  const bez = [];
  for (const { text, conf } of lines) {
    if (footer.test(text)) break;
    if (foreign.test(text)) continue;
    const merged = text.replace(/(\d)\s+(?=\d)/g, '$1'); // OCR trennt lange Nummern manchmal mit Leerzeichen: "931000 099000"
    const num = (merged.match(/\d{4,}/) || [])[0];
    if (num && codeSet.has(num)) { if (bez.length) break; continue; } // die Barcode-Zahl selbst ist nie eine Bezeichnung
    const isText = conf >= 60 && /\p{L}{3,}/u.test(text);
    if (!bez.length && !r.artikel && num && num.length >= 8 && !isText) { r.artikel = num; continue; }
    if (isText && bez.length < 2) { bez.push(text); continue; }
    if (bez.length && !r.charge) {
      // Rohstoff-Chargen sind oft nicht rein numerisch ("PNS 5 SF-26-201", "KSM-ORG-25-SII-S1432").
      // Stehen die gefundenen Ziffern als eigenes, durch Leerzeichen/Satzzeichen abgetrenntes Wort da
      // (z. B. Vordruck-Reste wie "Ey NEE 500912"), sind sie die Charge. Kleben sie an Buchstaben
      // (wie "S1432" in "...SII-S1432"), ist das kein eigenständiges Wort, sondern Teil eines
      // zusammenhängenden Codes -- dann zählt die ganze Zeile, wenn sie wie eine Charge aussieht.
      const i = num ? merged.indexOf(num) : -1;
      const edge = j => j < 0 || j >= merged.length || /[^\p{L}\d]/u.test(merged[j]);
      if (num && i >= 0 && edge(i - 1) && edge(i + num.length)) { r.charge = num; break; }
      if (conf >= 45 && /\d/.test(text) && /^[\p{L}\p{N}][\p{L}\p{N}\-. \/]{2,39}$/u.test(text)) { r.charge = text; break; }
      if (num) { r.charge = num; break; } // Ziffern glued, aber Zeile passt nicht ins Muster: besser als nichts
    }
  }
  [r.bez1 = '', r.bez2 = ''] = bez;

  // Barcodes sind zuverlässiger als Texterkennung und gewinnen immer.
  // Bei zwei Codes, von denen genau einer eindeutig kürzer ist (Fertigware: Charge < 8 Zeichen,
  // Artikelnummer länger), entscheidet der Inhalt -- das bleibt unabhängig von Drehung/Reihenfolge
  // richtig. Sind beide gleich lang oder beide lang (Rohstoffe: Charge oft genauso lang wie die
  // Artikelnummer oder länger, z. B. "KSM-ORG-25-SII-S1432"), entscheidet die gedruckte Reihenfolge:
  // Artikelnummer steht auf diesem Etikett immer oben, Charge immer unten -- codes kommt bereits so
  // sortiert an (siehe readCodes in app.js).
  // ponytail: bei einem Foto ohne EXIF-Ausrichtung, das zugleich in den zweiten Fall fällt, kann
  // "oben/unten" vertauscht sein. Der weit überwiegende Normalfall (Foto mit EXIF) bleibt richtig.
  const uniq = [...new Set(codes)];
  let art, charge;
  if (uniq.length >= 2) {
    const short = uniq.filter(c => c.length < 8);
    if (short.length === 1) { charge = short[0]; art = uniq.find(c => c !== charge); }
    else { art = uniq[0]; charge = uniq[uniq.length - 1]; }
  } else {
    art = uniq.find(c => c.length >= 8);
    charge = uniq.find(c => c !== art && c.length < 8);
  }
  if (art) { r.artikel = art; r.artikelCode = true; }
  if (charge) { r.charge = charge; r.chargeCode = true; }
  return r;
}

/* ---------- Etikettfarbe ---------- */
// Firmenregel: Artikelnummer-Präfix -> Pflichtfarbe des Etiketts.
const LABEL_RULES = [['910', 'weiß'], ['911', 'gelb'], ['912', 'orange']];
function requiredLabelColor(artikel) {
  const a = String(artikel ?? '').trim();
  const rule = LABEL_RULES.find(([p]) => a.startsWith(p));
  return rule ? rule[1] : null;
}

// pixels: [[r,g,b], ...] Stichproben rund um den Barcode. Ergebnis 'weiß' | 'gelb' | 'orange' | null (unsicher).
// Papier ist das Helle im Bild: dunkle Striche/Schrift und Karton fallen unten raus, Folien-Glanz (immer weiß)
// oben. Gemessen wird das Band zwischen 50. und 80. Helligkeits-Perzentil.
// ponytail: feste Schwellen für Sättigung/Farbton. Warmes Hallenlicht macht Weiß leicht gelblich -> dann
// "unsicher" statt falscher Warnung. Mit echten Fotos der gelben/orangenen Etiketten nachjustieren (LABEL_HSV).
const LABEL_HSV = { whiteMaxSat: 0.15, yellowHue: [40, 75], yellowMinSat: 0.22, orangeHue: [8, 40], orangeMinSat: 0.3 };
function classifyLabelColor(pixels) {
  if (!pixels || pixels.length < 20) return null;
  const lum = ([r, g, b]) => 0.299 * r + 0.587 * g + 0.114 * b;
  const sorted = pixels.slice().sort((a, b) => lum(a) - lum(b));
  const band = sorted.slice(Math.floor(sorted.length * 0.5), Math.ceil(sorted.length * 0.8));
  const med = i => { const v = band.map(p => p[i]).sort((a, b) => a - b); return v[v.length >> 1]; };
  const [r, g, b] = [med(0), med(1), med(2)];
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  if (max < 90) return null; // zu dunkel, kein Etikett im Bild
  const s = (max - min) / max;
  let h = 0;
  if (max !== min) {
    if (max === r) h = 60 * (((g - b) / (max - min)) % 6);
    else if (max === g) h = 60 * ((b - r) / (max - min) + 2);
    else h = 60 * ((r - g) / (max - min) + 4);
  }
  if (h < 0) h += 360;
  const T = LABEL_HSV;
  if (s < T.whiteMaxSat) return 'weiß';
  if (h >= T.yellowHue[0] && h <= T.yellowHue[1] && s >= T.yellowMinSat) return 'gelb';
  if (h >= T.orangeHue[0] && h < T.orangeHue[1] && s >= T.orangeMinSat) return 'orange';
  return null;
}

/* ---------- Pickliste ---------- */
const normH = h => String(h ?? '').toLowerCase().replace(/[^a-zäöüß0-9]/g, '');
const pickErr = m => Object.assign(new Error(m), { userMessage: true }); // erwartbarer Fehler: nur Toast, kein Konsolenfehler
const normArt = s => String(s ?? '').toUpperCase().replace(/\s+/g, '');
const normCharge = s => normArt(s).replace(/^0+(?=.)/, ''); // "0001446028" == "1446028"

// Menge aus Zelle lesen: echte Zahl oder Text wie "8 kg" / "12,5" / "24 Stk".
function parseQty(raw, text) {
  if (typeof raw === 'number') return { n: raw, kg: /kg/i.test(text) };
  const m = String(raw ?? '').match(/(\d+(?:[.,]\d+)?)\s*(kg)?/i);
  return m ? { n: parseFloat(m[1].replace(',', '.')), kg: !!m[2] } : null;
}

// raw/fmt: XLSX.utils.sheet_to_json(sheet, {header:1, defval:''}) einmal mit raw:true, einmal raw:false
// (formatierter Text behält "8 kg" und führende Nullen bei als Zahl gespeicherten Chargen).
// Versteht zwei Aufbauten:
//  - Druck-Pickliste: Titelzeilen, Kopf "Artikelnummer / Bezeichnung" in einer Spalte, pro Artikel zwei Zeilen
//    (Nummer + Charge + "8 kg", darunter Bezeichnung + Hinweis wie "GEKÜHLTE WARE")
//  - einfache Tabelle: eine Zeile pro Artikel mit Menge+Einheit oder Anzahl/Gewicht (wie der eigene Export)
function parsePicklist(raw, fmt = raw) {
  const h = raw.findIndex(r => r.some(c => ['artikelnummer', 'artikel', 'artikelnr', 'artnr'].includes(normH(c))));
  if (h < 0) throw pickErr('Spalte "Artikelnummer" nicht gefunden.');
  const colArt = raw[h].findIndex(c => ['artikelnummer', 'artikel', 'artikelnr', 'artnr'].includes(normH(c)));
  // Kopf kann über bis zu drei Zeilen gehen ("Menge" / "best.")
  const col = names => {
    for (let i = h; i <= h + 2 && i < raw.length; i++) {
      const j = raw[i].findIndex((c, k) => k !== colArt && names.some(n => normH(c).startsWith(n)));
      if (j >= 0) return j;
    }
    return -1;
  };
  const colCharge = col(['charge', 'lot']), colMenge = col(['menge']), colEinheit = col(['einheit']);
  const colAnzahl = col(['anzahl']), colGewicht = col(['gewicht']), colBez = col(['bezeichnung']);
  if (colMenge < 0 && colAnzahl < 0 && colGewicht < 0) throw pickErr('Spalte "Menge", "Anzahl" oder "Gewicht" nicht gefunden.');

  const text = (i, j) => {
    if (j < 0) return '';
    const v = raw[i]?.[j], f = fmt[i]?.[j];
    if (typeof v === 'number') return f !== undefined && f !== '' && !/e[+-]/i.test(String(f)) ? String(f).trim() : String(v);
    return String(v ?? '').trim();
  };
  const qty = i => {
    for (const [j, forceKg, forceSt] of [[colMenge, false, false], [colAnzahl, false, true], [colGewicht, true, false]]) {
      if (j < 0 || String(raw[i]?.[j] ?? '').trim() === '') continue;
      const q = parseQty(raw[i][j], text(i, j));
      if (!q || !(q.n > 0)) continue;
      const kg = forceKg || (!forceSt && (q.kg || /kg/i.test(text(i, colEinheit))));
      return { required: q.n, einheit: kg ? 'kg' : 'Stück' };
    }
    return null;
  };
  const isArticle = s => /^\d{3,}[A-Z0-9\-/.]*$/i.test(s);
  const isHeader = s => /^(bezeichnung|artikel|charge|lot|menge|best|einheit|anzahl|gewicht|produktion|logistik)/.test(normH(s));

  const lines = [];
  let cur = null;
  for (let i = h + 1; i < raw.length; i++) {
    const a = text(i, colArt);
    if (isArticle(a)) {
      cur = { artikel: a, bez: colBez >= 0 && colBez !== colArt ? text(i, colBez) : '', charge: text(i, colCharge), hinweis: '',
        ...(qty(i) || { required: 0, einheit: 'Stück' }), picked: 0, scans: [] };
      lines.push(cur);
    } else if (cur && a && !isHeader(a) && !cur.bez) {
      cur.bez = a; // zweite Zeile eines Artikels: Bezeichnung, daneben evtl. Hinweis
      const note = text(i, colCharge);
      if (note && !isHeader(note)) cur.hinweis = note;
      if (!cur.required) Object.assign(cur, qty(i) || {});
    }
  }
  const valid = lines.filter(l => l.required > 0);
  if (!valid.length) throw pickErr('Keine gültige Zeile mit Artikelnummer und Menge gefunden.');
  const title = h > 0 ? raw.slice(0, h).flat().map(c => String(c).trim()).find(Boolean) || '' : '';
  // Titel wie "Pickliste B4 -> Bühl": das ist der Lagerplatz-Umzug für die ganze Liste (Von -> Nach).
  const route = title.replace(/^pickliste\s*/i, '').match(/(.+?)\s*(?:->|-+>|→)\s*(.+)/);
  const von = route ? route[1].trim() : '', nach = route ? route[2].trim() : '';
  return { title, von, nach, lines: valid, skipped: lines.length - valid.length };
}

// Fotografierte Pickliste (Papier statt Excel) in dasselbe Zeilen/Spalten-Raster verwandeln, das
// parsePicklist() schon von XLSX.utils.sheet_to_json(..., {header:1}) kennt -- dieselbe Auswertung
// (Artikel-Erkennung, Charge/Menge, Von->Nach im Titel) läuft dann für beide Wege unverändert.
// ocrLines: Tesseract-Zeilen mit Wort-Boxen (r.data.lines: [{words:[{text,confidence,bbox:{x0,...}}]}]),
// width: Bildbreite in Pixeln (für die Mindest-Lücke zwischen Spalten).
// Idee: Spalten eines gedruckten Tabellenrasters erkennt man daran, dass die linken Kanten der Wörter
// sich auf ein paar x-Positionen häufen, mit deutlichen Lücken dazwischen (Spaltenabstand) -- anders als
// der enge, unregelmäßige Abstand zwischen Wörtern innerhalb einer Spalte/Zelle.
function picklistGridFromWords(ocrLines, width) {
  const words = [];
  for (const l of ocrLines) for (const w of l.words || []) {
    if (w.confidence < 40 || !w.text.trim()) continue; // Handschrift/Rauschen am Rand meist sehr unsicher
    words.push({ text: w.text, x0: w.bbox.x0, x1: w.bbox.x1, y0: l.bbox?.y0 ?? w.bbox.y0 });
  }
  if (!words.length) return [];

  // 1) Innerhalb jeder Zeile eng benachbarte Wörter (normaler Wortabstand) zu Textfragmenten zusammenfassen.
  //    Das ist noch keine Spalte, nur "gehört zusammen" -- wichtig, damit ein langes erstes Wort einer Zelle
  //    ("Artikelnummer PFL") das zweite Wort nicht allein über dessen x0 in die falsche Spalte rutschen lässt.
  const byLine = new Map();
  for (const w of words) { if (!byLine.has(w.y0)) byLine.set(w.y0, []); byLine.get(w.y0).push(w); }
  const localGap = width * 0.012; // normaler Wortabstand bleibt klar darunter
  const frags = [];
  for (const [y0, ws] of byLine) {
    ws.sort((a, b) => a.x0 - b.x0);
    let cur = null;
    for (const w of ws) {
      if (cur && w.x0 - cur.x1 <= localGap) { cur.text += ' ' + w.text; cur.x1 = w.x1; }
      else { cur = { text: w.text, x0: w.x0, x1: w.x1, y0 }; frags.push(cur); }
    }
  }

  // 2) Spalten über alle Fragmente hinweg erkennen: deren linke Kanten häufen sich auf ein paar x-Positionen,
  //    mit einer deutlich größeren Lücke dazwischen als der Wortabstand innerhalb einer Zelle.
  const xs = frags.map(f => f.x0).sort((a, b) => a - b);
  const colGap = width * 0.05;
  const bounds = [];
  for (let i = 1; i < xs.length; i++) if (xs[i] - xs[i - 1] > colGap) bounds.push((xs[i] + xs[i - 1]) / 2);
  const colOf = x0 => bounds.filter(b => b < x0).length;
  const nCols = bounds.length + 1;

  const rows = new Map(); // y0 der Zeile -> Map(Spalte -> Fragmente in Reihenfolge)
  for (const f of frags) {
    if (!rows.has(f.y0)) rows.set(f.y0, new Map());
    const row = rows.get(f.y0), col = colOf(f.x0);
    row.set(col, [...(row.get(col) || []), f.text]);
  }
  return [...rows.entries()].sort((a, b) => a[0] - b[0]) // Zeilen von oben nach unten
    .map(([, row]) => Array.from({ length: nCols }, (_, c) => (row.get(c) || []).join(' ')));
}

// Pickliste-Modus: Barcodes gegen die Liste abgleichen statt nur die Ziffernlänge zu raten.
// Die Pickliste weiß, welche Artikelnummern und Chargen vorkommen, das ist zuverlässiger.
function applyPicklist(r, codes, lines) {
  const all = [...new Set(codes)];
  const line = lines.find(l => all.some(c => normArt(c) === normArt(l.artikel))) ||
    lines.find(l => normArt(l.artikel) === normArt(r.artikel));
  if (!line) return r;
  const out = { ...r, artikel: line.artikel, artikelCode: all.some(c => normArt(c) === normArt(line.artikel)) || r.artikelCode };
  if (!out.bez1 && line.bez) out.bez1 = line.bez;
  const charges = lines.filter(l => normArt(l.artikel) === normArt(line.artikel) && l.charge).map(l => l.charge);
  const hit = all.find(c => charges.some(x => normCharge(x) === normCharge(c)));
  const rest = all.filter(c => normArt(c) !== normArt(line.artikel));
  if (hit) { out.charge = charges.find(x => normCharge(x) === normCharge(hit)); out.chargeCode = true; }
  else if (rest.length === 1) { out.charge = rest[0]; out.chargeCode = true; }
  else if (normArt(out.charge) === normArt(line.artikel)) { out.charge = ''; out.chargeCode = false; }
  return out;
}

if (typeof module !== 'undefined') module.exports = { cleanLine, parseLabel, parsePicklist, applyPicklist, picklistGridFromWords, normArt, normCharge, requiredLabelColor, classifyLabelColor };
