/**
 * Transport form of a recovery ceremony: every envelope as standard base64, so
 * it crosses server functions and the database as plain text. Contains only
 * ciphertext; no factor, share or key. The version travels explicitly: version
 * 2 (2-of-4) and version 3 (3-of-4) carry the same four shards, so the shard
 * set alone must never decide how a ceremony is opened.
 */
// Type-only: this module is also loaded on the UI thread, which must not pull in the crypto code.
import type { CeremonyVersion, CoreFactor, RecoveryCeremony } from "@/lib/crypto-enclave/recovery-mpc";

/** Mirror of recovery-mpc VERSION_THRESHOLD (a test keeps them equal). */
export const WIRE_THRESHOLD: Readonly<Record<CeremonyVersion, number>> = Object.freeze({ 1: 2, 2: 2, 3: 3 });

export type CeremonyWire = {
  version: CeremonyVersion;
  ceremonyId: string;
  keyId: string;
  sealedMaster: string;
  shards: Record<CoreFactor, string> & { nfc_card?: string };
};

export const CEREMONY_ID_RE = /^[0-9a-f]{32}$/;
export const B64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
export const SHARD_B64_MAX = 6000;
export const MASTER_B64_MAX = 400;

/** Restores with the server's piece per member per hour (fail-closed). */
export const CEREMONY_RESTORES_PER_HOUR = 5;

export function toB64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function fromB64(value: string): Uint8Array {
  if (!B64_RE.test(value)) throw new TypeError("invalid_base64");
  return Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
}

export function ceremonyToWire(c: RecoveryCeremony, keyId: string): CeremonyWire {
  const core = { device_prf: toB64(c.shards.device_prf), paper_guardian: toB64(c.shards.paper_guardian), server_guardian: toB64(c.shards.server_guardian) };
  return {
    version: c.version,
    ceremonyId: c.ceremonyId,
    keyId,
    sealedMaster: toB64(c.sealedMaster),
    shards: c.version === 1 ? core : { ...core, nfc_card: toB64(c.shards.nfc_card) },
  };
}

/** Strict: the declared version must match the shard set exactly (version 1 has no card shard, 2 and 3 must have one). */
export function ceremonyFromWire(w: CeremonyWire, memberId: string): RecoveryCeremony {
  if (!CEREMONY_ID_RE.test(w.ceremonyId)) throw new TypeError("invalid_ceremony");
  const version = w.version;
  if (version !== 1 && version !== 2 && version !== 3) throw new TypeError("invalid_ceremony");
  const card = w.shards.nfc_card;
  const hasCard = typeof card === "string" && card.length > 0;
  if (hasCard !== (version !== 1)) throw new TypeError("invalid_ceremony");
  const base = { ceremonyId: w.ceremonyId, memberId, sealedMaster: fromB64(w.sealedMaster) };
  const core = { device_prf: fromB64(w.shards.device_prf), paper_guardian: fromB64(w.shards.paper_guardian), server_guardian: fromB64(w.shards.server_guardian) };
  if (version === 1) return { ...base, version: 1, threshold: 2, shards: core };
  const all = { ...core, nfc_card: fromB64(card as string) };
  return version === 2 ? { ...base, version: 2, threshold: 2, shards: all } : { ...base, version: 3, threshold: 3, shards: all };
}

/** A stored ceremony as the version-aware reads (db/0266 *_v2) return it. */
export type CeremonyRow = {
  ceremony_id: string;
  key_id: string;
  sealed_master: string;
  device_shard: string;
  paper_shard: string;
  server_shard: string;
  card_shard: string | null;
  ceremony_version: number;
  device_credential: string;
};

/**
 * Wire form of a stored ceremony. A version 1 row must not carry a card shard,
 * version 2 and 3 rows must; any other version is refused rather than guessed,
 * so a 3-of-4 ceremony is never handed out (or opened) as 2-of-4 or 2-of-3.
 */
export function ceremonyRowToWire(r: CeremonyRow): CeremonyWire {
  const core = { device_prf: r.device_shard, paper_guardian: r.paper_shard, server_guardian: r.server_shard };
  const version = Number(r.ceremony_version);
  const base = { ceremonyId: r.ceremony_id, keyId: r.key_id, sealedMaster: r.sealed_master };
  if (version === 1 && r.card_shard === null) return { ...base, version: 1, shards: core };
  if ((version === 2 || version === 3) && typeof r.card_shard === "string" && r.card_shard.length > 0) {
    return { ...base, version, shards: { ...core, nfc_card: r.card_shard } };
  }
  throw new TypeError("invalid_ceremony_row");
}

/** Shares needed to open a ceremony of this wire form (3 for every ceremony made now). */
export const wireThreshold = (w: CeremonyWire): number => WIRE_THRESHOLD[w.version];

/** Number of words typed so far (for enabling a button; the words themselves are not kept). */
export function wordCount(text: string): number {
  const t = text.trim();
  return t ? t.split(/\s+/).length : 0;
}
