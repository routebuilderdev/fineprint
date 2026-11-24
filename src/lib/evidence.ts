/**
 * Per-item evidence: does this checklist item actually come from the letter?
 *
 * Agreement and grounding answer "did the model repeat itself" and "can the field quote
 * the letter". Neither says anything about a single line in a merged list: one sample can
 * invent an action, survive the majority vote, and the field still looks settled. So each
 * item is checked against the letter text on its own, with the cheapest honest test:
 * how many of its content words appear in the letter.
 *
 * This is deliberately not a similarity score. Actions are paraphrases ("pay the amount
 * due" for "you must pay the sum owing"), so a low score is a prompt to look, not proof
 * of a hallucination — the flag says "no match in the letter", never "wrong".
 */

const STOPWORDS = new Set(
  (
    "a an and any are as at be been before but by can could did do does for from had has " +
    "have if in into is it its may must no not of on or our shall should than that the " +
    "their them then there these they this those to until up was were what when which " +
    "who will with within would you your yours"
  ).split(" "),
);

/** Crude suffix strip, applied to both sides so plurals and tenses still match. */
function stem(word: string): string {
  return word
    .replace(/(ies)$/, "y")
    .replace(/(sses|ches|shes|xes)$/, "ss")
    .replace(/(ing|ed)$/, "")
    .replace(/(s)$/, "");
}

function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

export interface ItemEvidence {
  /** Content words in the item. */
  total: number;
  /** Content words found in the letter. */
  covered: number;
  /** Content words the letter does not contain, in item order. */
  missing: string[];
  /** False only when the letter clearly does not contain the item's wording. */
  supported: boolean;
  /** Closest sentence in the letter, as the evidence to read against. */
  closest: { sentence: string; similarity: number } | null;
}

/** Split on sentence ends and blank lines; keep it simple and reversible. */
function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n{2,}/)
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter((s) => s.length > 3);
}

/** Character-bigram Dice, same measure the merge uses. */
function similarity(a: string, b: string): number {
  const grams = (s: string) => {
    const out = new Set<string>();
    const t = ` ${s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim()} `;
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

/**
 * Minimum share of an item's content words that must appear in the letter.
 * 0.6 keeps a paraphrase with one synonym ("post" for "send") unflagged while still
 * catching an item built from words the letter never uses.
 */
export const MIN_COVERAGE = 0.6;
/**
 * A sentence this close to the item counts as its evidence even when the wording differs.
 * Word coverage alone flagged honest paraphrases; source-grounding guidance for extraction
 * is explicit that string matching is brittle and should be paired with a proximity check
 * rather than trusted alone.
 */
export const MIN_SENTENCE_MATCH = 0.45;

export function checkItem(
  letterText: string,
  item: string,
  minCoverage = MIN_COVERAGE,
): ItemEvidence {
  const letterWords = new Set(tokens(letterText).map(stem));
  const words = tokens(item).filter((w) => w.length > 2 && !STOPWORDS.has(w));
  const missing = words.filter((w) => !letterWords.has(stem(w)));
  const total = words.length;
  const covered = total - missing.length;

  let closest: ItemEvidence["closest"] = null;
  for (const sentence of sentences(letterText)) {
    const s = similarity(item, sentence);
    if (!closest || s > closest.similarity) closest = { sentence, similarity: s };
  }

  const hasWords = total >= 2 && covered / total >= minCoverage;
  const hasSentence = (closest?.similarity ?? 0) >= MIN_SENTENCE_MATCH;
  // Too little to judge, or no letter text to check against: don't accuse the item.
  const supported = total < 2 || !letterText.trim() || hasWords || hasSentence;
  return { total, covered, missing, supported, closest };
}
