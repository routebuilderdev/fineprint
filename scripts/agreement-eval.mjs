/**
 * Validates the agreement estimator and picks an escalation threshold.
 *
 * IMPORTANT: this measures the *estimator*, not the model. The runs below are
 * hand-built from a ground truth with deliberate errors, so the numbers tell you
 * how well "samples disagree" predicts "the majority answer is wrong" for a given
 * k and threshold. Replace the fixtures with outputs captured from the real model
 * (spike-output.json) once the on-device spike has run.
 */
import { mkdirSync } from "node:fs";
import { build } from "esbuild";
import { pathToFileURL } from "node:url";

mkdirSync(".tmp", { recursive: true });
await build({
  entryPoints: ["src/lib/agreement.ts"],
  bundle: true,
  format: "esm",
  outfile: ".tmp/agreement.mjs",
  logLevel: "error",
});
const { scoreFields, normaliseScalar } = await import(
  pathToFileURL(`${process.cwd()}/.tmp/agreement.mjs`).href
);

/* ------------------------------------------------------------------ */
/* Capture-file mode: tune against real runs exported from the app.    */
/*   npm run eval:agreement -- fineprint-run-123.json                 */
/* ------------------------------------------------------------------ */
if (process.argv[2]) {
  const { readFileSync } = await import("node:fs");
  const capture = JSON.parse(readFileSync(process.argv[2], "utf8"));
  const runs = (capture.runs ?? []).map((r) => r.extraction ?? r);
  if (runs.length < 2) {
    console.error("Need at least 2 runs in the capture file.");
    process.exit(1);
  }
  const scores = scoreFields(runs);
  const latencies = (capture.runs ?? []).map((r) => r.latencyMs).filter((n) => typeof n === "number");

  console.log(`Capture: ${process.argv[2]}`);
  console.log(`runs: ${runs.length} | sources: ${[...new Set((capture.runs ?? []).map((r) => r.source))].join(", ") || "n/a"}`);
  if (latencies.length) {
    const sorted = [...latencies].sort((a, b) => a - b);
    const mean = latencies.reduce((s, n) => s + n, 0) / latencies.length;
    console.log(
      `latency: mean ${mean.toFixed(0)} ms | min ${sorted[0]} | max ${sorted[sorted.length - 1]} ms`,
    );
  }
  console.log("\nfield              agreement  value");
  for (const f of scores) {
    const value = Array.isArray(f.value) ? `[${f.value.length} items]` : (f.value ?? "null");
    console.log(`${f.key.padEnd(18)} ${(f.agreement * 100).toFixed(0).padStart(8)}%  ${String(value).slice(0, 40)}`);
  }

  console.log("\nescalation share by threshold (share of fields that would be sent):");
  for (const t of [0.5, 0.6, 0.66, 0.7, 0.8, 0.9, 1.0]) {
    const share = scores.filter((f) => f.agreement < t).length / scores.length;
    console.log(`  tau=${t.toFixed(2)}  ${(share * 100).toFixed(0)}%  ${share <= 0.25 ? "<- within budget" : ""}`);
  }
  const target = 0.2;
  const fit = [0.5, 0.6, 0.66, 0.7, 0.8, 0.9, 1.0]
    .map((t) => ({ t, share: scores.filter((f) => f.agreement < t).length / scores.length }))
    .filter((r) => r.share <= target)
    // Prefer the most sensitive (highest) threshold that still fits the budget.
    .sort((a, b) => b.share - a.share || b.t - a.t)[0];
  console.log(
    fit
      ? `\nRecommended tau for <=${target * 100}% escalation on this capture: ${fit.t.toFixed(2)}`
      : `\nNo threshold hits <=${target * 100}% escalation; consider k=5 or a tighter prompt.`,
  );
  process.exit(0);
}

const GT = (over = {}) => ({
  documentType: "denial",
  deadline: "2027-01-19",
  actions: ["Send a written appeal to the claims address.", "Attach the itemised bill."],
  references: ["Claim 88-4419-02", "Policy 4021-7788-1"],
  ...over,
});

/** Each run is a patch over the ground truth; 5 runs per case. */
const CASES = [
  { id: "clean", runs: [{}, {}, {}, {}, {}] },
  { id: "deadline-slip-minority", runs: [{}, { deadline: "2027-01-09" }, {}, {}, {}] },
  { id: "deadline-slip-majority", runs: [{ deadline: "2027-01-09" }, { deadline: "2027-01-09" }, {}, { deadline: "2027-01-09" }, {}] },
  { id: "date-format-noise", runs: [{}, { deadline: "19 January 2027" }, {}, {}, {}] },
  { id: "action-extra-hallucination", runs: [{ actions: ["Call the insurer.", "Send a written appeal to the claims address.", "Attach the itemised bill."] }, {}, {}, {}, {}] },
  { id: "reference-missing", runs: [{}, {}, { references: ["Claim 88-4419-02"] }, {}, {}] },
  { id: "wrong-doc-type", runs: [{ documentType: "bill" }, { documentType: "bill" }, { documentType: "bill" }, {}, {}] },
  { id: "unstable-everything", runs: [
    { deadline: "2027-01-09", actions: ["Call them."] },
    { documentType: "bill", deadline: "2027-02-01" },
    { references: [] },
    { deadline: "2026-12-01", actions: ["Appeal in writing."] },
    {},
  ] },
  { id: "clean-but-paraphrased", runs: [
    {},
    { actions: ["Send an appeal in writing to the claims address.", "Attach the itemised bill."] },
    {},
    { actions: ["Send a written appeal to the claims address.", "Attach the itemised bill."] },
    {},
  ] },
  { id: "two-ids-merged", runs: [{}, { references: ["Claim 88-4419-02, Policy 4021-7788-1"] }, {}, {}, {}] },
  { id: "empty-once", runs: [{}, { deadline: null, actions: [] }, {}, {}, {}] },
  { id: "confident-wrong", runs: [
    { deadline: "2027-01-09" }, { deadline: "2027-01-09" }, { deadline: "2027-01-09" }, { deadline: "2027-01-09" }, { deadline: "2027-01-09" },
  ] },
];

const FIELDS = ["documentType", "deadline", "actions", "references"];

function valueOf(field, extraction) {
  return field === "actions" || field === "references" ? extraction[field] : extraction[field];
}

function eq(field, a, b) {
  if (field === "actions" || field === "references") {
    const norm = (xs) => (xs ?? []).map((x) => normaliseScalar(x)).filter(Boolean);
    const A = norm(a);
    const B = norm(b);
    if (A.length !== B.length) return false;
    return A.every((x) => B.includes(x));
  }
  return normaliseScalar(a) === normaliseScalar(b);
}

function evaluate(k, tau) {
  let tp = 0, fp = 0, fn = 0, tn = 0, blind = 0;
  for (const c of CASES) {
    const runs = c.runs.slice(0, k).map((patch) => GT(patch));
    const scores = scoreFields(runs);
    for (const f of FIELDS) {
      const s = scores.find((x) => x.key === f);
      if (!s) continue;
      const escalate = s.agreement < tau;
      const majorityWrong = !eq(f, s.value, valueOf(f, GT()));
      if (!escalate && majorityWrong && s.agreement >= 0.999) blind += 1;
      if (escalate && majorityWrong) tp += 1;
      else if (escalate && !majorityWrong) fp += 1;
      else if (!escalate && majorityWrong) fn += 1;
      else tn += 1;
    }
  }
  const recall = tp + fn ? tp / (tp + fn) : 0;
  const far = fp + tn ? fp / (fp + tn) : 0;
  const precision = tp + fp ? tp / (tp + fp) : 0;
  return { k, tau, tp, fp, fn, tn, blind, recall, falseEscalationRate: far, precision };
}

const taus = [];
for (let t = 0.3; t <= 1.0001; t += 0.05) taus.push(Number(t.toFixed(2)));

console.log("Agreement eval — synthetic labeled runs (estimator check, not model accuracy)\n");
console.log("cases:", CASES.length, "| fields per case:", FIELDS.length, "| decisions:", CASES.length * FIELDS.length);

for (const k of [3, 5]) {
  console.log(`\n=== k=${k} (${k === 3 ? "first three runs" : "all five runs"}) ===`);
  console.log("tau   recall  falseEsc  precision  caught missed  wasted");
  for (const tau of taus) {
    const r = evaluate(k, tau);
    console.log(
      `${r.tau.toFixed(2)}  ${(r.recall * 100).toFixed(0).padStart(5)}%  ${(r.falseEscalationRate * 100)
        .toFixed(0)
        .padStart(7)}%  ${(r.precision * 100).toFixed(0).padStart(8)}%  ${String(r.tp).padStart(6)} ${String(r.fn).padStart(6)}  ${String(r.fp).padStart(6)}`,
    );
  }
}

// Pick k=3 (cost) unless k=5 catches materially more errors.
const k3 = taus.map((t) => evaluate(3, t));
const k5 = taus.map((t) => evaluate(5, t));
// Youden's J balances catching real errors against leaking text we did not need to send.
const youden = (r) => r.recall - r.falseEscalationRate;
const best = (rows) =>
  [...rows].sort(
    (a, b) => youden(b) - youden(a) || b.recall - a.recall || a.falseEscalationRate - b.falseEscalationRate,
  )[0];

const b3 = best(k3);
const b5 = best(k5);
console.log("\n--- recommendation (Youden's J = recall - false-escalation rate) ---");
console.log(
  `k=3: tau=${b3.tau.toFixed(2)} recall=${(b3.recall * 100).toFixed(0)}% falseEscalation=${(b3.falseEscalationRate * 100).toFixed(0)}% J=${youden(b3).toFixed(2)}`,
);
console.log(
  `k=5: tau=${b5.tau.toFixed(2)} recall=${(b5.recall * 100).toFixed(0)}% falseEscalation=${(b5.falseEscalationRate * 100).toFixed(0)}% J=${youden(b5).toFixed(2)}`,
);
console.log(
  `\nBlind spot: ${b5.blind} field(s) were wrong while all five samples agreed — no agreement signal can catch these.`,
);
const gain = b5.recall - b3.recall;
console.log(
  `\nScalar shares at k=3 are 0.33 / 0.67 / 1.00, so for scalars any tau in (0.67, 1] behaves` +
    ` identically. List fields are scored by item clustering and can land in between.` +
    ` This eval is synthetic; scripts/tune-eval.mjs is the one calibrated on the real model.`,
);
console.log(
  gain >= 0.1
    ? `k=5 is worth the extra samples: +${(gain * 100).toFixed(0)} points of recall.`
    : `k=5 does not buy enough: +${(gain * 100).toFixed(0)} points of recall for ~67% more on-device time. Stay at k=3.`,
);
