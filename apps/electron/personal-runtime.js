import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { launchDesktopRuntime } from "./desktop-runtime.js";
import { configurePersonalAppPaths, personalEnvironment, personalPaths, preparePersonalProfile } from "./personal-bootstrap.js";

const PERSONAL_FIRST_RUN_COPY = Object.freeze({
  title: "欢迎使用 TiboTempo",
  message: "分析本机 Codex 用量和模型性能",
  detail: "应用在本机读取用量元数据；读取订阅额度时会通过 Codex 查询。历史和设置保存在本机。",
  checkboxLabel: "开机时启动",
  failureTitle: "TiboTempo 无法启动",
  failureMessage: "无法保存或读取启动设置。",
  failureDetail: "请保留现有资料并检查应用目录的访问权限。",
  buttons: Object.freeze(["继续", "退出"]),
});

// A monochrome companion to the SVG: a gauge and a ruler remain legible at
// menu-bar size, where the full-colour app icon would be too detailed.
export function createPersonalIcon(nativeImage, platform = process.platform) {
  const width = 32;
  const bitmap = Buffer.alloc(width * width * 4);
  const distanceToNeedle = (x, y) => {
    const dx = 5, dy = -6;
    const t = Math.max(0, Math.min(1, ((x - 16) * dx + (y - 19) * dy) / (dx * dx + dy * dy)));
    return Math.hypot(x - (16 + t * dx), y - (19 + t * dy));
  };
  for (let y = 0; y < width; y++) {
    for (let x = 0; x < width; x++) {
      const gauge = y <= 19 && Math.abs(Math.hypot(x - 16, y - 19) - 9) <= 1.3;
      const needle = distanceToNeedle(x, y) <= 1.1 || Math.hypot(x - 16, y - 19) <= 1.6;
      const ruler = (y >= 24 && y <= 25 && x >= 7 && x <= 25)
        || (y >= 22 && y <= 24 && [9, 13, 16, 19, 23].includes(x));
      if (gauge || needle || ruler) {
        const offset = (y * width + x) * 4;
        bitmap[offset] = 230;
        bitmap[offset + 1] = 198;
        bitmap[offset + 2] = 70;
        bitmap[offset + 3] = 255;
      }
    }
  }
  const image = nativeImage.createFromBitmap(bitmap, { width, height: width, scaleFactor: 2 });
  if (platform === "darwin") image.setTemplateImage(true);
  return image;
}

/** The injectable overrides exist only for an unpackaged synthetic-profile test. */
export async function launchPersonalApp({
  runtime, environment = process.env, appData, firstRunReceiptBackend, lifecycleOptions,
  onStartupPhase, onStartupStop,
} = {}) {
  const { app, nativeImage } = runtime ?? {};
  if (!app || !nativeImage) throw new TypeError("Electron runtime is required");
  if (app.isPackaged && (appData !== undefined || firstRunReceiptBackend !== undefined
      || lifecycleOptions !== undefined || onStartupPhase !== undefined
      || onStartupStop !== undefined || environment !== process.env)) {
    throw new TypeError("packaged personal app does not accept test overrides");
  }
  const resourceRoot = app.isPackaged
    ? app.getAppPath()
    : resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const paths = personalPaths({ appData: appData ?? app.getPath("appData"), resourceRoot });
  configurePersonalAppPaths(app, paths);
  await preparePersonalProfile(paths);
  const icon = createPersonalIcon(nativeImage);
  if (process.platform === "darwin" && typeof app.dock?.setIcon === "function") {
    const applicationIcon = nativeImage.createFromPath(join(resourceRoot, "apps/electron/assets/tibotempo.png"));
    if (!applicationIcon.isEmpty()) {
      void app.whenReady().then(() => app.dock.setIcon(applicationIcon)).catch(() => {});
    }
  }
  return launchDesktopRuntime({
    runtime: { ...runtime, icon, createTrayIcon: () => icon },
    app,
    paths,
    environment: personalEnvironment(environment, paths, process.platform),
    firstRunReceiptBackend,
    firstRunDialogCopy: PERSONAL_FIRST_RUN_COPY,
    firstRunStartAtLoginDefault: false,
    ignoreLegacyStateRoots: true,
    lifecycleOptions: { ...lifecycleOptions, appName: "TiboTempo", minimalMenu: true },
    onStartupPhase,
    onStartupStop,
  });
}
