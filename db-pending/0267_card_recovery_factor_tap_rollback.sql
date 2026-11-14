-- 0267 ROLLBACK — restores consume_sdm_tap and its purpose constraint exactly
-- as db/0245 + db/0258 left them (purposes public_proof and step_up only).
--
-- NOT a migration: the runners never replay it (it is not in db/). Run it only
-- after the owner's separate GO, in one transaction. It does not touch
-- public.schema_migrations (Neon's rows are never rewritten); record the
-- rollback in scripts/migration-history-allowlist.ts and docs/HANDOVER.md.
--
-- Refuses to run once any grant was spent for recovery_factor: dropping that
-- value would break the restored constraint and erase which taps were used.

do $$
begin
  if exists (select 1 from vault_enclave.sdm_tap_grants where consumed_for = 'recovery_factor') then
    raise exception '0267 rollback: recovery_factor grants exist; rollback refused';
  end if;
end $$;

alter table vault_enclave.sdm_tap_grants drop constraint if exists sdm_tap_grants_purpose;
alter table vault_enclave.sdm_tap_grants add constraint sdm_tap_grants_purpose
  check (consumed_for is null or consumed_for in ('public_proof', 'step_up'));

-- Body verbatim from db/0245; search_path as set by db/0258.
create or replace function vault_enclave.consume_sdm_tap(p_tap_ref text, p_purpose text)
returns table (granted boolean, card_state text)
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_caller uuid := vault_enclave.caller_user_id();
  v_grant vault_enclave.sdm_tap_grants%rowtype;
  v_card vault_enclave.sdm_batch_cards%rowtype;
begin
  if p_tap_ref is null or p_tap_ref !~ '^tap_[0-9a-f]{64}$' or p_purpose not in ('public_proof', 'step_up') then
    perform vault_enclave.append_audit(v_caller, 'sdm_tap_consume', 'denied', 'bad_request', null);
    return query select false, null::text; return;
  end if;
  select * into v_grant from vault_enclave.sdm_tap_grants g
   where g.grant_digest = pg_catalog.sha256(pg_catalog.convert_to(p_tap_ref, 'UTF8')) for update;
  if not found or v_grant.consumed_at is not null or v_grant.expires_at < v_now then
    perform vault_enclave.append_audit(v_caller, 'sdm_tap_consume', 'denied',
      case when not found then 'unknown_grant' when v_grant.consumed_at is not null then 'grant_spent' else 'grant_expired' end, null);
    return query select false, null::text; return;
  end if;
  select * into v_card from vault_enclave.sdm_batch_cards c where c.card_id = v_grant.card_id;
  if v_card.revoked_at is not null or (p_purpose = 'step_up' and (v_caller is null or v_card.owner_user_id is distinct from v_caller)) then
    update vault_enclave.sdm_tap_grants set consumed_at = v_now, consumed_for = p_purpose where grant_digest = v_grant.grant_digest;
    perform vault_enclave.append_audit(v_caller, 'sdm_tap_consume', 'denied',
      case when v_card.revoked_at is not null then 'card_revoked' else 'not_card_owner' end, null);
    return query select false, null::text; return;
  end if;
  update vault_enclave.sdm_tap_grants set consumed_at = v_now, consumed_for = p_purpose where grant_digest = v_grant.grant_digest;
  perform vault_enclave.append_audit(v_caller, 'sdm_tap_consume', 'granted', p_purpose, null);
  return query select true, case when v_card.owner_user_id is null then 'unactivated' else 'active' end;
end $$;

revoke all on function vault_enclave.consume_sdm_tap(text, text) from public, rout_app;
grant execute on function vault_enclave.consume_sdm_tap(text, text) to rout_app;

do $$
begin
  if has_function_privilege('public', 'vault_enclave.consume_sdm_tap(text, text)', 'execute') then
    raise exception '0267 rollback: PUBLIC must not execute consume_sdm_tap';
  end if;
  if not has_function_privilege('rout_app', 'vault_enclave.consume_sdm_tap(text, text)', 'execute') then
    raise exception '0267 rollback: rout_app lost EXECUTE on consume_sdm_tap';
  end if;
  if has_table_privilege('rout_app', 'vault_enclave.sdm_tap_grants', 'select, insert, update, delete')
     or has_table_privilege('rout_app', 'vault_enclave.sdm_batch_cards', 'select, insert, update, delete') then
    raise exception '0267 rollback: rout_app must not have table rights in vault_enclave';
  end if;
end $$;
