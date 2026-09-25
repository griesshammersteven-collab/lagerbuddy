/* Picklisten-Änderungen als Operationen. Reine Funktionen ohne Browser, Test: node check.js
   Jede Änderung (Buchen, Überspringen, Umteilen …) ist eine kleine Operation statt "ganze Liste überschreiben".
   So kann ein Handy offline weiterarbeiten und seine Operationen später auf den dann aktuellen Serverstand
   anwenden -- bucht der Picker, während der Teamleiter eine Charge korrigiert, bleibt beides erhalten.
   Operationen müssen idempotent sein: ging die Antwort des Servers verloren, wird dieselbe Operation noch einmal
   auf einen Stand angewendet, der sie schon enthält (deshalb z. B. Buchungen am Zeitstempel wiedererkennen). */

const PICK_FIELDS = ['artikel', 'charge', 'required', 'gebinde', 'ba', 'kunde', 'baOk']; // baOk: { von, ts } -- BA-Nr./Kunde vom Picker geprüft
const cloneDoc = d => (d == null ? null : JSON.parse(JSON.stringify(d)));

// doc: Pickliste oder null (gibt es nicht / gelöscht). Ergebnis: neue Pickliste oder null. doc bleibt unverändert.
function applyOp(doc, op) {
  if (op.t === 'neu') return doc ? cloneDoc(doc) : cloneDoc(op.doc);
  if (!doc) return null; // Änderung an einer Liste, die inzwischen weg ist: verfällt
  if (op.t === 'weg') return null;
  const d = cloneDoc(doc);
  const line = () => d.lines.find(l => l.lid === op.lid);
  switch (op.t) {
    case 'ersetzen': { // neues Foto/Excel: Positionen und Fortschritt neu, Zuteilung bleibt
      const { fuer } = d;
      const out = { ...d, ...cloneDoc(op.data), fuer };
      delete out.freigabe;
      return out;
    }
    case 'fuer': d.fuer = op.fuer; break;
    case 'route': d.von = op.von; d.nach = op.nach; break;
    case 'freigabe': d.freigabe = op.freigabe; break;
    case 'feld': {
      const l = line();
      if (l && PICK_FIELDS.includes(op.key)) { if (op.v == null) delete l[op.key]; else l[op.key] = op.v; }
      break;
    }
    case 'skip': { const l = line(); if (l) { if (op.skipped) l.skipped = op.skipped; else delete l.skipped; } break; }
    case 'scan': {
      const l = line();
      if (l && !l.scans.some(s => s.ts === op.scan.ts && s.picker === op.scan.picker)) {
        l.scans.push(op.scan);
        // anzahl > 1: Sammelbuchung -- ein Gebinde gescannt, weitere gleiche vom Picker bestätigt
        l.picked = Math.round((l.picked + op.scan.menge * (op.scan.anzahl || 1)) * 1000) / 1000; // 0,1 + 0,2 kg ohne Gleitkomma-Rest
      }
      break;
    }
  }
  return d;
}

// Positionen brauchen eine feste Kennung (lid), damit eine Operation nach "ersetzen" nicht die falsche Zeile trifft.
function withLineIds(doc, newId) {
  for (const l of doc.lines) if (!l.lid) l.lid = newId();
  return doc;
}

// Plausibilitätsprüfung für Picklisten vom Server: Eine kaputte Liste (Fehler auf einem anderen Handy oder bewusst
// manipuliert) darf die App nicht auf allen Handys lahmlegen -- sie wird dann übergangen statt gespeichert.
// Dieselben Regeln prüft der Server in lb_speichern (supabase/setup.sql).
const istText = v => typeof v === 'string' && v.length <= 200;
function gueltig(doc) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc) || !Array.isArray(doc.lines) || doc.lines.length > 500) return false;
  return doc.lines.every(l => l && typeof l === 'object' && istText(l.lid) && istText(l.artikel)
    && Number.isFinite(l.required) && Number.isFinite(l.picked) && Array.isArray(l.scans) && l.scans.length <= 2000
    && l.scans.every(s => s && typeof s === 'object' && Number.isFinite(s.menge)));
}

if (typeof module !== 'undefined') module.exports = { applyOp, withLineIds, cloneDoc, gueltig };
