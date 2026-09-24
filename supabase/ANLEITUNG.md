# Picklisten-Abgleich einrichten (Supabase)

Damit Teamleiter und Picker mit **verschiedenen Handys** arbeiten können, gleichen die Handys ihre
Picklisten über ein Supabase-Projekt ab. Einmalig etwa 5 Minuten.

## 1. Projekt anlegen
1. Auf <https://supabase.com> ein kostenloses Konto anlegen und **New project** wählen.
2. **Region: Frankfurt (eu-central-1)**, damit die Daten in der EU liegen.
3. Datenbank-Passwort vergeben und sicher ablegen. Die App braucht es nicht.

## 2. Datenbank einrichten
1. Im Projekt links **SQL Editor** öffnen.
2. Den Inhalt von `supabase/setup.sql` einfügen und **Run** klicken.
3. `supabase/zugang.sql` in den Editor kopieren und oben die drei Codes durch eigene ersetzen:
   - **Lager-Code**: gilt für alle, wird einmal pro Handy eingegeben (mind. 6 Zeichen)
   - **Passwort CMue** und **Passwort MD**: für die Teamleiter-Anmeldung (mind. 8 Zeichen)
4. **Run** klicken. Die Datei danach **nicht** mit den echten Codes speichern oder ins Repo legen.

## 3. App verbinden
Unter **Project Settings → API Keys** (bzw. **Data API**) zwei Werte kopieren:
- **Project URL**, z. B. `https://abcdefgh.supabase.co`
- den öffentlichen Schlüssel: **Publishable key** (`sb_publishable_…`) oder bei älteren Projekten **anon public**

Diese beiden Werte kommen in `app.js` bei `const SYNC = … { url: '', key: '' }`. Beide sind öffentlich und
dürfen im Code stehen. Geschützt wird über den Lager-Code, den nur der Server kennt.
**Niemals den `service_role`- oder `secret`-Schlüssel eintragen.**

## 4. Handys
- App öffnen und bei „Neue Version verfügbar“ aktualisieren. Einmal den **Lager-Code** eingeben, fertig.
- Teamleiter melden sich mit ihrem neuen Passwort an. Das alte Kürzel+„4567“ gilt dann nicht mehr.
- Picklisten, die schon auf einem Handy liegen, werden beim ersten Abgleich hochgeladen.

## Gut zu wissen
- **Offline**: Buchungen ohne Netz werden gesammelt und nachgeschickt. Die Pickliste zeigt, wie viele warten.
- **Konflikte**: Bucht ein Picker, während der Teamleiter eine Position korrigiert, bleibt beides erhalten.
- **Code ändern**: `zugang.sql` mit neuen Werten nochmal ausführen. Die Handys fragen dann neu nach dem Lager-Code.
- **Neuer Teamleiter**: Zeile in `zugang.sql` ergänzen und das Kürzel in `app.js` bei `MASTERS` eintragen.
- **Kostenloses Projekt**: Supabase pausiert es nach einer Woche ganz ohne Nutzung. Im Alltag passiert das nicht,
  nach Betriebsferien im Supabase-Dashboard einmal **Restore** klicken.
- Etikettfotos verlassen das Handy nie. Auf den Server gehen nur die ausgelesenen Picklisten-Daten.
