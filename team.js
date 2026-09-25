/* ---------- Team verwalten (nur Hauptadmin) ----------
   Personen anlegen und ändern: Kürzel, Name, Rolle (Picker, Teamleiter, Hauptadmin), Bereiche der App und aktiv/inaktiv.
   Teamleiter und Hauptadmin bekommen ein Startpasswort, das nur einmal angezeigt wird; bei der ersten Anmeldung wählen
   sie ein eigenes (app.js, pwForm). Mit Server prüft lb_person_speichern jede Änderung über das Hauptadmin-Passwort,
   ohne Server bleibt die Liste nur auf diesem Handy. Lädt nach app.js. */

let tmEdit = null; // null = Liste | { neu: true } | die bearbeitete Person
const ROLLEN_HINWEIS = {
  picker: 'Meldet sich nur mit dem Kürzel an, ohne Passwort.',
  admin: 'Alle Teamleiter-Rechte: Picklisten laden, zuteilen, korrigieren, freigeben, Bestand exportieren. Braucht ein Passwort.',
  hauptadmin: 'Wie Teamleiter und darf zusätzlich das Team verwalten und Passwörter zurücksetzen.',
};
const ROLLEN_ORDNUNG = { hauptadmin: 0, admin: 1, picker: 2 };
const tmRolle = () => document.querySelector('input[name=tmRolle]:checked')?.value || '';

function renderTeam() {
  const liste = [...team].sort((a, b) => ROLLEN_ORDNUNG[a.rolle] - ROLLEN_ORDNUNG[b.rolle] || a.kuerzel.localeCompare(b.kuerzel, 'de'));
  $('tmList').replaceChildren(...liste.map(p => {
    const li = document.createElement('li');
    li.className = 'card' + (p.aktiv ? '' : ' aus');
    const b = document.createElement('button');
    b.className = 'entry'; b.type = 'button';
    b.setAttribute('aria-label', `${p.kuerzel} bearbeiten`);
    const kopf = document.createElement('div'); kopf.className = 'tm-kopf nums';
    const rolle = document.createElement('span'); rolle.className = 'tm-rolle ' + p.rolle; rolle.textContent = ROLLEN[p.rolle];
    kopf.append(p.kuerzel, rolle);
    if (!p.aktiv) { const aus = document.createElement('span'); aus.className = 'tm-rolle'; aus.textContent = 'deaktiviert'; kopf.append(aus); }
    const sub = document.createElement('div'); sub.className = 'sub';
    sub.textContent = [p.name, BEREICHE.filter(x => p.bereiche.includes(x[0])).map(x => x[1]).join(', ')].filter(Boolean).join(' · ');
    b.append(kopf, sub);
    b.onclick = () => tmOeffnen(p);
    li.append(b);
    return li;
  }));
  $('tmForm').hidden = !tmEdit;
  $('tmNeu').hidden = !!tmEdit || !$('tmPwBox').hidden;
}

function tmOeffnen(p) {
  tmEdit = p || { neu: true };
  $('tmPwBox').hidden = true;
  const neu = !p, selbst = !neu && p.kuerzel === picker;
  $('tmTitel').textContent = neu ? 'Person anlegen' : `${p.kuerzel} bearbeiten`;
  $('tmKuerzel').value = p?.kuerzel || '';
  $('tmKuerzel').readOnly = !neu; // Kürzel steht in Picklisten und Buchungen, daher nicht umbenennen
  $('tmName').value = p?.name || '';
  for (const r of document.querySelectorAll('input[name=tmRolle]')) {
    r.checked = r.value === (p?.rolle || 'picker');
    r.disabled = selbst && r.value !== 'hauptadmin'; // sich selbst nicht aussperren (prüft auch der Server)
  }
  for (const c of document.querySelectorAll('input[name=tmBereich]')) c.checked = (p?.bereiche || ALLE_BEREICHE).includes(c.value);
  $('tmAktiv').checked = p ? p.aktiv : true;
  $('tmAktiv').disabled = selbst;
  $('tmReset').hidden = neu || selbst || p.rolle === 'picker' || !SYNC_ON;
  $('tmErr').hidden = true;
  tmRolleHinweis();
  renderTeam();
  $('tmForm').scrollIntoView({ behavior: glatt(), block: 'start' });
  if (neu) setTimeout(() => $('tmKuerzel').focus(), 50);
}
function tmSchliessen() { tmEdit = null; renderTeam(); }
function tmRolleHinweis() { $('tmRolleHint').textContent = ROLLEN_HINWEIS[tmRolle()] || ''; }
function tmFehler(msg) { $('tmErr').textContent = msg; $('tmErr').hidden = false; }

function zeigePasswort(kuerzel, pw, hinweis) {
  $('tmPwTitel').textContent = `Passwort für ${kuerzel}`;
  $('tmPwCode').textContent = pw;
  $('tmPwHint').textContent = hinweis;
  $('tmPwBox').hidden = false;
  tmEdit = null; renderTeam();
  $('tmPwBox').scrollIntoView({ behavior: glatt(), block: 'start' });
  $('tmPwOk').focus({ preventScroll: true });
}

async function tmSpeichern(ev) {
  ev.preventDefault();
  const alt = tmEdit?.neu ? null : tmEdit;
  if (!tmEdit) return;
  const p = {
    kuerzel: $('tmKuerzel').value.trim(), name: $('tmName').value.trim(), rolle: tmRolle(),
    bereiche: [...document.querySelectorAll('input[name=tmBereich]:checked')].map(c => c.value), aktiv: $('tmAktiv').checked,
  };
  if (!/^[A-Za-zÄÖÜäöüß0-9]{2,8}$/.test(p.kuerzel)) { tmFehler('Kürzel: 2 bis 8 Buchstaben oder Ziffern, ohne Leerzeichen.'); return; }
  if (!alt && team.some(x => x.kuerzel.toLowerCase() === p.kuerzel.toLowerCase())) { tmFehler(`Das Kürzel ${p.kuerzel} gibt es schon.`); return; }
  if (!ROLLEN[p.rolle]) { tmFehler('Bitte eine Rolle wählen.'); return; }
  if (!p.bereiche.length) { tmFehler('Mindestens einen Bereich wählen.'); return; }
  if (alt && alt.rolle !== 'picker' && p.rolle === 'picker'
      && !confirm(`${p.kuerzel} wird Picker. Das Passwort von ${p.kuerzel} gilt dann nicht mehr.\n\nOK = speichern`)) return;
  if (!SYNC_ON) { // ohne Server: nur auf diesem Handy, Passwort wie beim Anmelden Kürzel + "4567"
    team = alt ? team.map(x => x === alt ? p : x) : [...team, p];
    teamSpeichern(); teamGeaendert();
    if (p.rolle !== 'picker' && (!alt || alt.rolle === 'picker')) zeigePasswort(p.kuerzel, p.kuerzel + '4567', 'Ohne Server gilt für Teamleiter immer Kürzel + 4567.');
    else { toast(`${p.kuerzel} gespeichert.`); tmSchliessen(); }
    return;
  }
  $('tmSave').disabled = true;
  try {
    const res = await rpc('lb_person_speichern', { lager, admin_kuerzel: tlAuth?.kuerzel ?? null, admin_pw: tlAuth?.pw ?? null, person: p });
    await ladeTeam(true);
    if (res?.startpasswort) zeigePasswort(res.kuerzel, res.startpasswort,
      `Nur jetzt sichtbar. Bitte an ${res.kuerzel} weitergeben. Bei der ersten Anmeldung muss ${res.kuerzel} ein eigenes Passwort wählen.`);
    else { toast(`${res?.kuerzel || p.kuerzel} gespeichert.`); tmSchliessen(); }
  } catch (err) {
    if (err.kind === 'zugang') lagerUngueltig();
    else tmFehler(err.kind === 'server' ? 'Keine Verbindung zum Server. Bitte Internet prüfen und noch einmal speichern.' : err.message);
  } finally { $('tmSave').disabled = false; }
}

async function tmZuruecksetzen() {
  const p = tmEdit;
  if (!p || p.neu || !SYNC_ON) return;
  if (!confirm(`Passwort für ${p.kuerzel} zurücksetzen? Das bisherige gilt dann nicht mehr, ${p.kuerzel} bekommt ein neues Startpasswort.`)) return;
  $('tmReset').disabled = true;
  try {
    const res = await rpc('lb_passwort_zuruecksetzen', { lager, admin_kuerzel: tlAuth?.kuerzel ?? null, admin_pw: tlAuth?.pw ?? null, kuerzel: p.kuerzel });
    zeigePasswort(p.kuerzel, res.passwort,
      `Nur jetzt sichtbar. Bitte an ${p.kuerzel} weitergeben. Bei der nächsten Anmeldung muss ${p.kuerzel} ein eigenes Passwort wählen.`);
  } catch (err) {
    if (err.kind === 'zugang') lagerUngueltig();
    else tmFehler(err.kind === 'server' ? 'Keine Verbindung zum Server. Bitte Internet prüfen und noch einmal versuchen.' : err.message);
  } finally { $('tmReset').disabled = false; }
}

$('teamBtn').onclick = () => {
  if (rang !== 'hauptadmin') return;
  if (mode === 'team') { setMode(BEREICHE.find(b => bereiche.includes(b[0]))?.[3] || 'scan'); return; } // nochmal tippen: zurück
  if (busy || !$('form').hidden) { toast('Bitte zuerst das Etikett fertig buchen oder verwerfen.'); return; }
  tmEdit = null; $('tmPwBox').hidden = true;
  setMode('team');
  ladeTeam(true);
  window.scrollTo({ top: 0 });
};
$('tmNeu').onclick = () => tmOeffnen(null);
$('tmZurueck').onclick = () => { if (mode === 'team') $('teamBtn').click(); };
$('tmCancel').onclick = tmSchliessen;
$('tmForm').onsubmit = tmSpeichern;
$('tmReset').onclick = tmZuruecksetzen;
for (const r of document.querySelectorAll('input[name=tmRolle]')) r.onchange = tmRolleHinweis;
$('tmPwOk').onclick = () => { $('tmPwBox').hidden = true; $('tmPwCode').textContent = ''; renderTeam(); };
$('tmPwCopy').onclick = async () => {
  try { await navigator.clipboard.writeText($('tmPwCode').textContent); toast('Passwort kopiert.'); }
  catch { toast('Kopieren ging nicht. Bitte abschreiben.'); }
};
