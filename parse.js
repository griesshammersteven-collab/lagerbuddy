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
  return { title, lines: valid, skipped: lines.length - valid.length };
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

if (typeof module !== 'undefined') module.exports = { cleanLine, parseLabel, parsePicklist, applyPicklist, normArt, normCharge };
