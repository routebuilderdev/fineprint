/**
 * The submission take, in one continuous screencast.
 *
 * It covers the claims the hackathon asks a video to carry, in the order they are easiest
 * to believe: chrome-on-device read, the checklist, the same letter read with the network
 * switched off at the browser level, the local re-read that sends nothing, the forced
 * cloud leg with the exact payload shown, then the measured numbers and the limits.
 *
 * Every number on the cards is from the project's own measurements: τ=0.99 over six
 * letters escalated 21% of fields with no missed errors; k=5 cost 67% more on-device time
 * for the same recall; two of five free cloud models were unusable during one health check.
 */

export const TITLE_CARD = {
  kicker: "FINE PRINT · #BUILDHYBRIDAI 2026",
  title: "The letters people are afraid to open.",
  lines: [
    "An insurance denial, read on this laptop by Chrome's own model — Gemini Nano, through Firebase AI Logic.",
    "The network stays out of it unless a field genuinely cannot be settled, and the exact payload is always on screen.",
  ],
  footer: "one letter · two paths · nothing leaves unless you watch it leave",
};

export const NUMBERS_CARD = {
  kicker: "MEASURED, NOT ASSERTED",
  title: "Six real letters, scored.",
  stats: [
    { v: "0.99", l: "agreement threshold" },
    { v: "21%", l: "of fields escalated" },
    { v: "0", l: "wrong fields left on device" },
    { v: "k=5", l: "67% more device time, same recall" },
  ],
  lines: [
    "Three on-device samples per field; a field below the threshold is what earns an escalation.",
    "Cheapest first: a focused on-device re-read that must quote the letter, then one redacted cloud request.",
  ],
  footer: "agreement is the confidence signal — Chrome's Prompt API exposes no logprobs",
};

export const LIMITS_CARD = {
  kicker: "LIMITS, PLAINLY",
  title: "What this design cannot do.",
  lines: [
    "A grounded quote proves a field is answerable from the letter — not that every returned item sits inside that sentence.",
    "Agreement catches disagreement, not a mistake all three passes repeat. That is the error class it misses.",
    "On-device reading is Chrome-only and English-first, and it handles one short letter at a time.",
    "Cloud capacity is external: in one health check two of five free models were unusable, which is why the ladder exists.",
  ],
  footer: "the numbers above are measured; these are the failure modes they do not cover",
};

export const END_CARD = {
  kicker: "FINE PRINT · #BUILDHYBRIDAI 2026",
  title: "Free, offline, and nothing leaves unless you can see it leave.",
  lines: [
    "Gemini Nano in Chrome does the reading. Firebase AI Logic carries the one redacted request when the device cannot settle a field.",
    "Apache-2.0, with the measured numbers and the limits published alongside it.",
  ],
  footer: "on-device by default · cloud only for what it cannot settle",
};
