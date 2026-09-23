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
  const colGebinde = col(['gebinde']); // z. B. "Gebindegröße": kg/Stück pro Gebinde, falls in der Vorlage vorhanden
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
    if (cur && !cur.gebinde) {
      const g = parseFloat(text(i, colGebinde).replace(',', '.'));
      if (g > 0) cur.gebinde = g;
    }
  }
  const valid = lines.filter(l => l.required > 0);
  if (!valid.length) throw pickErr('Keine gültige Zeile mit Artikelnummer und Menge gefunden.');
  const title = h > 0 ? raw.slice(0, h).flat().map(c => String(c).trim()).find(Boolean) || '' : '';
  // Titel wie "Pickliste B4 -> Bühl": das ist der Lagerplatz-Umzug für die ganze Liste (Von -> Nach).
  // "\S*liste" statt "Pickliste": im Foto ist der linke Rand oft abgeschnitten ("ckliste B4 -> Bühl")
  const route = title.replace(/^\S*liste\s+/i, '').match(/(.+?)\s*(?:->|-+>|→)\s*(.+)/);
  const von = route ? route[1].trim() : '', nach = route ? route[2].trim() : '';
  return { title, von, nach, lines: valid, skipped: lines.length - valid.length };
}

// Wie viele Gebinde braucht es für eine Position? 200 kg bei 25 kg/Gebinde -> 8. Aufgerundet: ein
// angebrochenes Gebinde zählt als eins, man kann ja kein Teil-Gebinde greifen.
function gebindeCount(required, gebinde) {
  return gebinde > 0 ? Math.ceil(required / gebinde) : null;
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
  // 1) Innerhalb jeder OCR-Zeile eng benachbarte Wörter (normaler Wortabstand) zu Textfragmenten zusammenfassen,
  //    damit ein langes erstes Wort einer Zelle das zweite nicht über dessen x0 in eine falsche Spalte schiebt.
  //    Reine Strich-/Satzzeichen-Wörter sind meist Tabellenlinien ("|", "—") und fliegen raus ("->" bleibt).
  const localGap = width * 0.012;
  const frags = [];
  for (const l of ocrLines) {
    const ws = (l.words || []).filter(w => w.confidence >= 40 && w.text.trim() && !/^[|¦![\]()—–_=~.,:;'"`]+$/.test(w.text.trim())) // Handschrift/Rauschen meist unsicher
      .map(w => ({ text: w.text.trim(), x0: w.bbox.x0, x1: w.bbox.x1, y: w.bbox.y1 != null ? (w.bbox.y0 + w.bbox.y1) / 2 : (l.bbox?.y0 ?? w.bbox.y0) }))
      .sort((a, b) => a.x0 - b.x0);
    let cur = null;
    for (const w of ws) {
      if (cur && w.x0 - cur.x1 <= localGap) { cur.text += ' ' + w.text; cur.x1 = w.x1; cur.ys.push(w.y); }
      else { cur = { text: w.text, x0: w.x0, x1: w.x1, ys: [w.y] }; frags.push(cur); }
    }
  }
  if (!frags.length) return [];
  for (const f of frags) f.y = f.ys.reduce((s, y) => s + y, 0) / f.ys.length;

  // 2) Spalten: die linken Kanten häufen sich auf ein paar x-Positionen, mit deutlich größerer Lücke dazwischen.
  const xs = frags.map(f => f.x0).sort((a, b) => a - b);
  const bounds = [];
  for (let i = 1; i < xs.length; i++) if (xs[i] - xs[i - 1] > width * 0.05) bounds.push((xs[i] + xs[i - 1]) / 2);
  for (const f of frags) f.col = bounds.filter(b => b < f.x0).length;

  // 3) Zeilen NICHT über die Höhe bilden: ein schräg gehaltenes Handy lässt rechte Spalten eine halbe Zeile
  //    tiefer liegen als links (Foto 23.09.2026). Stattdessen spaltenweise von oben nach unten lesen:
  //    jede Artikelnummer startet eine Position, der n-te Wert in Charge/Menge gehört zur n-ten Position.
  const byY = (a, b) => a.y - b.y;
  const firstTok = s => s.split(/\s+/)[0];
  const isArt = f => /^\d{3,}[A-Z0-9\-/.]*$/i.test(firstTok(f.text));
  const anyHead = f => /^(artikel|bezeichnung|charge|lot|menge|best|einheit|anzahl|gewicht|gebinde|produktion|logistik)/.test(normH(f.text));
  const colHead = f => /^(charge|lot|menge|einheit|anzahl|gewicht|bezeichnung|gebinde)/.test(normH(f.text));
  // Ohne "Artikel…"-Überschrift ist es keine Pickliste (z. B. ein Etikett) -- tolerant gegen Lesefehler am Wortende
  const artHead = frags.find(f => /^(artikel|artnr)/.test(normH(f.text)));
  if (!artHead) return [];
  const artCol = artHead.col, headY = artHead.y;

  const recs = [];
  for (const f of frags.filter(f => f.col === artCol && f.y > headY).sort(byY)) {
    if (isArt(f)) recs.push({ y: f.y, art: firstTok(f.text), bez: [] });
    else if (recs.length && !anyHead(f)) recs.at(-1).bez.push(f.text);
  }
  const pitch = recs.length > 1 ? (recs.at(-1).y - recs[0].y) / (recs.length - 1) : Infinity;

  const cols = [];
  for (const c of [...new Set(frags.map(f => f.col))].filter(c => c !== artCol).sort((a, b) => a - b)) {
    const inCol = frags.filter(f => f.col === c);
    const head = inCol.filter(colHead).sort((a, b) => Math.abs(a.y - headY) - Math.abs(b.y - headY))[0];
    const vals = inCol.filter(f => f.y > (head ? head.y : headY) && !anyHead(f)).sort(byY);
    const main = recs.map(() => ''), second = recs.map(() => '');
    const add = (arr, k, t) => { arr[k] = arr[k] ? arr[k] + ' ' + t : t; };
    const withDigit = vals.filter(f => /\d/.test(f.text));
    if (vals.length === recs.length) vals.forEach((f, k) => { main[k] = f.text; });
    else if (withDigit.length === recs.length) {
      // Charge-Spalte mit Hinweisen dazwischen ("GEKÜHLTE WARE"): Werte mit Ziffern sind die Chargen,
      // Text ohne Ziffern ist der Hinweis zur Position davor
      let k = -1;
      for (const f of vals) if (/\d/.test(f.text)) main[++k] = f.text; else add(second, Math.max(k, 0), f.text);
    } else {
      // ponytail: Anzahl passt nicht (leere/ungelesene Zelle) -> nach Höhe: letzte Position, die nicht deutlich
      // tiefer steht. Bei stark schrägem Foto kann das danebenliegen; der Prüfhinweis nach dem Import bleibt.
      for (const f of vals) {
        const k = Math.max(0, recs.findLastIndex(r => r.y <= f.y + pitch * 0.3));
        if (main[k]) add(second, k, f.text); else main[k] = f.text;
      }
    }
    cols.push({ name: head ? head.text : '', main, second, qtyLike: vals.filter(f => /^\d+([.,]\d+)?\s*(kg|stk|stück)?\.?$/i.test(f.text)).length });
  }
  // Überschrift "Menge" nicht gelesen? Dann ist es die Spalte, die fast nur aus Mengen besteht.
  if (!cols.some(c => /^(menge|anzahl|gewicht)/.test(normH(c.name)))) {
    const q = cols.filter(c => !c.name && c.qtyLike >= recs.length / 2).sort((a, b) => b.qtyLike - a.qtyLike)[0];
    if (q) q.name = 'Menge';
  }
  const named = cols.filter(c => c.name);

  const above = frags.filter(f => f.y < headY).sort((a, b) => a.y - b.y || a.x0 - b.x0);
  const title = (above.find(f => /->|→/.test(f.text)) || above[0])?.text;
  const rows = title ? [[title]] : [];
  rows.push(['Artikelnummer', ...named.map(c => c.name)]);
  recs.forEach((r, k) => {
    rows.push([r.art, ...named.map(c => c.main[k])]);
    rows.push([r.bez.join(' '), ...named.map(c => c.second[k])]);
  });
  return rows;
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

if (typeof module !== 'undefined') module.exports = { cleanLine, parseLabel, parsePicklist, applyPicklist, picklistGridFromWords, gebindeCount, normArt, normCharge, requiredLabelColor, classifyLabelColor };
