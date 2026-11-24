export type FieldKey = "documentType" | "deadline" | "actions" | "references";

export type Source = "ON_DEVICE" | "IN_CLOUD" | "MOCK";

export interface Extraction {
  documentType: string;
  deadline: string | null;
  actions: string[];
  references: string[];
}

export interface ExtractionRun {
  extraction: Extraction;
  source: Source;
  latencyMs: number;
  /** Cloud model that answered, when the escalation ladder stepped down. */
  model?: string;
}

export interface FieldScore {
  key: FieldKey;
  value: string | string[] | null;
  /** Fraction of the k runs that agreed with the chosen value, 0..1. */
  agreement: number;
  /** Normalised values produced by each run, in run order. */
  perRun: (string | string[] | null)[];
  /** List fields: items seen so rarely they were left out of the merged answer. */
  dropped?: number;
}

export interface ScoredExtraction {
  fields: FieldScore[];
  overall: number;
  runs: ExtractionRun[];
}

export interface RedactionResult {
  text: string;
  /** Human labels for what was removed, e.g. "email address". */
  removed: string[];
  charsIn: number;
  charsOut: number;
}
