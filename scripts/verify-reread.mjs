/**
 * Drives the targeted re-read in real Chrome with the installed on-device model.
 *
 * It clicks exactly what a user clicks (Read it → second read) and reports the badges,
 * which only say "on-device re-read" when the model's answer came with a quote that we
 * verified against the letter text. No Firebase in .env.local means the fields it could
 * not ground are expected to fail at the cloud step — that failure is the proof the two
 * paths are separate.
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

await page.goto(process.env.APP_URL || "http://localhost:4173/", { waitUntil: "networkidle2" });

await page.evaluate(() => {
  const btn = [...document.querySelectorAll("button")].find((b) => /insurance denial/i.test(b.textContent ?? ""));
  btn?.click();
});
await page.evaluate(() => {
  const btn = [...document.querySelectorAll("button")].find((b) => /^read it$/i.test(b.textContent.trim()));
  btn?.click();
});
await page.waitForFunction(() => document.querySelector(".fields")?.textContent?.includes("20"), { timeout: 240_000 });

const before = await page.evaluate(() => ({
  chips: [...document.querySelectorAll(".chip")].map((c) => c.textContent.replace(/\s+/g, " ").trim()),
  button: [...document.querySelectorAll("button")]
    .map((b) => b.textContent.replace(/\s+/g, " ").trim())
    .find((t) => /second read/i.test(t)) ?? null,
}));
console.log(`chips before: ${JSON.stringify(before.chips)}`);
console.log(`button:       ${before.button}`);

await page.evaluate(() => {
  const btn = [...document.querySelectorAll("button")].find((b) => /second read/i.test(b.textContent ?? ""));
  btn?.click();
});

await page
  .waitForFunction(
    () =>
      [...document.querySelectorAll(".chip")].some((c) => /on-device re-read/i.test(c.textContent ?? "")) ||
      Boolean(document.querySelector(".error:not(:empty)")),
    { timeout: 240_000 },
  )
  .catch(() => {});

const after = await page.evaluate(() => ({
  chips: [...document.querySelectorAll(".chip")].map((c) => c.textContent.replace(/\s+/g, " ").trim()),
  receipt: document.querySelector(".panel--receipt")?.innerText.replace(/\s+/g, " ").trim() ?? "",
  error: document.querySelector(".error")?.textContent?.trim() ?? "",
  values: [...document.querySelectorAll(".fields li")].map((li) =>
    li.innerText.replace(/\s+/g, " ").trim().slice(0, 90),
  ),
}));

console.log(`chips after:  ${JSON.stringify(after.chips)}`);
console.log(`values:       ${JSON.stringify(after.values, null, 0)}`);
console.log(`receipt:      ${after.receipt || "(none)"}`);
console.log(`error:        ${after.error || "(none)"}`);
if (errors.length) console.log(`page errors:  ${errors.slice(0, 3).join(" | ")}`);

await browser.close();
