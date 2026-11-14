// @vitest-environment node
/**
 * Ceremonies made before version 3 (version 1 = 2-of-3, version 2 = 2-of-4)
 * are never created any more, but a stored one must keep opening exactly as
 * before. The fixture was produced by recovery-mpc.ts as it stood at db/0266,
 * before version 3 existed, with test-only secrets; this proves byte-for-byte
 * compatibility with that ciphertext.
 */
import { describe, expect, it } from "vitest";
import fixture from "./__fixtures__/recovery-legacy.json";
import { cardFactorKeys } from "./card-factor";
import { RecoveryError, factorKeys, paperFactorKeys, recoverMasterKey, type RecoveryCeremony, type RecoveryFactor } from "./recovery-mpc";

const fromHex = (h: string) => Uint8Array.from(h.match(/../g) ?? [], (x) => parseInt(x, 16));
const fromB64 = (b: string) => Uint8Array.from(atob(b), (c) => c.charCodeAt(0));
const member = fixture.member;
const masterKey = fromHex(fixture.master);
const sec: Record<RecoveryFactor, Uint8Array> = {
  device_prf: factorKeys("device_prf", fromHex(fixture.deviceSecret), member).secretKey,
  server_guardian: factorKeys("server_guardian", fromHex(fixture.serverSecret), member).secretKey,
  paper_guardian: paperFactorKeys(fixture.mnemonic, member).secretKey,
  nfc_card: cardFactorKeys(fromHex(fixture.cardSecret), member).secretKey,
};
const pick = (...f: RecoveryFactor[]) => Object.fromEntries(f.map((x) => [x, sec[x]]));
function load(v: "1" | "2"): RecoveryCeremony {
  const c = fixture.ceremonies[v];
  return {
    version: c.version, ceremonyId: c.ceremonyId, memberId: member, threshold: c.threshold, sealedMaster: fromB64(c.sealedMaster),
    shards: Object.fromEntries(Object.entries(c.shards).map(([k, x]) => [k, fromB64(x as string)])),
  } as unknown as RecoveryCeremony;
}
const subsets = <T,>(xs: readonly T[]): T[][] => xs.reduce<T[][]>((acc, x) => acc.concat(acc.map((s) => [...s, x])), [[]]);

describe("stored version 1 and 2 ceremonies still open unchanged", () => {
  it("version 1 (2-of-3): every subset of its 3 factors opens iff it has >= 2", async () => {
    const c = load("1");
    for (const set of subsets<RecoveryFactor>(["device_prf", "paper_guardian", "server_guardian"])) {
      const attempt = recoverMasterKey({ ceremony: c, memberId: member, factorSecretKeys: pick(...set) });
      if (set.length >= 2) expect([...(await attempt)], set.join("+")).toEqual([...masterKey]);
      else await expect(attempt).rejects.toThrow(RecoveryError);
    }
    // A card is refused on a ceremony that never had one.
    await expect(recoverMasterKey({ ceremony: c, memberId: member, factorSecretKeys: pick("nfc_card", "paper_guardian") })).rejects.toThrow(RecoveryError);
  });

  it("version 2 (2-of-4): every subset of its 4 factors opens iff it has >= 2", async () => {
    const c = load("2");
    for (const set of subsets<RecoveryFactor>(["device_prf", "paper_guardian", "server_guardian", "nfc_card"])) {
      const attempt = recoverMasterKey({ ceremony: c, memberId: member, factorSecretKeys: pick(...set) });
      if (set.length >= 2) expect([...(await attempt)], set.join("+")).toEqual([...masterKey]);
      else await expect(attempt).rejects.toThrow(RecoveryError);
    }
  });

  it("a stored version 2 ceremony relabelled as version 3 does not open", async () => {
    const c = { ...load("2"), version: 3, threshold: 3 } as unknown as RecoveryCeremony;
    await expect(recoverMasterKey({ ceremony: c, memberId: member, factorSecretKeys: pick("device_prf", "paper_guardian", "nfc_card") })).rejects.toThrow(RecoveryError);
  });
});
