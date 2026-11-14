/**
 * The only way app code spends a ROUT Card tap grant (H.6). The database
 * answers a denial with granted=false instead of raising, so its audit row
 * commits; this wrapper turns that answer into a TapDenied error, so a caller
 * that forgets to check the result can never continue as if the tap passed.
 */
import { z } from "zod";
import type { IVaultPort, SdmCardState, SdmTapPurpose, TapGrant, VaultCaller } from "./vault-port.server";

/** Exact row shape of vault_enclave.consume_sdm_tap: a grant always names the card state, a denial never does. */
export const SdmTapConsumeRow = z.discriminatedUnion("granted", [
  z.object({ granted: z.literal(true), card_state: z.enum(["active", "unactivated"]) }).strict(),
  z.object({ granted: z.literal(false), card_state: z.null() }).strict(),
]);
export type SdmTapConsumeRow = z.infer<typeof SdmTapConsumeRow>;

export type SdmTapResult = { granted: true; cardState: SdmCardState } | { granted: false };

/** Parses a raw database row; anything that is not exactly a grant is a denial. */
export function parseSdmTapRow(row: unknown): SdmTapResult {
  const parsed = SdmTapConsumeRow.safeParse(row);
  if (!parsed.success || !parsed.data.granted) return { granted: false };
  return { granted: true, cardState: parsed.data.card_state };
}

/** Thrown for every refused tap: bad request, unknown, spent or expired grant, revoked or foreign card, database error. */
export class TapDenied extends Error {
  readonly purpose: SdmTapPurpose;
  constructor(purpose: SdmTapPurpose) {
    super("tap_denied");
    this.name = "TapDenied";
    this.purpose = purpose;
  }
}

/** Spends the grant once for one purpose; resolves only with the card state of a granted tap. */
export async function consumeSdmTap(
  port: Pick<IVaultPort, "consumeSdmTapRow">,
  caller: VaultCaller | null,
  grant: TapGrant,
  purpose: SdmTapPurpose,
): Promise<SdmCardState> {
  let result: SdmTapResult;
  try {
    result = await port.consumeSdmTapRow(caller, grant, purpose);
  } catch {
    throw new TapDenied(purpose);
  }
  if (!result.granted) throw new TapDenied(purpose);
  return result.cardState;
}
