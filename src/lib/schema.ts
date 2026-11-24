import type { Extraction, FieldKey } from "../types";

/**
 * Schema used for both paths:
 * - Firebase `generationConfig.responseSchema` (cloud fallback, and on-device via the SDK)
 * - Chrome Prompt API `responseConstraint` (direct on-device)
 *
 * Keep this inside the OpenAPI-ish subset Gemini accepts: object / array / string /
 * enum / required. No unions, no nulls, no numeric constraints.
 */
export const LETTER_SCHEMA = {
  type: "object",
  properties: {
    documentType: {
      type: "string",
      enum: ["denial", "lease", "benefit", "bill", "fine", "tax", "immigration", "other"],
      description:
        "Best fit for what kind of official letter this is. Parking, speeding and other penalty notices are 'fine', not 'bill'.",
    },
    deadline: {
      type: "string",
      description:
        "The single most urgent date or deadline stated in the letter, as YYYY-MM-DD. Empty string if none.",
    },
    actions: {
      type: "array",
      items: { type: "string" },
      description: "Concrete things the recipient must do, one short imperative sentence each. Max 3.",
    },
    references: {
      type: "array",
      items: { type: "string" },
      description:
        "Reference numbers, claim numbers, case IDs, phone numbers or addresses the recipient must quote. Max 4.",
    },
  },
  required: ["documentType", "deadline", "actions", "references"],
} as const;

export const EXTRACTION_PROMPT = `You read official letters for someone who is anxious and short on time.
Return only the structured fields. Rules:
- documentType: the single best category. A penalty or citation notice is a fine, not a bill.
- deadline: the most urgent actionable date in YYYY-MM-DD. Empty string if the letter states none. Never invent one.
- actions: at most 3, each a short imperative sentence a person can do this week.
- references: at most 4 identifiers the recipient must quote (claim, case, policy, phone, postal address).
Do not include names, diagnoses, amounts owed, or anything not needed to act on the letter.`;

/**
 * Schema for a targeted re-read: one field, plus the sentence it came from.
 *
 * Asking for the quote is the point. A value alone is another guess; a value the
 * model can point at in the letter can be checked by string comparison on our side,
 * which is what makes it safe to keep on device instead of escalating.
 */
export function focusedSchema(field: FieldKey) {
  const value =
    field === "actions" || field === "references"
      ? { type: "array", items: { type: "string" } }
      : field === "documentType"
        ? { type: "string", enum: ["denial", "lease", "benefit", "bill", "fine", "tax", "immigration", "other"] }
        : { type: "string" };
  return {
    type: "object",
    properties: {
      value,
      quote: {
        type: "string",
        description:
          "The exact sentence or clause from the letter that supports value, copied word for word. Empty string if the letter does not state it.",
      },
    },
    required: ["value", "quote"],
    additionalProperties: false,
  };
}

export function focusQuestion(field: FieldKey): string {
  switch (field) {
    case "documentType":
      return "What kind of official letter is this? One category.";
    case "deadline":
      return "What single date must the recipient act by? Answer YYYY-MM-DD, or an empty string if the letter states no date.";
    case "actions":
      return "What does the letter require the recipient to do? At most 3 short imperative sentences.";
    case "references":
      return "Which reference numbers, case IDs, policy numbers or phone numbers must the recipient quote? At most 4.";
  }
}

export const REREAD_PROMPT = `You are re-reading one official letter to settle a single uncertain field.
Answer only that field, and copy the supporting sentence verbatim into "quote".
If the letter does not answer it, return an empty value and an empty quote — do not guess.`;

export function parseFocused(raw: string): { value: string | string[]; quote: string } {
  let value: unknown;
  try {
    value = JSON.parse(stripFences(raw));
  } catch {
    throw new Error("Model did not return JSON");
  }
  if (!value || typeof value !== "object") throw new Error("Model returned a non-object");
  const obj = value as Record<string, unknown>;
  const quote = typeof obj.quote === "string" ? obj.quote.trim() : "";
  const rawValue = obj.value;
  if (Array.isArray(rawValue)) {
    return { value: toStringArray(rawValue), quote };
  }
  return { value: typeof rawValue === "string" ? rawValue.trim() : "", quote };
}

export function parseExtraction(raw: string): Extraction {
  let value: unknown;
  try {
    value = JSON.parse(stripFences(raw));
  } catch {
    throw new Error("Model did not return JSON");
  }
  if (!value || typeof value !== "object") throw new Error("Model returned a non-object");

  const obj = value as Record<string, unknown>;
  const documentType =
    typeof obj.documentType === "string" && obj.documentType.trim()
      ? obj.documentType.trim()
      : "other";
  const deadline =
    typeof obj.deadline === "string" && obj.deadline.trim() ? obj.deadline.trim() : null;
  const actions = toStringArray(obj.actions).slice(0, 3);
  const references = toStringArray(obj.references).slice(0, 4);

  return { documentType, deadline, actions, references };
}

function stripFences(text: string): string {
  const t = text.trim();
  if (!t.startsWith("```")) return t;
  return t.replace(/^```(?:json)?\s*/i, "").replace(/```$/, "").trim();
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((v): v is string => typeof v === "string")
    .map((v) => v.trim())
    .filter(Boolean);
}
