/**
 * Runs the tuning harness in real Chrome and saves tune-output.json.
 * Requires `npm run preview` (port 4173) and an installed on-device model.
 *
 *   node scripts/tune.mjs --k 5 --out tune-output-k5.json
 */
import puppeteer from "puppeteer-core";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const argOf = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const K = Number(argOf("k", "3"));
const OUT = argOf("out", "tune-output.json");

const exe = ["/usr/bin/google-chrome", "/usr/bin/chromium"].find((p) => existsSync(p));
const browser = await puppeteer.launch({
  executablePath: exe,
  userDataDir: process.env.SPIKE_PROFILE || join(process.cwd(), ".chrome-profile"),
  headless: false,
  ignoreDefaultArgs: [
    "--disable-background-networking",
    "--disable-component-extensions-with-background-pages",
    "--disable-features=Translate,AcceptCHFrame,MediaRouter,OptimizationHints,WebUIReloadButton,ProcessPerSiteUpToMainFrameThreshold,IsolateSandboxedIframes",
  ],
  args: ["--no-first-run", "--no-default-browser-check", "--disable-dev-shm-usage", "--window-size=1280,980"],
});

const page = await browser.newPage();
page.on("console", (m) => {
  const t = m.text();
  if (!/Built-In AI|Feedback/i.test(t)) console.log(`[page] ${t.slice(0, 120)}`);
});

await page.goto(`${process.env.APP_URL || "http://localhost:4173"}/tune.html?k=${K}`, {
  waitUntil: "domcontentloaded",
});

await page.waitForFunction(() => Boolean(window.__TUNE_RESULT__), { timeout: 900_000, polling: 2000 });
const result = await page.evaluate(() => window.__TUNE_RESULT__);

writeFileSync(OUT, JSON.stringify(result, null, 2));
const letters = result.letters ?? [];
const failed = letters.flatMap((l) =>
  l.samples.filter((s) => s.error).map((s) => `${l.id}: ${s.error}`),
);
console.log(`\nwrote ${OUT} — ${letters.length} letters × ${letters[0]?.samples.length ?? 0} samples (k=${result.k})`);
if (failed.length) console.log(`errors:\n  ${failed.join("\n  ")}`);

await browser.close();
