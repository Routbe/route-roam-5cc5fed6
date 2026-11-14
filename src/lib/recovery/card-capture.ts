/**
 * Getting the ROUT Card recovery secret into this tab, for setup, restore or
 * sign-in by recovery. Two ways race; the first valid secret wins and every
 * later one is wiped:
 *
 *   - Web NFC (Chrome on Android, page open): the card is read here directly.
 *   - Hand-off: the tap opens /t in another tab of this browser, which seals the
 *     secret to this tab over a BroadcastChannel (card-handoff.ts).
 *
 * Setup only seals a shard to a card the server confirmed as the member's own
 * (purpose recovery_factor, db-pending/0267): over Web NFC this tab asks
 * `confirmOwnTap`, over the hand-off /t asks before it delivers. Restore and
 * sign-in need no such check: a wrong card simply does not open its shard.
 *
 * The caller owns the resolved secret and must wipe it, normally by
 * transferring it to the crypto worker.
 */
import { cardHandoffSupported, waitForCardSecret, type CardHandoffPurpose } from "./card-handoff";
import { scanCardFactors, webNfcAvailable, type CardTapParams } from "@/lib/wallet/card-tap-url";

export type CardCaptureEvents = {
  /** A ROUT Card without the recovery fragment (not yet re-personalised). */
  onNoFragment?: () => void;
  /** Setup: the server did not confirm the card as the member's own. */
  onNotOwnCard?: () => void;
};

export function cardCaptureSupported(): boolean {
  return cardHandoffSupported() || webNfcAvailable();
}

export function captureCardSecret(
  purpose: CardHandoffPurpose,
  signal: AbortSignal,
  options: CardCaptureEvents & { confirmOwnTap?: (tap: CardTapParams) => Promise<boolean> } = {},
): Promise<Uint8Array> {
  if (purpose === "setup" && !options.confirmOwnTap) return Promise.reject(new TypeError("confirm_required"));
  const inner = new AbortController();
  const stopInner = () => inner.abort();
  return new Promise<Uint8Array>((resolve, reject) => {
    let settled = false;
    let failures = 0;
    const ways = (cardHandoffSupported() ? 1 : 0) + (webNfcAvailable() ? 1 : 0);
    const win = (secret: Uint8Array) => {
      if (settled) {
        secret.fill(0);
        return;
      }
      settled = true;
      signal.removeEventListener("abort", stopInner);
      inner.abort();
      resolve(secret);
    };
    const lose = (e: unknown) => {
      if (settled) return;
      failures++;
      // Abort, or every way failed: give up. One way failing (no NFC permission) keeps the other.
      if (signal.aborted || failures >= ways) {
        settled = true;
        signal.removeEventListener("abort", stopInner);
        inner.abort();
        reject(signal.aborted ? new DOMException("aborted", "AbortError") : e);
      }
    };
    if (ways === 0) return reject(new Error("card_capture_unavailable"));
    if (signal.aborted) return reject(new DOMException("aborted", "AbortError"));
    signal.addEventListener("abort", stopInner, { once: true });
    signal.addEventListener("abort", () => lose(new DOMException("aborted", "AbortError")), { once: true });

    if (cardHandoffSupported()) waitForCardSecret(purpose, inner.signal).then(win, lose);
    if (webNfcAvailable()) {
      let checking = false;
      scanCardFactors(
        inner.signal,
        ({ tap, secret }) => {
          if (settled || checking) return secret.fill(0);
          if (purpose !== "setup") return win(secret);
          checking = true;
          void (options.confirmOwnTap as (t: CardTapParams) => Promise<boolean>)(tap)
            .catch(() => false)
            .then((own) => {
              checking = false;
              if (own) return win(secret);
              secret.fill(0);
              if (!settled) options.onNotOwnCard?.();
            });
        },
        options.onNoFragment,
      ).catch(lose);
    }
  });
}
