/**
 * Films the demo at 1024p in one continuous take.
 *
 * The method is the one used for the correlation demo, and it is the reason that
 * recording worked there and fought us here:
 *
 * - Chrome runs headless and offscreen. Nothing on the desktop can reach a frame, so
 *   there is no window chrome, no clock, no other app — not because we crop, but
 *   because only this page is ever rendered.
 * - The camera is Page.startScreencast, which streams frames as the browser paints and
 *   keeps streaming across navigations. Page.captureScreenshot waits for a fresh frame
 *   and never answers while a document is swapping (Chromium 571157133, 40727095), which
 *   is what broke every earlier take.
 * - Frames carry metadata.timestamp, so a still moment is one frame held for its real
 *   duration. No gaps, no guessed intervals, one file.
 * - Captions and the pointer are drawn inside the page, on every new document, so they
 *   are part of the recording instead of being burned in afterwards.
 *
 *   node scripts/demo/film.mjs --record   → .tmp/demo/take.mp4 + .tmp/demo/timeline.json
 *   node scripts/demo/film.mjs --shot     → .tmp/demo/shot-*.png
 *
 * Requires the app on :4173 and the model profile in .chrome-profile.
 */
import { spawn } from "node:child_process";
import { END_CARD, LIMITS_CARD, NUMBERS_CARD, TITLE_CARD } from "./take.mjs";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const W = 1820;
const H = 1024;
const FPS = 30;
const APP = process.env.APP_URL ?? "http://localhost:4173";
const CHROME = process.env.CHROME ?? "google-chrome-stable";
const PROFILE = join(process.cwd(), ".chrome-profile");
const OUT = join(process.cwd(), ".tmp", "demo");
const mode = process.argv.includes("--record") ? "record" : "shot";
mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (message) => process.stdout.write(`film: ${message}\n`);

/* ── a small DevTools client ─────────────────────────────────────────────── */

class Cdp {
  #socket;
  #next = 1;
  #pending = new Map();
  #handlers = new Map();

  static async connect(url) {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener("error", () => reject(new Error(`cannot reach ${url}`)), { once: true });
    });
    const cdp = new Cdp();
    cdp.#socket = socket;
    socket.addEventListener("message", (event) => cdp.#receive(JSON.parse(event.data)));
    return cdp;
  }

  send(method, params = {}, sessionId) {
    const id = this.#next++;
    this.#socket.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.#pending.delete(id)) reject(new Error(`${method} timed out`));
      }, 180_000);
    });
  }

  on(method, handler) {
    this.#handlers.set(method, handler);
  }

  close() {
    this.#socket.close();
  }

  #receive(message) {
    if (message.id !== undefined) {
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      if (message.error) pending.reject(new Error(`${message.error.message}${message.error.data ? ` (${message.error.data})` : ""}`));
      else pending.resolve(message.result);
      return;
    }
    this.#handlers.get(message.method)?.(message.params, message.sessionId);
  }
}

/* ── the overlay: caption band and pointer ───────────────────────────────── */

const OVERLAY = String.raw`
(() => {
  const CSS = [
    "#__film_ui{position:fixed;inset:0;pointer-events:none;z-index:2147483647}",
    "#__film_ui .arrow{position:absolute;left:0;top:0;width:22px;height:31px;transform:translate(30px,30px);transform-origin:2px 1px;transition:transform .3s cubic-bezier(.22,.75,.24,1);filter:drop-shadow(0 1px 4px rgba(0,0,0,.75))}",
    "#__film_ui .ring{position:absolute;left:0;top:0;width:52px;height:52px;margin:-26px 0 0 -26px;border-radius:999px;border:3px solid rgba(110,231,183,.95);opacity:0}",
    "#__film_bar{position:fixed;left:0;right:0;bottom:0;display:none;padding:0 34px;background:#0b0e14;border-top:1px solid #1e242e;font-family:ui-sans-serif,-apple-system,'Segoe UI',sans-serif}",
    "#__film_bar::before{content:'';position:absolute;left:0;right:0;top:-34px;height:34px;background:linear-gradient(to bottom,rgba(11,14,20,0),#0b0e14);pointer-events:none}",
    "#__film_bar .plate{height:104px;display:flex;flex-direction:column;justify-content:center}",
    "#__film_bar .chip{font:600 11px/1 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.15em;text-transform:uppercase;color:#6ee7b7;margin-bottom:10px}",
    "#__film_bar .text{color:#eef1f5;font-size:24px;line-height:1.3;max-width:1180px}",
    "body{padding-bottom:120px !important}",
    "@keyframes __film_tick{from{opacity:.97}to{opacity:1}}",
    "#__film_tick{position:fixed;left:0;top:0;width:2px;height:2px;background:#0b0e14;animation:__film_tick .45s linear infinite alternate;pointer-events:none}"
  ].join("");

  const install = () => {
    if (document.getElementById("__film_ui")) return;
    const style = document.createElement("style");
    style.textContent = CSS;
    document.documentElement.appendChild(style);

    const ui = document.createElement("div");
    ui.id = "__film_ui";
    ui.innerHTML =
      '<svg class="arrow" viewBox="0 0 20 28" aria-hidden="true">' +
      '<path d="M1 1 L1 21.6 L6.4 16.5 L9.9 24.7 L13.5 23.2 L10 15 L17.1 15 Z" ' +
      'fill="#ffffff" stroke="#111318" stroke-width="1.4" stroke-linejoin="round"/></svg>' +
      '<div class="ring"></div>';
    document.documentElement.appendChild(ui);

    const bar = document.createElement("div");
    bar.id = "__film_bar";
    bar.innerHTML = '<div class="plate"><div class="chip"></div><div class="text"></div></div>';
    document.documentElement.appendChild(bar);

    const tick = document.createElement("div");
    tick.id = "__film_tick";
    document.body.appendChild(tick);

    const arrow = ui.querySelector(".arrow");
    const ring = ui.querySelector(".ring");
    let x = 30;
    let y = 30;
    const place = (scale) => {
      arrow.style.transform = "translate(" + x + "px," + y + "px) scale(" + scale + ")";
    };

    window.__filmPointer = {
      hide() { ui.style.opacity = "0"; },
      show() { ui.style.opacity = "1"; },
      move(nx, ny) { x = nx; y = ny; place(1); },
      press() { place(0.86); },
      release() { place(1); },
      click() {
        ring.style.left = x + "px";
        ring.style.top = y + "px";
        ring.style.transition = "none";
        ring.style.transform = "scale(.45)";
        ring.style.opacity = "1";
        void ring.offsetWidth;
        ring.style.transition = "transform .44s ease-out, opacity .44s ease-out";
        ring.style.transform = "scale(1.7)";
        ring.style.opacity = "0";
      },
    };

    // Full-frame card, drawn in the page so a title or an end card never means navigating
    // away and back (which would put a blank document in the middle of the take).
    window.__filmCard = (card) => {
      let layer = document.getElementById("__film_card");
      if (!card) {
        layer?.remove();
        return;
      }
      if (!layer) {
        layer = document.createElement("div");
        layer.id = "__film_card";
        layer.style.cssText = [
          "position:fixed", "inset:0", "z-index:2147483647", "background:#0b0e14",
          "display:grid", "place-items:center", "font-family:ui-sans-serif,-apple-system,'Segoe UI',sans-serif",
        ].join(";");
        document.documentElement.appendChild(layer);
      }
      layer.innerHTML =
        '<div style="width:1200px">' +
        '<div style="font:600 14px/1 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.18em;text-transform:uppercase;color:#6ee7b7;margin-bottom:30px">' +
        card.kicker +
        '</div><h1 style="font-size:58px;line-height:1.1;letter-spacing:-.02em;color:#eef1f5;margin:0 0 30px;font-weight:700">' +
        card.title +
        '</h1>' +
        (card.stats || [])
          .map(
            (stat) =>
              '<div style="display:inline-block;vertical-align:top;margin:0 64px 34px 0">' +
              '<div style="font-size:46px;font-weight:700;color:#6ee7b7;letter-spacing:-.02em;line-height:1">' +
              stat.v +
              '</div><div style="font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.10em;text-transform:uppercase;color:#8b95a5;margin-top:10px;max-width:250px">' +
              stat.l +
              "</div></div>",
          )
          .join("") +
        '<div style="clear:both"></div>' +
        card.lines.map((line) =>
          '<p style="font-size:25px;line-height:1.5;color:#9aa3b2;margin:0 0 14px;max-width:1120px">' + line + '</p>',
        ).join("") +
        '<div style="height:1px;background:#1e242e;margin:34px 0 20px"></div>' +
        '<div style="font:13px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.12em;text-transform:uppercase;color:#6b7482">' +
        card.footer +
        "</div></div>";
    };

    window.__filmCaption = (chip, text) => {
      bar.querySelector(".chip").textContent = chip || "";
      bar.querySelector(".text").textContent = text || "";
      bar.style.display = chip || text ? "flex" : "none";
    };
  };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", install, { once: true });
  else install();
})();
`;

/* ── session ─────────────────────────────────────────────────────────────── */

const session = { cdp: null, chrome: null, page: null, frames: [], recorder: null };

async function launch({ headless = true } = {}) {
  const profile = join(OUT, "chrome-film");
  rmSync(profile, { recursive: true, force: true });

  session.chrome = spawn(
    CHROME,
    [
      ...(headless ? ["--headless=new"] : []),
      "--remote-debugging-port=0",
      // The model weights live in the persistent profile; a throwaway profile would
      // report "downloadable" and stall the take.
      `--user-data-dir=${PROFILE}`,
      `--window-size=${W},${H}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--disable-sync",
      "--disable-background-networking",
      "--hide-scrollbars",
      "--force-color-profile=srgb",
      "--disable-lcd-text",
      "--font-render-hinting=none",
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );

  let stderr = "";
  session.chrome.stderr.on("data", (chunk) => (stderr += chunk.toString()));

  // Chrome writes DevToolsActivePort into the profile it was told to use.
  const portFile = join(PROFILE, "DevToolsActivePort");
  const before = existsSync(portFile) ? readFileSync(portFile, "utf8") : "";
  let port = "";
  for (let i = 0; i < 300; i += 1) {
    if (existsSync(portFile)) {
      const text = readFileSync(portFile, "utf8");
      if (text !== before) {
        port = text.split("\n")[0].trim();
        break;
      }
    }
    await sleep(100);
  }
  if (!port) {
    try {
      const version = await (await fetch("http://127.0.0.1:9333/json/version")).json();
      port = new URL(version.webSocketDebuggerUrl).port;
    } catch {
      throw new Error(`chrome never opened its debugging port\n${stderr.slice(-800)}`);
    }
  }

  const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  session.cdp = await Cdp.connect(version.webSocketDebuggerUrl);
  const { targetId } = await session.cdp.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await session.cdp.send("Target.attachToTarget", { targetId, flatten: true });
  session.page = sessionId;

  await session.cdp.send("Page.enable", {}, session.page);
  await session.cdp.send("Runtime.enable", {}, session.page);
  await session.cdp.send(
    "Emulation.setDeviceMetricsOverride",
    { width: W, height: H, deviceScaleFactor: 1, mobile: false },
    session.page,
  );
  await session.cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: OVERLAY }, session.page);
  await session.cdp.send("Page.bringToFront", {}, session.page);
  log(`attached on :${port}`);
}

async function shutdown() {
  try {
    session.cdp?.close();
  } catch {
    /* already gone */
  }
  session.chrome?.kill("SIGTERM");
}

async function evaluate(expression) {
  const { result, exceptionDetails } = await session.cdp.send(
    "Runtime.evaluate",
    { expression, returnByValue: true, awaitPromise: true },
    session.page,
  );
  if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
  return result.value;
}

/**
 * Poll for a condition. A poll that lands while the renderer is busy (the on-device
 * model runs on this thread) throws instead of hanging, and the next poll retries —
 * which is the difference between a wait that survives inference and one that dies
 * with a protocol timeout.
 */
async function waitFor(expression, { timeout = 180_000, label = expression, interval = 400 } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    try {
      if (await evaluate(expression)) return;
    } catch {
      /* a navigation is in flight, or the renderer is busy */
    }
    if (Date.now() > deadline) throw new Error(`gave up waiting for ${label}`);
    await sleep(interval);
  }
}

async function openApp(path) {
  await session.cdp.send("Page.navigate", { url: `${APP}${path}` }, session.page);
  await waitFor('document.readyState === "complete" && !!document.querySelector("main")', {
    label: `the app at ${path}`,
    timeout: 30_000,
  });
  await waitFor("!!window.__filmPointer", { label: "the overlay", timeout: 15_000 });
  await evaluate("window.__filmPointer.move(-90,-90)");
  await sleep(700);
}

const hasSecondReadButtonSource = `[...document.querySelectorAll("button")].some((b) => /for a second read/i.test(b.textContent))`;
const hasSecondReadButton = () => evaluate(hasSecondReadButtonSource);

/**
 * The second-read button only exists when at least one field is below the agreement
 * threshold, and a clean read can settle everything. Re-read until the button is there,
 * so the take cannot stall on a state the app legitimately produces.
 */
async function ensureSecondReadButton(attempts = 4) {
  for (let i = 0; i < attempts; i += 1) {
    if (await hasSecondReadButton()) return;
    log(`no uncertain field on run ${i + 1}, reading again`);
    // While a read is running the corner button says "Reading…" and is disabled, so the
    // retry waits for the idle label instead of clicking a button that is not there.
    await waitFor(
      `[...document.querySelectorAll("button")].some((b) => /^Read it$/.test(b.textContent.trim()) && !b.disabled)`,
      { label: "an idle Read it button" },
    );
    await clickButton("^Read it$");
    await waitFor(
      `${hasSecondReadButtonSource} || [...document.querySelectorAll("button")].some((b) => /^Read it$/.test(b.textContent.trim()) && !b.disabled)`,
      { label: "the read to finish" },
    );
  }
  if (await hasSecondReadButton()) return;
  throw new Error("every field kept agreeing: there is nothing to escalate in this take");
}

/**
 * Scroll the opened payload clear of the caption band: the redaction is the proof, so the
 * whole block has to be readable, not just its first line.
 */
async function revealPayload() {
  await evaluate(`(() => {
    const pre = document.querySelector(".panel--receipt pre.payload");
    if (!pre) return;
    const bottom = pre.getBoundingClientRect().bottom + window.scrollY;
    window.scrollTo({ top: Math.max(0, bottom - (window.innerHeight - 200)), behavior: "smooth" });
  })()`);
  await sleep(1400);
}

/**
 * Scroll the receipt's last line clear of the caption band. The band owns the bottom of
 * the frame, so without this the settled-quote lines sit behind it.
 */
async function revealReceipt() {
  await evaluate(`(() => {
    const panel = document.querySelector(".panel--receipt");
    if (!panel) return;
    const bottom = panel.getBoundingClientRect().bottom + window.scrollY;
    window.scrollTo({ top: Math.max(0, bottom - (window.innerHeight - 160)), behavior: "smooth" });
  })()`);
  await sleep(1100);
}

async function caption(chip, text) {
  await evaluate(`window.__filmCaption(${JSON.stringify(chip)}, ${JSON.stringify(text)})`);
  // The caption change is also the narration slot, so its time is recorded rather than
  // inferred afterwards.
  if (t0) timeline.push({ name: chip, caption: text, atMs: Math.round((Date.now() / 1000 - t0) * 1000) });
}

async function clickOn(expression, label) {
  const spot = await evaluate(`(() => {
    const element = ${expression};
    if (!element) return null;
    const rect = element.getBoundingClientRect();
    return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
  })()`);
  if (!spot) throw new Error(`cannot click ${label}: it is not on the page`);

  await evaluate("window.__filmPointer.show()");
  await evaluate(`window.__filmPointer.move(${spot.x}, ${spot.y})`);
  await session.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: spot.x, y: spot.y, buttons: 0 }, session.page);
  await sleep(430);
  await evaluate("window.__filmPointer.press()");
  await sleep(90);
  await evaluate("window.__filmPointer.click(); window.__filmPointer.release();");
  // The pointer is drawn, not dispatched: a synthesised mouse event at these coordinates
  // is reliable for hover but silently does nothing on some of these buttons, so the
  // click itself goes through the element's own handler.
  const clicked = await evaluate(
    `(() => { const element = ${expression}; if (!element) return false; element.click(); return true; })()`,
  );
  if (!clicked) throw new Error(`cannot click ${label}: it is not on the page`);
  await sleep(260);
  log(`clicked ${label}`);
}

/** Click the first button whose label matches the pattern (the label's count varies). */
const clickButton = (pattern) =>
  clickOn(
    `[...document.querySelectorAll("button")].find((b) => new RegExp(${JSON.stringify(pattern)}, "i").test(b.textContent.trim()))`,
    `"${pattern}"`,
  );

/* ── recording ───────────────────────────────────────────────────────────── */

const timeline = [];
let t0 = 0;
const beat = (name) => timeline.push({ name, atMs: Math.round((Date.now() / 1000 - t0) * 1000) });

function startCapture(dir) {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });

  session.cdp.on("Page.screencastFrame", (frame, pageSession) => {
    void session.cdp.send("Page.screencastFrameAck", { sessionId: frame.sessionId }, pageSession).catch(() => {});
    const recorder = session.recorder;
    if (!recorder?.open) return;
    const file = join(recorder.dir, `f-${String(recorder.frames.length).padStart(5, "0")}.jpg`);
    writeFileSync(file, Buffer.from(frame.data, "base64"));
    recorder.frames.push({ file, t: frame.metadata.timestamp });
  });
}

async function startScreencast() {
  await session.cdp.send(
    "Page.startScreencast",
    { format: "jpeg", quality: 95, maxWidth: W, maxHeight: H, everyNthFrame: 1 },
    session.page,
  );
}

async function stopCapture() {
  const recorder = session.recorder;
  recorder.open = false;
  recorder.stoppedAt = Date.now() / 1000;
  await sleep(200);
  await session.cdp.send("Page.stopScreencast", {}, session.page);
  session.recorder = null;

  if (!recorder.frames.length) throw new Error("captured no frames");

  const lines = [];
  recorder.frames.forEach((frame, i) => {
    const next = recorder.frames[i + 1];
    const until = next ? next.t : recorder.stoppedAt;
    const duration = Math.min(Math.max(until - frame.t, 1 / 120), 6);
    lines.push(`file '${frame.file}'`, `duration ${duration.toFixed(4)}`);
  });
  lines.push(`file '${recorder.frames[recorder.frames.length - 1].file}'`);
  const listPath = join(recorder.dir, "list.txt");
  writeFileSync(listPath, `${lines.join("\n")}\n`);

  const out = join(OUT, "take.mp4");
  await new Promise((resolve, reject) => {
    const child = spawn(
      "ffmpeg",
      [
        "-hide_banner", "-loglevel", "error", "-y",
        "-f", "concat", "-safe", "0", "-i", listPath,
        "-fps_mode", "cfr", "-r", String(FPS),
        "-vf", `scale=${W}:${H}:flags=lanczos,format=yuv420p`,
        "-c:v", "libx264", "-preset", "slow", "-crf", "16", "-movflags", "+faststart",
        "-an", out,
      ],
      { stdio: "inherit" },
    );
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}`))));
  });

  log(`take.mp4  ${(recorder.stoppedAt - recorder.frames[0].t).toFixed(1)}s  ${recorder.frames.length} frames`);
  return out;
}

/* ── the take ────────────────────────────────────────────────────────────── */

const showCard = (card) => evaluate(`window.__filmCard(${JSON.stringify(card)})`);
const hideCard = () => evaluate("window.__filmCard(null)");
const cardBeat = (name) => timeline.push({ name, atMs: Math.round((Date.now() / 1000 - t0) * 1000) });

/** Take the browser itself offline — no Wi-Fi switch, but the same signal the app listens for. */
async function setOffline(offline) {
  await session.cdp.send("Network.enable", {}, session.page);
  await session.cdp.send(
    "Network.emulateNetworkConditions",
    { offline, latency: 0, downloadThroughput: -1, uploadThroughput: -1 },
    session.page,
  );
  await sleep(700);
}

async function readLetter() {
  await clickButton("^Read it$");
  await waitFor('!!document.querySelector(".fields")', { label: "the checklist" });
  await sleep(1500);
}

async function record() {
  session.recorder = { dir: join(OUT, "frames-take"), frames: [], open: true };
  startCapture(session.recorder.dir);

  await openApp("/");
  await evaluate("window.__filmPointer.hide()");
  await showCard(TITLE_CARD);
  t0 = Date.now() / 1000;
  timeline.push({ name: "CARD · TITLE", atMs: 0 });

  await startScreencast();
  await sleep(7200);
  await hideCard();

  await caption("STEP 1 / 8 · THE LETTER", "An insurance denial: money, a deadline, and a reference to quote.");
  await sleep(2000);
  await clickButton("Sample: insurance denial");
  await sleep(1800);
  beat("letter-filled");

  await caption(
    "STEP 2 / 8 · READ ON THIS LAPTOP",
    "Chrome's own model, three passes. The progress line says on-device, and how long each pass took.",
  );
  await readLetter();
  await sleep(1800);
  beat("read-done");

  await caption(
    "STEP 3 / 8 · WHAT IT SAYS",
    "Deadline, actions, references — with the agreement behind every badge.",
  );
  await sleep(6000);
  beat("checklist");

  await setOffline(true);
  await caption(
    "STEP 4 / 8 · NETWORK OFF",
    "The browser is offline. Header says so, and a different letter still reads, on the device.",
  );
  await sleep(1400);
  await clickButton("Sample: lease addendum");
  await sleep(1600);
  await readLetter();
  await sleep(2400);
  beat("offline-read");
  await sleep(3200);
  await setOffline(false);

  await caption(
    "STEP 5 / 8 · THE UNCERTAIN FIELD",
    "Back online, the denial again: the field that disagreed gets one focused re-read, which must quote the letter.",
  );
  await clickButton("Sample: insurance denial");
  await sleep(1500);
  await readLetter();
  await ensureSecondReadButton();
  await clickButton("for a second read");
  await waitFor('!!document.querySelector(".panel--receipt")', { label: "the receipt" });
  await revealReceipt();
  await sleep(2200);
  beat("privacy-receipt");

  await evaluate('history.pushState({}, "", "/?forceCloud=1")');
  await caption(
    "STEP 6 / 8 · THE CLOUD LEG",
    "Escalation forced for this take, so the cloud path can be shown: same letter, on-device re-read skipped.",
  );
  await clickButton("Sample: insurance denial");
  await sleep(1500);
  await readLetter();
  await ensureSecondReadButton();
  await clickButton("for a second read");
  await waitFor('!!document.querySelector(".panel--receipt")', { label: "the cloud receipt" });
  await revealReceipt();
  await sleep(1800);
  beat("cloud-badge");

  await clickOn(
    'document.querySelector(".panel--receipt details summary")',
    "the payload disclosure",
  );
  await revealPayload();
  await caption(
    "STEP 7 / 8 · THE EXACT PAYLOAD",
    "This is the whole request: 579 characters, phone number already replaced.",
  );
  await sleep(8000);
  beat("payload");

  await evaluate("window.__filmPointer.hide()");
  await evaluate('window.__filmCaption("", "")');
  await showCard(NUMBERS_CARD);
  cardBeat("CARD · NUMBERS");
  await sleep(9800);
  await showCard(LIMITS_CARD);
  cardBeat("CARD · LIMITS");
  await sleep(11200);
  await showCard(END_CARD);
  cardBeat("CARD · END");
  await sleep(9000);

  await stopCapture();
  writeFileSync(
    join(OUT, "timeline.json"),
    `${JSON.stringify({ width: W, height: H, timeline }, null, 2)}\n`,
  );
  log("timeline.json written");
}

async function shots() {
  await openApp("/");
  await evaluate("window.__filmCaption('', '')");
  const shot = async (name) => {
    const { data } = await session.cdp.send("Page.captureScreenshot", { format: "png" }, session.page);
    writeFileSync(join(OUT, `${name}.png`), Buffer.from(data, "base64"));
    log(`shot ${name}.png`);
  };

  await sleep(1500);
  await shot("shot-01-letter");
  await clickButton("Sample: insurance denial");
  await sleep(1500);
  await clickButton("Read it");
  await waitFor('!!document.querySelector(".fields")', { label: "the checklist" });
  await sleep(2000);
  await shot("shot-02-read");
  await clickButton("for a second read");
  await waitFor('!!document.querySelector(".panel--receipt")', { label: "the receipt" });
  await sleep(2200);
  await shot("shot-03-privacy-receipt");
  await openApp("/?forceCloud=1");
  await clickButton("Sample: insurance denial");
  await sleep(1000);
  await clickButton("Read it");
  await waitFor('!!document.querySelector(".fields")', { label: "the checklist again" });
  await sleep(1500);
  await clickButton("for a second read");
  await waitFor('!!document.querySelector(".panel--receipt")', { label: "the cloud receipt" });
  await sleep(2600);
  await shot("shot-04-cloud-badge");
}

/** Diagnostics for the cloud leg: prints what the page says while it waits. */
async function probe() {
  session.cdp.on("Runtime.consoleAPICalled", (event) => {
    const text = event.args?.map((a) => a.value ?? a.description ?? "").join(" ") ?? "";
    if (text) log(`console.${event.type}: ${text.slice(0, 300)}`);
  });
  session.cdp.on("Runtime.exceptionThrown", (event) => {
    log(`exception: ${event.exceptionDetails?.exception?.description?.slice(0, 300)}`);
  });
  await openApp("/?forceCloud=1");
  await clickButton("Sample: insurance denial");
  await sleep(1000);
  await clickButton("Read it");
  await waitFor('!!document.querySelector(".fields")', { label: "the checklist" });
  await sleep(1200);
  await clickButton("for a second read");
  for (let i = 0; i < 24; i += 1) {
    await sleep(5000);
    const state = await evaluate(`({
      receipt: document.querySelector(".panel--receipt")?.textContent?.replace(/\\s+/g, " ").slice(0, 200) ?? null,
      busy: [...document.querySelectorAll("button")].filter((b) => b.disabled).map((b) => b.textContent.trim()),
      text: document.body.innerText.replace(/\\s+/g, " ").slice(0, 700),
    })`);
    log(`${(i + 1) * 5}s ${JSON.stringify(state)}`);
    if (state.receipt) break;
  }
}

try {
  await launch({ headless: true });
  const run = process.argv.includes("--probe") ? probe : mode === "record" ? record : shots;
  await run();
} finally {
  await shutdown();
}
