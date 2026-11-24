import puppeteer from "puppeteer-core";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const browser = await puppeteer.launch({
  executablePath: "/usr/bin/google-chrome",
  userDataDir: mkdtempSync(join(tmpdir(), "diag-")),
  headless: false,
  args: ["--no-first-run", "--disable-dev-shm-usage"],
});
const page = await browser.newPage();
for (const url of ["chrome://on-device-internals", "chrome://components"]) {
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 });
    await new Promise((r) => setTimeout(r, 2500));
    const text = await page.evaluate(() => document.body.innerText || "");
    console.log(`\n===== ${url} =====`);
    console.log(text.split("\n").filter((l) => l.trim()).slice(0, 45).join("\n"));
  } catch (e) {
    console.log(`\n===== ${url} FAILED: ${e.message}`);
  }
}
await browser.close();
