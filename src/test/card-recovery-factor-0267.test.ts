// @vitest-environment node
/**
 * db-pending/0267 (recovery_factor card tap), its rollback and the strict
 * consumeSdmTap() wrapper (H.6). Replays db/ on PGlite, then 0267 -> rollback
 * -> 0267 again, and runs consume_sdm_tap as rout_app with a real caller.
 */
import { PGlite } from "@electric-sql/pglite";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listMigrationFiles, planMigrations } from "../../scripts/migration-plan";
import { consumeSdmTap, parseSdmTapRow, TapDenied } from "@/lib/vault/sdm-tap-consume.server";
import { LocalPostgresVaultAdapter, type TapGrant, type VaultSqlExecutor } from "@/lib/vault/vault-port.server";

const ROOT = join(__dirname, "..", "..");
const SQL_0267 = readFileSync(join(ROOT, "db-pending", "0267_card_recovery_factor_tap.sql"), "utf8");
const SQL_ROLLBACK = readFileSync(join(ROOT, "db-pending", "0267_card_recovery_factor_tap_rollback.sql"), "utf8");
const OWNER = "00000000-0000-4000-8000-0000000000c1";
const OTHER = "00000000-0000-4000-8000-0000000000c2";
const CARD = "00000000-0000-4000-8000-0000000000ca";

describe("parseSdmTapRow / consumeSdmTap (unit)", () => {
  it("accepts only an exact grant row", () => {
    expect(parseSdmTapRow({ granted: true, card_state: "active" })).toEqual({ granted: true, cardState: "active" });
    expect(parseSdmTapRow({ granted: false, card_state: null })).toEqual({ granted: false });
    for (const bad of [{ granted: true, card_state: null }, { granted: false, card_state: "active" }, { granted: "true", card_state: "active" }, { granted: true, card_state: "active", extra: 1 }, null, undefined, {}]) {
      expect(parseSdmTapRow(bad)).toEqual({ granted: false });
    }
  });

  const g = `tap_${"a".repeat(64)}` as TapGrant;
  it("throws TapDenied on a denial and on a port error, returns the state only on a grant", async () => {
    await expect(consumeSdmTap({ consumeSdmTapRow: async () => ({ granted: false }) }, null, g, "public_proof")).rejects.toBeInstanceOf(TapDenied);
    await expect(consumeSdmTap({ consumeSdmTapRow: async () => { throw new Error("db down"); } }, null, g, "step_up")).rejects.toBeInstanceOf(TapDenied);
    await expect(consumeSdmTap({ consumeSdmTapRow: async () => ({ granted: true, cardState: "active" }) }, null, g, "recovery_factor")).resolves.toBe("active");
  });

  it("is the only app path to consume_sdm_tap", () => {
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const f of readdirSync(dir)) {
        const p = join(dir, f);
        if (statSync(p).isDirectory()) { if (f !== "test") walk(p); continue; }
        if (!/\.(ts|tsx)$/.test(f) || /\.test\.tsx?$/.test(f)) continue;
        const s = readFileSync(p, "utf8");
        if (s.includes("vault_enclave.consume_sdm_tap($")) hits.push(`sql:${relative(ROOT, p)}`);
        if (/\.consumeSdmTapRow\(/.test(s)) hits.push(`row:${relative(ROOT, p)}`);
      }
    };
    walk(join(ROOT, "src"));
    expect(hits.sort()).toEqual(["row:src/lib/vault/sdm-tap-consume.server.ts", "sql:src/lib/vault/vault-port.server.ts"]);
  });
});

describe("0267 + rollback on a replay of db/", () => {
  let db: PGlite;
  const exec: VaultSqlExecutor = async (userId, query, params) => {
    await db.exec("begin");
    try {
      await db.exec("set local role rout_app");
      await db.query("select set_config('rout.current_user_id', $1, true)", [userId]);
      const r = await db.query<Record<string, unknown>>(query, [...params]);
      await db.exec("commit");
      return r.rows;
    } catch (e) {
      await db.exec("rollback");
      throw e;
    }
  };
  const port = new LocalPostgresVaultAdapter(exec);
  const newGrant = async () => {
    const ref = `tap_${randomBytes(32).toString("hex")}`;
    await db.query("insert into vault_enclave.sdm_tap_grants (grant_digest, card_id, created_at, expires_at) values ($1, $2, now(), now() + interval '120 seconds')", [createHash("sha256").update(ref).digest(), CARD]);
    return ref as TapGrant;
  };
  const definition = async () => (await db.query<{ d: string }>("select pg_get_functiondef('vault_enclave.consume_sdm_tap(text, text)'::regprocedure) as d")).rows[0]!.d;
  const apply = (sql: string) => db.exec(`begin;\n${sql}\n;commit;`);
  let original = "";

  beforeAll(async () => {
    const { btree_gist } = await import("@electric-sql/pglite/contrib/btree_gist");
    const { pgcrypto } = await import("@electric-sql/pglite/contrib/pgcrypto");
    db = await PGlite.create({ extensions: { pgcrypto, btree_gist } });
    const dir = join(ROOT, "db");
    for (const step of planMigrations(listMigrationFiles(dir), new Set())) {
      if (step.action === "run") await db.exec(`begin;\n${readFileSync(join(dir, step.file), "utf8")}\n;commit;`);
    }
    await db.query("insert into public.users (id, email) values ($1, 'owner@example.test'), ($2, 'other@example.test')", [OWNER, OTHER]);
    // One owned card; foreign keys to fleet/batch rows are not under test here.
    await db.exec("set session_replication_role = replica");
    await db.query("insert into vault_enclave.sdm_batch_cards (card_id, batch_id, uid_hash, owner_user_id, activated_at) values ($1, gen_random_uuid(), $2, $3, now())", [CARD, randomBytes(32), OWNER]);
    await db.exec("set session_replication_role = origin");
    original = await definition();
  }, 300_000);
  afterAll(async () => db?.close());

  it("before 0267: recovery_factor is refused", async () => {
    await expect(consumeSdmTap(port, { userId: OWNER }, await newGrant(), "recovery_factor")).rejects.toBeInstanceOf(TapDenied);
  });

  it("0267: only the card's owner passes, once; others and anonymous callers are TapDenied", async () => {
    await apply(SQL_0267);
    const g = await newGrant();
    expect(await consumeSdmTap(port, { userId: OWNER }, g, "recovery_factor")).toBe("active");
    await expect(consumeSdmTap(port, { userId: OWNER }, g, "recovery_factor")).rejects.toBeInstanceOf(TapDenied);
    await expect(consumeSdmTap(port, { userId: OTHER }, await newGrant(), "recovery_factor")).rejects.toBeInstanceOf(TapDenied);
    await expect(consumeSdmTap(port, null, await newGrant(), "recovery_factor")).rejects.toBeInstanceOf(TapDenied);
    expect(await consumeSdmTap(port, null, await newGrant(), "public_proof")).toBe("active");
    expect(await consumeSdmTap(port, { userId: OWNER }, await newGrant(), "step_up")).toBe("active");
    const audit = await db.query<{ reason: string }>("select reason from vault_enclave.audit_logs where action = 'sdm_tap_consume' order by seq desc limit 5");
    expect(audit.rows.map((r) => r.reason)).toContain("not_card_owner");
  });

  it("rollback refuses while recovery_factor grants exist, changing nothing", async () => {
    await expect(apply(SQL_ROLLBACK)).rejects.toThrow(/recovery_factor grants exist/);
    await db.exec("rollback").catch(() => undefined);
    expect(await definition()).not.toBe(original);
  });

  it("rollback restores the exact db/0245+0258 function, constraint and rights; 0267 then re-applies", async () => {
    await db.exec("delete from vault_enclave.sdm_tap_grants where consumed_for = 'recovery_factor'");
    await apply(SQL_ROLLBACK);
    expect(await definition()).toBe(original);
    const con = await db.query<{ d: string }>("select pg_get_constraintdef(oid) as d from pg_constraint where conname = 'sdm_tap_grants_purpose'");
    expect(con.rows[0]!.d).not.toContain("recovery_factor");
    const rights = await db.query<{ pub: boolean; app: boolean }>("select has_function_privilege('public', 'vault_enclave.consume_sdm_tap(text, text)', 'execute') as pub, has_function_privilege('rout_app', 'vault_enclave.consume_sdm_tap(text, text)', 'execute') as app");
    expect(rights.rows[0]).toEqual({ pub: false, app: true });
    await expect(consumeSdmTap(port, { userId: OWNER }, await newGrant(), "recovery_factor")).rejects.toBeInstanceOf(TapDenied);
    expect(await consumeSdmTap(port, { userId: OWNER }, await newGrant(), "step_up")).toBe("active");

    await apply(SQL_0267);
    expect(await consumeSdmTap(port, { userId: OWNER }, await newGrant(), "recovery_factor")).toBe("active");
  });
});
