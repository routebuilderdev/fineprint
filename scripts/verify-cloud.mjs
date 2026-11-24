/**
 * Drives the cloud second read in real Chrome and reports exactly what happened.
 *
 * Two honest outcomes, no third:
 *  - Firebase configured: the escalated fields come back from the cloud model and the
 *    badges read "cloud second read". The script also records every request the page
 *    makes to a generative endpoint, so the receipt's character count can be checked
 *    against reality.
 *  - Firebase not configured: the app must refuse, name the missing configuration, and
 *    no generative request may leave the page. That refusal is the fail-closed proof.
 *
 * ?forceCloud=1 skips the on-device re-read so the cloud leg is reachable even when the
 * re-read would settle every uncertain field.
 */
import puppeteer from "puppeteer-core";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Vite reads .env.local at build time; read the same file so the report matches the build.
const envLocal = join(process.cwd(), ".env.local");
if (existsSync(envLocal)) {
  for (const line of readFileSync(envLocal, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

const configured = ["VITE_FIREBASE_API_KEY", "VITE_FIREBASE_PROJECT_ID", "VITE_FIREBASE_APP_ID"].every(
  (k) => {
    const v = process.env[k];
    return v && v.trim().length > 0;
  },
);
console.log(`env keys present: ${configured ? "yes" : "no"}${existsSync(envLocal) ? " (.env.local exists)" : " (no .env.local)"}`);
if (!configured) {
  console.log(
    "cloud leg: NOT exercised — Firebase AI Logic has no anonymous path; it needs a project's\n" +
      "web config (VITE_FIREBASE_API_KEY, VITE_FIREBASE_AUTH_DOMAIN, VITE_FIREBASE_PROJECT_ID,\n" +
      "VITE_FIREBASE_APP_ID) in .env.local, or the same values in the environment.",
  );
}

const exe = ["/usr/bin/google-chrome", "/usr/bin/chromium"].find((p) => existsSync(p));
const browser = await puppeteer.launch({
  executablePath: exe,
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
const errors = [];
const aiRequests = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("request", (req) => {
  const url = req.url();
  if (/generativelanguage|aiplatform|firebasevertexai|googleapis\.com\/v1/.test(url)) {
    aiRequests.push(`${req.method()} ${url.split("?")[0]}`);
  }
});

await page.goto(`${process.env.APP_URL || "http://localhost:4173/" }?forceCloud=1`, {
  waitUntil: "networkidle2",
});
const provider = await page.evaluate(() => document.body.innerText.match(/(Firebase AI Logic|Chrome Prompt API[^\n]*)/)?.[0] ?? "(unknown)");
console.log(`provider:         ${provider}`);

await page.evaluate(() => {
  const btn = [...document.querySelectorAll("button")].find((b) => /insurance denial/i.test(b.textContent ?? ""));
  btn?.click();
});
await page.evaluate(() => {
  const btn = [...document.querySelectorAll("button")].find((b) => /^read it$/i.test(b.textContent.trim()));
  btn?.click();
});
const readOk = await page
  .waitForFunction(() => document.querySelector(".fields")?.textContent?.includes("20"), {
    timeout: 240_000,
  })
  .then(() => true)
  .catch(() => false);
if (!readOk) {
  const state = await page.evaluate(() => ({
    error: document.querySelector(".error")?.textContent?.trim() ?? "",
    progress: [...document.querySelectorAll(".muted")].map((p) => p.textContent?.trim()).filter(Boolean).slice(-3),
    body: document.body.innerText.replace(/\s+/g, " ").slice(0, 300),
  }));
  console.log(`read failed: error=${JSON.stringify(state.error)} progress=${JSON.stringify(state.progress)}`);
  console.log(`body: ${state.body}`);
  if (errors.length) console.log(`page errors: ${errors.slice(0, 3).join(" | ")}`);
  await browser.close();
  process.exit(1);
}

const before = await page.evaluate(() => ({
  chips: [...document.querySelectorAll(".chip")].map((c) => c.textContent.replace(/\s+/g, " ").trim()),
  button: [...document.querySelectorAll("button")]
    .map((b) => b.textContent.replace(/\s+/g, " ").trim())
    .find((t) => /second read/i.test(t)) ?? null,
}));
console.log(`chips before:     ${JSON.stringify(before.chips)}`);
console.log(`button:           ${before.button}`);

await page.evaluate(() => {
  const btn = [...document.querySelectorAll("button")].find((b) => /second read/i.test(b.textContent ?? ""));
  btn?.click();
});
await page
  .waitForFunction(
    () =>
      [...document.querySelectorAll(".chip")].some((c) => /cloud second read/i.test(c.textContent ?? "")) ||
      Boolean(document.querySelector(".error:not(:empty)")),
    { timeout: 240_000 },
  )
  .catch(() => {});

const after = await page.evaluate(() => ({
  chips: [...document.querySelectorAll(".chip")].map((c) => c.textContent.replace(/\s+/g, " ").trim()),
  receipt: document.querySelector(".panel--receipt")?.innerText.replace(/\s+/g, " ").trim() ?? "",
  error: document.querySelector(".error")?.textContent?.trim() ?? "",
  chars: document.querySelector(".panel--receipt .receipt-line")?.textContent?.trim() ?? "",
}));
const cloudBadges = after.chips.filter((c) => /cloud second read/i.test(c)).length;
console.log(`chips after:      ${JSON.stringify(after.chips)}`);
console.log(`cloud badges:     ${cloudBadges}`);
console.log(`receipt:          ${after.receipt || "(none)"}`);
console.log(`error:            ${after.error || "(none)"}`);
console.log(`generative calls: ${aiRequests.length ? aiRequests.join(", ") : "none"}`);

const verdict = configured
  ? cloudBadges > 0 && aiRequests.length > 0
    ? "PASS — cloud second read returned from a generative endpoint"
    : "FAIL — configured, but no cloud result and/or no generative request"
  : cloudBadges === 0 && aiRequests.length === 0 && /Firebase/i.test(after.error)
    ? "PASS (fail-closed) — refused with a configuration error and made no generative request"
    : "FAIL — not configured, yet it neither refused clearly nor stayed silent";
console.log(`verdict:          ${verdict}`);
if (errors.length) console.log(`page errors:      ${errors.slice(0, 3).join(" | ")}`);

await browser.close();
process.exit(verdict.startsWith("PASS") ? 0 : 1);
