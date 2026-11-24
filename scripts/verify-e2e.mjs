/**
 * End-to-end check of the shipped flow in real Chrome, with the real model and the real
 * cloud, exactly as a user drives it:
 *
 *   pass 1 — sample letter → Read it (k on-device samples) → second read:
 *            the app re-reads each uncertain field on device, keeps the grounded ones and
 *            escalates only what it could not quote.
 *   pass 2 — ?forceCloud=1 → same read, but the re-read is skipped so the cloud leg is
 *            exercised deterministically.
 *
 * Reports chips, receipt, errors and every generative request the page made.
 */
import puppeteer from "puppeteer-core";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const envLocal = join(process.cwd(), ".env.local");
if (existsSync(envLocal)) {
  for (const line of readFileSync(envLocal, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
const base = process.env.APP_URL || "http://localhost:4173";

const browser = await puppeteer.launch({
  executablePath: "/usr/bin/google-chrome",
  userDataDir: process.env.SPIKE_PROFILE || join(process.cwd(), ".chrome-profile"),
  headless: false,
  protocolTimeout: 420_000,
  ignoreDefaultArgs: [
    "--disable-background-networking",
    "--disable-component-extensions-with-background-pages",
    "--disable-features=Translate,AcceptCHFrame,MediaRouter,OptimizationHints,WebUIReloadButton,ProcessPerSiteUpToMainFrameThreshold,IsolateSandboxedIframes",
  ],
  args: ["--no-first-run", "--no-default-browser-check", "--disable-dev-shm-usage", "--window-size=1280,980"],
});

const page = await browser.newPage();
const pageErrors = [];
const consoleWarnings = [];
const calls = [];
page.on("pageerror", (e) => pageErrors.push(e.message));
page.on("console", (m) => {
  if (m.type() === "warn" || m.type() === "error") consoleWarnings.push(m.text().slice(0, 160));
});
page.on("request", (r) => {
  if (/firebasevertexai|generativelanguage/.test(r.url())) calls.push(`${r.method()} ${r.url().split("/").pop()}`);
});

const click = (re) =>
  page.evaluate((src) => {
    const rx = new RegExp(src, "i");
    const btn = [...document.querySelectorAll("button")].find((b) => rx.test(b.textContent ?? ""));
    btn?.click();
    return Boolean(btn);
  }, re.source);

const state = () =>
  page.evaluate(() => ({
    chips: [...document.querySelectorAll(".chip")].map((c) => c.textContent.replace(/\s+/g, " ").trim()),
    receipt: document.querySelector(".panel--receipt")?.innerText.replace(/\s+/g, " ").trim() ?? "",
    error: document.querySelector(".error")?.textContent?.trim() ?? "",
    flags: [...document.querySelectorAll(".item-flag")].length,
    fields: document.querySelector(".fields")?.innerText.replace(/\s+/g, " ").slice(0, 220) ?? "",
    button: [...document.querySelectorAll("button")]
      .map((b) => b.textContent.replace(/\s+/g, " ").trim())
      .find((t) => /second read/i.test(t)) ?? null,
    provider: document.body.innerText.match(/(Firebase AI Logic|Chrome Prompt API[^\n]*)/)?.[0] ?? "?",
  }));

async function readAndSettle(url, label) {
  await page.goto(url, { waitUntil: "networkidle2" });
  await click(/insurance denial/);
  await click(/^read it$/);
  const readOk = await page
    .waitForFunction(() => document.querySelector(".fields")?.textContent?.includes("20"), { timeout: 300_000 })
    .then(() => true)
    .catch(() => false);
  const afterRead = await state();
  console.log(`\n=== ${label} ===`);
  console.log(`provider:  ${afterRead.provider}`);
  if (!readOk) {
    console.log(`READ FAILED: error=${JSON.stringify(afterRead.error)}`);
    console.log(`page errors: ${pageErrors.slice(-3).join(" | ") || "(none)"}`);
    return null;
  }
  console.log(`chips:     ${JSON.stringify(afterRead.chips)}`);
  console.log(`button:    ${afterRead.button}`);
  console.log(`fields:    ${afterRead.fields}`);

  if (afterRead.button) {
    const beforeCalls = calls.length;
    await click(/second read/);
    await page
      .waitForFunction(
        () =>
          document.querySelector(".panel--receipt") ||
          document.querySelector(".chip")?.textContent?.includes("cloud") ||
          Boolean(document.querySelector(".error:not(:empty)")),
        { timeout: 300_000 },
      )
      .catch(() => {});
    await new Promise((r) => setTimeout(r, 1500));
    const done = await state();
    console.log(`chips +:   ${JSON.stringify(done.chips)}`);
    console.log(`flags:     ${done.flags} item(s) with no match in letter`);
    console.log(`receipt:   ${done.receipt || "(none)"}`);
    console.log(`error:     ${done.error || "(none)"}`);
    console.log(`cloud req: ${calls.length - beforeCalls}`);
    return done;
  }
  console.log("second read: not offered (everything settled)");
  return afterRead;
}

const normal = await readAndSettle(`${base}/`, "pass 1 — normal flow (re-read first)");
const forced = await readAndSettle(`${base}/?forceCloud=1`, "pass 2 — forced cloud escalation");

console.log("\n=== summary ===");
console.log(`on-device labels in pass 1: ${normal ? normal.chips.filter((c) => /on-device/.test(c)).length : 0}`);
console.log(`cloud labels in pass 2:     ${forced ? forced.chips.filter((c) => /cloud/.test(c)).length : 0}`);
console.log(`generative calls total:     ${calls.length} (${calls.join(", ") || "none"})`);
if (consoleWarnings.length) console.log(`console warnings: ${consoleWarnings.slice(-4).join(" | ")}`);
if (pageErrors.length) console.log(`page errors: ${pageErrors.slice(-3).join(" | ")}`);

await browser.close();
