/**
 * Demo-mode smoke test: loads the app, reads a sample letter, and checks that the
 * checklist, agreement chips and receipt panel actually render.
 * Run against `npm run preview` (default http://localhost:4173).
 */
import puppeteer from "puppeteer-core";
import { existsSync } from "node:fs";

const exe = ["/usr/bin/google-chrome", "/usr/bin/chromium"].find((p) => existsSync(p));
if (!exe) throw new Error("Chrome not found");

const url = process.argv[2] || "http://localhost:4173/";
const browser = await puppeteer.launch({ executablePath: exe, headless: "new", args: ["--no-sandbox"] });
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});

let failed = false;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failed = true;
};

try {
  await page.goto(url, { waitUntil: "networkidle2", timeout: 30000 });
  check("app renders", (await page.$eval("h1", (el) => el.textContent)) === "Fine Print");

  const buttons = await page.$$eval("button", (els) => els.map((e) => e.textContent ?? ""));
  const sample = buttons.find((b) => b.includes("insurance denial"));
  check("sample button present", Boolean(sample));

  const [sampleBtn] = await page.$$("button");
  const all = await page.$$("button");
  for (const b of all) {
    const t = await b.evaluate((el) => el.textContent ?? "");
    if (t.includes("insurance denial")) {
      await b.click();
      break;
    }
  }
  void sampleBtn;

  await new Promise((r) => setTimeout(r, 200));
  const hasText = await page.$eval("textarea", (el) => el.value.length > 100);
  check("sample text loaded", hasText);

  for (const b of await page.$$("button")) {
    const t = await b.evaluate((el) => el.textContent ?? "");
    if (t.trim() === "Read it") {
      await b.click();
      break;
    }
  }

  await page.waitForFunction(() => document.body.innerText.includes("Overall agreement"), {
    timeout: 30000,
  });
  const body = await page.evaluate(() => document.body.innerText);

  check("headline shows a deadline", /day[s]? left|Deadline passed|No deadline/.test(body));
  const lower = body.toLowerCase();
  check(
    "all four field labels render",
    ["what this is", "deadline", "what they want from you", "quote these"].every((l) => lower.includes(l)),
  );
  check("agreement chips render", /%\s·\s(demo data|on-device|cloud|mixed)/.test(body));
  check("escalation button offered", /second read/i.test(body));
  check("no page errors", errors.length === 0, errors.join(" | "));

  const escalate = await page.$$eval("button", (els) => els.map((e) => e.textContent ?? ""));
  console.log("buttons now:", escalate.filter(Boolean).join(" / "));
} catch (err) {
  failed = true;
  console.log(`FAIL  smoke run threw — ${err.message}`);
} finally {
  await browser.close();
}

process.exit(failed ? 1 : 0);
