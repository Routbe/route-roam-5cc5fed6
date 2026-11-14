// @vitest-environment node
/**
 * Owner decision 2026-11-14: recovery = any 3 of 4 shards (passkey PRF, ROUT
 * Card, ROUT's server shard, 24 paper words). Every ceremony made is version 3.
 *
 * Exhaustive model check over all 16 factor subsets (and both ways ROUT's
 * factor can arrive: its secret key or its already-opened share), plus
 * fast-check properties over random Master Keys, members, factor secrets and
 * subset orders: a subset rebuilds the exact Master Key if and only if it holds
 * at least 3 factors, and every binding (factor, member, ceremony, version,
 * threshold) holds for any generated input.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { cardFactorKeys, cardFactorKeysFromFragment, cardFragment } from "./card-factor";
import {
  CURRENT_CEREMONY_VERSION,
  RECOVERY_FACTORS,
  RECOVERY_THRESHOLD,
  RecoveryError,
  VERSION_THRESHOLD,
  beginRecoveryCeremony,
  completeRecoveryCeremony,
  createPaperFactor,
  createRecoveryCeremony,
  factorKeys,
  openFactorShard,
  paperFactorKeys,
  recoverMasterKey,
  type RecoveryCeremony,
  type RecoveryFactor,
} from "./recovery-mpc";
import { WIRE_THRESHOLD } from "@/lib/recovery/ceremony-wire";

const ALICE = "00000000-0000-4000-8000-00000000000a";
const BOB = "00000000-0000-4000-8000-00000000000b";
const master = new Uint8Array(32).map((_, i) => i + 1);
const device = factorKeys("device_prf", new Uint8Array(32).fill(7), ALICE);
const server = factorKeys("server_guardian", new Uint8Array(32).fill(9), ALICE);
const paper = createPaperFactor(ALICE);
const cardSecret = new Uint8Array(32).map((_, i) => (i * 37 + 11) & 0xff);
const card = cardFactorKeysFromFragment(cardFragment(cardSecret), ALICE);
const pub = { device_prf: device.publicKey, server_guardian: server.publicKey, paper_guardian: paper.keys.publicKey, nfc_card: card.publicKey };
const sec: Record<RecoveryFactor, Uint8Array> = { device_prf: device.secretKey, server_guardian: server.secretKey, paper_guardian: paper.keys.secretKey, nfc_card: card.secretKey };
const pick = (...factors: RecoveryFactor[]) => Object.fromEntries(factors.map((f) => [f, sec[f]])) as Partial<Record<RecoveryFactor, Uint8Array>>;
const subsets = <T,>(xs: readonly T[]): T[][] => xs.reduce<T[][]>((acc, x) => acc.concat(acc.map((s) => [...s, x])), [[]]);

describe("3-of-4 recovery (ceremony version 3)", async () => {
  const ceremony = await createRecoveryCeremony({ masterKey: master, memberId: ALICE, factorPublicKeys: pub });

  it("is version 3 with threshold 3, and the wire table mirrors the thresholds", () => {
    expect(CURRENT_CEREMONY_VERSION).toBe(3);
    expect(RECOVERY_THRESHOLD).toBe(3);
    expect(ceremony.version).toBe(3);
    expect(ceremony.threshold).toBe(3);
    expect(Object.keys(ceremony.shards).sort()).toEqual([...RECOVERY_FACTORS].sort());
    expect(WIRE_THRESHOLD).toEqual(VERSION_THRESHOLD);
  });

  it("model check: each of the 16 factor subsets opens if and only if it has at least 3 factors", async () => {
    const all = subsets(RECOVERY_FACTORS);
    expect(all).toHaveLength(16);
    for (const set of all) {
      // ROUT's factor both as secret key and as the share the server opened itself.
      for (const serverOpened of set.includes("server_guardian") ? [false, true] : [false]) {
        const own = set.filter((f) => !(serverOpened && f === "server_guardian"));
        const openedShares = serverOpened ? { server_guardian: openFactorShard(ceremony, ALICE, "server_guardian", server.secretKey) } : undefined;
        const attempt = recoverMasterKey({ ceremony, memberId: ALICE, factorSecretKeys: pick(...own), openedShares });
        if (set.length >= 3) expect([...(await attempt)], set.join("+")).toEqual([...master]);
        else await expect(attempt, set.join("+")).rejects.toThrow(RecoveryError);
        if (openedShares) expect(openedShares.server_guardian.every((b) => b === 0)).toBe(true);
      }
    }
  });

  it("ROUT's server plus a stolen card is one share short, with or without anything else ROUT holds", async () => {
    const serverShare = openFactorShard(ceremony, ALICE, "server_guardian", server.secretKey);
    await expect(recoverMasterKey({ ceremony, memberId: ALICE, factorSecretKeys: pick("nfc_card"), openedShares: { server_guardian: serverShare } })).rejects.toThrow(RecoveryError);
    // The same factor twice (secret key and opened share) still counts once.
    const again = openFactorShard(ceremony, ALICE, "server_guardian", server.secretKey);
    await expect(recoverMasterKey({ ceremony, memberId: ALICE, factorSecretKeys: pick("nfc_card", "server_guardian"), openedShares: { server_guardian: again } })).rejects.toThrow(RecoveryError);
  });

  it("relabelling a 3-of-4 ceremony as 2-of-4 (version 2) opens nothing, not even with 3 factors", async () => {
    const downgraded = { ...ceremony, version: 2, threshold: 2 } as unknown as RecoveryCeremony;
    await expect(recoverMasterKey({ ceremony: downgraded, memberId: ALICE, factorSecretKeys: pick("device_prf", "nfc_card") })).rejects.toThrow(RecoveryError);
    await expect(recoverMasterKey({ ceremony: downgraded, memberId: ALICE, factorSecretKeys: pick("device_prf", "nfc_card", "paper_guardian") })).rejects.toThrow(RecoveryError);
    const wrongThreshold = { ...ceremony, threshold: 2 } as unknown as RecoveryCeremony;
    await expect(recoverMasterKey({ ceremony: wrongThreshold, memberId: ALICE, factorSecretKeys: pick("device_prf", "nfc_card", "paper_guardian") })).rejects.toThrow(RecoveryError);
  });

  it("shards are bound to their factor, member and ceremony", async () => {
    // A shard moved to another factor's slot.
    const swapped = { ...ceremony, shards: { ...ceremony.shards, nfc_card: ceremony.shards.paper_guardian, paper_guardian: ceremony.shards.nfc_card } } as RecoveryCeremony;
    await expect(recoverMasterKey({ ceremony: swapped, memberId: ALICE, factorSecretKeys: pick("device_prf", "nfc_card", "paper_guardian") })).rejects.toThrow(RecoveryError);
    // The ceremony presented for another member.
    await expect(recoverMasterKey({ ceremony: { ...ceremony, memberId: BOB }, memberId: BOB, factorSecretKeys: pick("device_prf", "server_guardian", "nfc_card") })).rejects.toThrow(RecoveryError);
    // Shards of two ceremonies mixed.
    const other = await createRecoveryCeremony({ masterKey: master, memberId: ALICE, factorPublicKeys: pub });
    expect(other.ceremonyId).not.toBe(ceremony.ceremonyId);
    const mixed = { ...ceremony, shards: { ...ceremony.shards, server_guardian: other.shards.server_guardian } } as RecoveryCeremony;
    await expect(recoverMasterKey({ ceremony: mixed, memberId: ALICE, factorSecretKeys: pick("device_prf", "server_guardian", "nfc_card") })).rejects.toThrow(RecoveryError);
    // Another card does not count as the card factor.
    const otherCard = cardFactorKeys(new Uint8Array(32).fill(0x5a), ALICE);
    await expect(recoverMasterKey({ ceremony, memberId: ALICE, factorSecretKeys: { ...pick("device_prf", "paper_guardian"), nfc_card: otherCard.secretKey } })).rejects.toThrow(RecoveryError);
  });

  it("detects a tampered shard or sealed Master Key", async () => {
    const shard = ceremony.shards.nfc_card.slice();
    shard[shard.length - 1] = (shard[shard.length - 1] ?? 0) ^ 1;
    await expect(recoverMasterKey({ ceremony: { ...ceremony, shards: { ...ceremony.shards, nfc_card: shard } } as RecoveryCeremony, memberId: ALICE, factorSecretKeys: pick("device_prf", "nfc_card", "paper_guardian") })).rejects.toThrow(RecoveryError);
    const sealed = ceremony.sealedMaster.slice();
    sealed[30] = (sealed[30] ?? 0) ^ 1;
    await expect(recoverMasterKey({ ceremony: { ...ceremony, sealedMaster: sealed }, memberId: ALICE, factorSecretKeys: pick("device_prf", "nfc_card", "paper_guardian") })).rejects.toThrow(RecoveryError);
  });

  it("never makes a ceremony without the card, with duplicate factor keys or bad inputs", async () => {
    const { nfc_card: _card, ...noCard } = pub;
    await expect(createRecoveryCeremony({ masterKey: master, memberId: ALICE, factorPublicKeys: noCard as typeof pub })).rejects.toThrow("card_factor_required");
    await expect(beginRecoveryCeremony({ masterKey: master, memberId: ALICE, factorPublicKeys: { paper_guardian: paper.keys.publicKey, server_guardian: server.publicKey } as never })).rejects.toThrow("card_factor_required");
    await expect(createRecoveryCeremony({ masterKey: master, memberId: ALICE, factorPublicKeys: { ...pub, nfc_card: paper.keys.publicKey } })).rejects.toThrow("factor_keys_must_differ");
    await expect(createRecoveryCeremony({ masterKey: master, memberId: ALICE, factorPublicKeys: { ...pub, server_guardian: device.publicKey } })).rejects.toThrow(TypeError);
    await expect(createRecoveryCeremony({ masterKey: new Uint8Array(16), memberId: ALICE, factorPublicKeys: pub })).rejects.toThrow(TypeError);
    await expect(createRecoveryCeremony({ masterKey: master, memberId: "alice", factorPublicKeys: pub })).rejects.toThrow(TypeError);
  });

  it("a two-step ceremony seals the device shard last, wipes it, and refuses a device key equal to another factor", async () => {
    const half = { paper_guardian: paper.keys.publicKey, server_guardian: server.publicKey, nfc_card: card.publicKey };
    const { draft, deviceShare } = await beginRecoveryCeremony({ masterKey: master, memberId: ALICE, factorPublicKeys: half });
    expect(Object.keys(draft.shards).sort()).toEqual(["nfc_card", "paper_guardian", "server_guardian"]);
    expect(draft.threshold).toBe(3);
    const full = completeRecoveryCeremony(draft, deviceShare, device.publicKey);
    expect(deviceShare.every((b) => b === 0)).toBe(true);
    expect([...(await recoverMasterKey({ ceremony: full, memberId: ALICE, factorSecretKeys: pick("device_prf", "nfc_card", "paper_guardian") }))]).toEqual([...master]);
    const second = await beginRecoveryCeremony({ masterKey: master, memberId: ALICE, factorPublicKeys: half });
    expect(() => completeRecoveryCeremony(second.draft, second.deviceShare, card.publicKey)).toThrow(TypeError);
    expect(second.deviceShare.every((b) => b === 0)).toBe(true);
  });

  it("the paper factor comes back from its 24 words (any case and spacing), and is bound to the member", async () => {
    const again = paperFactorKeys(`  ${paper.mnemonic.toUpperCase()} `, ALICE);
    expect([...(await recoverMasterKey({ ceremony, memberId: ALICE, factorSecretKeys: { device_prf: device.secretKey, nfc_card: card.secretKey, paper_guardian: again.secretKey } }))]).toEqual([...master]);
    expect([...paperFactorKeys(paper.mnemonic, BOB).publicKey]).not.toEqual([...paper.keys.publicKey]);
    expect(() => paperFactorKeys(paper.mnemonic.split(" ").slice(0, 23).join(" "), ALICE)).toThrow(RecoveryError);
  });
});

describe("3-of-4 recovery: properties over generated inputs", () => {
  const bytes32 = fc.uint8Array({ minLength: 32, maxLength: 32 }).filter((b) => b.some((x) => x !== 0));
  const member = fc.uuid({ version: 4 });
  const factorSet = fc.subarray([...RECOVERY_FACTORS]).chain((set) => fc.shuffledSubarray(set, { minLength: set.length, maxLength: set.length }));

  it("for any Master Key, member and factor secrets: a subset (in any order) rebuilds the key iff it has >= 3 factors", async () => {
    await fc.assert(
      fc.asyncProperty(bytes32, member, fc.array(bytes32, { minLength: 4, maxLength: 4 }), factorSet, async (mk, who, secrets, set) => {
        fc.pre(new Set(secrets.map((s) => s.join(","))).size === 4);
        const keys = Object.fromEntries(RECOVERY_FACTORS.map((f, i) => [f, factorKeys(f, secrets[i] as Uint8Array, who)])) as Record<RecoveryFactor, ReturnType<typeof factorKeys>>;
        const c = await createRecoveryCeremony({
          masterKey: mk.slice(),
          memberId: who,
          factorPublicKeys: { device_prf: keys.device_prf.publicKey, paper_guardian: keys.paper_guardian.publicKey, server_guardian: keys.server_guardian.publicKey, nfc_card: keys.nfc_card.publicKey },
        });
        const given = Object.fromEntries(set.map((f) => [f, keys[f].secretKey]));
        const attempt = recoverMasterKey({ ceremony: c, memberId: who, factorSecretKeys: given });
        if (set.length >= VERSION_THRESHOLD[3]) expect([...(await attempt)]).toEqual([...mk]);
        else await expect(attempt).rejects.toThrow(RecoveryError);
      }),
      { numRuns: 40 },
    );
  }, 120_000);

  it("for any single flipped bit in the sealed Master Key or a used shard, recovery fails", async () => {
    const c = await createRecoveryCeremony({ masterKey: master, memberId: ALICE, factorPublicKeys: pub });
    const used: RecoveryFactor[] = ["device_prf", "nfc_card", "paper_guardian"];
    await fc.assert(
      fc.asyncProperty(fc.constantFrom<"sealedMaster" | RecoveryFactor>("sealedMaster", ...used), fc.nat(), fc.integer({ min: 0, max: 7 }), async (where, at, bit) => {
        const target = where === "sealedMaster" ? c.sealedMaster : c.shards[where];
        const flipped = target.slice();
        const i = at % flipped.length;
        flipped[i] = (flipped[i] ?? 0) ^ (1 << bit);
        const tampered = (where === "sealedMaster" ? { ...c, sealedMaster: flipped } : { ...c, shards: { ...c.shards, [where]: flipped } }) as RecoveryCeremony;
        await expect(recoverMasterKey({ ceremony: tampered, memberId: ALICE, factorSecretKeys: pick(...used) })).rejects.toThrow(RecoveryError);
      }),
      { numRuns: 60 },
    );
  }, 120_000);

  it("for any other member id, the same ceremony and factors open nothing", async () => {
    const c = await createRecoveryCeremony({ masterKey: master, memberId: ALICE, factorPublicKeys: pub });
    await fc.assert(
      fc.asyncProperty(member.filter((m) => m !== ALICE), async (who) => {
        await expect(recoverMasterKey({ ceremony: { ...c, memberId: who }, memberId: who, factorSecretKeys: pick("device_prf", "nfc_card", "paper_guardian", "server_guardian") })).rejects.toThrow(RecoveryError);
      }),
      { numRuns: 30 },
    );
  });
});
