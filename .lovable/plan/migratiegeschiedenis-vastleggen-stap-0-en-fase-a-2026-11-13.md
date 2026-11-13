# Migratiegeschiedenis vastleggen, Stap 0 en Fase A

Alles blijft op je eigen infrastructuur. Er gaat niets naar Neon. Deze ronde bevat geen enkele migratie.

## Nagekeken (alleen lezen, vandaag)

De vier bekende afwijkingen in de migratiegeschiedenis staan elk precies zo op de uitzonderingslijst (`scripts/migration-history-allowlist.ts`). Bestandsnaam en Neon-controlecode komen overeen.

| Bestand | Op Neon (uitgevoerd) | Code nu | Effect aanwezig in Neon? |
|---|---|---|---|
| 91_shadowban.sql | 4187…47c9, 12-10 06:05 | db/, andere code f2d6…a95a (achteraf bewerkt) | Ja, `profiles.is_shadowbanned` |
| 95_question_stories.sql | 9e28…a5, 19-10 20:04 | niet in db/, archief e409…54d4 | Ja, `profile_questions.story_until` (via 0000_baseline, live 30-10) |
| 0169_workspace_icon.sql | 9568…43f7, 02-11 11:30 | niet in db/, archief 11a7…021b; opnieuw uitgegeven als 0172 (live 03-11) | Ja, `workspaces.icon` |
| 0209_recovery_vault_pairwise.sql | 44ae…87ac, 07-11 14:16 | db/, andere code 3f48…ffa5 (achteraf bewerkt) | 3-van-5-tabellen zijn weg (0243, live 12-11); `rout_pairwise_register` draait met `pg_catalog, pg_temp` (0254, live 13-11) |

Ook nagekeken:
- `db-pending/0265_booking_ledger.sql` bevat geen `pg_catalog.greatest`/`least` meer. 0265 staat niet in `db/`.
- De code meldt 0266, net als Neon.
- Je dossier klopt hierin dus al. Hoeveel tests nu rood staan, heb ik nog niet gecontroleerd.

## Wat ik ga doen

### 1. Afwijkingen vastleggen (alleen documentatie)
- Een nieuwe bijlage achteraan `docs/HANDOVER.md` met de tabel hierboven, de datum en de gebruikte leesvragen. De genummerde secties blijven letterlijk staan.
- Ik verander niets aan de uitzonderingslijst en niets aan Neon.

### 2. Stap 0: de basis gezond
- De verouderde teksten in `db-pending/README.md`, de laatste bijlage van het overdrachtsdossier (0266 staat er nog als wachtend) en het QA-draaiboek (verwacht nog 0254) rechtzetten op de echte stand: 0266 live, 0265 en 0267 wachtend.
- De volledige testronde draaien, met de typecontrole en lint erbij.
- Elke rode test eerst diagnosticeren en daarna gericht herstellen. Doel: 0 rood.
- Migratiebestanden, `CODE_SCHEMA_LEVEL` en de snapshot blijven ongewijzigd.

### 3. Fase A: hoofdpagina, discover, about, info en boekingspagina's
- **Meetronde:** schermafbeeldingen op 320, 360, 384, 414, 768, 834, 1024, 1280, 1440 en 1920, plus liggend.
- **Automatische controle per formaat:**
  - horizontale overloop
  - afgesneden elementen
  - verschuiving tijdens laden (CLS)
  - tikdoelen kleiner dan 44 px
  - contrast onder AAA
- **Herstel:**
  - de "9 pagina's"-scrollsectie op mobiel
  - tabellen worden kaarten of netjes scrollbare blokken
  - animaties alleen via transform en opacity, met respect voor "minder beweging"
  - inzoomen op telefoon weer toelaten
  - de vaste Engelse tekst op `/t` vertalen
  - de twee taalkeuzes gelijktrekken
- **Teksten:** nalopen op herstel 2-van-4, passkeys en kluis.
- **Per pagina:** een eigen titel, omschrijving en deelafbeelding van 1200x630 in NL/EN/FR/DE.
- **Ontwerp:** verfijnen binnen de bestaande huisstijl.
- **Oplevering:** voor- en na-schermafbeeldingen per formaat plus het controlerapport.

### 4. Eisen voor Fase B en later (nu alleen vastleggen, niet bouwen)
Deze regels komen als vaste projectregels in `AGENTS.md`:
- herstel van sleutels via de bestaande deelsleutels
- verplichte hybride post-quantum versleuteling (ML-KEM-1024 + X25519)
- vaste lengte en vaste responstijd voor boekings- en bitmaskerverkeer
- de Omni-werker als blinde doorgeefbuis, zonder kluissleutels

Fase B begint pas na jouw GO, en elke migratie vraagt een aparte GO.

## Technische details
- De controlecodes zijn berekend als SHA-256 van de ruwe bestandsbytes, net als `checksumOf` in `scripts/migration-plan.ts`.
- Neon is gelezen via een alleen-lezen batch op `public.schema_migrations`, `information_schema.columns`, `pg_proc.proconfig` en `pg_class`.
- Meten gebeurt met Playwright tegen de lokale preview. CLS en contrast worden per pagina gemeten met PerformanceObserver en een contrastberekening.
- Pagina's die een ingelogde gebruiker nodig hebben, kan ik in deze preview niet meten, omdat er geen databaseverbinding is. Die meld ik als geblokkeerd.
