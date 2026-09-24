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
  -- coalesce: fehlt "lines", wäre der Vergleich NULL und die Prüfung würde stillschweigend durchgewinkt
  if id is null or length(id) > 64 or coalesce(jsonb_typeof(doc), '') <> 'object'
     or coalesce(jsonb_typeof(doc -> 'lines'), '') <> 'array' or pg_column_size(doc) > 1000000 then
    raise exception 'lb_daten: ungültige Pickliste';
  end if;
  tl := public.lb_ist_tl(tl_kuerzel, tl_pw);
  select * into alt from public.lb_picks p where p.id = lb_speichern.id for update;
  if not found then
    insert into public.lb_picks (id, doc) values (lb_speichern.id, lb_speichern.doc) returning * into neu;
    return jsonb_build_object('ok', true, 'row', to_jsonb(neu));
  end if;
  if alt.geloescht or alt.rev <> basis then
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

revoke all on function public.lb_ok(text, text), public.lb_zugang(text), public.lb_ist_tl(text, text), public.lb_norm(text)
  from public, anon, authenticated;
revoke all on function public.lb_pruefen(text), public.lb_teamleiter(text, text, text),
  public.lb_liste(text, timestamptz), public.lb_speichern(text, text, jsonb, integer, text, text),
  public.lb_loeschen(text, text, text, text) from public, authenticated; -- die App nutzt keine Supabase-Logins
grant execute on function public.lb_pruefen(text), public.lb_teamleiter(text, text, text),
  public.lb_liste(text, timestamptz), public.lb_speichern(text, text, jsonb, integer, text, text),
  public.lb_loeschen(text, text, text, text) to anon;
