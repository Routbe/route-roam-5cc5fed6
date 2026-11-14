import { useEffect, useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Check, CreditCard, FileText, Fingerprint, KeyRound, Plus, RotateCcw, Server, ShieldCheck, Trash2 } from "lucide-react";
import { useAuth } from "@/hooks/useAuth";
import { useCryptoLifecycle } from "@/hooks/useCryptoLifecycle";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { requestStepUp, withStepUp } from "@/components/auth/StepUpDialog";
import { enclave, EnclaveError } from "@/lib/crypto-enclave/client";
import type { RecoveryCeremony } from "@/lib/crypto-enclave/recovery-mpc";
import { ceremonyMessage as message, takeInput, takeValue } from "@/components/recovery/ceremony-ui";
import { refreshSessionFreshness } from "@/lib/auth/step-up.functions";
import { addPasskey } from "@/lib/webauthn.functions";
import { deviceLabelFrom } from "@/lib/passkey-label";
import { ceremonyFromWire, ceremonyToWire, fromB64, toB64, wordCount, WIRE_THRESHOLD } from "@/lib/recovery/ceremony-wire";
import { verifyCardTapFn } from "@/lib/wallet/card-tap.functions";
import type { CardTapParams } from "@/lib/wallet/card-tap-url";
import { CardWait, FactorPicker, type FactorId } from "@/components/recovery/FactorPicker";
import {
  beginCeremonyRestore, deleteRecoveryCeremony, finishCeremonyRestore, getRecoveryCeremonyStatus, getRecoveryServerKey, saveRecoveryCeremony,
} from "@/lib/recovery/ceremony.functions";

type Status = Awaited<ReturnType<typeof getRecoveryCeremonyStatus>>;
type Step = "start" | "card" | "words" | "check" | "passkey" | "done";
const STEPS: { id: Exclude<Step, "done">; label: string }[] = [
  { id: "start", label: "Start" },
  { id: "card", label: "Kaart" },
  { id: "words", label: "Woorden" },
  { id: "check", label: "Controle" },
  { id: "passkey", label: "Toegangssleutel" },
];


/**
 * Herstelkluis 3 van 4: passkey + ROUT Card + 24 paper words + ROUT's own
 * piece; any 3 rebuild the Master Key. Every key operation runs in the crypto
 * enclave worker; the card secret only passes through this thread on its way
 * there (transferred, so this side's buffer is detached). The only words React state
 * ever holds are the paper words while they are on screen, dropped on
 * confirmation; typed words live only in uncontrolled inputs, are read once on
 * submit, handed to the worker and cleared from the field.
 */
export function RecoveryCeremonyPanel() {
  const { user } = useAuth();
  return user ? <RecoveryCeremonySession key={user.id} userId={user.id} /> : null;
}

function RecoveryCeremonySession({ userId }: { userId: string }) {
  const status = useServerFn(getRecoveryCeremonyStatus);
  const [state, setState] = useState<Status | null>(null);
  const [deviceKey, setDeviceKey] = useState<string | null | undefined>(undefined);
  const [mode, setMode] = useState<"idle" | "setup" | "restore">("idle");
  const [error, setError] = useState<string | null>(null);
  const refresh = () => {
    setError(null);
    void status().then(setState).catch(() => setError("Je herstelkluis is nu niet bereikbaar."));
    void enclave.deviceKey.status(userId).then((k) => setDeviceKey(k?.keyId ?? null)).catch(() => setDeviceKey(null));
  };
  useEffect(refresh, [userId]);
  const done = () => { setMode("idle"); refresh(); };

  return (
    <section id="herstelkluis" aria-labelledby="herstelkluis-title" className="space-y-4 rounded-2xl border border-border bg-card p-4 sm:p-5">
      <div className="space-y-1">
        <h2 id="herstelkluis-title" className="flex items-center gap-2 text-lg font-medium"><KeyRound className="size-4" /> Herstelkluis · 3 van 4</h2>
        <p className="text-sm text-muted-foreground">
          Je hoofdsleutel wordt in 4 stukken verdeeld. Met 3 ervan krijg je hem terug. Twee stukken samen openen niets, ook niet voor ROUT met een gestolen kaart.
        </p>
      </div>
      <ul className="grid gap-2 text-sm sm:grid-cols-2">
        <li className="flex items-center gap-2 rounded-xl border border-border bg-background p-3"><Fingerprint className="size-4 shrink-0" /> Je toegangssleutel</li>
        <li className="flex items-center gap-2 rounded-xl border border-border bg-background p-3"><CreditCard className="size-4 shrink-0" /> Je ROUT Card</li>
        <li className="flex items-center gap-2 rounded-xl border border-border bg-background p-3"><FileText className="size-4 shrink-0" /> 24 woorden op papier</li>
        <li className="flex items-center gap-2 rounded-xl border border-border bg-background p-3"><Server className="size-4 shrink-0" /> Een stuk bij ROUT</li>
      </ul>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      {mode === "idle" && state && (
        <Overview state={state} deviceKey={deviceKey} onSetup={() => setMode("setup")} onRestore={() => setMode("restore")} onChanged={refresh} />
      )}
      {mode === "setup" && <SetupWizard userId={userId} hasDeviceKey={!!deviceKey} onDone={done} onCancel={() => setMode("idle")} />}
      {mode === "restore" && state?.ceremony && <RestoreFlow userId={userId} version={state.ceremony.version} onDone={done} onCancel={() => setMode("idle")} />}
    </section>
  );
}

function Overview({ state, deviceKey, onSetup, onRestore, onChanged }: {
  state: Status; deviceKey: string | null | undefined; onSetup: () => void; onRestore: () => void; onChanged: () => void;
}) {
  const remove = useServerFn(deleteRecoveryCeremony);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const pending = !state.canSetUp && (
    <p className="text-sm text-muted-foreground">De herstelkluis met 3 van 4 stukken wordt binnenkort geactiveerd. Tot dan kun je hem nog niet instellen; ROUT maakt geen zwakkere kluis.</p>
  );
  if (!state.ceremony) {
    return (
      <div className="space-y-3">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm">Nog geen herstelkluis. Het instellen duurt ongeveer drie minuten. Houd pen en papier en je ROUT Card klaar, en doe het op je telefoon.</p>
          <Button onClick={onSetup} disabled={!state.canSetUp} className="w-full sm:w-auto"><KeyRound /> Herstelkluis instellen</Button>
        </div>
        {pending}
      </div>
    );
  }
  const need = WIRE_THRESHOLD[state.ceremony.version];
  const onThisDevice = deviceKey === state.ceremony.keyId;
  const since = new Date(state.ceremony.createdAt).toLocaleDateString("nl-BE", { dateStyle: "long" });
  return (
    <div className="space-y-3">
      <p className="flex items-start gap-2 rounded-xl border border-border bg-background p-3 text-sm">
        <ShieldCheck className="mt-0.5 size-4 shrink-0" />
        <span>Actief sinds {since}. {onThisDevice ? "Dit toestel gebruikt deze hoofdsleutel." : `Je hoofdsleutel staat nog niet op dit toestel. Zet hem terug met ${need} van je stukken.`}</span>
      </p>
      {state.ceremony.version !== 3 && (
        <p className="text-sm text-muted-foreground">Deze kluis is verouderd: hij opent al met 2 stukken. Stel hem opnieuw in als 3 van 4, met je ROUT Card.</p>
      )}
      {pending}
      {!state.ceremony.canSignIn && (
        <p className="text-sm text-muted-foreground">Deze kluis is gemaakt vóór inloggen met herstel bestond. Stel hem opnieuw in, dan kun je er ook mee inloggen als je buitengesloten bent.</p>
      )}
      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
        {!onThisDevice && <Button onClick={onRestore}><RotateCcw /> Hoofdsleutel terugzetten</Button>}
        <Button variant="soft" onClick={onSetup} disabled={!state.canSetUp}><KeyRound /> Opnieuw instellen</Button>
        {!confirm ? (
          <Button variant="ghost" onClick={() => setConfirm(true)}><Trash2 /> Verwijderen</Button>
        ) : (
          <Button
            variant="destructive"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await withStepUp(() => remove());
                toast.success("Herstelkluis verwijderd. Je papieren woorden werken niet meer.");
                onChanged();
              } catch (e) { toast.error(message(e)); } finally { setBusy(false); setConfirm(false); }
            }}
          >
            <Trash2 /> Ja, verwijder mijn herstelkluis
          </Button>
        )}
      </div>
    </div>
  );
}

function Stepper({ step }: { step: Step }) {
  const at = STEPS.findIndex((s) => s.id === step);
  return (
    <ol className="grid grid-cols-5 gap-2" aria-label="Stappen">
      {STEPS.map((s, i) => {
        const state = step === "done" || i < at ? "done" : i === at ? "current" : "todo";
        return (
          <li key={s.id} aria-current={state === "current" ? "step" : undefined} className="min-w-0 space-y-1">
            <div className={`h-1 rounded-full ${state === "todo" ? "bg-muted" : "bg-primary"}`} />
            <p className={`flex min-w-0 items-center gap-1 text-[11px] sm:text-xs ${state === "current" ? "font-medium text-foreground" : "text-muted-foreground"}`}>
              {state === "done" && <Check className="size-3 shrink-0" />}<span className="truncate">{s.label}</span>
            </p>
          </li>
        );
      })}
    </ol>
  );
}

function SetupWizard({ userId, hasDeviceKey, onDone, onCancel }: { userId: string; hasDeviceKey: boolean; onDone: () => void; onCancel: () => void }) {
  const { capture } = useCryptoLifecycle();
  const serverKey = useServerFn(getRecoveryServerKey);
  const save = useServerFn(saveRecoveryCeremony);
  const verifyTap = useServerFn(verifyCardTapFn);
  const confirmOwnTap = async (tap: CardTapParams) => (await verifyTap({ data: { ...tap, purpose: "recovery_factor" } })).status === "card_confirmed";
  const [step, setStep] = useState<Step>("start");
  // Typed words never enter React state: uncontrolled fields, read once, then cleared.
  const masterField = useRef<HTMLTextAreaElement>(null);
  const [masterCount, setMasterCount] = useState(0);
  // The only key material React ever holds: the paper words while they are on screen.
  const [words, setWords] = useState<string[] | null>(null);
  const [written, setWritten] = useState(false);
  const [positions, setPositions] = useState<number[]>([]);
  const answerFields = useRef<Record<number, HTMLInputElement | null>>({});
  const [filled, setFilled] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needsPasskey, setNeedsPasskey] = useState(false);
  const handle = useRef<string | null>(null);
  const sealedRef = useRef<{ ceremony: RecoveryCeremony; keyId: string; loginKey: Uint8Array; credential: string; saved: boolean } | null>(null);

  useEffect(() => () => {
    if (handle.current) void enclave.ceremony.discard(handle.current).catch(() => undefined);
    handle.current = null;
  }, []);

  const cancel = () => {
    sealedRef.current = null;
    if (handle.current) void enclave.ceremony.discard(handle.current).catch(() => undefined);
    handle.current = null;
    setWords(null);
    onCancel();
  };

  /** Called with the card secret the moment the card arrives; the secret is transferred to the worker (or wiped). */
  async function begin(cardSecret: Uint8Array) {
    const scope = capture();
    setBusy(true); setError(null);
    try {
      const { publicKey } = await serverKey();
      const typed = takeValue(masterField);
      setMasterCount(0);
      const r = await enclave.ceremony.begin(userId, fromB64(publicKey), cardSecret, hasDeviceKey ? typed : undefined);
      scope.assertCurrent();
      handle.current = r.handle;
      setPositions(r.checkPositions);
      setWords(r.paperWords.split(" "));
      setStep("words");
    } catch (e) {
      if (scope.isUiCurrent()) { setStep("start"); setError(message(e)); }
    } finally {
      cardSecret.fill(0); // no-op once transferred; wipes it if the worker was never reached
      if (scope.isUiCurrent()) setBusy(false);
    }
  }

  function wordsWritten() {
    setWords(null); // destroyed now: from here on only the worker holds hashes of three of them
    setWritten(false);
    setStep("check");
  }

  async function check() {
    if (!handle.current) return;
    const scope = capture();
    setBusy(true); setError(null);
    try {
      const typed = positions.map((position) => ({ position, word: takeInput(answerFields.current[position]) }));
      setFilled(0);
      const r = await enclave.ceremony.checkWords(handle.current, typed);
      scope.assertCurrent();
      if (r.ok) setStep("passkey");
      else setError("Niet alle woorden kloppen. Kijk op je papier en probeer opnieuw.");
    } catch (e) {
      if (!scope.isUiCurrent()) return;
      if (e instanceof EnclaveError && e.code === "unknown_handle") {
        handle.current = null;
        setStep("start");
        setError("Te vaak fout. Om veiligheidsredenen begin je opnieuw met nieuwe woorden. Gooi het vorige papier weg.");
      } else setError(message(e));
    } finally { if (scope.isUiCurrent()) setBusy(false); }
  }

  async function sealWithPasskey() {
    if (!handle.current) return;
    const h = handle.current;
    const scope = capture();
    setBusy(true); setError(null); setNeedsPasskey(false);
    try {
      // The worker seals the device share exactly once. A retry after a failed
      // save or confirmation reuses that sealed result (ciphertext and public
      // keys only) instead of asking the worker to seal again, which it refuses.
      if (!sealedRef.current) {
        const { withPasskeyPrf } = await import("@/lib/recovery/passkey-prf");
        sealedRef.current = await withPasskeyPrf("ceremony", async (output, credential) => ({ credential, ...(await enclave.ceremony.sealDevice(h, output)), saved: false }));
        scope.assertCurrent();
      }
      const sealed = sealedRef.current;
      if (!sealed.saved) {
        const r = await withStepUp(() => save({ data: { ceremony: ceremonyToWire(sealed.ceremony, sealed.keyId), deviceCredential: sealed.credential, loginKey: toB64(sealed.loginKey) } }));
        if (!r.ok) {
          throw new Error(r.error === "schema_pending"
            ? "De herstelkluis met 3 van 4 stukken is nog niet geactiveerd. Er is niets opgeslagen."
            : "ROUT kon zijn stuk niet controleren. Begin opnieuw.");
        }
        sealed.saved = true;
      }
      await enclave.ceremony.commit(h, userId);
      handle.current = null;
      sealedRef.current = null;
      scope.assertCurrent();
      setStep("done");
      toast.success("Herstelkluis actief.");
    } catch (e) {
      if (!scope.isUiCurrent()) return;
      if (e instanceof EnclaveError && e.code === "unknown_handle") {
        handle.current = null;
        sealedRef.current = null;
        setStep("start");
        setError("Deze stap is verlopen. Begin opnieuw met nieuwe woorden en gooi het vorige papier weg.");
        return;
      }
      const prf = e instanceof Error && (e.message === "prf_unsupported" || /NotAllowed/i.test(e.name));
      setNeedsPasskey(prf);
      setError(message(e));
    } finally { if (scope.isUiCurrent()) setBusy(false); }
  }

  async function registerPasskey() {
    setBusy(true); setError(null);
    try {
      const label = deviceLabelFrom(navigator.userAgent);
      let r = await addPasskey(label);
      if (!r.ok && (r.code === "SESSION_NOT_FRESH" || /not fresh/i.test(r.reason ?? ""))) {
        if (!(await requestStepUp())) return;
        await refreshSessionFreshness();
        r = await addPasskey(label);
      }
      if (!r.ok) { setError(r.reason ?? "De toegangssleutel kon niet worden toegevoegd."); return; }
      toast.success("Toegangssleutel toegevoegd. Bevestig hem nu voor je herstelkluis.");
      setNeedsPasskey(false);
    } catch (e) { setError(message(e)); } finally { setBusy(false); }
  }

  return (
    <div className="space-y-4">
      <Stepper step={step} />

      {(step === "start" || step === "card") && (
        <div className="space-y-3">
          {hasDeviceKey ? (
            <>
              <p className="text-sm">Typ je huidige 24 herstelwoorden. Zo weten we zeker dat de herstelkluis je echte hoofdsleutel beschermt. Ze blijven in de beveiligde rekenmodule op dit toestel en worden nooit verstuurd.</p>
              <label htmlFor="ceremony-master-words" className="sr-only">Je huidige 24 herstelwoorden</label>
              <Textarea id="ceremony-master-words" ref={masterField} defaultValue="" onChange={(e) => setMasterCount(wordCount(e.target.value))} rows={3} autoComplete="off" autoCorrect="off" spellCheck={false} className="font-mono" placeholder="woord1 woord2 woord3 …" />
            </>
          ) : (
            <p className="text-sm">Dit toestel heeft nog geen hoofdsleutel. We maken er nu een in de beveiligde rekenmodule en verdelen hem meteen in 4 stukken. Je ziet de hoofdsleutel zelf nooit.</p>
          )}
          <p className="text-xs text-muted-foreground">Een vorige herstelkluis werkt niet meer zodra deze klaar is.</p>
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          {step === "start" ? (
            <div className="flex flex-col gap-2 sm:flex-row">
              <Button disabled={busy || (hasDeviceKey && masterCount !== 24)} onClick={() => { setError(null); setStep("card"); }}><KeyRound /> Beginnen</Button>
              <Button variant="ghost" onClick={cancel}>Annuleren</Button>
            </div>
          ) : busy ? (
            <p role="status" className="text-sm text-muted-foreground">Kaart ontvangen. Je kluis wordt voorbereid…</p>
          ) : (
            <CardWait purpose="setup" confirmOwnTap={confirmOwnTap} onSecret={(secret) => void begin(secret)} onCancel={() => setStep("start")} />
          )}
        </div>
      )}

      {step === "words" && words && (
        <div className="space-y-3">
          <p className="text-sm">Schrijf deze 24 woorden op papier, in deze volgorde. Bewaar het papier op een veilige plek. Geen foto of schermafbeelding.</p>
          <ol className="grid grid-cols-2 gap-2 rounded-xl border border-border bg-background p-3 font-mono text-sm sm:grid-cols-4" aria-label="Je 24 papieren herstelwoorden">
            {words.map((w, i) => (
              <li key={i} className="flex gap-2"><span className="w-6 text-right text-muted-foreground">{i + 1}.</span><span>{w}</span></li>
            ))}
          </ol>
          <label className="flex items-start gap-2 text-sm">
            <Checkbox checked={written} onCheckedChange={(v) => setWritten(v === true)} className="mt-0.5" />
            <span>Ik heb de 24 woorden opgeschreven. Ze verdwijnen van het scherm zodra ik verder ga.</span>
          </label>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Button disabled={!written} onClick={wordsWritten}>Verder</Button>
            <Button variant="ghost" onClick={cancel}>Annuleren</Button>
          </div>
        </div>
      )}

      {step === "check" && (
        <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); void check(); }}>
          <p className="text-sm">Typ ter controle deze 3 woorden van je papier.</p>
          <div className="grid gap-3 sm:grid-cols-3">
            {positions.map((p) => (
              <div key={p} className="space-y-1">
                <label htmlFor={`ceremony-word-${p}`} className="text-sm font-medium">Woord {p}</label>
                <Input id={`ceremony-word-${p}`} ref={(el) => { answerFields.current[p] = el; }} defaultValue="" onChange={() => setFilled(positions.filter((q) => (answerFields.current[q]?.value ?? "").trim().length > 0).length)} autoComplete="off" autoCorrect="off" autoCapitalize="none" spellCheck={false} className="font-mono" />
              </div>
            ))}
          </div>
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          <div className="flex flex-col gap-2 sm:flex-row">
            <Button type="submit" disabled={busy || filled !== positions.length}><Check /> Controleren</Button>
            <Button type="button" variant="ghost" onClick={cancel}>Annuleren</Button>
          </div>
        </form>
      )}

      {step === "passkey" && (
        <div className="space-y-3">
          <p className="text-sm">Laatste stap: bevestig met je toegangssleutel. Die beschermt het vierde stuk. Daarna vraagt ROUT nog één keer je toegangssleutel om de kluis op te slaan.</p>
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
            <Button disabled={busy} onClick={() => void sealWithPasskey()}><Fingerprint /> Bevestigen met toegangssleutel</Button>
            {needsPasskey && <Button variant="soft" disabled={busy} onClick={() => void registerPasskey()}><Plus /> Toegangssleutel toevoegen</Button>}
            <Button variant="ghost" onClick={cancel}>Annuleren</Button>
          </div>
        </div>
      )}

      {step === "done" && (
        <div className="space-y-3">
          <p className="flex items-start gap-2 rounded-xl border border-border bg-background p-3 text-sm">
            <ShieldCheck className="mt-0.5 size-4 shrink-0" />
            <span>Je herstelkluis is actief. Verlies je dit toestel, dan zet je je hoofdsleutel terug met 3 van je 4 stukken: toegangssleutel, ROUT Card, papier en het stuk van ROUT.</span>
          </p>
          <Button onClick={onDone}>Klaar</Button>
        </div>
      )}
    </div>
  );
}

function RestoreFlow({ userId, version, onDone, onCancel }: { userId: string; version: 1 | 2 | 3; onDone: () => void; onCancel: () => void }) {
  const { capture } = useCryptoLifecycle();
  const begin = useServerFn(beginCeremonyRestore);
  const finish = useServerFn(finishCeremonyRestore);
  const paperField = useRef<HTMLTextAreaElement>(null);
  const [paperCount, setPaperCount] = useState(0);
  const [picked, setPicked] = useState<FactorId[]>([]);
  const [waitingCard, setWaitingCard] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // ROUT's piece is always used here; the member adds the rest.
  const need = WIRE_THRESHOLD[version];
  const available: FactorId[] = version === 1 ? ["rout", "passkey", "paper"] : ["rout", "passkey", "card", "paper"];
  const complete = picked.length + 1 === need;
  const usesPaper = picked.includes("paper");

  async function restore(cardSecret?: Uint8Array) {
    const scope = capture();
    setBusy(true); setError(null); setWaitingCard(false);
    let started = false;
    try {
      const r = await begin();
      if (!r.ok) {
        setError(r.error === "rate_limited" ? "Te veel herstelpogingen. Probeer het over een uur opnieuw." : "Er is nog geen herstelkluis.");
        return;
      }
      started = true;
      const ceremony = ceremonyFromWire(r.ceremony, userId);
      const serverShare = fromB64(r.serverShare);
      const paperWords = usesPaper ? takeValue(paperField) : undefined;
      setPaperCount(0);
      const input = { userId, ceremony, keyId: r.ceremony.keyId, serverShare, ...(paperWords ? { paperWords } : {}), ...(cardSecret ? { cardSecret } : {}) };
      if (picked.includes("passkey")) {
        const { withPasskeyPrf } = await import("@/lib/recovery/passkey-prf");
        await withPasskeyPrf("ceremony", (prf) => enclave.ceremony.restore({ ...input, prf }), r.deviceCredential);
      } else {
        await enclave.ceremony.restore(input);
      }
      scope.assertCurrent();
      await finish({ data: { outcome: "restored" } });
      toast.success("Je hoofdsleutel staat weer op dit toestel.");
      onDone();
    } catch (e) {
      if (started) void finish({ data: { outcome: "failed" } }).catch(() => undefined);
      if (scope.isUiCurrent()) setError(message(e));
    } finally {
      cardSecret?.fill(0); // no-op once transferred
      if (scope.isUiCurrent()) setBusy(false);
    }
  }

  const go = () => (picked.includes("card") ? setWaitingCard(true) : void restore());

  return (
    <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); if (complete) go(); }}>
      <p className="text-sm">ROUT geeft zijn stuk vrij. Kies welke {need - 1} stukken van jou je erbij gebruikt. Je krijgt van elke poging een e-mail.</p>
      <FactorPicker available={available} fixed={["rout"]} selected={picked} need={need} onChange={setPicked} disabled={busy || waitingCard} />
      {usesPaper && (
        <div className="space-y-2">
          <label htmlFor="ceremony-paper-words" className="text-sm font-medium">Je 24 papieren woorden</label>
          <Textarea id="ceremony-paper-words" ref={paperField} defaultValue="" onChange={(e) => setPaperCount(wordCount(e.target.value))} rows={3} autoComplete="off" autoCorrect="off" spellCheck={false} className="font-mono" placeholder="woord1 woord2 woord3 …" />
        </div>
      )}
      {waitingCard ? (
        <CardWait purpose="restore" onSecret={(secret) => void restore(secret)} onCancel={() => setWaitingCard(false)} />
      ) : (
        <div className="flex flex-col gap-2 sm:flex-row">
          <Button type="submit" disabled={busy || !complete || (usesPaper && paperCount !== 24)}><RotateCcw /> Terugzetten</Button>
          <Button type="button" variant="ghost" onClick={() => { takeValue(paperField); setPaperCount(0); onCancel(); }}>Annuleren</Button>
        </div>
      )}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    </form>
  );
}
