/**
 * Picks the escalation threshold from real on-device samples.
 *
 * For every field of every letter: agreement across k samples (what the app knows)
 * versus whether the majority answer actually matches ground truth (what only we know).
 * Then, per threshold: how much gets sent to the cloud, how many wrong answers stay
 * local (missed errors), and how many right answers get sent anyway (wasted).
 */
import { readFileSync } from "node:fs";
import { build } from "esbuild";
import { pathToFileURL } from "node:url";
import { mkdirSync } from "node:fs";

mkdirSync(".tmp", { recursive: true });
await build({
  entryPoints: ["src/lib/agreement.ts"],
  bundle: true,
  format: "esm",
  outfile: ".tmp/agreement.mjs",
  logLevel: "error",
});
const { scoreFields } = await import(pathToFileURL(`${process.cwd()}/.tmp/agreement.mjs`).href);

const file = process.argv[2] || "tune-output.json";
const data = JSON.parse(readFileSync(file, "utf8"));

const norm = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");
const tokens = (s) =>
  new Set(
    String(s ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9 ]+/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2 && !["the", "and", "for", "your", "with", "this", "that", "must", "will"].includes(w))
      // crude stem so confirm/confirmation and accept/acceptance compare equal
      .map((w) => w.slice(0, 6)),
  );

/** How much of the truth's meaning the model captured; extra detail is not an error. */
const coverage = (value, truth) => {
  const B = tokens((value ?? []).join(" "));
  const A = tokens((truth ?? []).join(" "));
  if (!A.size) return 1;
  let covered = 0;
  for (const t of A) if (B.has(t)) covered += 1;
  return covered / A.size;
};

function correct(key, value, truth) {
  if (key === "documentType") return String(value) === String(truth.documentType);
  if (key === "deadline") return norm(value) === norm(truth.deadline);
  if (key === "reference") {
    // Substring match on normalised text: "tenancy reference 2026/114" contains "2026/114".
    const joined = (value ?? []).map(norm).join("|");
    const t = (truth.references ?? []).map(norm).filter(Boolean);
    if (!t.length) return joined.length === 0;
    return t.every((id) => joined.includes(id));
  }
  return coverage(value, truth.actions) >= 0.6;
}

const rows = [];
for (const letter of data.letters) {
  const runs = letter.samples.filter((s) => s.parsed).map((s) => s.parsed);
  if (runs.length < 2) {
    console.log(`skip ${letter.id}: only ${runs.length} usable samples`);
    continue;
  }
  const scores = scoreFields(runs);
  for (const f of scores) {
    const key = f.key === "references" ? "reference" : f.key;
    rows.push({
      letter: letter.id,
      field: f.key,
      agreement: f.agreement,
      value: f.value,
      right: correct(key, f.value, letter.truth),
      latency: Math.round(
        letter.samples.reduce((sum, s) => sum + (s.latencyMs ?? 0), 0) / letter.samples.length,
      ),
    });
  }
}

const total = rows.length;
const wrong = rows.filter((r) => !r.right);
console.log(`\n${file}: ${data.letters.length} letters, ${total} fields, ${wrong.length} wrong by majority`);
console.log(
  `latency: ${Math.min(...rows.map((r) => r.latency))}–${Math.max(...rows.map((r) => r.latency))} ms per sample\n`,
);
for (const r of wrong) {
  console.log(
    `  WRONG  ${r.letter}/${r.field}  agreement ${(r.agreement * 100).toFixed(0)}%  value ${JSON.stringify(r.value).slice(0, 70)}`,
  );
}

console.log("\n tau   escalated   missed   wasted   note");
let best = null;
for (const t of [0.34, 0.5, 0.66, 0.7, 0.8, 0.85, 0.9, 1.0, 1.01]) {
  const escalated = rows.filter((r) => r.agreement < t);
  const missed = wrong.filter((r) => r.agreement >= t);
  const wasted = escalated.filter((r) => r.right);
  const rate = escalated.length / total;
  const note = missed.length === 0 && rate <= 0.25 ? "<- within budget, no misses" : "";
  console.log(
    ` ${t.toFixed(2)}  ${(rate * 100).toFixed(0).padStart(7)}%   ${String(missed.length).padStart(5)}   ${String(wasted.length).padStart(5)}   ${note}`,
  );
  if (missed.length === 0 && (!best || rate < best.rate)) best = { t, rate };
}

console.log(
  best
    ? `\nrecommended: tau=${best.t.toFixed(2)} (${(best.rate * 100).toFixed(0)}% escalated, 0 missed errors)`
    : "\nno threshold avoids missed errors — collect more samples",
);
