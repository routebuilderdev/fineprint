/**
 * Spike harness. Open /spike.html in Chrome 139+ (with the multimodal flag enabled)
 * and it reports what the on-device model can actually do on this machine:
 * availability, schema-constrained JSON validity, image input, and k-sample timing.
 *
 * Results are exposed on window.__SPIKE_RESULT__ so scripts/spike.mjs can read them.
 */

const LETTER = `Northwind Health — Claims Department
PO Box 4412, Springfield

RE: Claim 88-4419-02    Policy 4021-7788-1
Date of service: 2026-10-02

We are unable to approve the claim referenced above. The service was billed as
out-of-network. You may request an internal review within 60 days. Appeals must be
received by 2027-01-19. Send a written statement and the itemised bill to the address
above, or fax +1 (555) 010-4477. Please quote claim 88-4419-02 on every page.`;

const SCHEMA = {
  type: "object",
  properties: {
    documentType: { type: "string", enum: ["denial", "lease", "benefit", "bill", "fine", "tax", "other"] },
    deadline: { type: "string", description: "YYYY-MM-DD, empty string if none." },
    actions: { type: "array", items: { type: "string" } },
    references: { type: "array", items: { type: "string" } },
  },
  required: ["documentType", "deadline", "actions", "references"],
};

const PROMPT = `Read this official letter. Return the JSON fields only.
deadline must be YYYY-MM-DD or an empty string. Max 3 actions, max 4 references.

--- LETTER ---
${LETTER}`;

type AnyLM = {
  availability: (o?: unknown) => Promise<string>;
  create: (o?: unknown) => Promise<AnySession>;
  params?: () => Promise<unknown>;
};
type AnySession = {
  prompt: (input: unknown, o?: unknown) => Promise<string>;
  destroy?: () => void;
  contextWindow?: number;
};

const out: Record<string, unknown> = {
  ranAt: new Date().toISOString(),
  userAgent: navigator.userAgent,
  hasLanguageModel: false,
};

/** Paint progress into the page without publishing the result marker. */
function render(): void {
  const el = document.getElementById("out");
  if (el) el.textContent = JSON.stringify(out, null, 2);
}

/** Publish the final result. The runner waits on this marker, so it must only fire
 *  once the run is actually finished — a partial publish closes the browser mid-download. */
function report(): void {
  render();
  (window as unknown as { __SPIKE_RESULT__: unknown }).__SPIKE_RESULT__ = out;
  document.title = "spike done";
}

async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: number | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = window.setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    window.clearTimeout(timer);
  }
}

function checkSchema(raw: string): { validJson: boolean; keysOk: boolean; sample: unknown } {
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    const keysOk =
      typeof value.documentType === "string" &&
      typeof value.deadline === "string" &&
      Array.isArray(value.actions) &&
      Array.isArray(value.references);
    return { validJson: true, keysOk, sample: value };
  } catch {
    return { validJson: false, keysOk: false, sample: raw.slice(0, 200) };
  }
}

async function letterImage(): Promise<Blob> {
  const canvas = document.createElement("canvas");
  canvas.width = 1000;
  canvas.height = 700;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no 2d context");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#111111";
  ctx.font = "22px Georgia, serif";
  const lines = LETTER.split("\n");
  lines.forEach((line, i) => ctx.fillText(line, 40, 60 + i * 34));
  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("toBlob failed"))), "image/png");
  });
}

async function main(): Promise<void> {
  const lm = (globalThis as { LanguageModel?: AnyLM }).LanguageModel;
  if (!lm) {
    out.error = "LanguageModel global missing (Chrome too old, or Prompt API unavailable)";
    report();
    return;
  }
  out.hasLanguageModel = true;

  const textOpts = {
    expectedInputs: [{ type: "text", languages: ["en"] }],
    expectedOutputs: [{ type: "text", languages: ["en"] }],
  };
  const imageOpts = {
    expectedInputs: [{ type: "text", languages: ["en"] }, { type: "image" }],
    expectedOutputs: [{ type: "text", languages: ["en"] }],
  };

  out.availabilityText = await lm.availability(textOpts).catch((e: unknown) => `error: ${String(e)}`);
  out.availabilityImage = await lm.availability(imageOpts).catch((e: unknown) => `error: ${String(e)}`);

  const textState = out.availabilityText as string;
  if (textState === "unavailable") {
    report();
    return;
  }

  // Creating a session can trigger a multi-minute model download on first run.
  const waitForDownload = new URLSearchParams(location.search).get("download") === "1";
  const createStart = performance.now();
  let session: AnySession;
  try {
    session = await withTimeout(
      lm.create({
        ...textOpts,
        monitor(m: EventTarget) {
          m.addEventListener("downloadprogress", (e) => {
            const loaded = (e as ProgressEvent).loaded ?? 0;
            (out as Record<string, unknown>).downloadProgress = Math.round(loaded * 10000) / 100;
            render();
          });
        },
      }),
      waitForDownload ? 1_200_000 : 60_000,
      "LanguageModel.create",
    );
  } catch (err) {
    out.sessionError = String(err);
    out.hint = "Model not ready. Re-run with /spike.html?download=1 and wait for the download.";
    report();
    return;
  }
  out.sessionCreateMs = Math.round(performance.now() - createStart);
  out.contextWindow = session.contextWindow ?? null;

  // 1. Schema-constrained text generation
  try {
    const t0 = performance.now();
    const raw = await withTimeout(
      session.prompt(PROMPT, { responseConstraint: SCHEMA }),
      180_000,
      "schema prompt",
    );
    out.schemaMs = Math.round(performance.now() - t0);
    Object.assign(out, { textResult: checkSchema(raw) });
  } catch (err) {
    out.schemaError = String(err);
  }

  // 2. Image + schema. Image input needs its own session created with image in
  // expectedInputs; reusing the text session throws NotSupportedError.
  if (out.availabilityImage === "available" || out.availabilityImage === "downloadable") {
    try {
      const imageSession = await withTimeout(
        lm.create({ ...imageOpts, monitor: () => {} }),
        180_000,
        "image session create",
      );
      const blob = await letterImage();
      const t0 = performance.now();
      const raw = await withTimeout(
        imageSession.prompt(
          [
            {
              role: "user",
              content: [
                { type: "text", value: `${PROMPT}\n\nThe letter is in the image.` },
                { type: "image", value: blob },
              ],
            },
          ],
          { responseConstraint: SCHEMA },
        ),
        180_000,
        "image prompt",
      );
      out.imageMs = Math.round(performance.now() - t0);
      Object.assign(out, { imageResult: checkSchema(raw) });
      imageSession.destroy?.();
    } catch (err) {
      out.imageError = String(err);
    }
  } else {
    out.imageSkipped = `availability=${String(out.availabilityImage)}`;
  }

  // 3. k-sample timing and agreement on real model output
  try {
    const started = performance.now();
    const raws: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      raws.push(
        await withTimeout(session.prompt(PROMPT, { responseConstraint: SCHEMA }), 180_000, "k sample"),
      );
    }
    const total = Math.round(performance.now() - started);
    out.k3TotalMs = total;
    out.k3PerSampleMs = Math.round(total / 3);
    out.k3Results = raws.map((r) => checkSchema(r));
  } catch (err) {
    out.k3Error = String(err);
  }

  session.destroy?.();
  report();
}

main().catch((err: unknown) => {
  out.fatal = String(err);
  report();
});
