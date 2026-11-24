/**
 * Why does the model component download start and then vanish?
 * Runs Chrome with component-updater + optimization-guide logging and prints the
 * lines that matter.
 */
import puppeteer from "puppeteer-core";
import { existsSync } from "node:fs";
import { join } from "node:path";

const exe = ["/usr/bin/google-chrome", "/usr/bin/chromium"].find((p) => existsSync(p));
const userDataDir = process.env.SPIKE_PROFILE || join(process.cwd(), ".chrome-profile");

const browser = await puppeteer.launch({
  executablePath: exe,
  userDataDir,
  headless: false,
  ignoreDefaultArgs: [
    "--disable-background-networking",
    "--disable-component-extensions-with-background-pages",
    "--disable-features=Translate,AcceptCHFrame,MediaRouter,OptimizationHints,WebUIReloadButton,ProcessPerSiteUpToMainFrameThreshold,IsolateSandboxedIframes",
  ],
  args: [
    "--no-first-run",
    "--disable-dev-shm-usage",
    "--enable-logging=stderr",
    "--vmodule=component_updater*=2,optimization_guide*=2,on_device_model*=2,optimization_guide_keyed_service*=2",
  ],
});

const proc = browser.process();
const lines = [];
proc?.stderr?.on("data", (buf) => {
  for (const line of buf.toString().split("\n")) {
    if (/component|on.?device|model|gemini|error|fail/i.test(line)) lines.push(line.trim());
  }
});
proc?.stdout?.on("data", (buf) => {
  for (const line of buf.toString().split("\n")) {
    if (/component|on.?device|model|gemini|error|fail/i.test(line)) lines.push(line.trim());
  }
});

const page = await browser.newPage();
await page.goto("http://localhost:4173/spike.html?download=1", { waitUntil: "domcontentloaded" });
await new Promise((r) => setTimeout(r, 90_000));

const state = await page.evaluate(() => ({
  progress: document.getElementById("out")?.textContent?.match(/"downloadProgress": ([0-9.]+)/)?.[1] ?? "n/a",
}));
console.log(`downloadProgress after 90s: ${state.progress}`);

await browser.close();
console.log(`\n--- chrome log (${lines.length} matching lines) ---`);
console.log([...new Set(lines)].slice(-45).join("\n") || "(no matching lines)");
