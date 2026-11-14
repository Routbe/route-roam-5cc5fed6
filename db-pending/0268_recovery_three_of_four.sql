-- 0268 — EXPAND: recovery vault 3-of-4 (ceremony version 3).
--
-- Owner decision (2026-11-14): recovery needs 3 of the 4 shards — passkey
-- (WebAuthn PRF), ROUT Card (#rk1 fragment secret, never seen by a server),
-- ROUT's server shard, 24 paper words. An attacker holding ROUT's server and a
-- stolen card is still one share short. Neon held 0 ceremonies when this was
-- written, so no member is moved between versions.
--
-- Only adds: version 3 to the version/card check (a version 3 row must carry a
-- card shard), a pairwise-distinct check over all four shards, and
-- rout_recovery_ceremony_put_v3, which always writes version 3 and refuses a
-- missing or repeated shard. The existing 8- and 9-argument saves and the
-- *_v2 reads stay as they are (code at 0266 keeps working); the *_v2 reads
-- already return ceremony_version, and code at 0266 refuses an unknown
-- version instead of opening it. db-pending/0269 later removes the old saves.
-- rout_app still has no table rights; the member comes from rout_current_user_id().

alter table public.recovery_ceremonies drop constraint if exists recovery_ceremonies_version_card;
alter table public.recovery_ceremonies add constraint recovery_ceremonies_version_card
  check ((ceremony_version = 1 and card_shard is null)
      or (ceremony_version in (2, 3) and card_shard is not null));

-- Four distinct shards: the same envelope stored twice would lower the real threshold.
alter table public.recovery_ceremonies drop constraint if exists recovery_ceremonies_v3_distinct;
alter table public.recovery_ceremonies add constraint recovery_ceremonies_v3_distinct
  check (ceremony_version <> 3 or (
    device_shard <> paper_shard and device_shard <> server_shard and device_shard <> card_shard
    and paper_shard <> server_shard and paper_shard <> card_shard and server_shard <> card_shard));

create or replace function public.rout_recovery_ceremony_put_v3(
  p_ceremony_id text, p_key_id text, p_sealed_master text,
  p_device_shard text, p_paper_shard text, p_server_shard text, p_card_shard text,
  p_device_credential text, p_login_key text)
returns void language plpgsql volatile security definer set search_path = pg_catalog, pg_temp as $$
declare v_user uuid := public.rout_current_user_id();
begin
  if v_user is null then raise exception 'no member context' using errcode = '42501'; end if;
  if p_login_key is null then raise exception 'login key required' using errcode = '22023'; end if;
  if p_device_shard is null or p_paper_shard is null or p_server_shard is null or p_card_shard is null then
    raise exception 'all four shards required' using errcode = '22023';
  end if;
  insert into public.recovery_ceremonies as c
    (user_id, ceremony_id, key_id, sealed_master, device_shard, paper_shard, server_shard, card_shard, ceremony_version,
     device_credential, login_key, created_at)
  values (v_user, p_ceremony_id, p_key_id, p_sealed_master, p_device_shard, p_paper_shard, p_server_shard, p_card_shard, 3,
          p_device_credential, p_login_key, pg_catalog.now())
  on conflict (user_id) do update set
    ceremony_id = excluded.ceremony_id, key_id = excluded.key_id, sealed_master = excluded.sealed_master,
    device_shard = excluded.device_shard, paper_shard = excluded.paper_shard, server_shard = excluded.server_shard,
    card_shard = excluded.card_shard, ceremony_version = 3,
    device_credential = excluded.device_credential, login_key = excluded.login_key, created_at = excluded.created_at;
end $$;

revoke all on function public.rout_recovery_ceremony_put_v3(text,text,text,text,text,text,text,text,text) from public;
grant execute on function public.rout_recovery_ceremony_put_v3(text,text,text,text,text,text,text,text,text) to rout_app;

-- In-transaction proof: table closed to rout_app, PUBLIC cannot save, path pinned.
do $$
begin
  if has_table_privilege('rout_app', 'public.recovery_ceremonies', 'select, insert, update, delete') then
    raise exception '0268: rout_app must not have table rights on recovery_ceremonies';
  end if;
  if has_function_privilege('public', 'public.rout_recovery_ceremony_put_v3(text,text,text,text,text,text,text,text,text)', 'execute') then
    raise exception '0268: PUBLIC must not execute rout_recovery_ceremony_put_v3';
  end if;
  if not has_function_privilege('rout_app', 'public.rout_recovery_ceremony_put_v3(text,text,text,text,text,text,text,text,text)', 'execute') then
    raise exception '0268: rout_app must execute rout_recovery_ceremony_put_v3';
  end if;
  if (select proconfig from pg_proc where oid = 'public.rout_recovery_ceremony_put_v3(text,text,text,text,text,text,text,text,text)'::regprocedure)
     is distinct from array['search_path=pg_catalog, pg_temp'] then
    raise exception '0268: rout_recovery_ceremony_put_v3 must pin search_path to pg_catalog, pg_temp';
  end if;
end $$;
