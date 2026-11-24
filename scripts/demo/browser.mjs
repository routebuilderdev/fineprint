/**
 * Chrome launcher for anything that needs the real on-device model.
 *
 * Puppeteer and Playwright both disable `OptimizationHints` in their default switch
 * lists. That feature backs Chrome's on-device model service, so a browser they launch
 * reports `LanguageModel.availability() === "unavailable"` even with the model installed
 * (OptGuideManifestModel holds the weights) and everything silently falls back to cloud.
 *
 * The only dependable fix is to launch Chrome ourselves with the flags we want and attach
 * over CDP, which adds no switches of its own.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import puppeteer from "puppeteer-core";

const CHROME = process.env.CHROME_PATH || "/usr/bin/google-chrome";
const PORT = Number(process.env.CDP_PORT || 9333);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function launchBrowser({ profile, windowSize = "1820,1144" } = {}) {
  const userDataDir = profile || process.env.SPIKE_PROFILE || join(process.cwd(), ".chrome-profile");
  const portFile = join(userDataDir, "DevToolsActivePort");

  const child = spawn(
    CHROME,
    [
      `--user-data-dir=${userDataDir}`,
      `--remote-debugging-port=${PORT}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-dev-shm-usage",
      "--hide-crash-restore-bubble",
      `--window-size=${windowSize}`,
      "about:blank",
    ],
    { stdio: "ignore", detached: false },
  );

  // Wait for the debugger endpoint instead of guessing a delay.
  for (let i = 0; i < 100; i += 1) {
    if (existsSync(portFile)) {
      const [port] = readFileSync(portFile, "utf8").split("\n");
      if (Number(port) === PORT) break;
    }
    await sleep(150);
  }

  let browser;
  for (let i = 0; i < 40; i += 1) {
    try {
      browser = await puppeteer.connect({
        browserURL: `http://127.0.0.1:${PORT}`,
        defaultViewport: null,
        protocolTimeout: 120_000,
      });
      break;
    } catch {
      await sleep(250);
    }
  }
  if (!browser) throw new Error("Chrome did not expose a debugging endpoint");

  return {
    browser,
    child,
    async close() {
      try {
        browser.disconnect();
      } catch {}
      // Close only the browser we spawned: never the user's own Chrome.
      try {
        child.kill("SIGTERM");
      } catch {}
    },
  };
}

export async function openPage(browser, width = 1820, height = 1024) {
  const pages = await browser.pages();
  const page = pages[0] ?? (await browser.newPage());
  await page.setViewport({ width, height, deviceScaleFactor: 1 });
  // An occluded window can stall compositor capture, so keep the tab in front.
  await page.bringToFront().catch(() => {});
  return page;
}
