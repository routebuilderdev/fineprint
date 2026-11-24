/**
 * Evidence for why the on-device model may be unavailable:
 *  - are the prompt-api flags actually applied in this profile?
 *  - does Chrome have a usable GPU (built-in AI refuses on software rendering)?
 *  - is the model component installed?
 */
import puppeteer from "puppeteer-core";
import { existsSync } from "node:fs";
import { join } from "node:path";

const exe = ["/usr/bin/google-chrome", "/usr/bin/chromium"].find((p) => existsSync(p));
if (!exe) throw new Error("Chrome not found");
const userDataDir = process.env.SPIKE_PROFILE || join(process.cwd(), ".chrome-profile");

const browser = await puppeteer.launch({
  executablePath: exe,
  userDataDir,
  headless: false,
  args: ["--no-first-run", "--no-default-browser-check", "--disable-dev-shm-usage"],
});
const page = await browser.newPage();

async function flags() {
  await page.goto("chrome://flags", { waitUntil: "domcontentloaded", timeout: 30_000 });
  await new Promise((r) => setTimeout(r, 2500));
  return page.evaluate(() => {
    const rows = [];
    const walk = (root) => {
      for (const el of root.querySelectorAll("*")) {
        if (el.shadowRoot) walk(el.shadowRoot);
        const select = el.querySelector?.("select");
        if (select) {
          const label = el.textContent.trim().split("\n")[0].slice(0, 80);
          rows.push({ label, value: select.value });
        }
      }
    };
    walk(document);
    return rows;
  });
}

const rows = await flags();
const wanted = ["Prompt API", "Prompt API Multimodal Input", "Gemma 4", "Multi-Token Prediction"];
for (const w of wanted) {
  const hit = rows.find((r) => r.label.toLowerCase().startsWith(w.toLowerCase()));
  console.log(`${hit ? "FOUND" : "MISSING"}  ${w} → ${hit ? hit.value : "-"}`);
}

console.log("\n--- chrome://gpu (selected) ---");
await page.goto("chrome://gpu", { waitUntil: "domcontentloaded", timeout: 30_000 });
await new Promise((r) => setTimeout(r, 3500));
const gpu = await page.evaluate(() => document.body.innerText);
const keep = gpu
  .split("\n")
  .map((l) => l.trim())
  .filter((l) => /webgl|canvas|gpu process|graphics feature|software only|hardware accelerated|angle|vulkan|driver/i.test(l));
console.log(keep.slice(0, 18).join("\n"));

console.log("\n--- chrome://components (on-device) ---");
await page.goto("chrome://components", { waitUntil: "domcontentloaded", timeout: 30_000 });
await new Promise((r) => setTimeout(r, 2500));
const comp = await page.evaluate(() => document.body.innerText);
console.log(
  comp
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /on.?device|model|optimization/i.test(l))
    .slice(0, 12)
    .join("\n") || "(no on-device components listed)",
);

await browser.close();
