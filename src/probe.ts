/**
 * Cloud probe: exercises the escalation leg with one cloud request and no on-device
 * sampling, so verifying "can we reach Gemini" never costs a GPU run.
 *
 * Loaded by probe.html. It sends the same shape the app sends — redaction first, then the
 * escalation payload — and prints the JSON, the model that answered, the latency and any
 * error. Nothing is stored and no letter is read from the device.
 */
import {
  escalate,
  isFirebaseConfigured,
  escalationLadder,
  probeCloudModels,
} from "./lib/hybrid";
import { buildEscalationPayload, redact } from "./lib/redact";

const LETTER = `Revenue Office — Assessment Notice
Reference CP-5012-88

Your return for the year ended 2026-04-05 has been assessed. The amount payable is
$1,284.00 and must reach us by 2027-01-31. Interest accrues daily after that date.

If you disagree with this assessment, file a formal objection within 30 days of this
notice. Quote reference CP-5012-88 on all correspondence and payments.`;

const out = document.getElementById("out") as HTMLElement | null;

function render(value: unknown) {
  const text = JSON.stringify(value, null, 2);
  if (out) out.textContent = text;
  const pre = document.createElement("pre");
  pre.id = "probe-json";
  pre.textContent = text;
  pre.style.display = "none";
  document.body.appendChild(pre);
  (window as unknown as { probeResult: unknown }).probeResult = value;
}

async function main() {
  const redacted = redact(LETTER, []);
  const payload = buildEscalationPayload(redacted.text, ["actions", "references"]);
  const startedAt = performance.now();

  // ?models=1 asks every rung in the ladder one tiny question, so the recording order is
  // based on what answers today rather than on what the docs say should.
  if (new URLSearchParams(location.search).get("models") === "1") {
    const health = await probeCloudModels(payload);
    render({
      ok: health.some((h) => h.ok),
      mode: "ladder-health",
      ladder: escalationLadder(),
      working: health.filter((h) => h.ok).map((h) => h.model),
      health,
    });
    return;
  }
  try {
    const run = await escalate(payload);
    render({
      ok: true,
      configured: isFirebaseConfigured(),
      ladder: escalationLadder(),
      answeredBy: run.model,
      source: run.source,
      latencyMs: run.latencyMs,
      totalMs: Math.round(performance.now() - startedAt),
      charsSent: redacted.charsOut,
      extraction: run.extraction,
    });
  } catch (err) {
    render({
      ok: false,
      configured: isFirebaseConfigured(),
      ladder: escalationLadder(),
      error: err instanceof Error ? err.message : String(err),
      charsSent: redacted.charsOut,
    });
  }
}

void main();
