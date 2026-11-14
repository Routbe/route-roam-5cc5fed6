import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const MEMBER = "00000000-0000-4000-8000-0000000000aa";
const mock = vi.hoisted(() => ({ start: vi.fn(), open: vi.fn(), recoverLogin: vi.fn(), prf: vi.fn(), fromWire: vi.fn(), capture: vi.fn() }));
vi.mock("@tanstack/react-start", () => ({ useServerFn: (fn: unknown) => fn }));
vi.mock("@/lib/recovery/recovery-login.functions", () => ({ startRecoveryLogin: mock.start, openRecoveryLogin: mock.open }));
vi.mock("@/lib/recovery/passkey-prf", () => ({ withPasskeyPrf: mock.prf }));
vi.mock("@/lib/recovery/card-capture", () => ({ captureCardSecret: mock.capture, cardCaptureSupported: () => true }));
vi.mock("@/lib/recovery/ceremony-wire", async (original) => ({
  ...await original<typeof import("@/lib/recovery/ceremony-wire")>(),
  ceremonyFromWire: mock.fromWire,
}));
vi.mock("@/lib/crypto-enclave/client", async (original) => ({
  ...await original<typeof import("@/lib/crypto-enclave/client")>(),
  enclave: { ceremony: { recoverLogin: mock.recoverLogin } },
}));
import { RecoveryLogin } from "./RecoveryLogin";

const share = btoa(String.fromCharCode(...new Uint8Array(48).fill(7)));
const words = Array.from({ length: 24 }, (_, i) => `w${i}`).join(" ");

describe("/recovery sign-in", () => {
  let fetcher: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    vi.clearAllMocks();
    mock.start.mockResolvedValue({ ok: true });
    mock.open.mockResolvedValue({
      ok: true, memberId: MEMBER, challenge: "c".repeat(43), serverShare: share, deviceCredential: "cred",
      ceremony: { version: 3, ceremonyId: "x", keyId: "key-1", sealedMaster: "", shards: {} },
    });
    mock.fromWire.mockReturnValue({ memberId: MEMBER });
    mock.recoverLogin.mockResolvedValue({ keyId: "key-1", signature: new Uint8Array(64).fill(1) });
    mock.capture.mockImplementation(async () => new Uint8Array(32).fill(0x42));
    mock.prf.mockImplementation(async (_p: string, consume: (o: Uint8Array) => Promise<unknown>) => consume(new Uint8Array(32)));
    fetcher = vi.fn(async () => ({ ok: true }));
    vi.stubGlobal("fetch", fetcher);
    vi.stubGlobal("location", { ...window.location, assign: vi.fn() });
  });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  async function toFactors() {
    render(<RecoveryLogin />);
    fireEvent.change(screen.getByLabelText("E-mailadres van je account"), { target: { value: "a@b.be" } });
    fireEvent.click(screen.getByRole("button", { name: /Code sturen/ }));
    fireEvent.change(await screen.findByLabelText("Code uit je e-mail"), { target: { value: "123456" } });
    fireEvent.click(screen.getByRole("button", { name: /Verder/ }));
    await screen.findByText(/Kies 3 van je stukken/);
  }
  const toggle = (label: string) => fireEvent.click(screen.getByLabelText(label));

  it("two pieces are never enough: the button stays off until exactly three are chosen", async () => {
    await toFactors();
    expect(mock.open).toHaveBeenCalledWith({ data: { email: "a@b.be", code: "123456" } });
    expect((screen.getByLabelText("Het stuk van ROUT") as HTMLInputElement).checked).toBe(true);
    toggle("Mijn 24 papieren woorden");
    fireEvent.change(screen.getByLabelText("Je 24 papieren woorden"), { target: { value: words } });
    const go = screen.getByRole("button", { name: /Herstellen en inloggen/ });
    expect(go).toBeDisabled();
    toggle("Mijn ROUT Card");
    expect(go).toBeEnabled();
    // A fourth piece cannot be added on top.
    expect(screen.getByLabelText("Mijn toegangssleutel")).toBeDisabled();
  });

  it("ROUT + paper + ROUT Card: the card is awaited, every piece goes to the worker once, the signature is redeemed", async () => {
    await toFactors();
    toggle("Mijn 24 papieren woorden");
    toggle("Mijn ROUT Card");
    const field = screen.getByLabelText("Je 24 papieren woorden") as HTMLTextAreaElement;
    fireEvent.change(field, { target: { value: words } });
    fireEvent.click(screen.getByRole("button", { name: /Herstellen en inloggen/ }));
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    expect(mock.capture.mock.calls[0][0]).toBe("login");
    const args = mock.recoverLogin.mock.calls[0][0];
    expect(args).toMatchObject({ userId: MEMBER, keyId: "key-1", challenge: "c".repeat(43), paperWords: words });
    expect(args.prf).toBeUndefined();
    expect(args.serverShare).toHaveLength(48);
    expect(args.cardSecret).toHaveLength(32);
    expect(field.value).toBe("");
    const [url, init] = fetcher.mock.calls[0] as [string, { body: string }];
    expect(url).toBe("/api/auth/recovery/verify");
    expect(JSON.parse(init.body).challenge).toBe("c".repeat(43));
    await waitFor(() => expect(window.location.assign).toHaveBeenCalledWith("/auth/continue"));
  });

  it("passkey + paper + card without ROUT never sends ROUT's piece", async () => {
    await toFactors();
    toggle("Het stuk van ROUT");
    toggle("Mijn toegangssleutel");
    toggle("Mijn 24 papieren woorden");
    toggle("Mijn ROUT Card");
    fireEvent.change(screen.getByLabelText("Je 24 papieren woorden"), { target: { value: words } });
    fireEvent.click(screen.getByRole("button", { name: /Bevestigen met toegangssleutel/ }));
    await waitFor(() => expect(mock.recoverLogin).toHaveBeenCalledTimes(1));
    const args = mock.recoverLogin.mock.calls[0][0];
    expect(args.serverShare).toBeUndefined();
    expect(args.prf).toBeInstanceOf(Uint8Array);
    expect(args.cardSecret).toBeInstanceOf(Uint8Array);
    expect(mock.prf).toHaveBeenCalledWith("ceremony", expect.any(Function), "cred");
  });

  it("a refused signature does not sign in and starts over", async () => {
    fetcher.mockResolvedValueOnce({ ok: false });
    await toFactors();
    toggle("Mijn toegangssleutel");
    toggle("Mijn ROUT Card");
    fireEvent.click(screen.getByRole("button", { name: /Bevestigen met toegangssleutel/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent("verlopen");
    expect(window.location.assign).not.toHaveBeenCalled();
    expect(screen.getByLabelText("E-mailadres van je account")).toBeInTheDocument();
  });

  it("a wrong code keeps ROUT's piece closed", async () => {
    mock.open.mockResolvedValueOnce({ ok: false, error: "invalid_code" });
    render(<RecoveryLogin />);
    fireEvent.change(screen.getByLabelText("E-mailadres van je account"), { target: { value: "a@b.be" } });
    fireEvent.click(screen.getByRole("button", { name: /Code sturen/ }));
    fireEvent.change(await screen.findByLabelText("Code uit je e-mail"), { target: { value: "000000" } });
    fireEvent.click(screen.getByRole("button", { name: /Verder/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent("klopt niet");
    expect(screen.queryByText(/Kies 3 van je stukken/)).toBeNull();
  });
});
