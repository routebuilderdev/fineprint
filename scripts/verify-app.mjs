/**
 * Drives the real app UI in real Chrome and reports what actually produced the result.
 * Proves the app path (not just the spike page) is running the on-device model.
 */
import puppeteer from "puppeteer-core";
import { existsSync } from "node:fs";
import { join } from "node:path";

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
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});

await page.goto(process.env.APP_URL || "http://localhost:4173/", { waitUntil: "networkidle2" });

const header = await page.$eval(".status", (el) => el.textContent.replace(/\s+/g, " ").trim());
console.log(`header: ${header}`);

const clicked = await page.evaluate(() => {
  const btn = [...document.querySelectorAll("button")].find((b) =>
    /insurance denial/i.test(b.textContent ?? ""),
  );
  btn?.click();
  return Boolean(btn);
});
console.log(`sample loaded: ${clicked}`);

await page.evaluate(() => {
  const btn = [...document.querySelectorAll("button")].find((b) => /^read it$/i.test(b.textContent.trim()));
  btn?.click();
});

const deadline = await page
  .waitForFunction(() => document.querySelector(".fields")?.textContent?.includes("20"), { timeout: 240_000 })
  .then(() => true)
  .catch(() => false);

const state = await page.evaluate(() => ({
  status: document.querySelector(".status")?.textContent?.replace(/\s+/g, " ").trim(),
  progress: document.querySelector(".progress")?.textContent?.trim() ?? "",
  deadline: document.querySelector(".fields")?.textContent?.replace(/\s+/g, " ").trim().slice(0, 220) ?? "",
  chips: [...document.querySelectorAll(".chip, .badge")].map((c) => c.textContent.trim()).slice(0, 8),
  bodyHasDemo: /demo data/i.test(document.body.innerText),
  escalateButton: [...document.querySelectorAll("button")]
    .map((b) => b.textContent.trim())
    .find((t) => /second read/i.test(t)) ?? null,
}));

console.log(`finished: ${deadline}`);
console.log(`status:   ${state.status}`);
console.log(`deadline: ${state.deadline}`);
console.log(`chips:    ${JSON.stringify(state.chips)}`);
console.log(`demo:     ${state.bodyHasDemo}`);
console.log(`escalate: ${state.escalateButton}`);
if (errors.length) console.log(`errors:   ${errors.slice(0, 3).join(" | ")}`);

await browser.close();
