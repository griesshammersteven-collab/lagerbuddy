-- LagerBuddy: Picklisten zwischen den Handys synchronisieren (Supabase / Postgres).
-- Einmal im Supabase-Dashboard unter "SQL Editor" ausführen. Mehrfach ausführen schadet nicht.
-- Danach zugang.sql mit euren eigenen Codes ausführen -- vorher geht nichts rein oder raus.
--
-- Sicherheitsmodell: Die App kennt nur den öffentlichen Supabase-Schlüssel. Beide Tabellen haben RLS ohne
-- Policies, also kommt von außen niemand direkt dran. Alles läuft über die Funktionen unten, und jede prüft
-- zuerst den Lager-Code, den man einmal pro Handy eingibt. Teamleiter-Rechte (umteilen, freigeben, löschen)
-- prüft der Server über das Teamleiter-Passwort. Codes liegen nur als bcrypt-Hash in der Datenbank.

create extension if not exists pgcrypto with schema extensions;

create table if not exists public.lb_geheim (
  k text primary key,          -- 'lager' oder 'tl:<Kürzel>'
  hash text not null           -- crypt(code, gen_salt('bf'))
);
alter table public.lb_geheim enable row level security;

create table if not exists public.lb_picks (
  id text primary key,
  doc jsonb not null,          -- die ganze Pickliste wie in der App (Positionen, Fortschritt, Zuteilung "fuer")
  rev integer not null default 1,           -- steigt bei jeder Änderung: Grundlage für die Konflikterkennung
  geloescht boolean not null default false, -- weich gelöscht, damit andere Handys es beim Abgleich mitbekommen
  geaendert timestamptz not null default clock_timestamp()
);
create index if not exists lb_picks_geaendert on public.lb_picks (geaendert);
alter table public.lb_picks enable row level security;
revoke all on table public.lb_geheim, public.lb_picks from anon, authenticated;

-- intern: Code vereinheitlichen -- nur Buchstaben und Ziffern, groß. Auf dem iPhone schreibt die Tastatur im Passwort-
-- feld nach dem ersten Buchstaben klein weiter ("Gr9j-pqzh-98bg"), damit scheiterte die Teamleiter-Anmeldung.
create or replace function public.lb_norm(pw text) returns text
language sql immutable set search_path = public as $$
  select upper(regexp_replace(coalesce(pw, ''), '[^0-9A-Za-z]', '', 'g'));
$$;

-- intern: stimmt der Code für diesen Schlüssel? Gespeichert ist der Hash des vereinheitlichten Codes (zugang.sql);
-- der Vergleich mit der wörtlichen Eingabe bleibt für Codes, die vor der Vereinheitlichung gesetzt wurden.
create or replace function public.lb_ok(k text, pw text) returns boolean
language sql stable security definer set search_path = public, extensions as $$
  select exists (select 1 from public.lb_geheim g where g.k = lb_ok.k
    and (g.hash = crypt(public.lb_norm(pw), g.hash) or g.hash = crypt(coalesce(pw, ''), g.hash)));
$$;

-- intern: ohne gültigen Lager-Code bricht jeder Aufruf ab
create or replace function public.lb_zugang(lager text) returns void
language plpgsql stable security definer set search_path = public, extensions as $$
begin
  if not public.lb_ok('lager', lager) then raise exception 'lb_zugang: Lager-Code falsch'; end if;
end $$;

-- intern: Teamleiter-Passwort richtig?
create or replace function public.lb_ist_tl(kuerzel text, pw text) returns boolean
language sql stable security definer set search_path = public, extensions as $$
  select kuerzel is not null and public.lb_ok('tl:' || kuerzel, pw);
$$;

-- intern: Aufbau einer Pickliste prüfen (dieselben Regeln wie gueltig() in picks.js). Eine kaputte Liste würde sonst
-- auf jedem Handy beim Abgleich landen und dort das Buchen lahmlegen; die Größengrenzen schützen den Handyspeicher.
create or replace function public.lb_doc_ok(doc jsonb) returns boolean
language plpgsql immutable set search_path = public as $$
declare
  l jsonb;
  s jsonb;
begin
  -- einzeln geprüft statt mit "or" verkettet: jsonb_array_length auf etwas anderes als ein Array wäre ein Fehler
  if coalesce(jsonb_typeof(doc), '') <> 'object' then return false; end if;
  if coalesce(jsonb_typeof(doc -> 'lines'), '') <> 'array' then return false; end if;
  if jsonb_array_length(doc -> 'lines') > 500 or pg_column_size(doc) > 300000 then return false; end if;
  for l in select * from jsonb_array_elements(doc -> 'lines') loop
    if jsonb_typeof(l) <> 'object' then return false; end if;
    if coalesce(jsonb_typeof(l -> 'lid'), '') <> 'string' or coalesce(jsonb_typeof(l -> 'artikel'), '') <> 'string'
       or coalesce(jsonb_typeof(l -> 'required'), '') <> 'number' or coalesce(jsonb_typeof(l -> 'picked'), '') <> 'number'
       or coalesce(jsonb_typeof(l -> 'scans'), '') <> 'array' then return false; end if;
    if length(l ->> 'lid') > 200 or length(l ->> 'artikel') > 200 or jsonb_array_length(l -> 'scans') > 2000 then return false; end if;
    for s in select * from jsonb_array_elements(l -> 'scans') loop
      if jsonb_typeof(s) <> 'object' or coalesce(jsonb_typeof(s -> 'menge'), '') <> 'number' then return false; end if;
    end loop;
  end loop;
  return true;
end $$;

-- Einrichtung am Handy: Lager-Code prüfen
create or replace function public.lb_pruefen(lager text) returns boolean
language sql stable security definer set search_path = public, extensions as $$
  select public.lb_ok('lager', lager);
$$;

-- Teamleiter-Anmeldung
create or replace function public.lb_teamleiter(lager text, kuerzel text, pw text) returns boolean
language plpgsql stable security definer set search_path = public, extensions as $$
begin
  perform public.lb_zugang(lager);
  return public.lb_ist_tl(kuerzel, pw);
end $$;

-- Abgleich: ohne "seit" alle aktuellen Listen, sonst alles, was sich seitdem geändert hat (auch Löschungen).
-- 2 Minuten Überlappung: eine Änderung, deren Transaktion etwas später fertig wurde, geht so nicht verloren.
create or replace function public.lb_liste(lager text, seit timestamptz default null) returns setof public.lb_picks
language plpgsql stable security definer set search_path = public, extensions as $$
begin
  perform public.lb_zugang(lager);
  return query
    select * from public.lb_picks p
    where (seit is null and not p.geloescht) or p.geaendert > seit - interval '2 minutes'
    order by p.geaendert;
end $$;

-- Speichern mit Konflikterkennung: "basis" ist die rev, auf der das Handy seine Änderung aufgebaut hat.
-- Passt sie nicht (jemand anders war schneller), wird nichts geschrieben und der aktuelle Stand zurückgegeben
-- -- das Handy wendet seine Änderungen darauf neu an und schickt nochmal.
create or replace function public.lb_speichern(lager text, id text, doc jsonb, basis integer,
  tl_kuerzel text default null, tl_pw text default null) returns jsonb
language plpgsql volatile security definer set search_path = public, extensions as $$
declare
  alt public.lb_picks;
  neu public.lb_picks;
  tl boolean;
begin
  perform public.lb_zugang(lager);
  if id is null or length(id) > 64 or not public.lb_doc_ok(doc) then
    raise exception 'lb_daten: ungültige Pickliste';
  end if;
  tl := public.lb_ist_tl(tl_kuerzel, tl_pw);
  select * into alt from public.lb_picks p where p.id = lb_speichern.id for update;
  if not found then
    -- auch eine neue Liste darf nur ein Teamleiter gleich als freigegeben anlegen
    if not tl and coalesce(jsonb_typeof(doc -> 'freigabe'), 'null') <> 'null' then
      raise exception 'lb_teamleiter: nur Teamleiter dürfen freigeben';
    end if;
    insert into public.lb_picks (id, doc) values (lb_speichern.id, lb_speichern.doc) returning * into neu;
    return jsonb_build_object('ok', true, 'row', to_jsonb(neu));
  end if;
  if alt.geloescht or basis is null or alt.rev <> basis then -- ohne basis keine Konfliktprüfung: dann als Konflikt
    return jsonb_build_object('ok', false, 'row', to_jsonb(alt));
  end if;
  if not tl and (alt.doc -> 'fuer' is distinct from doc -> 'fuer' or alt.doc -> 'freigabe' is distinct from doc -> 'freigabe') then
    raise exception 'lb_teamleiter: nur Teamleiter dürfen umteilen oder freigeben';
  end if;
  update public.lb_picks p set doc = lb_speichern.doc, rev = alt.rev + 1, geaendert = clock_timestamp()
    where p.id = lb_speichern.id returning * into neu;
  return jsonb_build_object('ok', true, 'row', to_jsonb(neu));
end $$;

-- Löschen (nur Teamleiter)
create or replace function public.lb_loeschen(lager text, id text, tl_kuerzel text, tl_pw text) returns jsonb
language plpgsql volatile security definer set search_path = public, extensions as $$
declare
  neu public.lb_picks;
begin
  perform public.lb_zugang(lager);
  if not public.lb_ist_tl(tl_kuerzel, tl_pw) then
    raise exception 'lb_teamleiter: nur Teamleiter dürfen Picklisten verwerfen';
  end if;
  update public.lb_picks p set geloescht = true, rev = p.rev + 1, geaendert = clock_timestamp()
    where p.id = lb_loeschen.id returning * into neu;
  return jsonb_build_object('ok', true, 'row', to_jsonb(neu));
end $$;

-- ---------- Lager: Ein-/Ausbuchungen je Lagerplatz und Bestand ----------
-- Jede Buchung ist eine Zeile, die nur angehängt und nie geändert wird; der Bestand je Lagerplatz ist die Summe
-- (ein minus aus). Die id vergibt das Handy: kommt eine Buchung nach einem Netzabbruch doppelt an, zählt sie einmal.
create table if not exists public.lb_bewegungen (
  id text primary key,
  ts timestamptz not null,                  -- Zeitpunkt der Buchung auf dem Handy
  lagerplatz text not null,                 -- z. B. H3.01.01.00.01
  artikel text not null,
  bez text not null default '',
  charge text not null default '',
  menge numeric not null,                   -- Menge gesamt (je Gebinde x Anzahl)
  gebinde integer not null,                 -- Anzahl Gebinde
  einheit text not null,                    -- kg | Stück
  richtung text not null,                   -- ein | aus
  quelle text not null,                     -- pickliste | wareneingang | lager
  pick_id text,
  picker text not null default '',
  erfasst timestamptz not null default clock_timestamp()
);
create index if not exists lb_bewegungen_platz on public.lb_bewegungen (lagerplatz);
create index if not exists lb_bewegungen_ts on public.lb_bewegungen (ts);
alter table public.lb_bewegungen enable row level security;
revoke all on table public.lb_bewegungen from anon, authenticated;

-- intern: eine Buchung prüfen (einzeln statt mit "or" verkettet, damit kein Cast auf falschen Typ läuft)
create or replace function public.lb_buchung_ok(b jsonb) returns boolean
language plpgsql immutable set search_path = public as $$
begin
  if coalesce(jsonb_typeof(b), '') <> 'object' then return false; end if;
  if coalesce(jsonb_typeof(b -> 'id'), '') <> 'string' or length(b ->> 'id') not between 1 and 100 then return false; end if;
  if coalesce(b ->> 'lagerplatz', '') !~ '^[A-Z][0-9]{1,3}(\.[0-9]{2}){4}$' then return false; end if;
  if coalesce(jsonb_typeof(b -> 'artikel'), '') <> 'string' or length(b ->> 'artikel') not between 1 and 64 then return false; end if;
  if length(coalesce(b ->> 'charge', '')) > 64 or length(coalesce(b ->> 'bez', '')) > 200
     or length(coalesce(b ->> 'picker', '')) > 20 or length(coalesce(b ->> 'pick_id', '')) > 64 then return false; end if;
  if coalesce(jsonb_typeof(b -> 'menge'), '') <> 'number' or coalesce(jsonb_typeof(b -> 'gebinde'), '') <> 'number'
     or coalesce(jsonb_typeof(b -> 'ts'), '') <> 'number' then return false; end if;
  if (b ->> 'menge')::numeric <= 0 or (b ->> 'menge')::numeric > 10000000 then return false; end if;
  if (b ->> 'gebinde')::numeric not between 1 and 10000 or (b ->> 'gebinde')::numeric <> floor((b ->> 'gebinde')::numeric) then return false; end if;
  if coalesce(b ->> 'einheit', '') not in ('kg', 'Stück') or coalesce(b ->> 'richtung', '') not in ('ein', 'aus')
     or coalesce(b ->> 'quelle', '') not in ('pickliste', 'wareneingang', 'lager') then return false; end if;
  return true;
end $$;

-- Buchungen speichern (bis 200 auf einmal, z. B. nach Offline-Zeit). Doppelte ids werden übergangen.
create or replace function public.lb_buchen(lager text, buchungen jsonb) returns integer
language plpgsql volatile security definer set search_path = public, extensions as $$
declare
  b jsonb;
  n integer := 0;
  k integer;
begin
  perform public.lb_zugang(lager);
  if coalesce(jsonb_typeof(buchungen), '') <> 'array' or jsonb_array_length(buchungen) > 200 then
    raise exception 'lb_daten: ungültige Buchungen';
  end if;
  for b in select * from jsonb_array_elements(buchungen) loop
    if not public.lb_buchung_ok(b) then raise exception 'lb_daten: ungültige Buchung'; end if;
    insert into public.lb_bewegungen (id, ts, lagerplatz, artikel, bez, charge, menge, gebinde, einheit, richtung, quelle, pick_id, picker)
    values (b ->> 'id', to_timestamp((b ->> 'ts')::numeric / 1000), b ->> 'lagerplatz', upper(b ->> 'artikel'), coalesce(b ->> 'bez', ''),
      coalesce(b ->> 'charge', ''), (b ->> 'menge')::numeric, (b ->> 'gebinde')::integer, b ->> 'einheit', b ->> 'richtung',
      b ->> 'quelle', nullif(b ->> 'pick_id', ''), coalesce(b ->> 'picker', ''))
    on conflict (id) do nothing;
    get diagnostics k = row_count;
    n := n + k;
  end loop;
  return n;
end $$;

-- Bestand je Lagerplatz, Artikel und Charge (führende Nullen der Charge zählen nicht: 0001446028 = 1446028)
create or replace function public.lb_bestand(lager text)
returns table (lagerplatz text, artikel text, charge text, einheit text, bez text, menge numeric, gebinde bigint, zuletzt timestamptz)
language plpgsql stable security definer set search_path = public, extensions as $$
#variable_conflict use_column
begin
  perform public.lb_zugang(lager);
  return query
    select b.lagerplatz, b.artikel, max(b.charge), b.einheit, max(nullif(b.bez, '')),
      sum(case when b.richtung = 'ein' then b.menge else -b.menge end),
      sum(case when b.richtung = 'ein' then b.gebinde else -b.gebinde end)::bigint, max(b.ts)
    from public.lb_bewegungen b
    group by b.lagerplatz, b.artikel, ltrim(b.charge, '0'), b.einheit
    having sum(case when b.richtung = 'ein' then b.menge else -b.menge end) <> 0
    order by b.lagerplatz, b.artikel;
end $$;

-- Letzte Buchungen (Excel-Export), neueste zuerst, höchstens 10000
create or replace function public.lb_bewegungen_liste(lager text, anzahl integer default 5000)
returns setof public.lb_bewegungen
language plpgsql stable security definer set search_path = public, extensions as $$
begin
  perform public.lb_zugang(lager);
  return query select * from public.lb_bewegungen b order by b.ts desc limit least(greatest(coalesce(anzahl, 5000), 1), 10000);
end $$;

revoke all on function public.lb_ok(text, text), public.lb_zugang(text), public.lb_ist_tl(text, text), public.lb_norm(text),
  public.lb_doc_ok(jsonb), public.lb_buchung_ok(jsonb) from public, anon, authenticated;
revoke all on function public.lb_pruefen(text), public.lb_teamleiter(text, text, text),
  public.lb_liste(text, timestamptz), public.lb_speichern(text, text, jsonb, integer, text, text),
  public.lb_loeschen(text, text, text, text), public.lb_buchen(text, jsonb), public.lb_bestand(text),
  public.lb_bewegungen_liste(text, integer) from public, authenticated; -- die App nutzt keine Supabase-Logins
grant execute on function public.lb_pruefen(text), public.lb_teamleiter(text, text, text),
  public.lb_liste(text, timestamptz), public.lb_speichern(text, text, jsonb, integer, text, text),
  public.lb_loeschen(text, text, text, text), public.lb_buchen(text, jsonb), public.lb_bestand(text),
  public.lb_bewegungen_liste(text, integer) to anon;
