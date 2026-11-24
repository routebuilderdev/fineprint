/**
 * chrome://flags renders inside nested shadow roots, so innerText comes back empty.
 * This walks the shadow trees and prints every flag whose text mentions the model.
 */
import puppeteer from "puppeteer-core";
import { existsSync, writeFileSync } from "node:fs";

const exe = ["/usr/bin/google-chrome", "/usr/bin/chromium"].find((p) => existsSync(p));
if (!exe) throw new Error("Chrome not found");

const browser = await puppeteer.launch({
  executablePath: exe,
  headless: false,
  args: ["--no-first-run", "--no-default-browser-check", "--disable-dev-shm-usage"],
});
const page = await browser.newPage();
await page.goto("chrome://flags", { waitUntil: "domcontentloaded", timeout: 30_000 });
await new Promise((r) => setTimeout(r, 2500));

const rows = await page.evaluate(() => {
  const out = [];
  const walk = (root) => {
    const nodes = root.querySelectorAll("*");
    for (const el of nodes) {
      if (el.shadowRoot) walk(el.shadowRoot);
      // A flag row in modern Chrome is <div class="experiment"> with a <select>
      const select = el.querySelector?.(":scope > select, :scope select");
      if (select && el.textContent && el.textContent.trim().length > 10) {
        const label = (el.querySelector("h3, .experiment-name, .name")?.textContent ?? el.textContent)
          .trim()
          .split("\n")[0]
          .slice(0, 140);
        out.push({
          label,
          value: select.value,
          options: [...select.options].map((o) => `${o.value}`).join(","),
          flagId: el.id || el.getAttribute("data-flag") || "",
        });
      }
    }
  };
  walk(document);
  return out;
});

const relevant = rows.filter((r) => /gemini|nano|built-?in ai|prompt api|optimization guide|on-?device/i.test(JSON.stringify(r)));
console.log(`found ${rows.length} flag rows, ${relevant.length} relevant\n`);
for (const r of relevant) {
  console.log(`- ${r.label}\n    value="${r.value}" id="${r.flagId}" options=${r.options}`);
}
writeFileSync("flags-dump.json", JSON.stringify(rows, null, 2));
await browser.close();
