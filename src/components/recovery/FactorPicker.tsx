import { useEffect, useRef, useState } from "react";
import { CreditCard, FileText, Fingerprint, Server, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { captureCardSecret, cardCaptureSupported } from "@/lib/recovery/card-capture";
import type { CardHandoffPurpose } from "@/lib/recovery/card-handoff";
import type { CardTapParams } from "@/lib/wallet/card-tap-url";

export type FactorId = "rout" | "passkey" | "paper" | "card";

export const FACTOR_LABEL: Record<FactorId, string> = {
  rout: "Het stuk van ROUT",
  passkey: "Mijn toegangssleutel",
  paper: "Mijn 24 papieren woorden",
  card: "Mijn ROUT Card",
};
const ICON: Record<FactorId, typeof Server> = { rout: Server, passkey: Fingerprint, paper: FileText, card: CreditCard };

/**
 * Pick exactly `need` pieces. `fixed` pieces are always used (ROUT's piece
 * when restoring on a signed-in device) and count toward `need`.
 */
export function FactorPicker({ available, selected, fixed = [], need, onChange, disabled }: {
  available: FactorId[]; selected: FactorId[]; fixed?: FactorId[]; need: number; onChange: (next: FactorId[]) => void; disabled?: boolean;
}) {
  const chosen = new Set<FactorId>([...fixed, ...selected]);
  return (
    <fieldset className="space-y-2" disabled={disabled}>
      <legend className="mb-2 text-sm font-medium">Kies {need} van je stukken ({chosen.size} van {need} gekozen)</legend>
      {available.map((f) => {
        const Icon = ICON[f];
        const isFixed = fixed.includes(f);
        const on = chosen.has(f);
        const full = !on && chosen.size >= need;
        return (
          <label key={f} className={`flex min-h-11 cursor-pointer items-center gap-3 rounded-xl border p-3 text-sm ${on ? "border-primary bg-background" : "border-border"} ${full || isFixed ? "cursor-default" : ""}`}>
            <input
              type="checkbox"
              checked={on}
              disabled={isFixed || full}
              onChange={(e) => onChange(e.target.checked ? [...selected, f] : selected.filter((x) => x !== f))}
              className="size-4"
            />
            <Icon className="size-4 shrink-0" />
            <span className="font-medium">{FACTOR_LABEL[f]}</span>
            {isFixed && <span className="ml-auto text-xs text-muted-foreground">altijd</span>}
          </label>
        );
      })}
    </fieldset>
  );
}

/**
 * Waits for a ROUT Card tap (Web NFC here, or /t in another tab hands it over).
 * Resolves `onSecret` once with the 32-byte secret, which the caller owns and
 * must transfer to the crypto worker or wipe. Unmounting stops the wait.
 */
export function CardWait({ purpose, onSecret, onCancel, confirmOwnTap }: {
  purpose: CardHandoffPurpose;
  onSecret: (secret: Uint8Array) => void;
  onCancel: () => void;
  confirmOwnTap?: (tap: CardTapParams) => Promise<boolean>;
}) {
  const [hint, setHint] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const handler = useRef(onSecret);
  handler.current = onSecret;
  useEffect(() => {
    if (!cardCaptureSupported()) {
      setFailed("Deze browser kan je ROUT Card niet ontvangen. Gebruik je telefoon met een recente browser.");
      return;
    }
    const abort = new AbortController();
    captureCardSecret(purpose, abort.signal, {
      confirmOwnTap,
      onNoFragment: () => setHint("Deze kaart heeft nog geen herstelmerk. Laat je ROUT Card eerst opnieuw personaliseren."),
      onNotOwnCard: () => setHint("Dit is niet je eigen, actieve ROUT Card. Tik je eigen kaart."),
    }).then(
      (secret) => {
        if (abort.signal.aborted) return secret.fill(0);
        handler.current(secret);
      },
      (e: unknown) => {
        if (abort.signal.aborted) return;
        setFailed(e instanceof DOMException && e.name === "TimeoutError" ? "Er is 5 minuten geen kaart getikt. Probeer opnieuw." : "Je ROUT Card kon niet worden gelezen. Probeer opnieuw.");
      },
    );
    return () => abort.abort();
    // purpose and confirmOwnTap are fixed for one wait
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div className="space-y-3 rounded-xl border border-border bg-background p-3" role="status" aria-live="polite">
      <p className="flex items-start gap-2 text-sm">
        <CreditCard className="mt-0.5 size-4 shrink-0" />
        <span>Tik nu je ROUT Card tegen de achterkant van je telefoon. Opent er een nieuw tabblad, kom dan hierheen terug: je kaart wordt versleuteld doorgegeven.</span>
      </p>
      {hint && <p className="text-sm text-muted-foreground">{hint}</p>}
      {failed && <p role="alert" className="text-sm text-destructive">{failed}</p>}
      <Button type="button" variant="ghost" onClick={onCancel}><X /> Stoppen</Button>
    </div>
  );
}
