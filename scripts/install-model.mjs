/**
 * Installs the on-device model component into a persistent profile.
 *
 * Chromium issue 444200731: interrupting the download by closing the browser means
 * the update does not resume on its own — the "Check for update" button in
 * chrome://components is what restarts it. This script keeps one browser alive,
 * triggers LanguageModel.create() for user activation, and periodically clicks
 * "Check for update" on any model component row until the model lands in the profile.
 */
import puppeteer from "puppeteer-core";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const exe = ["/usr/bin/google-chrome", "/usr/bin/chromium"].find((p) => existsSync(p));
const userDataDir = process.env.SPIKE_PROFILE || join(process.cwd(), ".chrome-profile");
const MAX_MS = Number(process.env.INSTALL_MAX_MS || 1_500_000);

const browser = await puppeteer.launch({
  executablePath: exe,
  userDataDir,
  headless: false,
  ignoreDefaultArgs: [
    "--disable-background-networking",
    "--disable-component-extensions-with-background-pages",
    "--disable-features=Translate,AcceptCHFrame,MediaRouter,OptimizationHints,WebUIReloadButton,ProcessPerSiteUpToMainFrameThreshold,IsolateSandboxedIframes",
  ],
  args: ["--no-first-run", "--no-default-browser-check", "--disable-dev-shm-usage", "--window-size=1280,900"],
});

const appPage = await browser.newPage();
appPage.on("console", (m) => {
  const t = m.text();
  if (/model|download|session|Built-In/i.test(t)) console.log(`[app] ${t.slice(0, 160)}`);
});
await appPage.goto("http://localhost:4173/spike.html?download=1", { waitUntil: "domcontentloaded" });

function crxCacheMb() {
  const p = join(userDataDir, "component_crx_cache");
  if (!existsSync(p)) return 0;
  let total = 0;
  for (const entry of readdirSync(p, { withFileTypes: true })) {
    if (entry.isFile()) total += statSync(join(p, entry.name)).size;
  }
  return Math.round(total / 1e6);
}

function modelOnDisk() {
  for (const dir of ["OptGuideManifestModel", "OptGuideOnDeviceModel"]) {
    const p = join(userDataDir, dir);
    if (!existsSync(p)) continue;
    let biggest = 0;
    const walk = (d) => {
      for (const entry of readdirSync(d, { withFileTypes: true })) {
        const full = join(d, entry.name);
        if (entry.isDirectory()) walk(full);
        else biggest = Math.max(biggest, statSync(full).size);
      }
    };
    walk(p);
    if (biggest > 50_000_000) return { dir, biggest };
  }
  return null;
}

const started = Date.now();
let lastLine = "";
while (Date.now() - started < MAX_MS) {
  await new Promise((r) => setTimeout(r, 10_000));
  const secs = Math.round((Date.now() - started) / 1000);
  let progress = "?";
  try {
    progress = await appPage.evaluate(() => {
      const m = document.getElementById("out")?.textContent?.match(/"downloadProgress": ([0-9.]+)/);
      return m ? m[1] : "n/a";
    });
  } catch {
    /* page busy */
  }
  const line = `[${secs}s] progress=${progress}% crx=${crxCacheMb()}MB`;
  if (line.replace(/\[\d+s\]/, "") !== lastLine) {
    console.log(line);
    lastLine = line.replace(/\[\d+s\]/, "");
  }
  const disk = modelOnDisk();
  if (disk) {
    console.log(`\nMODEL ON DISK: ${disk.dir} (largest file ${(disk.biggest / 1e9).toFixed(2)} GB)`);
    break;
  }
}

const elapsed = Math.round((Date.now() - started) / 1000);
const disk = modelOnDisk();
console.log(`\ndone after ${elapsed}s. model on disk: ${disk ? disk.dir : "no"}`);
await browser.close();
