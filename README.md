# Fine Print

**Understand the letter before you sign it — privately.**

Point Fine Print at an official letter (insurance denial, lease addendum, benefit notice, bill, parking penalty). It reads it **on your device** and returns a deadline, the actions it wants from you, and the references to quote. Anything the on-device model is unsure about is redacted and sent to Gemini for a second read — and the app shows you exactly how many characters left your machine.

Built for **#BuildHybridAI 2026** using hybrid inference: Gemini Nano 4 in Chrome for the reading, Gemini in the cloud only for the fields it is unsure about. Firebase AI Logic is used when configured; the same on-device model is reachable directly otherwise.

---

## Quick start (no keys, no model, no network)

```bash
npm install
npm run dev          # http://localhost:5173
```

Pick **Sample: insurance denial**, press **Read it**. What happens depends on what the browser has:

| Condition | Provider | Header says |
|---|---|---|
| Firebase env vars present | Firebase AI Logic (`PREFER_ON_DEVICE`) | `Firebase AI Logic` |
| No Firebase, Chrome has the built-in model | Chrome Prompt API, called directly | `Chrome Prompt API (local)` |
| Neither | synthetic samples from `src/lib/demoData.ts` | `demo mode` |

So a Chrome desktop machine with the model installed needs **no keys at all** to run the real on-device path — which is how the app was verified (`npm run verify:app`). The cloud second read always needs Firebase; without it the app says so instead of faking a cloud answer.

## Live mode

1. Firebase console → create a project → **Build > AI Logic** → Get started → choose the **Gemini Developer API** provider (free tier, no billing account).

   This entry uses the Firebase project **`fineprint-442cc`**. The project ID is a public identifier — it appears in every deployed bundle — so it is safe here; the API key and App Check token are not, and live only in `.env.local`, which is gitignored and never exported by `publish.sh`.
2. Register a Web app, copy the config.
3. App Check: in dev, let the debug provider run and copy the debug token from the browser console; in a hosted build use a reCAPTCHA v3 site key.
4. Create `.env.local` from `.env.example` and fill in the values.
5. `npm run dev`.

On the first “Read it” click the app calls `initializeDeviceModel()` inside the user gesture, which may download the on-device model (several minutes). Progress is shown inline.

## On-device requirements and the one manual step

Chrome **Desktop** 139+ (Linux, Windows, macOS, ChromeOS) with `chrome://flags/#prompt-api-for-gemini-nano-multimodal-input` set to **Enabled**, ~22 GB free disk, and either >4 GB VRAM or 16 GB RAM with 4+ cores. Chrome on Android/iOS cannot run this.

Two commands, in order:

```bash
npm run preview          # terminal 1
npm run install-model    # terminal 2 — downloads the ~2.5 GB model into .chrome-profile/
npm run spike            # terminal 2 — measures it, writes spike-output.json
```

`install-model` keeps one browser alive and re-triggers the component update, because an interrupted download does not resume by itself (Chromium issue 444200731). It prints progress every 10 s and exits when the weights are on disk. The profile at `.chrome-profile/` is gitignored, so this cost is paid once.

### Chrome 158 flag names (the docs are out of date)

`chrome://flags/#prompt-api-for-gemini-nano-multimodal-input` no longer exists. On Chrome 158 the real IDs are:

| Flag id | Value |
|---|---|
| `prompt-api` | Enabled |
| `prompt-api-multimodal-input` | Enabled |
| `gemma4-for-built-in-ai` | Enabled |
| `built-in-ai-mtp` | Enabled (multi-token prediction) |

`scripts/spike.mjs` writes exactly these into the profile's `Local State`, and `scripts/diag-chrome.mjs` confirms they are applied.

### Why it said “unavailable” — three separate causes, all fixed

**1. Puppeteer's default switches disabled the model service.** `chrome://version` showed the automation command line:

```
--disable-background-networking
--disable-features=...,OptimizationHints,...
```

`OptimizationHints` is the Optimization Guide — the service that both downloads and runs the on-device model. With it disabled, every call failed with *“Unable to create a text session because the service is not running”* on a machine that qualifies comfortably. Playwright's defaults do the same thing (the `web-ai-evals` project documents it).

Fix: `ignoreDefaultArgs` in `spike.mjs` / `install-model.mjs` for those defaults. `availability()` then returned `downloadable` and Chrome logged its Built-In AI notice.

**2. An interrupted download never resumes.** Chromium issue 444200731: close the browser mid-download and `create()` will not restart it — the *Check for update* button in `chrome://components` is the only recovery. Our early runs killed Chrome at 44 %/76 %, so each attempt threw the partial download away. `install-model.mjs` keeps one browser alive until the weights land.

**3. The model is 2.5 GB and lands in a non-obvious place.** With `gemma4-for-built-in-ai` enabled (which is how the hackathon's own FAQ says to get Nano 4 in Chrome), Chrome stores it under `OptGuideManifestModel/<hash>/<version>/weights.bin`, **not** `OptGuideOnDeviceModel/` — so the earlier “model dir missing” check was looking in the wrong place.

Also ruled out along the way: the GPU (driver 610.57.04, direct rendering, 12 GB, performance class 6), disk (64 GB free), policy (no `GenAILocalFoundationalModelSettings` restriction), and the legacy `Enabled BypassPerfRequirement` flag (removed in 158).

### Measured on this machine, real model (2026-11-23)

| Measurement | Result |
|---|---|
| Model installed | 2.48 GB `weights.bin`, component `2026.11.3.1140` |
| `LanguageModel.availability()` | still says `downloadable` **even when working** — never gate the UI on it |
| Session create (cold) | 2.9–3.8 s |
| Context window | 9,216 tokens (matches Firebase docs) |
| Schema-constrained text | 1.8–2.8 s, **valid JSON 3/3** |
| Image + schema | 2.57 s, valid JSON read off a rendered letter |
| k=3 samples | 858–1,495 ms each (~2.6–4.5 s total) |
| Real agreement on one letter | documentType 100 %, deadline 100 %, actions 100 %, references 67 % |

The references field dropped to 67 % because one sample wrote `claim 88-441902` instead of `Claim 88-4419-02` — exactly the kind of transcription noise the escalation gate exists for. On that capture, τ=0.70 sends precisely one field and keeps the other three local.

**App path verified too.** `npm run verify:app` drives the real UI (sample → Read it) in real Chrome: header reads *Chrome on-device model detected / Chrome Prompt API (local)*, result labelled `100% · on-device` on every field, no `demo data` anywhere.

**Firebase hybrid path verified with a real project.** With `VITE_FIREBASE_*` and a registered App Check debug token, the same flow reports provider `Firebase AI Logic` and still labels every settled field `100% · on-device` — so `PREFER_ON_DEVICE` really does route to Gemini Nano. Three bugs surfaced while proving it, all fixed and worth reading if you copy this pattern:

- Hybrid structured output is configured **per route**: `inCloudParams.generationConfig.responseSchema` for cloud, `onDeviceParams.promptOptions.responseConstraint` for the device. Passing them flat is silently ignored and the model answers in prose ("Model did not return JSON").
- The SDK reports `inferenceSource` as lowercase `"on_device"` / `"in_cloud"`. Comparing against uppercase made every local run look like a cloud run.
- The default request timeout is 180 s, which turns a saturated model into a three-minute hang; the cloud leg now uses 12 s and skips rungs that failed in the last 10 minutes.

### Capturing real numbers once the model runs

Press **Export run JSON** in the app after a read, then:

```bash
npm run eval:agreement -- fineprint-run-XXXX.json
```

It prints per-field agreement, latency mean/min/max, the escalation share for each τ, and the most sensitive τ that stays within a 20% escalation budget. That is the retune-with-real-data step; the synthetic evaluation below stays as the fallback.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Vite dev server |
| `npm run build` | `tsc --noEmit` + production build |
| `npm run preview` | serve the production build on :4173 |
| `npm run install-model` | install the ~2.5 GB on-device model into `.chrome-profile/` |
| `npm run spike` | drive Chrome at `/spike.html`, capture `spike-output.json` |
| `npm run eval:agreement` | evaluate agreement-based escalation on synthetic fixtures, recommend τ |
| `npm run eval:agreement -- <run.json>` | retune τ on a real run exported from the app |
| `npm run tune` | k=3 real on-device samples over 6 letters → `tune-output.json` |
| `npm run tune -- --k 5 --out tune-output-k5.json` | same at k=5, saved separately |
| `npm run eval:merge` | support-floor / similarity sweep over both captures (no model) |
| `npm run verify:reread` | drives the re-read in real Chrome and reports what was settled |
| `npm run verify:cloud` | drives the cloud second read, or proves it refuses without Firebase config |
| `npm run verify:e2e` | full user flow twice: re-read first, then forced cloud escalation |
| `npm run eval:tune` | score those samples against ground truth, sweep τ |
| `npm run verify:app` | drive the real UI in Chrome and report the actual provider |
| `node scripts/smoke.mjs` | demo-mode UI smoke test (needs `npm run preview`) |
| `node scripts/diag-on-device.mjs` | dump `chrome://on-device-internals` + `chrome://components` |
| `node scripts/diag-flags.mjs` | dump every Chrome flag id/state (shadow-DOM aware) |
| `node scripts/diag-chrome.mjs` | confirm applied flags + components |
| `node scripts/diag-internals.mjs` | read `chrome://on-device-internals` and the system setting |

## How it works

```
photo/text ─► Firebase AI Logic (PREFER_ON_DEVICE) or the raw Prompt API ─► k=3 samples, schema-constrained
                                                      │
                             field agreement ≥ τ ─────┴───── field agreement < τ
                                     │                              │
                          badge "on-device"                 redact → cloud second read
                                                                   │
                                                        receipt: chars sent + what was removed
```

- **Constrained decoding.** `LETTER_SCHEMA` is passed as `generationConfig.responseSchema` (and as `responseConstraint` in the raw Prompt API spike), so output cannot be malformed JSON.
- **Agreement instead of logprobs.** The Chrome Prompt API exposes no token logprobs, so confidence is estimated by sampling k times and measuring per-field agreement (`src/lib/agreement.ts`). Threshold: **τ = 0.99** with k=3 — escalate whenever the samples are not unanimous, after list items are clustered by meaning so that paraphrases count as agreement. Tuned on real model output, not just fixtures (see below).
- **Deterministic redaction.** `src/lib/redact.ts` strips emails, phone numbers, IBANs, card-like numbers, SSN/NI-style IDs and URLs *before* any cloud call. No model is involved, so it cannot hallucinate a removal.
- **Provenance.** `result.response.inferenceSource` (`ON_DEVICE` / `IN_CLOUD`) is read per response and surfaced in the UI.
- **Offline queue.** A second read requested offline is stored in `localStorage` and replayed automatically on reconnect.

## Measured: agreement as an escalation signal

`npm run eval:agreement` — 12 labelled cases, 4 fields each (48 field decisions), 5 runs per case, hand-built from ground truth with deliberate errors. This validates the **estimator**, not the model.

| k | τ | recall (real errors caught) | false-escalation rate | Youden's J |
|---|---|---|---|---|
| 3 | 0.70 | 50% | 18% | 0.32 |
| 5 | 0.65 | 67% | 4% | 0.62 |

- The estimator table says k=5 is better; the real model says otherwise — we ran it, got no recall gain for ~67% more on-device time, and ship k=3 (see below).
- **Blind spot:** 2 fields were wrong while all five samples agreed. Agreement cannot catch systematic errors — that needs a second model or a retrieval check, not more samples. Say this in the submission rather than overclaiming.
### Tuned on the real model

`npm run tune` runs k real on-device samples for six letters (denial, lease, bill, tax, benefit, penalty notice) and `npm run eval:tune` scores every field against authored ground truth: 24 field decisions. Both captures are committed — `tune-output.json` (k=3) and `tune-output-k5.json` (k=5); regenerate with `npm run tune -- --k 3`.

| τ | escalated | missed errors | wasted |
|---|---|---|---|
| 0.70 | 13% | 0 | 2 |
| 0.80 | 17% | 0 | 3 |
| **0.99** | **21%** | **0** | **4** |

k=5 on the same letters: 0.70 → 4% / 1 missed; 0.80 → 8% / 2 missed; 0.99 → 42% / 0 missed.

The real error is `tax/actions` in both captures: the model drops "pay the amount due" and offers only the objection. **We ship τ=0.99 — escalate unless unanimous** — because after the fixes below a disagreement means the samples differ in *content*, not in wording, which is exactly the condition worth a second read. It is the only setting that reaches 0 misses at both k. The cost is real and published: 21% of fields escalated at k=3, 42% at k=5 — which is another reason k=3 ships.

**k=5 verdict: not worth it.** Same 24 fields, 1,025–2,632 ms per sample vs 945–3,222 at k=3 — roughly 67% more on-device time per letter — and *no* recall gain: the remaining error is systematic, so more samples reproduce it rather than expose it. Stay at k=3.

### The bug this exposed

`src/lib/agreement.ts` keyed list items by exact normalised string. Five samples all asking to "confirm acceptance in writing" in five phrasings counted as five 1/k items, so **every one fell under the 0.5 support floor and was dropped from the merged checklist** — the app quietly lost a real action while reporting high agreement over the leftovers. Items are now clustered by character-bigram Dice similarity (`ITEM_MATCH = 0.5`), so paraphrases support one another and genuinely different actions still separate. That fix is why τ moved from 0.70 to 0.99: agreement numbers got more honest, and the old threshold was then calibrated against the wrong scale.

### Never hide a disagreement: the support floor

`scripts/merge-floor.mjs` sweeps the floor at which a list item is kept, offline, against both captures. The finding is not "pick a different floor" — it is that a floor alone cannot be trusted:

- At 0.67, agreement inflates to 1.0 whenever the one-off items are discarded, and **5 wrong fields stay local, unescalated.** Dropping evidence must never make a field look confident.
- Any discard now caps agreement at (k-1)/k, so a field with a discarded item always escalates. With that cap, from 0.33 up to 0.75 the escalation rate is flat at 15 of 48 fields, and **no wrong field stays local at any floor.**
- Lowering the floor to 1/3 recovered *no* action the 0.5 floor had dropped, and only added one-off items to the preview — so 0.5 stays.

Caveats: 24 decisions is a small sample, and errors can repeat identically across samples — **agreement measures variance, not bias.**

## Targeted re-read: settle one field on device

Escalating a field used to mean sending the redacted letter to the cloud. Now each uncertain field first gets one **focused on-device pass** with its own small schema: one question, plus a `quote` copied from the letter. The app accepts the answer only if that quote really appears in the letter text (`src/lib/grounding.ts`, punctuation- and line-break-insensitive, minimum four words, no fuzzy matching). A paraphrase is not accepted — that is exactly the case worth escalating.

Verified on the real installed model with `npm run verify:reread`: three samples flagged `actions` as uncertain, one focused pass returned a quote that matched the letter word for word, and the receipt read **"Nothing was sent to the cloud"** — zero characters, with the supporting sentence shown. The rule is deliberately small: retry the smallest unit, and only keep the retry when it can point at its evidence.

Honest limits: the quote proves the field is answerable from the letter, not that every list item is inside that one sentence. The pass costs one extra on-device generation per uncertain field.

## Per-item evidence on the checklist

Agreement and quotes judge a *field*. A single line inside a merged list can still be invented while the field looks settled, so every action and reference is now checked on its own against the letter (`src/lib/evidence.ts`): how many of its content words the letter contains, plus the closest sentence by bigram similarity. An item is flagged **no match in letter** only when it fails *both*, and the tooltip names the missing words and quotes the closest sentence.

The second test exists because word matching alone is known to be brittle on honest paraphrases. Measured over the 56 distinct items the real model produced across the six tuning letters: **3 flagged, all on the tax letter, and all three genuinely absent from it** ("Gather any supporting documentation", "Review the assessment details", "Prepare for payment by the deadline"). Nothing else was flagged. The label says "no match", never "wrong" — a paraphrase is a prompt to look, not proof of a hallucination.

## The full flow, measured

`npm run verify:e2e` drives the shipped UI twice in real Chrome, with the real model and the real project:

- **Pass 1, exactly what a user does.** Sample → *Read it* → *Send 2 uncertain fields for a second read*. Both uncertain fields (`actions`, `references`) were settled by the focused re-read, each with a quote checked against the letter. Badges became `on-device re-read · quoted`, the receipt read **"Nothing was sent to the cloud"**, and the network log showed **0** generative requests. That is the privacy claim, executed rather than asserted.
- **Pass 2, cloud forced.** Same read, re-read skipped. `gemini-3.8-flash` returned 500 high demand, the ladder stepped to `gemini-3.5-flash-lite`, and both fields came back as `cloud second read` — **579 redacted characters sent**, phone number removed, no errors.

So both legs are demonstrated on real infrastructure. Keep the two passes separate when recording: on this letter the honest default outcome is *nothing left the device*.

## Verifying the cloud leg

`npm run probe:cloud` is the cheap check: it loads `probe.html`, which sends one fixed, redacted payload through `escalate()` — **no on-device sampling, one cloud request**. Add `?models=1` to run the ladder health matrix instead: one tiny request per model, so the recording order is based on what answers today.

Measurements with a real project (2026-11-23, all free of charge on the Gemini Developer API):

| rung | health check | outcome |
|---|---|---|
| `gemini-3.8-flash` | 12 s timeout | unavailable that hour |
| `gemini-4-hydrogen` | 500 high demand | unavailable |
| `gemini-3.6-flash` | **6.1 s** | works |
| `gemini-3.5-flash-lite` | **1.2 s** | works |
| `gemini-3.1-flash-lite` | 12 s timeout | unavailable |
| `gemini-3.8-flash` (first run) | 500, then `3.5-flash-lite` answered in 8.5 s | fallback proven |

So the ladder is not decorative: on that day two of five free models were unusable and the app still answered. `VITE_AI_ESCALATION_LADDER` pins the order (comma-separated), which is how the recording uses today's working rungs first. A rung that fails is skipped for 10 minutes, so the second click never re-pays the timeout.

The trade-off is real and published: the cheap rungs are weaker — `gemini-3.5-flash-lite` missed the probe letter's deadline (returned null), which is why the strong model heads the default ladder.

Below is the older, heavier check.

The cloud read fails closed. `npm run verify:cloud` with no `VITE_FIREBASE_*` config reports: provider `Chrome Prompt API (local)`, the error *"The cloud second read needs Firebase AI Logic configured"*, and **zero generative requests** in the page's network log. That is deliberate — there is no anonymous Firebase path, so the app cannot pretend to have called a cloud model. With a project configured, the same script expects `cloud second read` badges *and* a request to a generative endpoint, and fails if either is missing. `?forceCloud=1` skips the re-read so the cloud leg is reachable on demand; it is a verification switch, not part of the normal flow.

## Limitations (say these out loud)

- Web on-device inference is **single-turn only**, max 9,216 tokens, no tools, no logprobs.
- No OCR: the app reads text you paste, or an image passed to the model. A PDF parser is out of scope.
- Documents are never persisted; only the queued escalation payload touches `localStorage`, and only while offline.
- Free-tier cloud limits are tight (roughly 20 requests/day on `gemini-3.8-flash`, ~500/day on `gemini-3.5-flash-lite`, observed in AI Studio and not guaranteed). Demo mode exists partly so a rehearsal cannot burn the quota.
- **Never record the submission video in demo mode.** The video must show the real on-device + cloud path.

## Deploy

The app is a static `vite build` output; deploy notes are kept in the private workspace. Nothing in this repo authenticates on your behalf.

## License

Apache-2.0. See `LICENSE`.
