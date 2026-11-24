/**
 * Chooses the list-item support floor (and the similarity cut) from real samples.
 *
 * Two things are being traded against each other, and they are not the same thing:
 *   - recall: dropping an item the model actually produced loses a real action;
 *   - honesty: keeping it lowers the field's agreement, so the gate escalates it.
 * Dropping a weak item makes a field look unanimous, which is the failure mode that
 * hides errors. So the floor is judged together with the escalation it produces.
 *
 *   node scripts/merge-floor.mjs            # both captures
 */
import { readFileSync, mkdirSync } from "node:fs";
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
await build({
  entryPoints: ["src/tuneLetters.ts"],
  bundle: true,
  format: "esm",
  outfile: ".tmp/tuneLetters.mjs",
  logLevel: "error",
});

const { scoreFields, ITEM_MATCH, SUPPORT_FLOOR } = await import(
  pathToFileURL(`${process.cwd()}/.tmp/agreement.mjs`).href
);
const { TUNE_LETTERS } = await import(pathToFileURL(`${process.cwd()}/.tmp/tuneLetters.mjs`).href);

const TAU = 0.99;
const truthById = new Map(TUNE_LETTERS.map((l) => [l.id, l.truth]));

const norm = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");
const tokens = (s) =>
  new Set(
    String(s ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9 ]+/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2 && !["the", "and", "for", "your", "with", "this", "that", "must", "will"].includes(w))
      .map((w) => w.slice(0, 6)),
  );

/** Share of `wanted`'s meaning that `value` actually contains. */
const contains = (value, wanted) => {
  const B = tokens(value);
  const A = tokens(wanted);
  if (!A.size) return 1;
  let hit = 0;
  for (const t of A) if (B.has(t)) hit += 1;
  return hit / A.size;
};

const fieldCorrect = (key, value, truth) => {
  if (key === "documentType") return String(value) === String(truth.documentType);
  if (key === "deadline") return norm(value) === norm(truth.deadline);
  if (key === "references") {
    const joined = (value ?? []).map(norm).join("|");
    const ids = (truth.references ?? []).map(norm).filter(Boolean);
    if (!ids.length) return joined.length === 0;
    return ids.every((id) => joined.includes(id));
  }
  return contains(value ?? [], truth.actions) >= 0.6;
};

function evaluate(captures, { itemMatch, supportFloor }) {
  const stats = {
    kept: 0,
    matched: 0,
    extra: 0,
    missed: 0,
    dup: 0,
    escalated: 0,
    fields: 0,
    wrong: 0,
    wrongKeptLocal: 0,
    dropped: 0,
    droppedLocal: 0,
  };
  const rows = [];

  for (const capture of captures) {
    for (const letter of capture.letters) {
      const runs = letter.samples.filter((s) => s.parsed).map((s) => s.parsed);
      if (runs.length < 2) continue;
      const truth = truthById.get(letter.id);
      if (!truth) continue;
      const scores = scoreFields(runs, { itemMatch, supportFloor });

      for (const f of scores) {
        stats.fields += 1;
        const right = fieldCorrect(f.key, f.value, truth);
        if (!right) stats.wrong += 1;
        const escalate = f.agreement + 0.001 < TAU;
        if (escalate) stats.escalated += 1;
        if (!right && !escalate) stats.wrongKeptLocal += 1;
        if (f.dropped) {
          stats.dropped += f.dropped;
          if (!escalate) stats.droppedLocal += 1;
        }

        if (f.key !== "actions") continue;
        const used = new Set();
        for (const item of f.value) {
          stats.kept += 1;
          let best = -1;
          let bestScore = 0.6;
          truth.actions.forEach((action, i) => {
            const s = contains(item, action);
            if (s >= bestScore) {
              best = i;
              bestScore = s;
            }
          });
          if (best === -1) stats.extra += 1;
          else if (used.has(best)) stats.dup += 1;
          else {
            used.add(best);
            stats.matched += 1;
          }
        }
        truth.actions.forEach((_, i) => {
          if (!used.has(i)) stats.missed += 1;
        });
        rows.push({ capture: capture.file, letter: letter.id, value: f.value, agreement: f.agreement });
      }
    }
  }

  const precision = stats.kept ? stats.matched / stats.kept : 1;
  const recall = stats.matched + stats.missed ? stats.matched / (stats.matched + stats.missed) : 1;
  const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
  return { ...stats, precision, recall, f1, rows };
}

const captures = ["tune-output.json", "tune-output-k5.json"]
  .map((file) => {
    try {
      return { file, ...JSON.parse(readFileSync(file, "utf8")) };
    } catch {
      return null;
    }
  })
  .filter(Boolean);

console.log(`captures: ${captures.map((c) => `${c.file} (k=${c.k ?? "?"})`).join(", ")}`);
console.log(`current: ITEM_MATCH=${ITEM_MATCH} SUPPORT_FLOOR=${SUPPORT_FLOOR.toFixed(3)} TAU=${TAU}`);

console.log("\nsupport floor sweep (itemMatch fixed at current, both captures pooled)");
console.log(" floor   kept  match  extra  miss   F1   escalated  wrong-left-local  dropped  dropped-local");
for (const floor of [0, 0.2, 1 / 3, 0.4, 0.5, 0.6, 0.67, 0.75]) {
  const r = evaluate(captures, { itemMatch: ITEM_MATCH, supportFloor: floor });
  console.log(
    `  ${floor.toFixed(2)}  ${String(r.kept).padStart(5)}  ${String(r.matched).padStart(5)}  ${String(r.extra).padStart(5)}  ${String(r.missed).padStart(4)}  ${r.f1.toFixed(2)}  ${String(r.escalated).padStart(8)}/${r.fields}  ${String(r.wrongKeptLocal).padStart(6)}  ${String(r.dropped).padStart(7)}  ${String(r.droppedLocal).padStart(7)}`,
  );
}

console.log("\nfields where items were discarded by the floor (should be escalated, not trusted)");
for (const capture of captures) {
  const r = evaluate([capture], { itemMatch: ITEM_MATCH, supportFloor: SUPPORT_FLOOR });
  console.log(`  ${capture.file}: ${r.dropped} item(s) dropped, ${r.droppedLocal} such field(s) kept local`);
}

console.log("\nsimilarity sweep (floor = 1/3)");
console.log(" itemMatch   kept  match  extra  miss   F1");
for (const itemMatch of [0.35, 0.4, 0.45, 0.5, 0.55, 0.6, 0.65]) {
  const r = evaluate(captures, { itemMatch, supportFloor: 1 / 3 });
  console.log(
    `     ${itemMatch.toFixed(2)}   ${String(r.kept).padStart(5)}  ${String(r.matched).padStart(5)}  ${String(r.extra).padStart(5)}  ${String(r.missed).padStart(4)}  ${r.f1.toFixed(2)}`,
  );
}

console.log("\nactions per letter at floor 1/3, itemMatch 0.5 (what changes vs 0.5)");
for (const floor of [0.5, 1 / 3]) {
  const r = evaluate(captures, { itemMatch: ITEM_MATCH, supportFloor: floor });
  console.log(`\n floor ${floor.toFixed(2)}`);
  for (const row of r.rows) {
    console.log(`   ${row.capture} ${row.letter.padEnd(9)} ${(row.agreement * 100).toFixed(0).padStart(3)}%  ${JSON.stringify(row.value)}`);
  }
}
