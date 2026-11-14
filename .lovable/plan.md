# Volledig plan: Progressive Zero-Knowledge Auth & Sovereignty Engine (Fase 0 t/m G)

Repo: route-roam-09e66f25 (bevestigd). Alles draait op eigen infrastructuur, er komt niets op Lovable Cloud. Neon blijft alleen-lezen. Elke migratie krijgt een aparte, handmatige GO.

---

## A. Al gedaan

**Import en verkenning**
- De repo is 1-op-1 in dit project gezet (zonder .git, node_modules en .workspace).
- Alle pagina's, de servercode, de crypto, de documentatie, de migraties en de Neon-structuur zijn grondig doorgelezen. Neon telt 262 toegepaste migraties (laatste 0266), 198 public-tabellen en 13 vault-tabellen.
- De regel "alleen eigen infrastructuur" staat in het geheugen.

**Stap 0**
- De vier afwijkingen in de migratiegeschiedenis staan beschreven in docs/HANDOVER.md, met de exacte Neon-checksums.
- Verouderde migratiedocumentatie is rechtgezet.
- Eén tijdsafhankelijke, wisselvallige test is gerepareerd, en de telling van één kaartvertaling ook.

**Fase A (openbare pagina's)**
- /t is vertaald.
- Inzoomen werkt weer.
- De taal wordt aan de serverkant gekozen.
- Knoppen zijn minstens 44 px groot.
- Inhoud blijft zichtbaar zonder JavaScript.
- Fontwissels verschuiven de pagina niet meer (CLS max 0,0007).
- Overal AAA-contrast.
- Gemeten op alle schermformaten. Screenshots staan in /mnt/documents/fase-a/.
- Tests: 2861 groen. Twee time-outs in een preview-test slaagden bij een herhaling.

**Herstel v3 (altijd 3 van 4)**
- Vier factoren: passkey-PRF, ROUT Card #rk1, server-shard en 24 papieren woorden.
- Werkt in de crypto-worker, met een eigen dataformaat, schermen voor instellen, herstellen en inloggen, en een /t-handoff via het URL-fragment.
- Getest met fast-check, alle mogelijke combinaties van delen, compatibiliteit met v1/v2 en PGlite-migratietests.
- Klaarstaand in db-pending/, niet toegepast:
  - 0267: controle dat de kaart echt van het lid is.
  - 0268: v3 EXPAND.
  - 0269: v3 CONTRACT.
- Bouwregels, roadmap, HANDOVER en het geheugen zijn bijgewerkt.

---

## B. Nog te doen, in volgorde

### Stap 1: Stap 0 en Fase A afsluiten
- De volledige testsuite draaien tot er 0 rode tests zijn, en de wisselvallige preview-test stabiel maken.
- CLS (< 0,05) en contrast opnieuw meten.
- Daarna leg ik de volledige SQL van **0267** aan je voor, met de risico's en een terugdraaiplan. Pas na jouw GO wordt hij toegepast.

### Stap 2: Formeel model van het herstel (vóór de SQL)
- Een TLA+-specificatie van herstel v4:
  - de staten 2-van-3 (actief), opschalen, 3-van-4 (actief), geautoriseerd terugschalen en ingetrokken;
  - gelijktijdige ceremonies, een kaart die halverwege wegvalt, en een sessie die tijdens de stap uitlogt.
- Wat bewezen moet worden:
  - Er is altijd precies één actieve ceremonie.
  - Er is nooit een tussenstaat waarin minder delen nodig zijn dan het niveau vraagt.
  - Er treedt geen deadlock op.
  - Terugschalen kan alleen met een verse step-up.
- TLC draait in CI. De SQL-migratie volgt het model.

### Stap 3: Wachtwoord met OPAQUE, Argon2id en PoW
- Vóór de handshake rekent de browser een Hashcash-puzzel uit:
  - de moeilijkheid stijgt bij veel pogingen;
  - de server controleert hem met een eenmalige uitdaging.
- Argon2id draait in WebAssembly in de crypto-worker:
  - minstens 64 MiB geheugen, 4 iteraties, en nooit in de hoofdthread;
  - er komt een kluissleutel uit, en het wachtwoord gaat nooit, ook niet als hash, naar de server.
- OPAQUE (RFC 9807, geauditeerde bibliotheek zoals @serenity-kit/opaque):
  - de server bewaart alleen een registratierecord;
  - de server-setup-sleutel (opk) ligt als RVE1-envelop in vault_enclave, ingepakt met de Master KEK;
  - daardoor maakt een dump van de database alleen geen woordenboekaanval mogelijk.
- Wasm-geheugen wordt bij elke afronding, fout en worker-stop met nullen overschreven:
  - een eigen WebAssembly.Memory per bewerking, die in een finally-blok wordt leeggemaakt;
  - de worker stopt bij het uitloggen;
  - een test leest het geheugen na afloop en verwacht alleen nullen.
- De bouwregel voor accounts wordt "passkey óf OPAQUE-wachtwoord". Een gewoon Better Auth-wachtwoord blijft geweigerd.
- Migratie: een tabel voor OPAQUE-registraties en de PoW-uitdagingen. Die komt in db-pending/ en krijgt een aparte GO.

### Stap 4: Veiligheidsschild (Sovereignty Health Score)
- Basis (rood/oranje), Soeverein Digitaal (groen), Hardware Enclave (goud/obsidiaan).
- Een subtiel schildje in de topbalk met de melding en een knop om te upgraden. Niemand wordt geblokkeerd.
- In vier talen (NL/EN/FR/DE), met AAA-contrast en knoppen van minstens 44 px.

### Stap 5: FIDO MDS3-attestatie
- Bij het registreren van een passkey controleert de server het attestatie-certificaat tegen de ondertekende MDS3-lijst. Die lijst wordt periodiek opgehaald en de handtekening wordt gecontroleerd.
- Een eerlijke beperking: de meeste gesynchroniseerde passkeys (Apple, Google) geven geen attestatie mee.
  - Gecertificeerde hardware krijgt een "geattesteerd" kenmerk en telt mee voor het hoogste niveau.
  - Een passkey zonder attestatie blijft werken op niveau 2.
  - Zo blijft het "niemand blokkeren" overeind.
- OPAQUE-wachtwoorden hebben per definitie geen hardware-attestatie. Ze blijven daarom niveau 1.

### Stap 6: Dynamisch herstel v4
- Zonder kaart: 2 van 3 (passkey-PRF of OPAQUE/Argon2id-seed + server + papier).
- Met kaart: automatisch 3 van 4, met een nieuw #rk1-deel via het fragment naar de kaart.
- Precies volgens het TLA+-model: eerst de nieuwe ceremonie, dan wordt de oude atomair ingetrokken.
- 0268 en 0269 worden herschreven tot v4 EXPAND en CONTRACT. Elk krijgt een aparte GO, en de CONTRACT pas zodra de schema-versie van productie dat toelaat.

### Stap 7: Gasten zonder spoor (Fase B, boekingen)
- Schuilnaam per host = HMAC-SHA256(gast-masterseed, host-id), berekend aan de kant van de gast.
- BBS+ blinde handtekeningen (BLS12-381, IETF-draft, Wasm): de host tekent blind een recht op een tijdslot. Bij aankomst toont de gast een zero-knowledge-bewijs. Dat bewijs blijft onkoppelbaar, ook als host-sleutels uitlekken.
- Blinde token buckets in SECURITY DEFINER-functies:
  - search_path = pg_catalog, pg_temp, met expliciete revoke en grant;
  - ze tellen per blind token en per tijdsvenster, zonder e-mailadres of IP-adres.
- Zero-knowledge range proofs (Bulletproofs in Wasm) bewijzen dat [start, eind] in een vrij venster valt, zonder de rest van de agenda te tonen.
  - Een eerlijke beperking: iemand moet de bezetting kennen om het vrije venster vast te leggen.
  - De host legt daarom een commitment vast op het venster. De server ziet alleen de commitment en het bewijs.
- Property-based tests met duizenden willekeurige gelijktijdige scenario's voor locks, buckets en het grootboek.
- Migraties per onderdeel in db-pending/, elk met een aparte GO.

### Stap 8: Post-quantum Double Ratchet voor kluis en grootboek
- Elk gesynchroniseerd event krijgt een eigen sleutel uit een PQ Double Ratchet (ML-KEM-1024 + X25519, in de stijl van PQ3/SPQR).
- Dat geeft forward secrecy en herstel na een inbraak (post-compromise security).
- Een ratchet-stap wist de oude sleutel meteen.
- Formaat RVE2. RVE1 blijft leesbaar voor bestaande data, maar nieuwe data wordt altijd RVE2.
- Een test laat het bouwen falen als een nieuwe blob geen PQ-hybride envelop is.

### Stap 9: Formeel bewijs dat er niets lekt (RLS non-interference)
- Alle RLS-policies en SECURITY DEFINER-functies worden gemodelleerd: een extractor zet ze om naar een model, en dat model wordt bewezen met Lean of Coq, of gecontroleerd met een SMT-solver (Z3).
- De eigenschap: een query van rout_app voor lid X levert nooit rijen of afleidbare informatie van een andere host, kluis of gast op.
- Het model wordt in CI vergeleken met de echte database-snapshot, zodat het niet kan afwijken.

### Stap 10: Fasen C t/m G
- Volgen dezelfde regels.
- Per fase leg ik je een apart plan voor.

---

## C. Eerlijke grenzen (staan ook in de documentatie)
- Een browser kan een sleutel niet aantoonbaar in TPM of Secure Enclave opsluiten. Alleen passkeys/WebAuthn gebruiken die hardware. Een OPAQUE-wachtwoord kan dat nooit.
- In JavaScript kan een getypte invoerstring niet worden gewist. Het wissen geldt voor buffers die we zelf beheren en voor Wasm-geheugen.
- Formele bewijzen gaan over het model. Of de code aan het model voldoet, controleren tests en de vergelijking met de snapshot.

## D. Regels en documentatie die worden bijgewerkt
- De accountregel: passkey óf OPAQUE.
- De herstelbeslissing in het geheugen: "2-van-3 zonder kaart, 3-van-4 met kaart".
- De booking-engine-regels met PoW, BBS+, ZK-range, Double Ratchet, MDS3 en formele modellen.
- De bijlage van HANDOVER en de roadmap, met alle nieuwe taken.

## E. Wat jij moet aanleveren
- Een GO per migratie: 0267 nu, de rest pas als ik ze aan je voorleg.
- Een fysieke ROUT Card en een telefoon voor de echte test van de kaart en de attestatie.

---

## F. Extra bindende regels (worden in AGENTS.md vastgelegd, gelden voor Fase B t/m G)
1. **COOP/COEP:** `Cross-Origin-Opener-Policy: same-origin` en `Cross-Origin-Embedder-Policy: require-corp` op de beveiligde schermen.
   - Eerst wordt gecontroleerd welke externe bronnen (fonts, afbeeldingen, Didit) dan breken. De openbare pagina's krijgen dit pas als niets meer breekt.
2. **Deterministische Wasm en SRI:** elke Wasm-module wordt reproduceerbaar gebouwd, krijgt een vastgepinde SHA-384 en weigert te laden bij een afwijkende hash.
3. **Offline herroepingscertificaten:** een kaart ontkoppelen kan alleen met een certificaat dat door 2 van 3 drempeldelen is ondertekend.
4. **Constant-time:**
   - Crypto-code mag niet vertakken op geheime data. Een lint-regel en een dudect-timingtest draaien in CI.
   - Eerlijke grens: JavaScript en de browser garanderen geen nanoseconde-gelijkheid. De test werkt daarom met een statistische drempel (Welch t < 4,5).
5. **Wissen bij achtergrond, blur en unload:** bij `visibilitychange` (hidden), `blur`, `pagehide`/`beforeunload` en het stoppen van een worker wordt het Wasm-geheugen gewist. Ontsleutelde sleutels worden vergrendeld, zodat je na terugkeer opnieuw moet ontgrendelen.
   - Afweging: `blur` vergrendelt ook bij elke klik naar een ander venster. Ik stel voor dat `blur` alleen het geheugen van lopende bewerkingen wist en dat `hidden` vergrendelt.
6. **VDF-verankering van de ledger:**
   - De Merkle-root van booking_events en de audit-logs gaat periodiek door een Wesolowski-VDF (klassegroep).
   - Het bewijs wordt opgeslagen en elke client kan het controleren.
7. **Noise_IKpsk2 / PQ-mTLS tussen web-runtime en Omni-Worker:**
   - Wederzijds geauthenticeerd, met een hybride PQ-psk.
   - Sleutels alleen uit eigen geheimen.

## G. Migratie 0267 ter controle (direct na goedkeuring van dit plan)

**Wat hij doet**
- De kaartcontrole krijgt een derde doel bij `vault_enclave.consume_sdm_tap`: `recovery_factor`.
- Een live tap bewijst dan "dit is mijn eigen, niet-ingetrokken kaart" voordat een herstel-deel aan de kaart wordt gekoppeld.
- Er komt geen nieuwe tabel en geen nieuw recht. Eigenaar, handtekening en rechten blijven gelijk.

**SQL (68 regels, bestand db-pending/0267_card_recovery_factor_tap.sql)**
- De check-constraint `sdm_tap_grants_purpose` wordt vervangen. Toegestaan: public_proof, step_up en recovery_factor.
- `consume_sdm_tap(text, text)` wordt opnieuw gedefinieerd:
  - SECURITY DEFINER met search_path = pg_catalog, pg_temp;
  - de aanroeper komt uit de transactie-context;
  - een grant kan maar één keer gebruikt worden (FOR UPDATE);
  - ingetrokken kaarten en kaarten van een ander lid worden geweigerd;
  - elke uitkomst komt op het audit-log;
  - weigeringen geven granted=false terug in plaats van een fout.
- REVOKE voor PUBLIC en GRANT EXECUTE aan rout_app. Een DO-blok stopt de migratie als PUBLIC toch mag uitvoeren of als rout_app tabelrechten in vault_enclave heeft.

**Risico's**
- *Laag:* bestaande aanroepen (public_proof, step_up) gedragen zich exact hetzelfde. Die logica is ongewijzigd ten opzichte van db/0258.
- *Constraint-wissel:* de oude constraint verdwijnt voor de nieuwe er staat. Dat gebeurt binnen één transactie, dus er is geen moment zonder constraint.
- *Vergrendeling:* ALTER TABLE vergrendelt sdm_tap_grants kort. Taps die op dat moment binnenkomen wachten even; er gaat geen data verloren.
- *Code:* recovery_factor wordt pas gebruikt door de herstel-code. Tot die code live staat, wordt het nieuwe doel nergens aangeroepen.
- *Geschiedenis:* er komt een nieuwe rij in schema_migrations. Daarna gaat CODE_SCHEMA_LEVEL naar 0267 en verhuist het bestand van db-pending naar db.

**Controles vooraf (alleen-lezen op Neon)**
- Er bestaat geen rij met consumed_for buiten de twee huidige waarden.
- De huidige functie-definitie is gelijk aan die in db/0258.
- Een PGlite-replay van db/ plus 0267 is groen.

**Terugdraaiplan**
- Een aparte rollback-SQL die:
  - eerst controleert dat er geen rij met consumed_for = 'recovery_factor' is (anders stopt hij);
  - de constraint terugzet op twee doelen;
  - de functie letterlijk herstelt uit db/0258;
  - de rechten opnieuw expliciet zet;
  - hetzelfde DO-blok draait.
- Ook voor de rollback geldt een aparte GO.

**Na jouw GO voor Neon**
1. De controles vooraf.
2. Toepassen in één transactie.
3. Rechten, checksum en audit controleren.
4. Het bestand naar db/, het schema-niveau naar 0267 en de testsuite draaien.

## H. Zeven verplichte correcties (vervangen waar ze botsen met B en F)
1. **Wissen alleen als de crypto-worker niets doet** (vervangt F.5):
   - Bij hidden of blur wist de worker alleen als `is_idle`.
   - Een lopende bewerking krijgt een afbreeksignaal en stopt met een gecontroleerde fout (`OperationAborted`). Daarna wordt het geheugen alsnog gewist.
   - Er wordt nooit gewist midden in een Wasm-instructie.
   - Vergrendelen pas na 30 s hidden, zodat even naar je wachtwoordmanager wisselen geen handshake breekt.
2. **COOP/COEP met een harde documentgrens** (vervangt F.1):
   - Kluis, herstel en wachtwoord krijgen een eigen document onder /secure/*.
   - Je komt daar altijd via een volledige pagina-herlaadbeurt, nooit via navigatie binnen de app.
   - Alleen dat document stuurt de headers. Een subdomein blijft een optie als de documentgrens niet volstaat.
3. **Schuilnaam per epoch** (vervangt B.7):
   - `HMAC-SHA256(masterseed, host_id || epoch)`. Standaard is de epoch per boeking (een willekeurige nonce).
   - Misbruiklimieten gaan via BBS+-tokens, zodat de host geen geschiedenis kan koppelen.
   - Afweging: een host die bewust een vaste klant wil herkennen, kan dat alleen als de gast dat zelf toestaat.
4. **Stateless SQL voor Neon-pooling** (vult B.2 aan):
   - Het TLA+-model laat de verbinding na elke stap vallen.
   - Elke SQL-stap is één zelfstandige transactie met FOR UPDATE op een herstel-masterrij, een idempotency-sleutel en een versienummer (compare-and-swap).
   - Geen sessievariabelen, advisory locks of tijdelijke tabellen buiten de transactie.
5. **Hybride ratchet** (vervangt B.8):
   - Een HKDF-symmetrische ratchet per event.
   - Een ML-KEM-1024 + X25519-stap alleen bij de start, bij een apparaatwissel of eens per 24 uur (een epoch).
   - Een header met alleen een epoch-id en een teller, en een test die de overhead per event begrenst.
6. **Weigering van 0267 kan niet stil voorbijgaan:**
   - Een strikte Zod-discriminated union `{granted:true,cardState} | {granted:false}`.
   - Één wrapper `consumeSdmTap()` geeft het resultaat terug als ‘never-ignored’ type en gooit bij false een `TapDenied`-fout in de aanroepende flow.
   - Een lint-regel verbiedt directe SQL-aanroepen.
   - De database blijft granted=false teruggeven. Een fout (RAISE) zou het audit-log terugdraaien, en dat is in strijd met de bestaande vault-regel.
7. **Wachtwoord niet als JavaScript-string:**
   - Een eigen invoerveld zonder `value`. Elk keydown-event gaat als bytes naar een Uint8Array in Wasm, en het scherm toont alleen bolletjes.
   - Eerlijke grens: de browser maakt per toets zelf een korte string (`event.key`) en stuurt die door het besturingssysteem. Die kan niemand wissen. Het lek verkleint van het hele wachtwoord tot losse tekens.
   - Afweging: plakken en wachtwoordmanagers werken in deze modus niet. Hij is daarom een keuze ("paranoïde invoer"), naast het normale veld dat direct na het afleiden wordt leeggemaakt.

## Uitvoering na goedkeuring
1. Roadmap en AGENTS.md bijwerken met F en H.
2. Stap 1: de testsuite tot 0 rood, en CLS en contrast opnieuw meten.
3. De rollback-SQL voor 0267 schrijven, de TypeScript-wrapper uit H.6 bouwen en de controles vooraf alleen-lezen op Neon draaien.
4. Je de resultaten laten zien. Migratie 0267 gaat pas naar Neon na je expliciete GO in een volgend bericht.
