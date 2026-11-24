/**
 * Can this quote actually be found in the letter?
 *
 * The targeted re-read is only trusted when the model can point at the text it read.
 * Comparison is punctuation- and whitespace-insensitive because line breaks in a letter
 * are layout, not content — but it is a strict substring test, not fuzzy matching:
 * a near-miss quote is exactly the case worth escalating.
 */
export function quoteIsGrounded(letterText: string, quote: string): boolean {
  const norm = (s: string) =>
    s
      .toLowerCase()
      .replace(/[\u2018\u2019]/g, "'")
      .replace(/[\u201c\u201d]/g, '"')
      .replace(/[^a-z0-9']+/g, " ")
      .trim();
  const q = norm(quote);
  // Short quotes ("the", "2026") match by accident and prove nothing.
  if (q.split(" ").filter(Boolean).length < 4) return false;
  return norm(letterText).includes(q);
}
