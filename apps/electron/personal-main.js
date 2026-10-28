import { launchPersonalApp } from "./personal-runtime.js";

const runtime = await import("electron");
const { app } = runtime;

// Do not await app readiness at module top level: Electron emits ready after
// the entry module has finished evaluating.
launchPersonalApp({ runtime }).then((desktop) => {
  if (desktop.lifecycle === null && desktop.status !== "secondary_instance") {
    process.exitCode = 1;
  }
}).catch(() => {
  runtime.dialog?.showErrorBox?.("TiboTempo 无法启动", "请保留现有资料并检查应用配置。");
  process.exitCode = 1;
  app.quit();
});
