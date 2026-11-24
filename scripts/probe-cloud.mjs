/**
 * Verifies the cloud escalation leg with one cloud request and no on-device sampling.
 *
 * Loads /probe.html, which sends a fixed letter-shaped payload through the same
 * redact → buildEscalationPayload → escalate path the app uses, and reports the JSON,
 * which model answered, the latency and any error.
 *
 * Requires a built preview: npm run build && npm run preview
 * Usage: node scripts/probe-cloud.mjs [url]
 */
import puppeteer from "puppeteer-core";
import { join } from "node:path";

const base = process.argv[2] || process.env.APP_URL || "http://localhost:4173";
const browser = await puppeteer.launch({
  executablePath: "/usr/bin/google-chrome",
  userDataDir: process.env.SPIKE_PROFILE || join(process.cwd(), ".chrome-profile"),
  headless: false,
  protocolTimeout: 180_000,
  ignoreDefaultArgs: [
    "--disable-background-networking",
    "--disable-component-extensions-with-background-pages",
    "--disable-features=Translate,AcceptCHFrame,MediaRouter,OptimizationHints,WebUIReloadButton,ProcessPerSiteUpToMainFrameThreshold,IsolateSandboxedIframes",
  ],
  args: ["--no-first-run", "--no-default-browser-check", "--disable-dev-shm-usage"],
});

const page = await browser.newPage();
page.on("console", (m) => {
  const text = m.text();
  if (/fineprint|AppCheck/i.test(text)) console.log(`console: ${text}`);
});
const requests = [];
page.on("request", (r) => {
  if (/firebasevertexai|generativelanguage/.test(r.url())) requests.push(r.method());
});

await page.goto(`${base}/probe.html`, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => window.probeResult !== undefined, { timeout: 120_000 }).catch(() => {});
const result = await page.evaluate(() => window.probeResult ?? { ok: false, error: "no result after 120s" });

console.log(JSON.stringify(result, null, 2));
console.log(`generative calls: ${requests.length ? requests.join(", ") : "none"}`);
const pass = Boolean(result?.ok) && result?.source === "IN_CLOUD" && requests.length > 0;
console.log(`verdict: ${pass ? "PASS — the cloud leg answered with schema JSON" : "FAIL — see error above"}`);
await browser.close();
process.exit(pass ? 0 : 1);
