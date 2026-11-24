/**
 * chrome://on-device-internals is the authoritative page for why the model is or
 * isn't available, but it is hidden until debug pages are enabled on chrome://chrome-urls.
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
  args: ["--no-first-run", "--no-default-browser-check", "--disable-dev-shm-usage"],
});
const page = await browser.newPage();

const deepText = () =>
  page.evaluate(() => {
    const chunks = [];
    const walk = (root) => {
      for (const el of root.querySelectorAll("*")) {
        if (el.shadowRoot) walk(el.shadowRoot);
        if (el.children.length === 0 && el.textContent) chunks.push(el.textContent.trim());
      }
    };
    walk(document);
    return chunks.filter(Boolean).join("\n");
  });

// 1. Enable debug pages
await page.goto("chrome://chrome-urls", { waitUntil: "domcontentloaded", timeout: 30_000 });
await new Promise((r) => setTimeout(r, 1500));
const clicked = await page.evaluate(() => {
  const scan = (root) => {
    for (const el of root.querySelectorAll("*")) {
      if (el.shadowRoot) {
        const hit = scan(el.shadowRoot);
        if (hit) return hit;
      }
      if (el.tagName === "BUTTON" && /enable/i.test(el.textContent ?? "")) {
        el.click();
        return el.textContent.trim();
      }
    }
    return null;
  };
  return scan(document);
});
console.log(`debug-page button: ${clicked ?? "not found"}`);
await new Promise((r) => setTimeout(r, 1500));

// 2. On-device internals
await page.goto("chrome://on-device-internals", { waitUntil: "domcontentloaded", timeout: 30_000 });
await new Promise((r) => setTimeout(r, 2500));
const internals = await deepText();
console.log("\n===== on-device internals =====");
console.log(internals.split("\n").slice(0, 60).join("\n") || "(empty)");

// 3. The on-device AI setting
await page.goto("chrome://settings/system", { waitUntil: "domcontentloaded", timeout: 30_000 });
await new Promise((r) => setTimeout(r, 2500));
const settings = await deepText();
console.log("\n===== settings/system (on-device) =====");
console.log(
  settings
    .split("\n")
    .filter((l) => /on-?device|ai/i.test(l))
    .slice(0, 25)
    .join("\n") || "(no match)",
);

await browser.close();
