-- 0269 — CONTRACT: only 3-of-4 recovery vaults remain possible.
--
-- Held back until production reports schema >= 0268 (the code that saves only
-- through rout_recovery_ceremony_put_v3). Then:
--   * the 2-of-3 (8-argument) and 2-of-4 (9-argument) saves are dropped, so no
--     code path can write a weaker vault again;
--   * the 0242-era version 1 reads are dropped (code at >= 0266 uses *_v2);
--   * the table accepts version 3 rows only.
-- Fail-closed: if any version 1 or 2 vault exists by then, this migration
-- aborts and changes nothing, so no member's vault is ever deleted or
-- silently relabelled. The owner decides about such rows first.

do $$
begin
  if exists (select 1 from public.recovery_ceremonies where ceremony_version <> 3) then
    raise exception '0269: version 1 or 2 recovery vaults exist; resolve them before closing the old versions';
  end if;
end $$;

drop function if exists public.rout_recovery_ceremony_put(text,text,text,text,text,text,text,text);
drop function if exists public.rout_recovery_ceremony_put(text,text,text,text,text,text,text,text,text);
drop function if exists public.rout_recovery_ceremony_status();
drop function if exists public.rout_recovery_ceremony_get();

alter table public.recovery_ceremonies alter column ceremony_version set default 3;
alter table public.recovery_ceremonies drop constraint if exists recovery_ceremonies_version_card;
alter table public.recovery_ceremonies add constraint recovery_ceremonies_version_card
  check (ceremony_version = 3 and card_shard is not null);

do $$
begin
  if to_regprocedure('public.rout_recovery_ceremony_put(text,text,text,text,text,text,text,text)') is not null
     or to_regprocedure('public.rout_recovery_ceremony_put(text,text,text,text,text,text,text,text,text)') is not null then
    raise exception '0269: an old recovery save still exists';
  end if;
  if to_regprocedure('public.rout_recovery_ceremony_put_v3(text,text,text,text,text,text,text,text,text)') is null then
    raise exception '0269: needs 0268 (rout_recovery_ceremony_put_v3)';
  end if;
  if has_table_privilege('rout_app', 'public.recovery_ceremonies', 'select, insert, update, delete') then
    raise exception '0269: rout_app must not have table rights on recovery_ceremonies';
  end if;
end $$;
