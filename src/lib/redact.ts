import type { RedactionResult } from "../types";

interface Pattern {
  label: string;
  regex: RegExp;
}

/**
 * Deterministic, reviewable redaction. Runs on the raw letter text before any
 * cloud call. Deliberately regex-based: a judge can read it, and it cannot
 * hallucinate. Names and street addresses come from the on-device extraction
 * as literal strings, so they are removed by exact match below.
 */
const PATTERNS: Pattern[] = [
  { label: "email address", regex: /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi },
  { label: "phone number", regex: /\+?\d[\d\s().-]{7,}\d/g },
  { label: "IBAN", regex: /\b[A-Z]{2}\d{2}[A-Z0-9]{10,30}\b/g },
  { label: "card number", regex: /\b(?:\d[ -]?){13,19}\b/g },
  { label: "NI / SSN style ID", regex: /\b\d{3}-\d{2}-\d{4}\b/g },
  { label: "URL", regex: /https?:\/\/\S+/gi },
];

export function redact(
  text: string,
  literalRemovals: string[] = [],
): RedactionResult {
  const removed: string[] = [];
  let out = text;

  for (const literal of literalRemovals) {
    const trimmed = literal.trim();
    if (trimmed.length < 3) continue;
    const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(escaped, "gi");
    if (re.test(out)) {
      out = out.replace(re, "[redacted]");
      removed.push("name / address");
    }
  }

  for (const { label, regex } of PATTERNS) {
    regex.lastIndex = 0;
    if (regex.test(out)) {
      regex.lastIndex = 0;
      out = out.replace(regex, "[redacted]");
      removed.push(label);
    }
  }

  return {
    text: out,
    removed: [...new Set(removed)],
    charsIn: text.length,
    charsOut: out.length,
  };
}

/** Reduce a full document to the minimum context the cloud needs. */
export function buildEscalationPayload(
  redactedLetter: string,
  lowConfidence: string[],
  maxChars = 1200,
): string {
  const focus = lowConfidence.length ? lowConfidence.join(", ") : "the uncertain fields";
  const body = redactedLetter.slice(0, maxChars);
  return `Re-read this redacted official letter. Pay particular attention to: ${focus}.
Return the same JSON structure. Use an empty string for anything the letter does not state.

--- LETTER (redacted) ---
${body}`;
}
