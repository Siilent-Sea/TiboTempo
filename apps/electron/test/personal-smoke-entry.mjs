// Launch the real Electron and companion with a synthetic, disposable profile.
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import * as electron from "electron";
import { launchPersonalApp } from "../personal-runtime.js";
import { writeSyntheticPerformanceFixture } from "./personal-fixture.mjs";

const consoleErrors = [];
const ipcFailures = [];
const auditedIpc = {
  handle(channel, handler) {
    electron.ipcMain.handle(channel, async (event, request) => {
      try { return await handler(event, request); }
      catch (error) {
        ipcFailures.push({ action: request?.action ?? "unknown", code: error?.code ?? "unknown" });
        throw error;
      }
    });
  },
  removeHandler(channel) { electron.ipcMain.removeHandler(channel); },
};
class HiddenBrowserWindow extends electron.BrowserWindow {
  constructor(options) {
    super({ ...options, show: false });
    this.webContents.on("console-message", (_event, details, oldMessage) => {
      const level = typeof details === "object" ? details.level : details;
      const message = typeof details === "object" ? details.message : oldMessage;
      if (level === "error" || level === 3) consoleErrors.push(String(message ?? "").slice(0, 300));
    });
  }
  show() {}
  showInactive() {}
  focus() {}
}

const root = await mkdtemp(join(await realpath(tmpdir()), "local-usage-smoke-"));
// A fresh desktop profile selects HOME/.codex; explicit custom paths are a
// saved Settings choice and should not be inferred from an ambient variable.
const codexHome = join(root, ".codex");
const fakeCodex = join(root, "codex-disabled");
await mkdir(join(codexHome, "sessions"), { recursive: true });
if (process.argv.includes("--fixture")) await writeSyntheticPerformanceFixture(codexHome);
await writeFile(fakeCodex, "#!/bin/sh\nexit 1\n", { mode: 0o700 });
await chmod(fakeCodex, 0o700);

let desktop;
process.stdout.write("personal_smoke_started\n");
const timeout = setTimeout(() => {
  process.stderr.write("personal_smoke_timeout\n");
  electron.app.exit(1);
}, 25_000);
async function run() {
try {
  desktop = await launchPersonalApp({
    runtime: { ...electron, BrowserWindow: HiddenBrowserWindow, ipcMain: auditedIpc },
    appData: root,
    environment: {
      HOME: root, USERPROFILE: root, CODEX_HOME: codexHome, CODEX_BIN: fakeCodex,
      PATH: process.env.PATH ?? "", LANG: "zh_CN.UTF-8",
    },
    firstRunReceiptBackend: {
      load: async () => ({ schemaVersion: "tibotattle-desktop-first-run-v1", acknowledged: true }),
      save: async () => { throw new Error("unexpected_receipt_write"); },
    },
    onStartupPhase: (phase) => process.stdout.write(`phase:${phase}\n`),
    onStartupStop: (phase) => process.stdout.write(`stop:${phase}\n`),
  });
  if (!desktop.lifecycle?.state.started || !desktop.lifecycle.state.dashboardReady) {
    throw new Error("desktop_not_ready");
  }
  if (electron.app.getPath("sessionData") !== electron.app.getPath("userData")) {
    throw new Error("desktop_profile_not_isolated");
  }
  const contents = electron.webContents.getAllWebContents().find((candidate) => {
    try {
      const url = new URL(candidate.getURL());
      return url.protocol == "http:" && url.hostname == "127.0.0.1";
    } catch { return false; }
  });
  if (!contents) {
    const candidates = electron.webContents.getAllWebContents().map((candidate) => {
      try {
        const url = new URL(candidate.getURL());
        return { protocol: url.protocol, hostname: url.hostname };
      } catch { return { protocol: "unavailable" }; }
    });
    process.stdout.write(JSON.stringify({ candidateCount: candidates.length, candidates, state: desktop.lifecycle.state }) + "\n");
    throw new Error("dashboard_window_missing");
  }
  await new Promise((done) => setTimeout(done, 250));
  const observed = await contents.executeJavaScript(
    "JSON.stringify({ready:document.readyState,hasBody:!!document.body,sameOrigin:location.hostname==='127.0.0.1',title:document.title,nav:[...document.querySelectorAll('[data-nav]')].map(e=>e.dataset.nav),icon:document.querySelector('.brand-icon')?.getAttribute('src'),iconReady:(document.querySelector('.brand-icon')?.naturalWidth??0)>0})",
  );
  const page = JSON.parse(observed);
  if (!page.hasBody || !page.sameOrigin || page.title !== "TiboTempo"
      || page.icon !== "./tibotempo.svg" || !page.iconReady
      || JSON.stringify(page.nav) !== JSON.stringify(["overview", "weekly", "performance", "method"])) {
    throw new Error("dashboard_not_loaded");
  }
  if (process.argv.includes("--fixture")) {
    const url = desktop.lifecycle.state.origin
      + "/api/local/model-performance?period=7&speedMode=standard&timeZone=Asia%2FShanghai";
    const deadline = Date.now() + 10_000;
    let result;
    do {
      const response = await fetch(url);
      if (response.status !== 200) throw new Error("fixture_model_api_failed");
      result = await response.json();
      if (result.status === "ready" && !result.collecting && result.models.length === 2) break;
      await new Promise((done) => setTimeout(done, 50));
    } while (Date.now() < deadline);
    if (result?.models?.length !== 2 || result.models.some((model) => model.turns !== 6)) {
      process.stdout.write(JSON.stringify({
        fixtureDiagnostic: {
          status: result?.status ?? null, collecting: result?.collecting ?? null,
          stale: result?.stale ?? null, historyProgress: result?.historyProgress ?? null,
          models: result?.models?.map(({ id, turns }) => ({ id, turns })) ?? [],
          selectedSyntheticRoot: desktop.childEnvironment?.CODEX_HOME === codexHome,
        },
      }) + "\n");
      throw new Error("fixture_model_counts_failed");
    }
    // A hidden test window normally pauses preloads. Simulate foreground
    // visibility without moving focus or revealing any user's desktop.
    await contents.executeJavaScript("Object.defineProperty(document,'hidden',{configurable:true,get:()=>false});Object.defineProperty(document,'visibilityState',{configurable:true,get:()=> 'visible'});document.dispatchEvent(new Event('visibilitychange'))");
  }
  await contents.executeJavaScript("document.querySelector('[data-nav=performance]').click()");
  await new Promise((done) => setTimeout(done, 250));
  const active = await contents.executeJavaScript("document.querySelector('[data-nav=performance]').getAttribute('aria-current')");
  if (active !== "page") throw new Error("performance_navigation_failed");
  if (process.argv.includes("--fixture")) {
    let points = 0;
    for (let attempt = 0; attempt < 40 && points === 0; attempt++) {
      points = await contents.executeJavaScript("document.querySelectorAll('#performance .performance-point').length");
      if (points === 0) await new Promise((done) => setTimeout(done, 100));
    }
    if (points === 0) throw new Error("performance_points_missing");
  }
  if (ipcFailures.length) throw new Error("desktop_ipc_failed:" + JSON.stringify(ipcFailures));
  if (consoleErrors.length) throw new Error("renderer_errors:" + JSON.stringify(consoleErrors));
  let preview = null;
  if (process.argv.includes("--preview")) {
    const base = resolve(fileURLToPath(new URL("../../..", import.meta.url)), ".release-build", "personal-previews");
    await mkdir(base, { recursive: true });
    const output = await mkdtemp(join(base, "run-"));
    const image = await contents.capturePage();
    if (!image.isEmpty()) {
      preview = join(output, "performance.png");
      await writeFile(preview, image.toPNG(), { flag: "wx" });
    }
  }
  process.stdout.write(JSON.stringify({ status: "ready", page, performanceActive: active, preview }) + "\n");
  await desktop.lifecycle.requestQuit();
  clearTimeout(timeout);
  await rm(root, { recursive: true, force: true });
  electron.app.exit(0);
} catch (error) {
  process.stderr.write(`personal_smoke_failed: ${error?.code ?? error?.message ?? "unknown"}\n`);
  await desktop?.lifecycle?.requestQuit?.().catch(() => {});
  clearTimeout(timeout);
  electron.app.exit(1);
}
}

// Let the Electron entry module finish before awaiting app readiness.
void run();
