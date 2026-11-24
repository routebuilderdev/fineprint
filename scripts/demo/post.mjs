/**
 * Adds a voiceover to the recorded take.
 *
 * Captions are already in the frames — they are drawn inside the page while recording —
 * so this only places narration: one edge-tts clip per caption, timed from the moment
 * that caption appeared. Each clip is measured and, if it overruns its slot, sped up
 * (atempo) rather than cut.
 *
 *   node scripts/demo/post.mjs
 *
 * Inputs:  .tmp/demo/take.mp4, .tmp/demo/timeline.json
 * Output:  .tmp/demo/fine-print-demo.mp4
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const OUT = join(process.cwd(), ".tmp", "demo");
const WORK = join(OUT, "post");
mkdirSync(WORK, { recursive: true });

const EDGE_TTS = [
  process.env.EDGE_TTS,
  join(homedir(), ".local", "bin", "edge-tts"),
  "/usr/bin/edge-tts",
].find((p) => p && existsSync(p));
if (!EDGE_TTS) throw new Error("edge-tts not found (pipx install edge-tts)");

const VOICE = process.env.VOICE || "en-US-AriaNeural";
const SOURCE = join(OUT, "take.mp4");

const probe = (file, entries) =>
  Number(
    execFileSync("ffprobe", ["-v", "error", "-show_entries", entries, "-of", "csv=p=0", file])
      .toString()
      .trim()
      .split(",")[0],
  );

const total = probe(SOURCE, "format=duration");
const { timeline } = JSON.parse(readFileSync(join(OUT, "timeline.json"), "utf8"));

/** Spoken wording per caption. Shorter than the on-screen text on purpose: it is heard. */
const SCRIPT = {
  "CARD · TITLE":
    "Fine Print reads the letters people are afraid to open. On the device, in Chrome.",
  "STEP 1 / 8 · THE LETTER":
    "An insurance denial. It decides money, and it sets a deadline.",
  "STEP 2 / 8 · READ ON THIS LAPTOP":
    "Chrome's own model reads it here. Three passes, on this laptop, with no request leaving it.",
  "STEP 3 / 8 · WHAT IT SAYS":
    "Out come the deadline, the actions, and the reference to quote, each with the agreement behind its badge.",
  "STEP 4 / 8 · NETWORK OFF":
    "Now the network is off at the browser. A different letter still reads. This is the part a cloud-only app cannot do.",
  "STEP 5 / 8 · THE UNCERTAIN FIELD":
    "Back online, the denial again. The field that disagreed gets one focused re-read, and the quote has to be word for word. It is. Nothing was sent to the cloud.",
  "STEP 6 / 8 · THE CLOUD LEG":
    "Now the cloud leg, forced for this take, so you can see what happens when the device genuinely cannot settle a field.",
  "STEP 7 / 8 · THE EXACT PAYLOAD":
    "This is the entire request: five hundred and seventy nine characters, and the phone number was replaced before it left.",
  "CARD · NUMBERS":
    "Six real letters at a threshold of zero point nine nine: twenty one percent of fields escalated, and no wrong field stayed on the device.",
  "CARD · LIMITS":
    "And the limits are real. A quote proves the answer is in the letter; agreement cannot catch a mistake that all three passes repeat.",
  "CARD · END":
    "Fine Print. Free, offline, and nothing leaves unless you can see it leave.",
};

const captionBeats = new Map();
for (const entry of timeline) {
  if (/^(STEP |CARD )/.test(entry.name ?? "")) captionBeats.set(entry.name, entry);
}
const slots = [...captionBeats.values()]
  .sort((a, b) => a.atMs - b.atMs)
  .map((entry) => ({ name: entry.name, start: entry.atMs / 1000, say: SCRIPT[entry.name] ?? entry.caption }));

if (!slots.length) throw new Error("the timeline has no caption beats");
if (!slots[0].say) throw new Error(`no script for ${slots[0].name}`);

for (const [i, slot] of slots.entries()) {
  slot.end = slots[i + 1]?.start ?? total;
}

slots.forEach((slot, i) => {
  const file = join(WORK, `line-${i}.mp3`);
  execFileSync(EDGE_TTS, ["--text", slot.say, "--voice", VOICE, "--write-media", file, "--no-progress"], {
    stdio: "ignore",
  });
  slot.audio = file;
  slot.duration = probe(file, "format=duration");
  const room = Math.max(slot.end - slot.start - 0.3, 0.6);
  slot.tempo = Math.min(Math.max(slot.duration / room, 1), 1.35);
});

const chain = slots.map((slot, i) => {
  const delay = Math.round(slot.start * 1000);
  const filters = [`adelay=${delay}|${delay}`];
  if (slot.tempo > 1.01) filters.unshift(`atempo=${slot.tempo.toFixed(3)}`);
  return `[${i + 1}:a]${filters.join(",")}[v${i}]`;
});

const filter = [
  ...chain,
  `${slots.map((_, i) => `[v${i}]`).join("")}amix=inputs=${slots.length}:normalize=0,apad,atrim=0:${total.toFixed(2)}[aout]`,
].join(";");

const final = join(OUT, "fine-print-demo.mp4");
execFileSync("ffmpeg", [
  "-y", "-v", "error",
  "-i", SOURCE,
  ...slots.flatMap((slot) => ["-i", slot.audio]),
  "-filter_complex", filter,
  "-map", "0:v", "-map", "[aout]",
  "-c:v", "copy",
  "-c:a", "aac", "-b:a", "128k",
  "-movflags", "+faststart",
  "-t", total.toFixed(2),
  final,
]);

for (const [i, slot] of slots.entries()) {
  console.log(`line ${i + 1}: ${slot.start.toFixed(1)}s → ${slot.end.toFixed(1)}s · ${slot.duration.toFixed(1)}s @ ${slot.tempo.toFixed(2)}x`);
}
console.log(`duration: ${total.toFixed(2)}s`);
console.log(`video:    ${final}`);
