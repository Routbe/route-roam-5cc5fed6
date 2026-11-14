# Held-back migrations

CONTRACT steps that remove legacy access. They stay out of `db/` (every file
there is replayed by the runners) until the deployed app uses the matching
EXPAND functions. Move a file into `db/` only when production runs that code
(the public health probe reports `schema` at or above the EXPAND number).


Applied and moved into `db/`: 0230, 0231, 0233, 0235, 0237 (production reported 0236).
- 0239 and 0241 applied (Nov 2026); no legacy rout_server access remains.
- 0262 applied on Neon (2026-11-13) and moved into `db/`.
- 0263 and 0264 applied on Neon (2026-11-13, production reported 0263); 0264 moved into `db/`. 

- 0265_booking_ledger.sql: held back (EXPAND, not yet applied on Neon); greatest/least unqualified. Moves to db/ with CODE_SCHEMA_LEVEL 0265 after the owner's GO.
- 0266_recovery_card_factor.sql: applied on Neon (2026-11-13 21:45) and moved into `db/`; CODE_SCHEMA_LEVEL is 0266.
- 0267_card_recovery_factor_tap.sql: held back (EXPAND, not applied on Neon): single-use `recovery_factor` card tap bound to the signed-in owner. Moves to db/ only after the owner's GO.
- 0268_recovery_three_of_four.sql: held back (EXPAND, not applied on Neon): version 3 (3-of-4) in the version/card check, four pairwise-distinct shards, `rout_recovery_ceremony_put_v3`. The app refuses every new vault until it is live (`to_regprocedure` check). Needs only 0266; moves to db/ after the owner's GO.
- 0269_recovery_three_of_four_contract.sql: held back (CONTRACT): drops the 2-of-3/2-of-4 saves and the version 1 reads and allows version 3 rows only. Apply only once production reports schema >= 0268; aborts without changes while any version 1 or 2 vault exists.
