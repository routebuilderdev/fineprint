import type { Extraction, ExtractionRun, FieldKey, FieldScore, ScoredExtraction } from "../types";

export const SCALAR_FIELDS: FieldKey[] = ["documentType", "deadline"];
export const LIST_FIELDS: FieldKey[] = ["actions", "references"];

const EPSILON = 0.001;

/** Lowercase, collapse whitespace, drop punctuation that models vary on. */
export function normaliseScalar(value: string | null): string | null {
  if (value == null) return null;
  const v = value
    .toLowerCase()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[^a-z0-9:'/\-\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return v.length ? v : null;
}

/**
 * Character-bigram Dice similarity, 0..1.
 *
 * List items are paraphrased between samples ("confirm acceptance in writing" vs
 * "confirm written acceptance"), so comparing whole strings would treat one action as
 * two unsupported ones. Bigrams survive that morphology; unrelated actions share none.
 */
function similarity(a: string, b: string): number {
  if (a === b) return 1;
  const grams = (s: string) => {
    const out = new Set<string>();
    const t = ` ${s.replace(/\s+/g, " ").trim()} `;
    for (let i = 0; i < t.length - 1; i += 1) out.add(t.slice(i, i + 2));
    return out;
  };
  const ga = grams(a);
  const gb = grams(b);
  if (!ga.size || !gb.size) return 0;
  let shared = 0;
  for (const g of ga) if (gb.has(g)) shared += 1;
  return (2 * shared) / (ga.size + gb.size);
}

export const ITEM_MATCH = 0.5;
/**
 * Minimum share of runs that must have produced an item for it to survive the merge.
 *
 * This is deliberately decoupled from the escalation threshold: an item seen once in
 * three runs is weak evidence, but dropping it here makes the field look unanimous and
 * the gate then never sends it for a second read. So the merge still requires majority
 * support (0.5), but any discard caps agreement at (k-1)/k below — the field is shown
 * as uncertain and escalated instead of looking unanimous. Swept in scripts/merge-floor.mjs:
 * a lower floor only added one-off items to the preview, without recovering any
 * action the 0.5 floor had dropped.
 */
export const SUPPORT_FLOOR = 0.5;

export interface ScoreOptions {
  /** Similarity at or above which two list items are the same item. */
  itemMatch?: number;
  /** Support (0..1) an item needs to be kept in the merged answer. */
  supportFloor?: number;
}

function majority<T>(values: T[]): { value: T; count: number } | null {
  if (!values.length) return null;
  const counts = new Map<string, { value: T; count: number }>();
  for (const v of values) {
    const k = JSON.stringify(v);
    const hit = counts.get(k);
    if (hit) hit.count += 1;
    else counts.set(k, { value: v, count: 1 });
  }
  return [...counts.values()].sort((a, b) => b.count - a.count)[0] ?? null;
}

/**
 * Per-field agreement across k independent samples.
 *
 * This is the replacement for token logprobs, which the Chrome Prompt API does not
 * expose. A field the model reproduces identically k times is treated as confident;
 * a field that changes between samples is escalated. It is an estimator, not a
 * calibrated probability - hence the threshold is tuned empirically in
 * scripts/agreement-eval.mjs.
 */
export function scoreFields(runs: Extraction[], options: ScoreOptions = {}): FieldScore[] {
  const itemMatch = options.itemMatch ?? ITEM_MATCH;
  const supportFloor = options.supportFloor ?? SUPPORT_FLOOR;
  const k = runs.length;
  if (k === 0) return [];
  const scores: FieldScore[] = [];

  for (const key of SCALAR_FIELDS) {
    const values = runs.map((r) => normaliseScalar(r[key] as string | null));
    const top = majority(values);
    const count = top ? values.filter((v) => JSON.stringify(v) === JSON.stringify(top.value)).length : 0;
    scores.push({
      key,
      value: top ? top.value : null,
      agreement: k ? count / k : 0,
      perRun: values,
    });
  }

  for (const key of LIST_FIELDS) {
    // Item-level support, clustered by meaning: one action phrased three ways is one
    // action with support 3/k, not three items with support 1/k each.
    const value = runs.map((r) => r[key] as string[]);
    const normalised = value.map((items) => items.map((i) => normaliseScalar(i)).filter(Boolean) as string[]);
    const displays = value.map((items) => items.map((i) => i.trim()));

    interface Cluster {
      members: string[];
      display: string;
      runs: Set<number>;
    }
    const clusters: Cluster[] = [];

    for (let i = 0; i < normalised.length; i += 1) {
      for (let j = 0; j < normalised[i].length; j += 1) {
        const item = normalised[i][j];
        const display = displays[i][j] ?? item;
        let best: Cluster | null = null;
        let bestScore = itemMatch;
        for (const c of clusters) {
          const s = Math.max(...c.members.map((m) => similarity(m, item)));
          if (s >= bestScore) {
            best = c;
            bestScore = s;
          }
        }
        if (best) {
          best.members.push(item);
          best.runs.add(i);
          if (display.length > best.display.length) best.display = display;
        } else {
          clusters.push({ members: [item], display, runs: new Set([i]) });
        }
      }
    }

    const scored = clusters
      .map((c) => ({ display: c.display, support: c.runs.size / k }))
      .sort((a, b) => b.support - a.support);
    const kept = scored.filter((c) => c.support + EPSILON >= supportFloor);
    const dropped = scored.length - kept.length;

    const meanSupport = kept.length
      ? kept.reduce((sum, c) => sum + c.support, 0) / kept.length
      : 0;
    // A discarded item is itself evidence that the samples disagreed. Without this cap,
    // dropping the one-off items makes the field look unanimous (agreement 1.0) and the
    // gate stops escalating the very fields where the model was least stable.
    const agreement = dropped > 0 ? Math.min(meanSupport, (k - 1) / k) : meanSupport;

    scores.push({
      key,
      value: kept.map((c) => c.display),
      agreement,
      perRun: normalised,
      dropped,
    });
  }

  return scores;
}

export function scoreRuns(runs: ExtractionRun[]): ScoredExtraction {
  const fields = scoreFields(runs.map((r) => r.extraction));
  const overall = fields.length
    ? fields.reduce((sum, f) => sum + f.agreement, 0) / fields.length
    : 0;
  return { fields, overall, runs };
}

export function needsEscalation(field: FieldScore, threshold: number): boolean {
  return field.agreement + EPSILON < threshold;
}

/** Fields below the threshold, in schema order. */
export function lowConfidenceFields(scored: ScoredExtraction, threshold: number): FieldScore[] {
  return scored.fields.filter((f) => needsEscalation(f, threshold));
}

/** Merge a cloud second opinion over the on-device values for the given fields. */
export function mergeSecondOpinion(
  base: Extraction,
  cloud: Extraction,
  overrides: FieldKey[],
): Extraction {
  const out: Extraction = { ...base, actions: [...base.actions], references: [...base.references] };
  for (const key of overrides) {
    if (key === "actions") out.actions = cloud.actions;
    else if (key === "references") out.references = cloud.references;
    else if (key === "documentType") out.documentType = cloud.documentType;
    else out.deadline = cloud.deadline;
  }
  return out;
}
