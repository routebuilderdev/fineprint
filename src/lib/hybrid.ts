import {
  EXTRACTION_PROMPT,
  LETTER_SCHEMA,
  REREAD_PROMPT,
  focusQuestion,
  focusedSchema,
  parseExtraction,
  parseFocused,
} from "./schema";
import { pickSample } from "./demoData";
import type { Extraction, ExtractionRun, FieldKey, Source } from "../types";

const env = import.meta.env;

export function isFirebaseConfigured(): boolean {
  return Boolean(
    env.VITE_FIREBASE_API_KEY && env.VITE_FIREBASE_PROJECT_ID && env.VITE_FIREBASE_APP_ID,
  );
}

/* ------------------------------------------------------------------ */
/* Direct Chrome Prompt API provider (no Firebase keys needed).         */
/* Firebase AI Logic is used when it is configured; otherwise the app   */
/* talks to the same on-device model through the browser API directly.  */
/* ------------------------------------------------------------------ */

type LocalSession = {
  prompt: (input: unknown, opts?: unknown) => Promise<string>;
  destroy?: () => void;
};

type LanguageModelApi = {
  availability?: (opts?: unknown) => Promise<string>;
  create: (opts?: unknown) => Promise<LocalSession>;
};

function localApi(): LanguageModelApi | undefined {
  return (globalThis as { LanguageModel?: LanguageModelApi }).LanguageModel;
}

/** True when this browser exposes the built-in model at all (Chrome desktop 139+). */
export function hasLocalModel(): boolean {
  return Boolean(localApi()?.create);
}

/** What the header should say the app is actually talking to. */
export function providerLabel(): string {
  if (isFirebaseConfigured()) return "Firebase AI Logic";
  if (hasLocalModel()) return "Chrome Prompt API (local)";
  return "demo mode";
}

export function cloudEnabled(): boolean {
  return isFirebaseConfigured();
}

function localOptions(withImage: boolean, onProgress?: (p: number) => void) {
  return {
    expectedInputs: withImage
      ? [{ type: "text", languages: ["en"] }, { type: "image" }]
      : [{ type: "text", languages: ["en"] }],
    expectedOutputs: [{ type: "text", languages: ["en"] }],
    monitor: (monitor: EventTarget) => {
      monitor.addEventListener?.("downloadprogress", (event: Event) => {
        const { loaded, total } = event as Event & { loaded: number; total: number };
        if (total > 0) onProgress?.(loaded / total);
      });
    },
  };
}

/**
 * A fresh session per sample on purpose: reusing one session lets each answer
 * condition on the previous one, which would make "samples disagree" a weaker
 * signal than it looks.
 */
async function withLocalSession<T>(
  withImage: boolean,
  fn: (session: LocalSession) => Promise<T>,
  onProgress?: (p: number) => void,
): Promise<T> {
  const api = localApi();
  if (!api) throw new Error("This browser has no built-in model (Chrome desktop 139+ required).");
  const session = await api.create(localOptions(withImage, onProgress));
  try {
    return await fn(session);
  } finally {
    session.destroy?.();
  }
}

async function dataUrlToBlob(dataUrl: string): Promise<Blob> {
  const response = await fetch(dataUrl);
  return response.blob();
}

function localPrompt(input: ExtractInput, prompt: string): string {
  const letter = input.text?.trim().slice(0, 8000);
  return letter ? `${prompt}\n\n--- LETTER ---\n${letter}` : prompt;
}

export function cloudModelName(): string {
  return env.VITE_AI_CLOUD_MODEL || "gemini-3.5-flash-lite";
}

export function escalationModelName(): string {
  return env.VITE_AI_ESCALATION_MODEL || "gemini-3.8-flash";
}

/**
 * Free-tier text models, strongest first, weakest last.
 *
 * Ordering is a quality decision until capacity forces a step down: the strong model is
 * the one worth its latency, and the lites exist to keep the demo alive when Google's
 * frontier capacity is saturated. All of these are listed as free of charge on the Gemini
 * Developer API pricing page, which is what makes a fallback safe to ship on a free tier.
 */
export const FREE_CLOUD_LADDER = [
  "gemini-4-hydrogen",
  "gemini-3.8-flash",
  "gemini-3.6-flash",
  "gemini-3.5-flash-lite",
  "gemini-3.1-flash-lite",
];

/** Ordered rungs: an explicit env list first, then the configured model, then the rest. */
export function escalationLadder(): string[] {
  const configured = (env.VITE_AI_ESCALATION_LADDER || "")
    .split(",")
    .map((s: string) => s.trim())
    .filter(Boolean);
  return [...new Set([...configured, escalationModelName(), ...FREE_CLOUD_LADDER])];
}

export interface ExtractInput {
  /** PNG/JPEG data URL, optionally provided. */
  imageDataUrl?: string;
  /** Raw letter text, when the user pasted it or OCR is available. */
  text?: string;
}

interface Parts {
  text?: string;
  inlineData?: { mimeType: string; data: string };
}

function buildParts(input: ExtractInput, prompt = EXTRACTION_PROMPT): Parts[] {
  const parts: Parts[] = [{ text: prompt }];
  if (input.text?.trim()) {
    parts.push({ text: `--- LETTER ---\n${input.text.trim().slice(0, 8000)}` });
  }
  if (input.imageDataUrl) {
    const [meta, data] = input.imageDataUrl.split(",");
    const mimeType = /data:([^;]+)/.exec(meta)?.[1] ?? "image/png";
    if (data) parts.push({ inlineData: { mimeType, data } });
  }
  return parts;
}

type AnyModel = {
  initializeDeviceModel?: (cb?: (progress: number) => void) => Promise<void>;
  generateContent: (req: unknown) => Promise<{ response: unknown }>;
};

let modelPromise: Promise<AnyModel> | null = null;


async function firebaseAi() {
  const { initializeApp, getApps } = await import("firebase/app");
  const app =
    getApps()[0] ??
    initializeApp({
      apiKey: env.VITE_FIREBASE_API_KEY,
      authDomain: env.VITE_FIREBASE_AUTH_DOMAIN,
      projectId: env.VITE_FIREBASE_PROJECT_ID,
      appId: env.VITE_FIREBASE_APP_ID,
    });

  // AI Logic enforces App Check, so a request without it is rejected. On localhost the
  // documented route is the debug provider: set the global before initialising, and the
  // SDK uses the registered debug token instead of attestation (the provider below is
  // then never asked for a token). Without a debug token, a real site key is required.
  const appCheckSiteKey = env.VITE_APPCHECK_SITE_KEY;
  const debugToken = env.VITE_APPCHECK_DEBUG_TOKEN;
  if (appCheckSiteKey || debugToken) {
    const { initializeAppCheck, ReCaptchaV3Provider } = await import("firebase/app-check");
    if (debugToken) {
      (self as unknown as { FIREBASE_APPCHECK_DEBUG_TOKEN: string }).FIREBASE_APPCHECK_DEBUG_TOKEN =
        debugToken;
    }
    initializeAppCheck(app, {
      provider: new ReCaptchaV3Provider(appCheckSiteKey ?? "debug-token-takes-precedence"),
      isTokenAutoRefreshEnabled: true,
    });
  }
  return app;
}

/** Hybrid model: on-device first, cloud fallback. */
export async function getHybridModel(): Promise<AnyModel> {
  if (!modelPromise) {
    modelPromise = (async () => {
      const app = await firebaseAi();
      const aiMod = (await import("firebase/ai")) as unknown as Record<string, any>;
      const ai = aiMod.getAI(app, { backend: new aiMod.GoogleAIBackend() });
      // Hybrid structured output is configured per route, not in the request:
      // inCloudParams takes responseMimeType + responseSchema, onDeviceParams takes
      // responseConstraint. Sending only generationConfig.responseSchema left the
      // on-device route unconstrained, so it answered in prose and parsing failed.
      // Structured output for a hybrid model is configured per route, and the nesting
      // matters: cloud reads inCloudParams.generationConfig, the device route reads
      // onDeviceParams.promptOptions.responseConstraint. Passing them flat is silently
      // ignored, the model answers in prose, and parsing fails with "did not return JSON".
      return aiMod.getGenerativeModel(ai, {
        mode: aiMod.InferenceMode.PREFER_ON_DEVICE,
        inCloudParams: {
          model: cloudModelName(),
          generationConfig: {
            responseMimeType: "application/json",
            responseSchema: LETTER_SCHEMA,
            temperature: 0.2,
          },
        },
        onDeviceParams: { promptOptions: { responseConstraint: LETTER_SCHEMA } },
      }) as AnyModel;
    })();
  }
  return modelPromise;
}

const cloudOnlyPromises = new Map<string, Promise<AnyModel>>();
/** model name → timestamp after which it is worth trying again. */
const rungCooldownUntil = new Map<string, number>();
const RUNG_COOLDOWN_MS = 10 * 60_000;

async function getCloudOnlyModel(modelName: string): Promise<AnyModel> {
  const cached = cloudOnlyPromises.get(modelName);
  if (cached) return cached;
  const promise = (async (): Promise<AnyModel> => {
    const app = await firebaseAi();
    const aiMod = (await import("firebase/ai")) as unknown as Record<string, any>;
    const ai = aiMod.getAI(app, { backend: new aiMod.GoogleAIBackend() });
    const model = aiMod.getGenerativeModel(
      ai,
      {
        mode: aiMod.InferenceMode.ONLY_IN_CLOUD,
        inCloudParams: {
          model: modelName,
          generationConfig: {
            responseMimeType: "application/json",
            responseSchema: LETTER_SCHEMA,
            temperature: 0.2,
          },
        },
      },
      // Default is 180 s. A saturated model should fail while the user is still looking at
      // the button, not three minutes later.
      { timeout: 12_000 },
    );
    return model as AnyModel;
  })();
  cloudOnlyPromises.set(modelName, promise);
  return promise;
}

/**
 * Capacity failures rather than bad requests. The strong model routinely answers 500/503
 * "experiencing high demand" for stretches of time; that is worth one step down the
 * ladder, whereas a malformed request or a permission error is not.
 */
function isCapacityError(err: unknown): boolean {
  const text = err instanceof Error ? err.message : String(err);
  return /\b(500|503)\b|high demand|overload(ed)?|prefill|unavailable/i.test(text);
}

/** A rung we cannot use at all (unknown name, retired model) is worth skipping, too. */
function isUnusableModel(err: unknown): boolean {
  const text = err instanceof Error ? err.message : String(err);
  return /\b(400|404)\b|not found|is not supported|unsupported model|does not exist|permission denied|403/i.test(
    text,
  );
}

/**
 * Must be called inside a user gesture. Downloads the on-device model if needed,
 * which can take minutes on first run.
 */
export async function warmUpOnDevice(onProgress?: (p: number) => void): Promise<boolean> {
  if (!isFirebaseConfigured()) {
    if (!hasLocalModel()) return false;
    // create() must happen inside the gesture; drop the session, the model stays loaded.
    const ok = await withLocalSession(false, async () => true, onProgress).then(
      () => true,
      (err) => {
        console.warn("[fineprint] local model warm-up failed", err);
        return false;
      },
    );
    return ok;
  }
  try {
    const model = await getHybridModel();
    if (!model.initializeDeviceModel) return false;
    await model.initializeDeviceModel(onProgress);
    return true;
  } catch (err) {
    console.warn("[fineprint] on-device warm-up failed", err);
    return false;
  }
}

function readSource(response: unknown): Source {
  const value = (response as { inferenceSource?: string } | undefined)?.inferenceSource;
  // The SDK reports lowercase "on_device" / "in_cloud". Compare case-insensitively so a
  // future enum spelling cannot make a local run look like a cloud one.
  const normalised = typeof value === "string" ? value.toUpperCase() : "";
  if (normalised === "ON_DEVICE") return "ON_DEVICE";
  if (normalised === "IN_CLOUD") return "IN_CLOUD";
  console.warn("[fineprint] inferenceSource missing; assuming cloud");
  return "IN_CLOUD";
}

function requestFor(parts: Parts[]) {
  // No generationConfig here: the schema belongs to the route configuration above.
  return { contents: [{ role: "user", parts }] };
}

export async function extractOnce(input: ExtractInput, prompt?: string): Promise<ExtractionRun> {
  if (!isFirebaseConfigured()) {
    if (!hasLocalModel()) return mockRun(input);
    const text = prompt ?? EXTRACTION_PROMPT;
    const image = input.imageDataUrl;
    const started = performance.now();
    const raw = await withLocalSession(Boolean(image), (session) => {
      if (!image) return session.prompt(localPrompt(input, text), { responseConstraint: LETTER_SCHEMA });
      return dataUrlToBlob(image).then((blob) =>
        session.prompt(
          [{ type: "text", value: `${localPrompt(input, text)}\n\nThe letter is in the image.` }, { type: "image", value: blob }],
          { responseConstraint: LETTER_SCHEMA },
        ),
      );
    });
    return {
      extraction: parseExtraction(raw),
      source: "ON_DEVICE",
      latencyMs: Math.round(performance.now() - started),
    };
  }

  const started = performance.now();
  const model = await getHybridModel();
  const result = await model.generateContent(requestFor(buildParts(input, prompt)));
  const latencyMs = Math.round(performance.now() - started);
  const response = (result as { response: { text(): string } }).response;
  const raw = response.text();
  const inferenceSource = readSource(response);
  return { extraction: parseExtraction(raw), source: inferenceSource, latencyMs };
}

/** k sequential samples. Sequential on purpose: the device model serialises anyway. */
export async function sampleK(
  input: ExtractInput,
  k = 3,
  onEach?: (run: ExtractionRun, index: number) => void,
): Promise<ExtractionRun[]> {
  const runs: ExtractionRun[] = [];
  for (let i = 0; i < k; i += 1) {
    let run: ExtractionRun;
    try {
      run = await extractOnce(input);
    } catch (err) {
      // The API can exist while the model is not usable. Fall back only when nothing
      // succeeded yet, and only to clearly-labelled MOCK runs — never mix real output.
      if (i === 0 && !isFirebaseConfigured() && hasLocalModel()) {
        console.warn("[fineprint] on-device model unusable, showing sample data", err);
        for (let j = 0; j < k; j += 1) {
          const mock = mockRun(input);
          runs.push(mock);
          onEach?.(mock, j);
        }
        return runs;
      }
      throw err;
    }
    runs.push(run);
    onEach?.(run, i);
  }
  return runs;
}

export interface ReReadResult {
  value: string | string[];
  quote: string;
  latencyMs: number;
}

/**
 * One focused pass over a single field, on device.
 *
 * This is the retry-the-smallest-unit step: the whole letter is still visible, but the
 * model is asked one question and must quote the sentence it answered from, so the app
 * can verify the answer without sending anything anywhere. Deliberately built-in-model
 * only — routing it through a cloud-capable model would defeat the purpose, so it throws
 * when there is no local model and the caller falls back to escalating.
 */
export async function reReadField(input: ExtractInput, field: FieldKey): Promise<ReReadResult> {
  if (!hasLocalModel()) throw new Error("No on-device model for a targeted re-read.");
  const started = performance.now();
  const prompt = `${REREAD_PROMPT}\n\nQuestion: ${focusQuestion(field)}`;
  const image = input.imageDataUrl;
  const constraint = focusedSchema(field);
  const raw = await withLocalSession(Boolean(image), (session) => {
    if (!image) return session.prompt(localPrompt(input, prompt), { responseConstraint: constraint });
    return dataUrlToBlob(image).then((blob) =>
      session.prompt(
        [{ type: "text", value: `${localPrompt(input, prompt)}\n\nThe letter is in the image.` }, { type: "image", value: blob }],
        { responseConstraint: constraint },
      ),
    );
  });
  const parsed = parseFocused(raw);
  return { ...parsed, latencyMs: Math.round(performance.now() - started) };
}

async function runCloudModel(modelName: string, payload: string): Promise<Omit<ExtractionRun, "model">> {
  const model = await getCloudOnlyModel(modelName);
  const result = await model.generateContent(requestFor([{ text: payload }]));
  const response = (result as { response: { text(): string } }).response;
  return { extraction: parseExtraction(response.text()), source: "IN_CLOUD", latencyMs: 0 };
}

/** Health matrix for the ladder: one tiny request per rung, used by the probe page. */
export async function probeCloudModels(
  payload: string,
): Promise<{ model: string; ok: boolean; latencyMs: number; error?: string }[]> {
  const results: { model: string; ok: boolean; latencyMs: number; error?: string }[] = [];
  for (const modelName of escalationLadder()) {
    const started = performance.now();
    try {
      await runCloudModel(modelName, payload);
      results.push({ model: modelName, ok: true, latencyMs: Math.round(performance.now() - started) });
    } catch (err) {
      results.push({
        model: modelName,
        ok: false,
        latencyMs: Math.round(performance.now() - started),
        error: (err instanceof Error ? err.message : String(err)).slice(0, 220),
      });
    }
  }
  return results;
}

export async function escalate(payload: string): Promise<ExtractionRun> {
  if (!isFirebaseConfigured()) {
    // Never fake a cloud read when the device model is real: say it is missing.
    if (hasLocalModel()) {
      throw new Error(
        "The cloud second read needs Firebase AI Logic configured (VITE_FIREBASE_* in .env.local).",
      );
    }
    return mockRun({ text: payload });
  }
  const started = performance.now();
  // One attempt per rung. No retry loop: the documented failure mode lasts minutes to
  // days, so hammering the same saturated model would burn free-tier quota for nothing.
  const ladder = escalationLadder();
  // Remember which rungs just failed. Capacity outages last minutes, so re-probing a dead
  // rung on every click only multiplies the wait; a cold rung is skipped for a while.
  const now = Date.now();
  const ready = ladder.filter((name) => (rungCooldownUntil.get(name) ?? 0) <= now);
  const attempt = ready.length ? ready : ladder;
  let lastError: unknown = null;
  for (const modelName of attempt) {
    try {
      const result = await runCloudModel(modelName, payload);
      const latencyMs = Math.round(performance.now() - started);
      if (modelName !== ladder[0]) {
        console.warn(`[fineprint] ${ladder[0]} unavailable; answered by ${modelName}`);
      }
      return { ...result, latencyMs, model: modelName };
    } catch (err) {
      lastError = err;
      const last = modelName === attempt[attempt.length - 1];
      if (isCapacityError(err) || isUnusableModel(err)) {
        rungCooldownUntil.set(modelName, Date.now() + RUNG_COOLDOWN_MS);
      }
      if (last || !(isCapacityError(err) || isUnusableModel(err))) throw err;
      console.warn(`[fineprint] cloud rung ${modelName} unavailable, trying the next one`);
    }
  }
  throw lastError ?? new Error("The cloud second read failed.");
}

/* ------------------------------------------------------------------ */
/* Mock provider: lets the whole UI run with no keys, no network, no model. */
/* ------------------------------------------------------------------ */

let mockCounter = 0;

function mockRun(input: ExtractInput): ExtractionRun {
  const sample = pickSample(input.text ?? "");
  const index = mockCounter % sample.variants.length;
  mockCounter += 1;
  const extraction: Extraction = structuredClone(sample.variants[index]);
  return {
    extraction,
    source: "MOCK",
    latencyMs: 240 + Math.round(Math.random() * 180),
  };
}

export function resetMockSequence(): void {
  mockCounter = 0;
}
