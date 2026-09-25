-- LagerBuddy: Zugangscodes setzen oder ändern. Nach setup.sql im Supabase "SQL Editor" ausführen.
-- Die drei Werte unten durch eigene ersetzen -- diese Datei danach NICHT mit echten Codes speichern oder committen.
-- Lager-Code: gibt man einmal pro Handy ein, gilt für alle Picker. Teamleiter-Passwörter: bei jeder Anmeldung.
-- Groß-/Kleinschreibung, Leerzeichen und Bindestriche spielen bei der Eingabe keine Rolle.
-- Code ändern = diese Datei mit neuem Wert nochmal ausführen; Handys fragen dann beim nächsten Abgleich neu.
-- Weitere Teamleiter und Picker legt der Hauptadmin (CMue) direkt in der App an: Team verwalten (Personen-Symbol oben).
do $$
declare
  lager text := 'HIER-LAGER-CODE';
  pw_cmue text := 'HIER-PASSWORT-CMUE';
  pw_md text := 'HIER-PASSWORT-MD';
begin
  if lager like 'HIER-%' or pw_cmue like 'HIER-%' or pw_md like 'HIER-%' then
    raise exception 'Bitte zuerst oben eigene Codes eintragen.';
  end if;
  -- Groß-/Kleinschreibung, Leerzeichen und Bindestriche zählen nicht (siehe lb_norm in setup.sql)
  lager := public.lb_norm(lager); pw_cmue := public.lb_norm(pw_cmue); pw_md := public.lb_norm(pw_md);
  if length(lager) < 6 or length(pw_cmue) < 8 or length(pw_md) < 8 then
    raise exception 'Zu kurz: Lager-Code mindestens 6, Passwörter mindestens 8 Buchstaben/Ziffern.';
  end if;
  insert into public.lb_geheim (k, hash) values
    ('lager', extensions.crypt(lager, extensions.gen_salt('bf', 8))),
    ('tl:CMue', extensions.crypt(pw_cmue, extensions.gen_salt('bf', 8))),
    ('tl:MD', extensions.crypt(pw_md, extensions.gen_salt('bf', 8)))
  on conflict (k) do update set hash = excluded.hash;
end $$;
