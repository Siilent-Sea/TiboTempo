import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
const app = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
const settingsHtml = await readFile(new URL("../public/electron-settings.html", import.meta.url), "utf8");
const trayHtml = await readFile(new URL("../public/electron-tray-popup.html", import.meta.url), "utf8");
const license = await readFile(new URL("../../../LICENSE", import.meta.url), "utf8");

test("the product presents itself as TiboTempo with its own bundled icon", () => {
  assert.match(html, /<title>TiboTempo<\/title>/u);
  assert.match(html, /<span>TiboTempo<\/span>/u);
  assert.match(html, /<html lang="zh-Hans">/u);
  // The icon is drawn and owned by the parent task; the page only references it.
  assert.match(html, /src="\.\/tibotempo\.svg"/u);
  assert.doesNotMatch(html, /tibotattle-icon\.png/u);
  assert.match(settingsHtml, /<title data-i18n="electron\.settings\.title">TiboTempo Settings<\/title>/u);
  assert.match(settingsHtml, /src="\.\/tibotempo\.svg"/u);
  assert.match(trayHtml, /<h1 id="tray-popup-title">TiboTempo<\/h1>/u);
  assert.match(trayHtml, /src="\.\/tibotempo\.svg"/u);
});

test("the MIT licence and the upstream copyright survive the rebrand", () => {
  assert.match(license, /MIT License/u);
  assert.match(license, /Copyright \(c\) 2026 Adam Allcock/u);
  assert.match(license, /The above copyright notice and this permission notice shall be included/u);
  assert.doesNotMatch(html, /built on TiboTattle/u);
  assert.doesNotMatch(settingsHtml, /built on TiboTempo/u);
});

test("only the four product pages remain reachable", () => {
  assert.deepEqual(
    [...html.matchAll(/data-nav="([^"]+)"/gu)].map((match) => match[1]),
    ["overview", "weekly", "performance", "method"],
  );
  const pages = new Set([...html.matchAll(/data-dashboard-page="([^"]+)"/gu)].map((match) => match[1]));
  for (const page of ["overview", "weekly", "performance", "method"]) {
    assert.equal(pages.has(page), true, page);
  }
  // Community and Projects & threads are gone outright. The usage chart keeps
  // its section as part of the recorded-usage evidence, but it is no longer a
  // separate destination in the navigation.
  for (const removed of ["community", "projects"]) {
    assert.equal(pages.has(removed), false, removed);
  }
  assert.doesNotMatch(html, /data-nav="trends"/u);
});

test("no account, community, updater or download entry is rendered", () => {
  for (const text of [html, settingsHtml, trayHtml]) {
    assert.doesNotMatch(text, /id="installer-link"|id="open-installed-app"|id="companion-setup"/u);
    assert.doesNotMatch(text, /settings-manage-sharing|settings-check-for-updates|settings-project-links/u);
    assert.doesNotMatch(text, /tibotattle\.com|github\.com\/adamallcock|x\.com\/adamallcock/u);
    assert.doesNotMatch(text, /id="electron-sharing-notice"|id="community"/u);
  }
  // The mount points for those removed views are gone from the runtime too, so
  // nothing can request a report the product no longer shows.
  assert.doesNotMatch(app, /mountWorkUsageView|workUsageView\.setReportingWindow/u);
  assert.doesNotMatch(app, /renderSharedInstallerJourney|install-cta\.js/u);
});

test("Settings keeps the tray, language and display controls a local build needs", () => {
  for (const id of [
    "settings-language",
    "settings-appearance",
    "settings-panel-tray",
    "settings-refresh-interval",
    "settings-open-dashboard-browser",
  ]) {
    assert.match(settingsHtml, new RegExp(`id="${id}"`), id);
  }
  // The removed update controls are absent from markup, and the renderer reads
  // each one optionally so an installed build cannot throw on their absence.
  for (const removed of [
    "settings-automatic-updates",
    "settings-check-for-updates",
    "settings-download-update",
    "settings-install-update",
    "settings-updates-status",
  ]) {
    assert.doesNotMatch(settingsHtml, new RegExp(`id="${removed}"`), removed);
  }
});

test("the model performance page keeps model, speed, time and effective turn counts", async () => {
  const performance = await readFile(new URL("../public/model-performance.js", import.meta.url), "utf8");
  // Speed modes, time zone and per-model measured turns are the product's
  // primary comparison; none of them may be dropped from the surface.
  assert.match(performance, /const SPEED_MODES = \["standard", "fast", "ultrafast"\]/u);
  assert.match(performance, /selectedTimeZone/u);
  assert.match(performance, /combinedSpeedSummary/u);
  assert.match(performance, /speedTurns/u);
  assert.match(app, /mountModelPerformance\(\{/u);
  assert.match(app, /sharedReporting: true/u);
});
