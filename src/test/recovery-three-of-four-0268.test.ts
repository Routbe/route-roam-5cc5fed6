// @vitest-environment node
/**
 * db-pending/0268 (EXPAND) and db-pending/0269 (CONTRACT): recovery vault 3-of-4.
 * Replays db/ on PGlite, applies the held-back files and runs every function as
 * rout_app with a real transaction context. Checks: put_v3 always stores version
 * 3 with all four distinct shards; the *_v2 reads return it with its version;
 * the old saves keep working until 0269; 0269 refuses to run while a version 1
 * or 2 vault exists, and afterwards only version 3 can be written at all.
 */
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listMigrationFiles, planMigrations } from "../../scripts/migration-plan";
import { definerMigrationViolations } from "../../scripts/security-definer-policy";
import { CODE_SCHEMA_LEVEL } from "@/lib/schema-version";

const ROOT = join(__dirname, "..", "..");
const DB_DIR = join(ROOT, "db");
const SQL_0268 = readFileSync(join(ROOT, "db-pending", "0268_recovery_three_of_four.sql"), "utf8");
const SQL_0269 = readFileSync(join(ROOT, "db-pending", "0269_recovery_three_of_four_contract.sql"), "utf8");

const ALICE = "00000000-0000-4000-8000-0000000000f1";
const BOB = "00000000-0000-4000-8000-0000000000f2";
const shard = (c: string) => c.repeat(80);
const MASTER = "M".repeat(60);
const LOGIN = `${"L".repeat(43)}=`;
const CRED = "credential-id_1";
const CEREMONY = "b".repeat(32);

let db: PGlite;

async function asApp<T>(caller: string | null, query: string, params: unknown[] = []): Promise<T[]> {
  await db.exec("begin");
  try {
    await db.exec("set local role rout_app");
    await db.query("select set_config('rout.current_user_id', $1, true)", [caller ?? ""]);
    const r = await db.query<T>(query, params);
    await db.exec("commit");
    return r.rows;
  } catch (e) {
    await db.exec("rollback");
    throw e;
  }
}

const putV3 = (who: string, s: { d?: string; p?: string; s?: string; c?: string | null } = {}) =>
  asApp(who, "select public.rout_recovery_ceremony_put_v3($1,$2,$3,$4,$5,$6,$7,$8,$9)", [
    CEREMONY, "key_id_1", MASTER, s.d ?? shard("D"), s.p ?? shard("P"), s.s ?? shard("S"), s.c === undefined ? shard("C") : s.c, CRED, LOGIN,
  ]);
const put8 = (who: string) =>
  asApp(who, "select public.rout_recovery_ceremony_put($1,$2,$3,$4,$5,$6,$7,$8)", [CEREMONY, "key_id_1", MASTER, shard("D"), shard("P"), shard("S"), CRED, LOGIN]);
const versionOf = async (who: string) =>
  (await asApp<{ ceremony_version: number }>(who, "select ceremony_version from public.rout_recovery_ceremony_get_v2()")).map((r) => r.ceremony_version);

beforeAll(async () => {
  const { btree_gist } = await import("@electric-sql/pglite/contrib/btree_gist");
  const { pgcrypto } = await import("@electric-sql/pglite/contrib/pgcrypto");
  db = await PGlite.create({ extensions: { pgcrypto, btree_gist } });
  for (const step of planMigrations(listMigrationFiles(DB_DIR), new Set())) {
    if (step.action === "run") await db.exec(`begin;\n${readFileSync(join(DB_DIR, step.file), "utf8")}\n;commit;`);
  }
  await db.query("insert into public.users (id, email) values ($1, 'alice@example.test'), ($2, 'bob@example.test')", [ALICE, BOB]);
}, 300_000);

afterAll(async () => {
  await db?.close();
});

describe("0268/0269: recovery vault 3-of-4", () => {
  it("both files stay held back: the code level is unchanged and they pass the SECURITY DEFINER lint", () => {
    expect(Number(CODE_SCHEMA_LEVEL)).toBeLessThan(268);
    expect(definerMigrationViolations(SQL_0268, 268)).toEqual([]);
    expect(definerMigrationViolations(SQL_0269, 269)).toEqual([]);
  });

  it("before 0268 the 3-of-4 save does not exist (the app then refuses to set up a vault)", async () => {
    const r = (await db.query<{ ok: boolean }>("select to_regprocedure('public.rout_recovery_ceremony_put_v3(text,text,text,text,text,text,text,text,text)') is not null as ok")).rows;
    expect(r).toEqual([{ ok: false }]);
  });

  it("0268: put_v3 stores version 3 with its card shard, pinned path, rout_app-only", async () => {
    await db.exec(`begin;\n${SQL_0268}\n;commit;`);
    await putV3(ALICE);
    expect(await versionOf(ALICE)).toEqual([3]);
    const st = await asApp<{ ceremony_version: number }>(ALICE, "select ceremony_version from public.rout_recovery_ceremony_status_v2()");
    expect(st).toEqual([{ ceremony_version: 3 }]);
    expect(await asApp(ALICE, "select * from public.rout_recovery_ceremony_get()")).toEqual([]); // 0264-era read: version 1 only
    expect(await asApp(BOB, "select * from public.rout_recovery_ceremony_get_v2()")).toEqual([]);
    const f = (await db.query<{ cfg: string[]; pub: boolean; app: boolean; def: boolean }>(
      `select p.proconfig as cfg, p.prosecdef as def, has_function_privilege('public', p.oid, 'execute') as pub, has_function_privilege('rout_app', p.oid, 'execute') as app
         from pg_proc p where p.oid = 'public.rout_recovery_ceremony_put_v3(text,text,text,text,text,text,text,text,text)'::regprocedure`,
    )).rows[0];
    expect(f).toEqual({ cfg: ["search_path=pg_catalog, pg_temp"], def: true, pub: false, app: true });
    await expect(asApp(ALICE, "select * from public.recovery_ceremonies")).rejects.toThrow(/permission denied/);
  });

  it("0268: refuses a missing card shard, any repeated shard, and a call without member context", async () => {
    await expect(putV3(BOB, { c: null })).rejects.toThrow(/all four shards required/);
    for (const dup of [{ c: shard("D") }, { c: shard("P") }, { c: shard("S") }, { p: shard("D") }, { s: shard("D") }, { s: shard("P") }]) {
      await expect(putV3(BOB, dup), JSON.stringify(Object.keys(dup))).rejects.toThrow(/recovery_ceremonies_(v3|card)_distinct/);
    }
    await expect(putV3("")).rejects.toThrow(/no member context/);
    expect(await versionOf(BOB)).toEqual([]);
  });

  it("0268 is an EXPAND: the old 8-argument save still writes a clean version 1 row, and 0268 replays idempotently", async () => {
    await put8(BOB);
    expect(await versionOf(BOB)).toEqual([1]);
    await db.exec(`begin;\n${SQL_0268}\n;commit;`);
    expect(await versionOf(ALICE)).toEqual([3]);
  });

  it("0269 aborts and changes nothing while a version 1 or 2 vault exists", async () => {
    await expect(db.exec(`begin;\n${SQL_0269}\n;commit;`)).rejects.toThrow(/version 1 or 2 recovery vaults exist/);
    await db.exec("rollback").catch(() => undefined);
    expect(await versionOf(BOB)).toEqual([1]);
    const old = (await db.query<{ ok: boolean }>("select to_regprocedure('public.rout_recovery_ceremony_put(text,text,text,text,text,text,text,text)') is not null as ok")).rows;
    expect(old).toEqual([{ ok: true }]);
  });

  it("0269: once only version 3 exists, the old saves are gone and the table accepts version 3 only", async () => {
    await putV3(BOB);
    expect(await versionOf(BOB)).toEqual([3]);
    await db.exec(`begin;\n${SQL_0269}\n;commit;`);
    await expect(put8(ALICE)).rejects.toThrow(/does not exist/);
    await expect(asApp(ALICE, "select public.rout_recovery_ceremony_put($1,$2,$3,$4,$5,$6,$7,$8,$9)", [CEREMONY, "k_1_xxxx", MASTER, shard("D"), shard("P"), shard("S"), shard("C"), CRED, LOGIN])).rejects.toThrow(/does not exist/);
    await expect(db.query("update public.recovery_ceremonies set ceremony_version = 2 where user_id = $1", [ALICE])).rejects.toThrow(/recovery_ceremonies_version_card/);
    await putV3(ALICE);
    expect(await versionOf(ALICE)).toEqual([3]);
    expect(await versionOf(BOB)).toEqual([3]);
  });
});
