/**
 * Master Key recovery: any 3 of 4 factors (version 3, the only version made).
 * Versions 1 (2-of-3) and 2 (2-of-4) are never created any more; a stored one
 * still opens byte-for-byte as before so no member is ever locked out by an
 * upgrade (Neon held none when version 3 was introduced).
 *
 * A fresh 256-bit ceremony key seals the Master Key (XChaCha20-Poly1305, AAD
 * bound to member + ceremony, and from version 2 also to the exact threshold
 * and factor set). The ceremony key, not the Master Key, is split with Shamir
 * (shamir-secret-sharing), one share per factor:
 *
 *   device_prf       key derived from the WebAuthn PRF output of a passkey
 *   nfc_card         key derived from the 32-byte secret in the ROUT Card's tap
 *                    URL fragment (card-factor.ts). The fragment never reaches
 *                    a server, so ROUT cannot derive this factor
 *   server_guardian  key derived on the server from ROUT_RECOVERY_FACTOR_SECRET;
 *                    the server can open only this one shard, never two
 *   paper_guardian   key derived from a 24-word BIP39 phrase kept offline
 *
 * Threshold 3 means: the server plus a stolen card is still one share short;
 * any two factors together reveal nothing about the ceremony key (Shamir is
 * information-theoretically hiding below the threshold).
 *
 * Each share travels only as an `mpc` RVE1 envelope (pqc-envelope.ts, holder
 * "shard_factor") sealed to its own factor, with a context naming member,
 * ceremony and factor: a shard moved to another factor, member or ceremony no
 * longer opens. Rotating the factors means a new ceremony (new key, new id);
 * the Master Key can stay.
 *
 * Every failure while recovering throws the same RecoveryError. Ceremony keys
 * and shares are wiped in `finally`; callers wipe the Master Key they pass in
 * and the one they get back.
 */
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { ed25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { randomBytes } from "@noble/hashes/utils.js";
import { entropyToMnemonic, mnemonicToEntropy, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { combine, split } from "shamir-secret-sharing";
import { envelopeKeyId, generateRecipientKeys, keyId, openEnvelope, sealEnvelope, type RecipientKeys } from "./pqc-envelope";

/** Every factor a ceremony can carry, in share order. */
export const RECOVERY_FACTORS = ["device_prf", "paper_guardian", "server_guardian", "nfc_card"] as const;
export type RecoveryFactor = (typeof RECOVERY_FACTORS)[number];
/** Factors of the original version 1 ceremony. */
export const CORE_FACTORS = ["device_prf", "paper_guardian", "server_guardian"] as const satisfies readonly RecoveryFactor[];
export type CoreFactor = (typeof CORE_FACTORS)[number];
export type CeremonyVersion = 1 | 2 | 3;
/** The only version new ceremonies get. */
export const CURRENT_CEREMONY_VERSION = 3 as const;
/** Factor set of each version. */
export const VERSION_FACTORS: Readonly<Record<CeremonyVersion, readonly RecoveryFactor[]>> = Object.freeze({
  1: CORE_FACTORS,
  2: RECOVERY_FACTORS,
  3: RECOVERY_FACTORS,
});
/** Shares needed to rebuild, per version. */
export const VERSION_THRESHOLD: Readonly<Record<CeremonyVersion, number>> = Object.freeze({ 1: 2, 2: 2, 3: 3 });
/** Shares needed for every ceremony made now: 3 of 4. */
export const RECOVERY_THRESHOLD = VERSION_THRESHOLD[CURRENT_CEREMONY_VERSION];
/** Shares per version (one per factor). */
export const versionShares = (version: CeremonyVersion) => VERSION_FACTORS[version].length;
const MASTER_KEY_BYTES = 32;
const NONCE_BYTES = 24;
const CEREMONY_ID_BYTES = 16;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type CoreShards = Readonly<Record<CoreFactor, Uint8Array>>;
type AllShards = Readonly<Record<RecoveryFactor, Uint8Array>>;

export type RecoveryCeremony = {
  ceremonyId: string; // 32 hex
  memberId: string;
  /** nonce (24) || XChaCha20-Poly1305(Master Key). */
  sealedMaster: Uint8Array;
} & (
  | { version: 1; threshold: 2; /** One mpc RVE1 envelope per factor. */ shards: CoreShards & { readonly nfc_card?: undefined } }
  | { version: 2; threshold: 2; shards: AllShards }
  | { version: 3; threshold: 3; shards: AllShards }
);

export class RecoveryError extends Error {
  constructor() {
    super("recovery_failed");
    this.name = "RecoveryError";
  }
}

const enc = new TextEncoder();
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const wipe = (...arrays: (Uint8Array | undefined)[]) => {
  for (const a of arrays) a?.fill(0);
};

function checkMember(memberId: string) {
  if (!UUID_RE.test(memberId)) throw new TypeError("member_id_invalid");
}
/** Version 1 and 2 strings are byte-identical to the ceremonies made before version 3. */
const masterAad = (version: CeremonyVersion, memberId: string, ceremonyId: string) =>
  enc.encode(
    version === 1
      ? `rout.recovery.mpc.master.v1|${memberId}|${ceremonyId}`
      : `rout.recovery.mpc.master.v${version}|${memberId}|${ceremonyId}|t=${VERSION_THRESHOLD[version]}|${VERSION_FACTORS[version].join(",")}`,
  );
const shardContext = (version: CeremonyVersion, memberId: string, ceremonyId: string, factor: RecoveryFactor) =>
  `rout.recovery.mpc.shard.v${version}|${memberId}|${ceremonyId}|${factor}`;

/** True when `c` is structurally a ceremony of its declared version (no crypto). */
function wellFormed(c: RecoveryCeremony, memberId: string): boolean {
  if (c.version !== 1 && c.version !== 2 && c.version !== 3) return false;
  if (c.memberId !== memberId || c.threshold !== VERSION_THRESHOLD[c.version] || !/^[0-9a-f]{32}$/.test(c.ceremonyId)) return false;
  const expected = VERSION_FACTORS[c.version];
  const shards = c.shards as Partial<Record<RecoveryFactor, Uint8Array>>;
  // Exactly the version's factors: no missing shard and no extra one.
  for (const f of RECOVERY_FACTORS) if ((shards[f] instanceof Uint8Array) !== expected.includes(f)) return false;
  return true;
}

/** Deterministic factor key pair from a 32-byte factor secret (PRF output, card secret, phrase entropy). */
export function factorKeys(factor: RecoveryFactor, factorSecret: Uint8Array, memberId: string): RecipientKeys {
  checkMember(memberId);
  if (factorSecret.length !== 32) throw new TypeError("factor_secret_must_be_32_bytes");
  const seed = hkdf(sha256, factorSecret, enc.encode("rout.recovery.factor.v1"), enc.encode(`${factor}|${memberId}`), 32);
  try {
    return generateRecipientKeys("shard_factor", seed);
  } finally {
    wipe(seed);
  }
}

/** A new offline paper/guardian factor: 24 BIP39 words (256-bit entropy). */
export function createPaperFactor(memberId: string): { mnemonic: string; keys: RecipientKeys } {
  const entropy = randomBytes(32);
  try {
    return { mnemonic: entropyToMnemonic(entropy, wordlist), keys: factorKeys("paper_guardian", entropy, memberId) };
  } finally {
    wipe(entropy);
  }
}

/** Re-derives the paper factor from its words; a mistyped word fails the BIP39 checksum. */
export function paperFactorKeys(mnemonic: string, memberId: string): RecipientKeys {
  const normalized = mnemonic.trim().toLowerCase().split(/\s+/).join(" ");
  if (normalized.split(" ").length !== 24 || !validateMnemonic(normalized, wordlist)) throw new RecoveryError();
  const entropy = mnemonicToEntropy(normalized, wordlist);
  try {
    return factorKeys("paper_guardian", entropy, memberId);
  } finally {
    wipe(entropy);
  }
}

/** Public keys of the factors sealed in the first half (all but the passkey). */
export type DraftFactorKeys = {
  paper_guardian: Uint8Array;
  server_guardian: Uint8Array;
  /** The ROUT Card factor; required: every new ceremony is 3-of-4. */
  nfc_card: Uint8Array;
};

/** A ceremony whose device shard is not sealed yet; holds no secret. */
export type CeremonyDraft = {
  version: typeof CURRENT_CEREMONY_VERSION;
  ceremonyId: string;
  memberId: string;
  threshold: 3;
  sealedMaster: Uint8Array;
  shards: Readonly<{ paper_guardian: Uint8Array; server_guardian: Uint8Array; nfc_card: Uint8Array }>;
};

const hexKeys = (keys: readonly Uint8Array[]) => keys.map((k) => hex(k));
const isKey = (k: unknown): k is Uint8Array => k instanceof Uint8Array && k.length > 0;

/**
 * First half of a ceremony: seals the Master Key, splits the ceremony key 3-of-4
 * and seals the paper, server and card shards. The device share comes back raw
 * (one share reveals nothing) so it can be sealed once the passkey is
 * available; the caller must wipe it, normally via completeRecoveryCeremony.
 */
export async function beginRecoveryCeremony(input: {
  masterKey: Uint8Array;
  memberId: string;
  factorPublicKeys: Readonly<DraftFactorKeys>;
}): Promise<{ draft: CeremonyDraft; deviceShare: Uint8Array }> {
  const { masterKey, memberId, factorPublicKeys } = input;
  checkMember(memberId);
  if (masterKey.length !== MASTER_KEY_BYTES) throw new TypeError("master_key_must_be_32_bytes");
  // No card, no ceremony: a weaker 2-of-3 or 2-of-4 is never made.
  if (!isKey(factorPublicKeys.nfc_card)) throw new TypeError("card_factor_required");
  if (!isKey(factorPublicKeys.paper_guardian) || !isKey(factorPublicKeys.server_guardian)) throw new TypeError("factor_key_missing");
  const given = [factorPublicKeys.paper_guardian, factorPublicKeys.server_guardian, factorPublicKeys.nfc_card];
  if (new Set(hexKeys(given)).size !== given.length) throw new TypeError("factor_keys_must_differ");

  const version = CURRENT_CEREMONY_VERSION;
  const threshold = VERSION_THRESHOLD[version] as 3;
  const ceremonyKey = randomBytes(32);
  const ceremonyId = hex(randomBytes(CEREMONY_ID_BYTES));
  let shares: Uint8Array[] = [];
  try {
    const nonce = randomBytes(NONCE_BYTES);
    const body = xchacha20poly1305(ceremonyKey, nonce, masterAad(version, memberId, ceremonyId)).encrypt(masterKey);
    const sealedMaster = new Uint8Array(NONCE_BYTES + body.length);
    sealedMaster.set(nonce);
    sealedMaster.set(body, NONCE_BYTES);

    const factors = VERSION_FACTORS[version];
    shares = await split(ceremonyKey, factors.length, threshold);
    const seal = (factor: Exclude<RecoveryFactor, "device_prf">) => {
      const share = shares[factors.indexOf(factor)];
      const key = factorPublicKeys[factor];
      if (!share || !key) throw new Error("split_failed");
      return sealEnvelope({ kind: "mpc", holder: "shard_factor", recipientPublicKey: key, plaintext: share, context: shardContext(version, memberId, ceremonyId, factor) });
    };
    const deviceShare = shares[factors.indexOf("device_prf")];
    if (!deviceShare) throw new Error("split_failed");
    const shards = Object.freeze({ paper_guardian: seal("paper_guardian"), server_guardian: seal("server_guardian"), nfc_card: seal("nfc_card") });
    shares = shares.filter((s) => s !== deviceShare); // the device share is the caller's now; the rest is wiped below
    return { draft: { version, ceremonyId, memberId, threshold, sealedMaster, shards }, deviceShare };
  } finally {
    wipe(ceremonyKey, ...shares);
  }
}

/** Second half: seals the device share to the passkey factor and wipes it. */
export function completeRecoveryCeremony(draft: CeremonyDraft, deviceShare: Uint8Array, devicePublicKey: Uint8Array): RecoveryCeremony {
  try {
    if (draft.version !== CURRENT_CEREMONY_VERSION || draft.threshold !== VERSION_THRESHOLD[CURRENT_CEREMONY_VERSION]) throw new TypeError("draft_version_invalid");
    if (!isKey(draft.shards.nfc_card)) throw new TypeError("card_shard_missing");
    const device = hex(keyId(devicePublicKey));
    const others = [draft.shards.paper_guardian, draft.shards.server_guardian, draft.shards.nfc_card];
    if (others.some((e) => hex(envelopeKeyId(e)) === device)) throw new TypeError("factor_keys_must_differ");
    const device_prf = sealEnvelope({
      kind: "mpc",
      holder: "shard_factor",
      recipientPublicKey: devicePublicKey,
      plaintext: deviceShare,
      context: shardContext(draft.version, draft.memberId, draft.ceremonyId, "device_prf"),
    });
    return {
      ceremonyId: draft.ceremonyId,
      memberId: draft.memberId,
      sealedMaster: draft.sealedMaster,
      version: 3,
      threshold: 3,
      shards: Object.freeze({ device_prf, paper_guardian: draft.shards.paper_guardian, server_guardian: draft.shards.server_guardian, nfc_card: draft.shards.nfc_card }),
    };
  } finally {
    wipe(deviceShare);
  }
}

/** Both halves at once (every factor public key known up front, card included). */
export async function createRecoveryCeremony(input: {
  masterKey: Uint8Array;
  memberId: string;
  factorPublicKeys: Readonly<DraftFactorKeys & { device_prf: Uint8Array }>;
}): Promise<RecoveryCeremony> {
  const { factorPublicKeys: k } = input;
  if (!isKey(k.nfc_card)) throw new TypeError("card_factor_required");
  const all = [k.device_prf, k.paper_guardian, k.server_guardian, k.nfc_card];
  if (new Set(hexKeys(all)).size !== all.length) throw new TypeError("factor_keys_must_differ");
  const { draft, deviceShare } = await beginRecoveryCeremony({
    masterKey: input.masterKey,
    memberId: input.memberId,
    factorPublicKeys: { paper_guardian: k.paper_guardian, server_guardian: k.server_guardian, nfc_card: k.nfc_card },
  });
  return completeRecoveryCeremony(draft, deviceShare, k.device_prf);
}

/** Opens one factor's shard; the server uses this for its own factor only. Caller wipes the share. */
export function openFactorShard(ceremony: RecoveryCeremony, memberId: string, factor: RecoveryFactor, secretKey: Uint8Array): Uint8Array {
  try {
    if (!wellFormed(ceremony, memberId)) throw new RecoveryError();
    const envelope = (ceremony.shards as Partial<Record<RecoveryFactor, Uint8Array>>)[factor];
    if (!envelope) throw new RecoveryError();
    return openEnvelope({ envelope, expectedKind: "mpc", holder: "shard_factor", secretKey, context: shardContext(ceremony.version, memberId, ceremony.ceremonyId, factor) });
  } catch {
    throw new RecoveryError();
  }
}

/** Rebuilds the Master Key from at least the ceremony's threshold of factors (secret keys or already-opened shares). */
export async function recoverMasterKey(input: {
  ceremony: RecoveryCeremony;
  memberId: string;
  factorSecretKeys: Partial<Record<RecoveryFactor, Uint8Array>>;
  /** Shares already opened by their holder (the server's own factor). Wiped here. */
  openedShares?: Partial<Record<RecoveryFactor, Uint8Array>>;
}): Promise<Uint8Array> {
  const { ceremony, memberId, factorSecretKeys } = input;
  const opened = input.openedShares ?? {};
  const openedFactors = RECOVERY_FACTORS.filter((f) => opened[f] !== undefined);
  const present = RECOVERY_FACTORS.filter((f) => factorSecretKeys[f] !== undefined && opened[f] === undefined);
  const shares: Uint8Array[] = openedFactors.map((f) => opened[f] as Uint8Array);
  let ceremonyKey: Uint8Array | undefined;
  try {
    if (!wellFormed(ceremony, memberId)) throw new RecoveryError();
    // Below the threshold Shamir would still "combine" into noise; refuse before.
    if (present.length + openedFactors.length < VERSION_THRESHOLD[ceremony.version]) throw new RecoveryError();
    const allowed = VERSION_FACTORS[ceremony.version];
    // A factor the ceremony does not carry (a card on a version 1 ceremony) is refused, not skipped.
    if ([...present, ...openedFactors].some((f) => !allowed.includes(f))) throw new RecoveryError();
    const shards = ceremony.shards as Partial<Record<RecoveryFactor, Uint8Array>>;
    for (const factor of present) {
      const secretKey = factorSecretKeys[factor];
      const envelope = shards[factor];
      if (!secretKey || !envelope) throw new RecoveryError();
      shares.push(
        openEnvelope({ envelope, expectedKind: "mpc", holder: "shard_factor", secretKey, context: shardContext(ceremony.version, memberId, ceremony.ceremonyId, factor) }),
      );
    }
    ceremonyKey = await combine(shares);
    if (ceremonyKey.length !== 32 || ceremony.sealedMaster.length <= NONCE_BYTES) throw new RecoveryError();
    const nonce = ceremony.sealedMaster.subarray(0, NONCE_BYTES);
    const view = xchacha20poly1305(ceremonyKey, nonce, masterAad(ceremony.version, memberId, ceremony.ceremonyId)).decrypt(
      ceremony.sealedMaster.subarray(NONCE_BYTES),
    );
    const master = view.slice();
    wipe(view);
    if (master.length !== MASTER_KEY_BYTES) throw new RecoveryError();
    return master;
  } catch {
    throw new RecoveryError();
  } finally {
    wipe(ceremonyKey, ...shares);
  }
}

/**
 * Ed25519 login key of the Master Key (sign-in by recovery). Only the public
 * key leaves; the caller wipes `secretKey` (the seed).
 */
export function loginKeyFromMaster(masterKey: Uint8Array, memberId: string): { secretKey: Uint8Array; publicKey: Uint8Array } {
  checkMember(memberId);
  if (masterKey.length !== MASTER_KEY_BYTES) throw new TypeError("master_key_must_be_32_bytes");
  const secretKey = hkdf(sha256, masterKey, enc.encode("rout.recovery.login-key.v1"), enc.encode(memberId), 32);
  return { secretKey, publicKey: ed25519.getPublicKey(secretKey) };
}
