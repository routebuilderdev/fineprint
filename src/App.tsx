import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SAMPLE_LETTERS } from "./lib/demoData";
import { lowConfidenceFields, mergeSecondOpinion, scoreRuns } from "./lib/agreement";
import { buildEscalationPayload, redact } from "./lib/redact";
import {
  cloudEnabled,
  escalate,
  providerLabel,
  reReadField,
  resetMockSequence,
  sampleK,
  warmUpOnDevice,
} from "./lib/hybrid";
import { quoteIsGrounded } from "./lib/grounding";
import { checkItem } from "./lib/evidence";
import type { Extraction, FieldKey, FieldScore, ScoredExtraction } from "./types";

/** List items are clustered by meaning before scoring, so agreement only drops when the
 *  samples differ in *content*, not in wording. That makes "not unanimous" the honest
 *  rule: any disagreement is worth a second read. Tuned on real model output at k=3 and
 *  k=5 (scripts/tune-eval.mjs); 0.70 missed a real error at 0.78 agreement. */
const AGREEMENT_THRESHOLD = 0.99;
const QUEUE_KEY = "fineprint.escalationQueue";

type DeviceState = "unknown" | "available" | "downloading" | "unavailable";

function toExtraction(fields: FieldScore[]): Extraction {
  const map = new Map(fields.map((f) => [f.key, f.value]));
  return {
    documentType: (map.get("documentType") as string | null) ?? "other",
    deadline: (map.get("deadline") as string | null) ?? null,
    actions: (map.get("actions") as string[] | null) ?? [],
    references: (map.get("references") as string[] | null) ?? [],
  };
}

/** Replace one field, keeping the rest: what a grounded re-read is allowed to change. */
function withField(extraction: Extraction, key: FieldKey, value: string | string[]): Extraction {
  const out = { ...extraction };
  if (key === "actions") out.actions = value as string[];
  else if (key === "references") out.references = value as string[];
  else if (key === "documentType") out.documentType = (value as string).trim() || "other";
  else out.deadline = (value as string).trim() || null;
  return out;
}

function badgeClass(agreement: number): string {
  if (agreement >= 0.999) return "chip chip--ok";
  if (agreement >= AGREEMENT_THRESHOLD) return "chip chip--mid";
  return "chip chip--low";
}

function labelFor(key: FieldKey): string {
  return {
    documentType: "What this is",
    deadline: "Deadline",
    actions: "What they want from you",
    references: "Quote these",
  }[key];
}

export default function App() {
  const [letterText, setLetterText] = useState("");
  const [imageDataUrl, setImageDataUrl] = useState<string | null>(null);
  const [imageName, setImageName] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");
  const [scored, setScored] = useState<ScoredExtraction | null>(null);
  const [display, setDisplay] = useState<Extraction | null>(null);
  const [overridden, setOverridden] = useState<FieldKey[]>([]);
  const [receipt, setReceipt] = useState<{
    chars: number;
    removed: string[];
    preview: string;
    queued: boolean;
    settled?: { field: FieldKey; quote: string }[];
  } | null>(null);
  const [rereadFields, setRereadFields] = useState<FieldKey[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [online, setOnline] = useState(navigator.onLine);
  const [device, setDevice] = useState<DeviceState>("unknown");
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, []);

  useEffect(() => {
    const lm = (globalThis as { LanguageModel?: { availability?: (o: unknown) => Promise<string> } })
      .LanguageModel;
    if (!lm?.availability) {
      setDevice("unavailable");
      return;
    }
    lm.availability({
      expectedInputs: [{ type: "text", languages: ["en"] }],
      expectedOutputs: [{ type: "text", languages: ["en"] }],
    })
      .then((state) => setDevice(state === "unavailable" ? "unavailable" : "available"))
      .catch(() => setDevice("unavailable"));
  }, []);

  // Replay a second read that was queued while offline.
  useEffect(() => {
    if (!online || !display || scored === null) return;
    const raw = localStorage.getItem(QUEUE_KEY);
    if (!raw) return;
    let entry: { payload: string; targets: FieldKey[]; chars: number; removed: string[] };
    try {
      entry = JSON.parse(raw);
    } catch {
      localStorage.removeItem(QUEUE_KEY);
      return;
    }
    localStorage.removeItem(QUEUE_KEY);
    void (async () => {
      setBusy(true);
      setProgress("sending the queued second read…");
      try {
        const run = await escalate(entry.payload);
        setDisplay(mergeSecondOpinion(display, run.extraction, entry.targets));
        setOverridden((prev) => [...new Set([...prev, ...entry.targets])]);
        setReceipt({
          chars: entry.chars,
          removed: entry.removed,
          preview: entry.payload,
          queued: false,
        });
      } catch (err) {
        setError(err instanceof Error ? err.message : "The queued second read failed.");
      } finally {
        setBusy(false);
        setProgress("");
      }
    })();
  }, [online, display, scored]);

  const fields = scored?.fields ?? [];
  const low = useMemo(
    () => (scored ? lowConfidenceFields(scored, AGREEMENT_THRESHOLD) : []),
    [scored],
  );
  const sourceLabel = useMemo(() => {
    const sources = new Set(scored?.runs.map((r) => r.source) ?? []);
    if (sources.has("MOCK")) return "demo data";
    if (sources.has("ON_DEVICE") && sources.has("IN_CLOUD")) return "mixed";
    if (sources.has("ON_DEVICE")) return "on-device";
    return "cloud";
  }, [scored]);

  const handleFile = useCallback((file: File | undefined) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      setImageDataUrl(typeof reader.result === "string" ? reader.result : null);
      setImageName(file.name);
      setScored(null);
      setDisplay(null);
      setReceipt(null);
      setOverridden([]);
      setRereadFields([]);
    };
    reader.readAsDataURL(file);
  }, []);

  const loadSample = useCallback((index: number) => {
    const sample = SAMPLE_LETTERS[index];
    setLetterText(sample.text);
    setImageDataUrl(null);
    setImageName(null);
    setScored(null);
    setDisplay(null);
    setReceipt(null);
    setOverridden([]);
    setRereadFields([]);
    setError(null);
  }, []);

  const analyze = useCallback(async () => {
    if (!letterText.trim() && !imageDataUrl) {
      setError("Add a letter first — paste text, pick a photo, or load a sample.");
      return;
    }
    setError(null);
    setBusy(true);
    setReceipt(null);
    setOverridden([]);
    setRereadFields([]);
    setProgress("preparing on-device model…");
    try {
      resetMockSequence();
      // Inside the click handler on purpose: Chrome requires user activation.
      await warmUpOnDevice((p) => setProgress(`downloading model ${Math.round(p * 100)}%`));
      const runs = await sampleK({ text: letterText, imageDataUrl: imageDataUrl ?? undefined }, 3, (run, i) =>
        setProgress(`sample ${i + 1}/3 · ${run.source.toLowerCase().replace("_", "-")} · ${run.latencyMs} ms`),
      );
      const result = scoreRuns(runs);
      setScored(result);
      setDisplay(toExtraction(result.fields));
      setProgress("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong reading the letter.");
      setProgress("");
    } finally {
      setBusy(false);
    }
  }, [imageDataUrl, letterText]);

  const secondOpinion = useCallback(async () => {
    if (!scored || !display) return;
    const targets = low.length ? low.map((f) => f.key) : ["deadline" as FieldKey];
    // Verification aid only (?forceCloud=1): skip the on-device re-read so the cloud leg
    // can be exercised on demand. Never set in a normal visit.
    const forceCloud = new URLSearchParams(window.location.search).get("forceCloud") === "1";
    setError(null);
    setBusy(true);

    // Cheapest, most private option first: one focused on-device pass per uncertain
    // field. It is only accepted when the model quotes the letter word for word, so a
    // grounded re-read never has to leave the machine.
    let next = display;
    const settled: { field: FieldKey; quote: string }[] = [];
    const remaining: FieldKey[] = [];
    for (const key of targets) {
      if (forceCloud) {
        remaining.push(key);
        continue;
      }
      setProgress(`re-reading ${labelFor(key).toLowerCase()} on this device…`);
      try {
        const reread = await reReadField(
          { text: letterText, imageDataUrl: imageDataUrl ?? undefined },
          key,
        );
        if (quoteIsGrounded(letterText, reread.quote)) {
          next = withField(next, key, reread.value);
          settled.push({ field: key, quote: reread.quote });
        } else {
          remaining.push(key);
        }
      } catch {
        remaining.push(key);
      }
    }
    setDisplay(next);
    if (settled.length) {
      setRereadFields((prev) => [...new Set([...prev, ...settled.map((s) => s.field)])]);
    }

    if (!remaining.length) {
      setReceipt({
        chars: 0,
        removed: [],
        preview:
          "Nothing was sent. Every uncertain field was settled on this device, each backed by a sentence copied out of the letter.",
        queued: false,
        settled,
      });
      setBusy(false);
      setProgress("");
      return;
    }

    const redactedLetter = redact(letterText, []);
    const payload = buildEscalationPayload(redactedLetter.text, remaining);

    if (!online) {
      localStorage.setItem(
        QUEUE_KEY,
        JSON.stringify({ payload, targets: remaining, chars: redactedLetter.charsOut, removed: redactedLetter.removed }),
      );
      setReceipt({
        chars: redactedLetter.charsOut,
        removed: redactedLetter.removed,
        preview: redactedLetter.text,
        queued: true,
        settled,
      });
      setBusy(false);
      setProgress("");
      return;
    }

    setProgress("asking the cloud for a second read…");
    try {
      const run = await escalate(payload);
      setDisplay(mergeSecondOpinion(next, run.extraction, remaining));
      setOverridden((prev) => [...new Set([...prev, ...remaining])]);
      setReceipt({
        chars: redactedLetter.charsOut,
        removed: redactedLetter.removed,
        preview: redactedLetter.text,
        queued: false,
        settled,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "The cloud read failed. The on-device result stands.");
    } finally {
      setBusy(false);
      setProgress("");
    }
  }, [display, imageDataUrl, letterText, low, online, scored]);

  const exportRun = useCallback(() => {
    if (!scored) return;
    const payload = {
      capturedAt: new Date().toISOString(),
      threshold: AGREEMENT_THRESHOLD,
      letterText,
      imageName,
      overall: scored.overall,
      fields: scored.fields,
      runs: scored.runs,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `fineprint-run-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, [imageName, letterText, scored]);

  const reset = useCallback(() => {
    setScored(null);
    setDisplay(null);
    setReceipt(null);
    setOverridden([]);
    setRereadFields([]);
    setProgress("");
    setError(null);
  }, []);

  const deviceCopy =
    device === "unavailable"
      ? "Chrome on-device model not detected"
      : device === "downloading"
        ? "On-device model downloading"
        : device === "available"
          ? "Chrome on-device model detected"
          : "Checking on-device model…";

  return (
    <div className="app">
      <header className="masthead">
        <div>
          <h1>Fine Print</h1>
          <p className="tagline">Understand the letter before you sign it — privately.</p>
        </div>
        <div className="status">
          <span className={`dot ${online ? "dot--on" : "dot--off"}`} />
          {online ? "Online" : "Offline — on-device only"}
          <span className="sep" />
          {deviceCopy}
          <span className="sep" />
          {providerLabel()}
        </div>
      </header>

      <main className="grid">
        <section className="panel">
          <h2>1. Add the letter</h2>
          <div className="row">
            <button className="btn btn--ghost" onClick={() => loadSample(0)} type="button">
              Sample: insurance denial
            </button>
            <button className="btn btn--ghost" onClick={() => loadSample(1)} type="button">
              Sample: lease addendum
            </button>
          </div>

          <label className="drop" htmlFor="file">
            <input
              id="file"
              ref={fileRef}
              type="file"
              accept="image/png,image/jpeg"
              onChange={(e) => handleFile(e.target.files?.[0])}
            />
            <span>{imageName ? `Photo: ${imageName}` : "Take or choose a photo (PNG/JPEG)"}</span>
          </label>

          <label className="field">
            <span>Or paste the text</span>
            <textarea
              value={letterText}
              onChange={(e) => setLetterText(e.target.value)}
              rows={6}
              placeholder="Paste the letter body here…"
            />
          </label>

          <div className="row">
            <button className="btn btn--primary" onClick={analyze} disabled={busy} type="button">
              {busy ? "Reading…" : "Read it"}
            </button>
            {scored && (
              <button className="btn btn--ghost" onClick={exportRun} type="button">
                Export run JSON
              </button>
            )}
            {(scored || receipt) && (
              <button className="btn btn--ghost" onClick={reset} type="button">
                Clear
              </button>
            )}
          </div>
          {progress && <p className="muted">{progress}</p>}
          {error && <p className="error">{error}</p>}
        </section>

        <section className="panel panel--result">
          <h2>2. What it says</h2>
          {!display && <p className="muted">Nothing read yet. The checklist appears here.</p>}

          {display && (
            <>
              <p className="headline">
                {display.deadline ? deadlineHeadline(display.deadline) : "No deadline found"}
              </p>

              <ul className="fields">
                {fields.map((field) => (
                  <li key={field.key}>
                    <div className="field-head">
                      <span className="field-label">{labelFor(field.key)}</span>
                      <span className={badgeClass(field.agreement)}>
                        {overridden.includes(field.key)
                          ? "cloud second read"
                          : rereadFields.includes(field.key)
                            ? "on-device re-read · quoted"
                            : field.agreement < AGREEMENT_THRESHOLD
                              ? "needs second opinion"
                              : `100% · ${sourceLabel}`}
                      </span>
                    </div>
                    <Value field={field} letterText={letterText} />
                  </li>
                ))}
              </ul>

              <p className="muted small">
                Overall agreement {Math.round((scored?.overall ?? 0) * 100)}% across{" "}
                {scored?.runs.length ?? 0} on-device samples.
              </p>

              {low.length > 0 && (
                <button className="btn btn--primary" onClick={secondOpinion} disabled={busy} type="button">
                  {online ? `Send ${low.length} uncertain field${low.length > 1 ? "s" : ""} for a second read` : "Queue second read for when you're back online"}
                </button>
              )}
            </>
          )}
        </section>

        {receipt && (
          <section className="panel panel--receipt">
            <h2>3. What left your device</h2>
            <p className="receipt-line">
              {receipt.chars > 0 ? (
                <>
                  <strong>{receipt.chars}</strong> characters sent to the cloud.
                  {receipt.removed.length > 0
                    ? ` Removed: ${receipt.removed.join(", ")}.`
                    : " Nothing else was removed."}
                </>
              ) : (
                <>
                  <strong>Nothing</strong> was sent to the cloud.
                </>
              )}
            </p>
            {receipt.settled && receipt.settled.length > 0 && (
              <div className="settled">
                <p className="muted small">
                  Settled on this device by re-reading one field and checking the quote:
                </p>
                <ul className="value-list">
                  {receipt.settled.map((s) => (
                    <li key={s.field}>
                      <strong>{labelFor(s.field)}</strong>: “{s.quote}”
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {receipt.queued && <p className="muted">Queued locally — it will send when you reconnect.</p>}
            <details>
              <summary>Show the exact payload</summary>
              <pre className="payload">{receipt.preview}</pre>
            </details>
          </section>
        )}
      </main>

      <footer className="foot">
        <span>
          On-device reading via Chrome&apos;s Prompt API
          {cloudEnabled() ? " through Firebase AI Logic" : " (direct, no SDK)"} · cloud fallback{" "}
          {cloudEnabled() ? "enabled" : "disabled — no Firebase config"}
        </span>
      </footer>
    </div>
  );
}

function deadlineHeadline(deadline: string): string {
  const due = new Date(`${deadline}T00:00:00`);
  if (Number.isNaN(due.getTime())) return `Deadline: ${deadline}`;
  const days = Math.ceil((due.getTime() - Date.now()) / 86_400_000);
  if (days < 0) return `Deadline passed (${deadline})`;
  return `${days} day${days === 1 ? "" : "s"} left — ${due.toLocaleDateString(undefined, {
    day: "numeric",
    month: "long",
    year: "numeric",
  })}`;
}

function Value({ field, letterText }: { field: FieldScore; letterText: string }) {
  if (field.key === "actions" || field.key === "references") {
    const items = (field.value as string[] | null) ?? [];
    if (!items.length) return <p className="value value--empty">None found.</p>;
    return (
      <ul className="value-list">
        {items.map((item) => {
          const evidence = checkItem(letterText, item);
          return (
            <li key={item}>
              {item}
              {!evidence.supported && (
                <span
                  className="item-flag"
                  title={`No sentence in the letter contains this. Missing words: ${evidence.missing.join(", ")}. Closest sentence: "${evidence.closest?.sentence ?? ""}"`}
                >
                  no match in letter
                </span>
              )}
            </li>
          );
        })}
      </ul>
    );
  }
  const text = (field.value as string | null) ?? "";
  return <p className="value">{text || "Not stated."}</p>;
}
