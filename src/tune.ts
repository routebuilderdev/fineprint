/**
 * Tuning harness. Runs k real on-device samples for every letter in tuneLetters.ts
 * (k from `?k=`, default 3) and exposes the raw results on window.__TUNE_RESULT__
 * so scripts/tune.mjs can save them.
 */
import { EXTRACTION_PROMPT, LETTER_SCHEMA } from "./lib/schema";
import { TUNE_LETTERS } from "./tuneLetters";

const K = Math.min(9, Math.max(2, Number(new URLSearchParams(location.search).get("k")) || 3));

type Session = { prompt: (input: unknown, opts?: unknown) => Promise<string>; destroy?: () => void };
type LM = { create: (opts?: unknown) => Promise<Session> };

const out = document.getElementById("out")!;
const log = (line: string) => {
  out.textContent += `${line}\n`;
  console.log(line);
};

async function main() {
  const lm = (globalThis as { LanguageModel?: LM }).LanguageModel;
  if (!lm?.create) {
    log("No LanguageModel in this browser.");
    (window as unknown as { __TUNE_RESULT__: unknown }).__TUNE_RESULT__ = { error: "no LanguageModel" };
    return;
  }

  const results: unknown[] = [];
  for (const letter of TUNE_LETTERS) {
    log(`--- ${letter.id} ---`);
    const samples: unknown[] = [];
    for (let i = 0; i < K; i += 1) {
      const started = performance.now();
      const session = await lm.create({
        expectedInputs: [{ type: "text", languages: ["en"] }],
        expectedOutputs: [{ type: "text", languages: ["en"] }],
      });
      try {
        const raw = await session.prompt(`${EXTRACTION_PROMPT}\n\n--- LETTER ---\n${letter.text}`, {
          responseConstraint: LETTER_SCHEMA,
        });
        let parsed: unknown = null;
        let error: string | null = null;
        try {
          parsed = JSON.parse(raw);
        } catch {
          error = "unparsable JSON";
        }
        samples.push({ raw, parsed, error, latencyMs: Math.round(performance.now() - started) });
      } catch (err) {
        samples.push({
          raw: "",
          parsed: null,
          error: err instanceof Error ? err.message : String(err),
          latencyMs: Math.round(performance.now() - started),
        });
      } finally {
        session.destroy?.();
      }
      log(`${letter.id} sample ${i + 1} done`);
    }
    results.push({ id: letter.id, truth: letter.truth, samples });
  }

  const payload = {
    ranAt: new Date().toISOString(),
    k: K,
    source: "ON_DEVICE",
    schemaVersion: LETTER_SCHEMA.properties.documentType.enum.join(","),
    letters: results,
  };
  (window as unknown as { __TUNE_RESULT__: unknown }).__TUNE_RESULT__ = payload;
  log("DONE");
}

void main();
