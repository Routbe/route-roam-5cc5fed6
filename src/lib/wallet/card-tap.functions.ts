/**
 * Public ROUT Card tap check (/t). No session needed: the card proves itself
 * with a live NTAG 424 DNA SUN tap (sdm-tap.server.ts). Rate limited fail-closed
 * per IP; every denial looks the same and nothing about the card's owner is returned.
 * A signed-in member with an open card step-up (db/0250) confirms that step-up
 * only by choosing purpose "step_up" on /t after seeing the question; only their
 * own card can do so. A plain tap never completes a step-up.
 * Purpose "recovery_factor" (signed-in only) confirms that the tapped card is the
 * member's own, unrevoked card before the browser seals a 3-of-4 recovery shard
 * to its fragment secret; it completes nothing else.
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { optionalAuth } from "@/lib/auth/middleware";
import { cardTapRoute } from "@/lib/wallet/card-tap-url";

export type CardTapResult =
  | { status: "verified"; activated: boolean }
  | { status: "step_up_confirmed" }
  | { status: "step_up_denied" }
  | { status: "card_confirmed" }
  | { status: "card_denied" }
  | { status: "denied" }
  | { status: "limited" };

export const verifyCardTapFn = createServerFn({ method: "POST" })
  .middleware([optionalAuth])
  .inputValidator((d: unknown) =>
    z.object({ p: z.string().max(64), m: z.string().max(64), purpose: z.enum(["proof", "step_up", "recovery_factor"]).default("proof") }).strict().parse(d),
  )
  .handler(async ({ data, context }): Promise<CardTapResult> => {
    const { getRequest, setResponseHeader } = await import("@tanstack/react-start/server");
    setResponseHeader("cache-control", "no-store");
    const { hitRateLimit, clientIp } = await import("@/lib/rate-limit-db.server");
    const limit = await hitRateLimit("card-tap", clientIp(getRequest()), { limit: 20, windowSec: 60 }, { failClosed: true }).catch(() => ({ ok: false }));
    if (!limit.ok) return { status: "limited" };
    const route = cardTapRoute(data.purpose, !!context.userId);
    if (route === "refuse") return { status: data.purpose === "recovery_factor" ? "card_denied" : "step_up_denied" };
    const tap = { p: data.p, m: data.m };
    if (route === "recovery_factor" && context.userId) {
      // False for every denial, including a database without db-pending/0267 (fail closed).
      const { confirmOwnCardTap } = await import("@/lib/vault/sdm-tap.server");
      return { status: (await confirmOwnCardTap(context.userId, tap)) ? "card_confirmed" : "card_denied" };
    }
    if (route === "step_up" && context.userId) {
      const { completeCardStepUpTap } = await import("@/lib/vault/sdm-tap.server");
      return { status: (await completeCardStepUpTap(context.userId, tap)) ? "step_up_confirmed" : "step_up_denied" };
    }
    try {
      const { publicCardProof } = await import("@/lib/vault/sdm-tap.server");
      const state = await publicCardProof(tap);
      return { status: "verified", activated: state === "active" };
    } catch {
      return { status: "denied" };
    }
  });

/** /t asks this before using a tap: does the signed-in member have an open card step-up? Reads no tap. */
export const pendingCardStepUpFn = createServerFn({ method: "POST" })
  .middleware([optionalAuth])
  .handler(async ({ context }): Promise<{ pending: boolean }> => {
    const { setResponseHeader } = await import("@tanstack/react-start/server");
    setResponseHeader("cache-control", "no-store");
    if (!context.userId) return { pending: false };
    const { vaultPort } = await import("@/lib/vault/vault-port.server");
    return { pending: await vaultPort().pendingCardStepUp({ userId: context.userId }).catch(() => false) };
  });
