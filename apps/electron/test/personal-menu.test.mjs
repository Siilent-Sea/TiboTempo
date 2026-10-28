import assert from "node:assert/strict";
import test from "node:test";

import { createDesktopMenuTemplate } from "../desktop-menu.js";
import { createDesktopTrayTemplate } from "../desktop-tray.js";

test("personal native menu exposes working local actions without unrelated sections", () => {
  const invoked = [];
  const actions = Object.fromEntries(["show", "refresh", "settings", "quit", "projects", "checkForUpdates"]
    .map((name) => [name, () => invoked.push(name)]));
  for (const platform of ["darwin", "win32"]) {
    const menu = createDesktopMenuTemplate({
      appName: "TiboTempo", actions, platform, locale: "zh-Hans", minimal: true,
    });
    const clickable = menu.flatMap((item) => item.submenu ?? []).filter((item) => typeof item.click === "function");
    for (const item of clickable) item.click();
    assert.deepEqual(invoked.splice(0), ["show", "refresh", "settings", "quit"]);
    assert.equal(menu.some((item) => item.submenu?.some((entry) => entry.click === actions.projects)), false);
  }
});

test("personal tray keeps allowance, recovery, settings and quit without upstream updater", () => {
  const invoked = [];
  const actions = {
    show: () => invoked.push("show"),
    retry: () => invoked.push("retry"),
    settings: () => invoked.push("settings"),
    quit: () => invoked.push("quit"),
    checkForUpdates: () => invoked.push("update"),
  };
  const tray = createDesktopTrayTemplate({
    appName: "TiboTempo", actions, platform: "darwin", locale: "zh-Hans", minimal: true,
  });
  for (const item of tray) if (typeof item.click === "function") item.click();
  assert.deepEqual(invoked, ["show", "retry", "settings", "quit"]);
  assert.ok(tray.some((item) => item.enabled === false));
  assert.equal(tray.some((item) => item.accelerator === "CmdOrCtrl+Q"), true);
});
