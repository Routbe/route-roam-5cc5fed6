# Plan: Progressive Zero-Knowledge Auth & Sovereignty Engine

## Wat er verandert voor gebruikers
- Nieuwe bezoekers kunnen een account maken met alleen een wachtwoord. Een passkey of ROUT Card blijft optioneel.
- In de topbalk staat een veiligheidsschild met drie niveaus:
  - Basis (rood/oranje): alleen een wachtwoord. Melding: "Basisbeveiliging actief. Voeg een Passkey of ROUT Card toe voor hardware-onschendbaarheid."
  - Soeverein Digitaal (groen): passkey gekoppeld.
  - Hardware Enclave (goud/obsidiaan): ROUT Card gekoppeld.
- Herstel past zich aan: zonder kaart werkt het met 2 van 3 delen, met kaart automatisch met 3 van 4.
- Gasten krijgen per host een eigen schuilnaam. Hosts kunnen gasten niet aan elkaar koppelen.

## Volgorde
1. **Stap 0 / Fase A controleren:** alle tests opnieuw draaien (0 rood) en CLS en contrast opnieuw meten. Er wordt niets gebouwd.
2. **Migratie 0267 (eigen-kaartcontrole):** ik laat je de inhoud en de risico's zien. Ik pas hem pas toe op Neon na jouw GO.
3. **Fase B, deel 1: wachtwoord met OPAQUE en Argon2id**
   - Het wachtwoord verlaat de browser nooit, ook niet als hash. De server bewaart alleen een OPAQUE-registratie.
   - Argon2id draait in WebAssembly in de bestaande crypto-worker met minstens 64 MiB geheugen en 4 iteraties. Daaruit volgt de kluissleutel.
   - Geheugen met geheimen wordt na elke bewerking op nul gezet. Waar dat niet kan (de invoerstring van het wachtwoord) staat het eerlijk in de documentatie.
4. **Fase B, deel 2: dynamisch herstel**
   - Nieuw formaat v4: 2 van 3 delen (passkey of wachtwoord + server + papier). Zodra een kaart gekoppeld wordt, schaalt het op naar 3 van 4. Het #rk1-deel gaat via het URL-fragment naar de kaart.
   - Opschalen gebeurt in één stap: eerst een nieuwe ceremonie, dan wordt de oude ingetrokken. Terugschalen naar een lager niveau kan alleen met expliciete bevestiging en een verse step-up.
5. **Fase B, deel 3: schuilnaam per host en blinde limieten**
   - Schuilnaam = HMAC-SHA256(gast-masterseed, host-id), berekend aan de kant van de gast.
   - Blinde token buckets in SECURITY DEFINER-functies (search_path = pg_catalog, pg_temp, rechten expliciet ingetrokken en toegekend). De server telt per schuilnaam en per tijdsvenster, zonder e-mailadres of IP-adres.
   - Property-based tests en een model-check voor de limiet-buckets en de staatsovergangen.
6. **Post-quantum en zeroization:** controleren dat elke nieuwe blob ML-KEM-1024 + X25519 RVE1 gebruikt. Een test maakt het bouwen rood als er een uitzondering is.

Elke nieuwe migratie (OPAQUE-registraties, v4-herstel, token buckets) komt eerst in db-pending/ en krijgt een aparte GO per migratie.

## Botsingen met eerdere beslissingen (worden aangepast)
- De bouwregel "accounts alleen met passkey" (passkey-enrollment, user.create.before hook) wordt "passkey óf OPAQUE-wachtwoord". Een gewoon wachtwoord via Better Auth blijft geweigerd.
- Het pas gebouwde v3-herstel (altijd 3 van 4) wordt het niveau "met kaart" binnen v4. Migraties 0268 en 0269 worden herzien voordat ze aan jou worden voorgelegd.
- De beslissing in het geheugen ("3-van-4") wordt bijgewerkt naar "2-van-3 zonder kaart, 3-van-4 met kaart".

## Technische details
- OPAQUE: een geauditeerde bibliotheek (bv. @serenity-kit/opaque, RFC 9807) in de worker. De server-setup-sleutel komt alleen uit een eigen geheim, nooit uit Lovable Cloud.
- Argon2id-WASM: een bundel die in de worker geladen wordt, zonder fallback naar de hoofdthread.
- Kinderen: geen aparte leeftijdslogica. Valt buiten deze opdracht.

## Open punt
Je bericht noemt de repo route-roam-5cc5fed6. Geïmporteerd is route-roam-09e66f25. Ik werk verder in dit project, tenzij je anders aangeeft.
