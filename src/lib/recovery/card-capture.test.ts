import { afterEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  handoff: true,
  nfc: true,
  wait: vi.fn(),
  scan: vi.fn(),
}));
vi.mock("./card-handoff", () => ({ cardHandoffSupported: () => h.handoff, waitForCardSecret: h.wait }));
vi.mock("@/lib/wallet/card-tap-url", () => ({ webNfcAvailable: () => h.nfc, scanCardFactors: h.scan }));
import { captureCardSecret } from "./card-capture";

const TAP = { p: "a".repeat(32), m: "b".repeat(16) };
const secret = (n: number) => new Uint8Array(32).fill(n);
const never = (signal: AbortSignal) => new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));

describe("ROUT Card capture for the 3-of-4 recovery vault", () => {
  afterEach(() => { vi.clearAllMocks(); h.handoff = true; h.nfc = true; });

  it("setup refuses to listen without an own-card check", async () => {
    await expect(captureCardSecret("setup", new AbortController().signal)).rejects.toThrow("confirm_required");
    expect(h.wait).not.toHaveBeenCalled();
  });

  it("setup over Web NFC accepts only a card the server confirmed; a foreign card is wiped and listening goes on", async () => {
    h.handoff = false;
    const foreign = secret(1);
    const own = secret(2);
    let emit: (f: { tap: typeof TAP; secret: Uint8Array }) => void = () => undefined;
    h.scan.mockImplementation((signal: AbortSignal, onFactor: typeof emit) => { emit = onFactor; return never(signal); });
    const confirm = vi.fn(async () => confirm.mock.calls.length > 1);
    const onNotOwnCard = vi.fn();
    const got = captureCardSecret("setup", new AbortController().signal, { confirmOwnTap: confirm, onNotOwnCard });
    emit({ tap: TAP, secret: foreign });
    await vi.waitFor(() => expect(onNotOwnCard).toHaveBeenCalledTimes(1));
    expect(foreign.every((b) => b === 0)).toBe(true);
    emit({ tap: TAP, secret: own });
    expect(await got).toBe(own);
    expect(confirm).toHaveBeenCalledTimes(2);
  });

  it("the first secret wins; a later one from the other way is wiped", async () => {
    const late = secret(9);
    let emit: (f: { tap: typeof TAP; secret: Uint8Array }) => void = () => undefined;
    h.wait.mockResolvedValue(secret(3));
    h.scan.mockImplementation((signal: AbortSignal, onFactor: typeof emit) => { emit = onFactor; return never(signal); });
    const got = await captureCardSecret("login", new AbortController().signal);
    expect([...got]).toEqual([...secret(3)]);
    emit({ tap: TAP, secret: late });
    expect(late.every((b) => b === 0)).toBe(true);
  });

  it("one way failing (no NFC permission) keeps the other; abort stops everything", async () => {
    h.scan.mockRejectedValue(new Error("NotAllowedError"));
    h.wait.mockImplementation((_p: string, signal: AbortSignal) => never(signal));
    const ctl = new AbortController();
    const got = captureCardSecret("restore", ctl.signal);
    await new Promise((r) => setTimeout(r, 10));
    ctl.abort();
    await expect(got).rejects.toThrow(/aborted/);
    expect((h.wait.mock.calls[0]?.[1] as AbortSignal).aborted).toBe(true);
  });
});
