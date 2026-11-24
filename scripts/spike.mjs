import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import puppeteer from "puppeteer-core";

const CANDIDATES = [
  process.env.CHROME_PATH,
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/opt/google/chrome/chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
].filter(Boolean);

const executablePath = CANDIDATES.find((p) => existsSync(p));
if (!executablePath) {
  console.error("No Chrome binary found. Set CHROME_PATH.");
  process.exit(1);
}

const url = process.argv[2] || "http://localhost:4173/spike.html";
const version = execSync(`"${executablePath}" --version`).toString().trim();
console.log(`chrome: ${version}`);
console.log(`url: ${url}`);

// Chrome stores chrome://flags selections in the profile's "Local State". Writing it
// directly is how the documented flag gets enabled without a human clicking.
// IDs read from chrome://flags on Chrome 158 (the docs still name an older flag).
// A persistent profile keeps the ~4 GB model download between runs.
const userDataDir = process.env.SPIKE_PROFILE || join(process.cwd(), ".chrome-profile");
mkdirSync(userDataDir, { recursive: true });
writeFileSync(
  join(userDataDir, "Local State"),
  JSON.stringify(
    {
      browser: {
        enabled_labs_experiments: [
          "prompt-api@1",
          "prompt-api-multimodal-input@1",
          "gemma4-for-built-in-ai@1",
          "built-in-ai-mtp@1",
        ],
      },
    },
    null,
    2,
  ),
);
console.log(`profile: ${userDataDir}`);

// Root cause of "Unable to create a text session because the service is not running":
// Puppeteer's default args disable background networking and, crucially, include
// OptimizationHints in --disable-features. The on-device model is fetched and run by
// the Optimization Guide service, so with those defaults the service never starts and
// availability() reports "unavailable" on a machine that comfortably qualifies.
const browser = await puppeteer.launch({
  executablePath,
  userDataDir,
  headless: false,
  ignoreDefaultArgs: [
    "--disable-background-networking",
    "--disable-component-extensions-with-background-pages",
    "--disable-features=Translate,AcceptCHFrame,MediaRouter,OptimizationHints,WebUIReloadButton,ProcessPerSiteUpToMainFrameThreshold,IsolateSandboxedIframes",
  ],
  args: ["--disable-dev-shm-usage", "--no-first-run", "--no-default-browser-check", "--window-size=1280,900"],
});

let code = 0;
try {
  const page = await browser.newPage();
  page.on("console", (msg) => console.log(`[page] ${msg.text()}`));
  page.on("pageerror", (err) => console.log(`[pageerror] ${err.message}`));

  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
  const waitMs = Number(process.env.SPIKE_WAIT_MS || (url.includes("download=1") ? 1_500_000 : 240_000));
  console.log(`waiting up to ${Math.round(waitMs / 1000)}s for the harness…`);
  await page.waitForFunction(() => Boolean(window.__SPIKE_RESULT__), { timeout: waitMs });

  const result = await page.evaluate(() => window.__SPIKE_RESULT__);
  writeFileSync("spike-output.json", JSON.stringify(result, null, 2));
  console.log("\n--- SPIKE RESULT ---");
  console.log(JSON.stringify(result, null, 2));

  if (result?.fatal || result?.error) code = 2;
} catch (err) {
  console.error("spike failed:", err.message);
  code = 1;
} finally {
  await browser.close();
}
process.exit(code);
