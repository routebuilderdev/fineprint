/**
 * Asks every model in the free cloud ladder one tiny question and prints the result, so
 * the escalation order can be set from measurements rather than from the last take.
 *
 *   node scripts/demo/probe-models.mjs
 */
import { launchBrowser, openPage } from "./browser.mjs";

const session = await launchBrowser({ windowSize: "1280,1000", headless: false });
const page = await openPage(session.browser, 1280, 900);

const events = [];
page.on("console", (message) => {
  if (message.type() === "error" || message.type() === "warn") events.push(message.text().slice(0, 200));
});

await page.goto("http://localhost:4173/probe.html?models=1", { waitUntil: "networkidle2" });
await page.waitForFunction(() => document.body.innerText.length > 40, { timeout: 120_000 }).catch(() => {});
await new Promise((r) => setTimeout(r, 45_000));

const text = await page.evaluate(() => document.body.innerText.replace(/\n{2,}/g, "\n").trim());
console.log(text);
if (events.length) console.log("\nconsole:", events.slice(0, 6).join(" | "));
await session.close();
