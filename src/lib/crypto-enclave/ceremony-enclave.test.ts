// @vitest-environment node
import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { forgetDeviceKey, loadDeviceKey } from "@/lib/e2ee/device-key";
import { newMasterKey } from "@/lib/e2ee/recovery";
import { openServerShard, serverFactorPublicKey } from "@/lib/recovery/server-factor.server";
import { runEnclaveOp } from "./enclave-core";
import type { EnclaveOp, EnclaveOps } from "./protocol";
import type { RecoveryCeremony } from "./recovery-mpc";

const SECRET = "A".repeat(32) + "b".repeat(32);
const prfOf = (n: number) => new Uint8Array(32).fill(n);
const cardOf = (n: number) => new Uint8Array(32).map((_, i) => (i * 13 + n) & 0xff);

async function call<K extends EnclaveOp>(op: K, args: EnclaveOps[K]["req"]): Promise<EnclaveOps[K]["res"]> {
  const r = await runEnclaveOp(op, args);
  if (!r.ok) throw new Error(r.code);
  return r.result as EnclaveOps[K]["res"];
}
const code = async (op: EnclaveOp, args: unknown) => {
  const r = await runEnclaveOp(op, args);
  return r.ok ? "ok" : r.code;
};

/** Runs a full setup and returns what the server would store plus the paper words. */
async function setup(userId: string, mnemonic?: string, card = 3) {
  const begun = await call("ceremony.begin", { userId, serverFactorKey: serverFactorPublicKey(userId, SECRET), cardSecret: cardOf(card), ...(mnemonic ? { mnemonic } : {}) });
  const words = begun.paperWords.split(" ");
  const answers = begun.checkPositions.map((position) => ({ position, word: words[position - 1] ?? "" }));
  expect((await call("ceremony.checkWords", { handle: begun.handle, answers })).ok).toBe(true);
  const sealed = await call("ceremony.sealDevice", { handle: begun.handle, prf: prfOf(5) });
  const committed = await call("ceremony.commit", { handle: begun.handle, userId });
  return { begun, ceremony: sealed.ceremony as RecoveryCeremony, keyId: committed.keyId, paper: begun.paperWords };
}
const begin = (userId: string, extra: Record<string, unknown> = {}) =>
  call("ceremony.begin", { userId, serverFactorKey: serverFactorPublicKey(userId, SECRET), cardSecret: cardOf(3), ...extra } as EnclaveOps["ceremony.begin"]["req"]);

describe("3-of-4 ceremony in the crypto enclave", () => {
  it("never begins without a freshly tapped ROUT Card, or with a malformed card secret", async () => {
    const userId = "00000000-0000-4000-8000-0000000000c0";
    expect(await code("ceremony.begin", { userId, serverFactorKey: serverFactorPublicKey(userId, SECRET) })).toBe("card_required");
    expect(await code("ceremony.begin", { userId, serverFactorKey: serverFactorPublicKey(userId, SECRET), cardSecret: new Uint8Array(31) })).toBe("invalid_input");
    expect(await code("ceremony.begin", { userId, serverFactorKey: serverFactorPublicKey(userId, SECRET), cardSecret: new Uint8Array(32) })).toBe("invalid_input");
    expect(await loadDeviceKey(userId)).toBeNull();
  });

  it("a device without a key gets a fresh Master Key, installed only at commit; the card secret is wiped", async () => {
    const userId = "00000000-0000-4000-8000-0000000000c1";
    const card = cardOf(3);
    const begun = await call("ceremony.begin", { userId, serverFactorKey: serverFactorPublicKey(userId, SECRET), cardSecret: card });
    expect(card.every((b) => b === 0)).toBe(true);
    expect(begun.version).toBe(3);
    expect(begun.fresh).toBe(true);
    expect(begun.paperWords.split(" ")).toHaveLength(24);
    expect(new Set(begun.checkPositions).size).toBe(3);
    expect(begun.checkPositions.every((p) => p >= 1 && p <= 24)).toBe(true);
    expect(await loadDeviceKey(userId)).toBeNull();
    await call("ceremony.discard", { handle: begun.handle });
    expect(await loadDeviceKey(userId)).toBeNull();
  });

  it("the passkey cannot seal before three words were retyped correctly", async () => {
    const userId = "00000000-0000-4000-8000-0000000000c2";
    const begun = await begin(userId);
    expect(await code("ceremony.sealDevice", { handle: begun.handle, prf: prfOf(1) })).toBe("invalid_input");
    const wrong = begun.checkPositions.map((position) => ({ position, word: "abandon" }));
    expect((await call("ceremony.checkWords", { handle: begun.handle, answers: wrong })).ok).toBe(false);
    for (let i = 0; i < 4; i++) await call("ceremony.checkWords", { handle: begun.handle, answers: wrong });
    // Fifth failure: the ceremony is gone.
    expect(await code("ceremony.checkWords", { handle: begun.handle, answers: wrong })).toBe("unknown_handle");
  });

  it("sealing happens once, and a failed device-key store can be retried at commit", async () => {
    const userId = "00000000-0000-4000-8000-0000000000c9";
    const begun = await begin(userId);
    const words = begun.paperWords.split(" ");
    const answers = begun.checkPositions.map((position) => ({ position, word: words[position - 1] ?? "" }));
    await call("ceremony.checkWords", { handle: begun.handle, answers });
    const sealed = await call("ceremony.sealDevice", { handle: begun.handle, prf: prfOf(9) });
    expect((sealed.ceremony as RecoveryCeremony).version).toBe(3);
    expect(await code("ceremony.sealDevice", { handle: begun.handle, prf: prfOf(9) })).toBe("invalid_input");
    const open = indexedDB.open.bind(indexedDB);
    indexedDB.open = () => { throw new Error("storage_blocked"); };
    try {
      expect(await code("ceremony.commit", { handle: begun.handle, userId })).not.toBe("ok");
    } finally {
      indexedDB.open = open;
    }
    expect((await call("ceremony.commit", { handle: begun.handle, userId })).keyId).toBe(begun.keyId);
    expect((await loadDeviceKey(userId))?.keyId).toBe(begun.keyId);
    expect(await code("ceremony.commit", { handle: begun.handle, userId })).toBe("unknown_handle");
  });

  it("each of the 4 three-piece combinations restores the same key on a new device; no two pieces do", async () => {
    const userId = "00000000-0000-4000-8000-0000000000c3";
    const { ceremony, keyId, paper } = await setup(userId);
    expect((await loadDeviceKey(userId))?.keyId).toBe(keyId);
    // Requests are wiped after each op (as after postMessage), so every piece is a fresh copy per call.
    const pieces = {
      prf: () => ({ prf: prfOf(5) }),
      paper: () => ({ paperWords: paper }),
      card: () => ({ cardSecret: cardOf(3) }),
      rout: () => ({ serverShare: openServerShard(structuredClone(ceremony), userId, SECRET) }),
    };
    const names = Object.keys(pieces) as (keyof typeof pieces)[];
    const combos = names.flatMap((a, i) => names.slice(i + 1).map((b) => [a, b]));
    for (const leave of names) {
      await forgetDeviceKey(userId);
      const used = names.filter((n) => n !== leave);
      const args = Object.assign({}, ...used.map((n) => pieces[n]()));
      expect((await call("ceremony.restore", { userId, ceremony: structuredClone(ceremony), keyId, ...args })).keyId, used.join("+")).toBe(keyId);
    }
    for (const pair of combos) {
      await forgetDeviceKey(userId);
      const args = Object.assign({}, ...pair.map((n) => pieces[n]()));
      expect(await code("ceremony.restore", { userId, ceremony: structuredClone(ceremony), keyId, ...args }), pair.join("+")).toBe("decrypt_failed");
    }
    // A wrong passkey or another card does not count.
    await forgetDeviceKey(userId);
    expect(await code("ceremony.restore", { userId, ceremony: structuredClone(ceremony), keyId, prf: prfOf(6), ...pieces.card(), ...pieces.rout() })).toBe("decrypt_failed");
    expect(await code("ceremony.restore", { userId, ceremony: structuredClone(ceremony), keyId, ...pieces.prf(), cardSecret: cardOf(4), ...pieces.rout() })).toBe("decrypt_failed");
    expect(await loadDeviceKey(userId)).toBeNull();
  });

  it("protects the existing Master Key: its words are required and must match", async () => {
    const userId = "00000000-0000-4000-8000-0000000000c4";
    const master = newMasterKey();
    await call("masterKey.unlock", { userId, mnemonic: master.mnemonic });
    const key = (await loadDeviceKey(userId))?.keyId;
    expect(await code("ceremony.begin", { userId, serverFactorKey: serverFactorPublicKey(userId, SECRET), cardSecret: cardOf(3) })).toBe("master_key_required");
    expect(await code("ceremony.begin", { userId, serverFactorKey: serverFactorPublicKey(userId, SECRET), cardSecret: cardOf(3), mnemonic: newMasterKey().mnemonic })).toBe("key_mismatch");
    const { keyId, begun } = await setup(userId, master.mnemonic);
    expect(begun.fresh).toBe(false);
    expect(keyId).toBe(key);
  });

  it("a ceremony of one member does not restore for another", async () => {
    const alice = "00000000-0000-4000-8000-0000000000c5";
    const bob = "00000000-0000-4000-8000-0000000000c6";
    const { ceremony, keyId, paper } = await setup(alice);
    expect(await code("ceremony.restore", { userId: bob, ceremony: structuredClone(ceremony), keyId, paperWords: paper, prf: prfOf(5), cardSecret: cardOf(3) })).toBe("invalid_input");
    expect(await code("ceremony.restore", { userId: bob, ceremony: { ...structuredClone(ceremony), memberId: bob }, keyId, paperWords: paper, prf: prfOf(5), cardSecret: cardOf(3) })).toBe("decrypt_failed");
  });

  it("a stored ceremony with a missing card shard, or relabelled to a lower threshold, is refused", async () => {
    const userId = "00000000-0000-4000-8000-0000000000d3";
    const { ceremony, keyId, paper } = await setup(userId, undefined, 9);
    const c = ceremony as RecoveryCeremony & { shards: Record<string, Uint8Array> };
    const { nfc_card: _gone, ...core } = c.shards;
    await forgetDeviceKey(userId);
    expect(await code("ceremony.restore", { userId, ceremony: { ...structuredClone(c), shards: structuredClone(core) }, keyId, prf: prfOf(5), paperWords: paper })).toBe("invalid_input");
    expect(await code("ceremony.restore", { userId, ceremony: { ...structuredClone(c), threshold: 2 }, keyId, prf: prfOf(5), paperWords: paper, cardSecret: cardOf(9) })).toBe("invalid_input");
    expect(await code("ceremony.restore", { userId, ceremony: { ...structuredClone(c), version: 2, threshold: 2 }, keyId, prf: prfOf(5), paperWords: paper })).toBe("decrypt_failed");
    expect(await loadDeviceKey(userId)).toBeNull();
  });
});
