import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { translate } from "../public/localization.js";
import { quotaExhaustionProjection } from "../public/lib.js";

const HOUR = 3_600_000;
const source = await readFile(new URL("../public/app.js", import.meta.url), "utf8");

function declaration(name) {
  const match = source.match(new RegExp(`^(?:async )?function ${name}\\([\\s\\S]*?^\\}`, "mu"));
  assert.ok(match, `exercise production ${name}`);
  return match[0];
}

/**
 * Minimal element double. The production renderer only appends children, sets
 * text, dataset and attributes, so this is enough to observe what a reader
 * would actually see without a browser or a DOM library.
 */
class Element {
  constructor(tag = "div", className = "", textContent = "") {
    this.tag = tag; this.className = className; this.text = textContent;
    this.children = []; this.dataset = {}; this.attributes = {}; this.style = {};
  }
  get textContent() { return this.text + this.children.map((c) => c.textContent).join(""); }
  set textContent(value) { this.text = String(value); this.children = []; }
  append(...children) { for (const c of children) this.children.push(c); }
  replaceChildren(...children) { this.text = ""; this.children = [...children]; }
  setAttribute(key, value) { this.attributes[key] = value; }
  removeAttribute(key) { delete this.attributes[key]; }
}

function render({ locale = "zh-Hans", window: quotaWindow }) {
  const container = new Element();
  const context = new Element();
  const node = (tag, className, text) => new Element(tag, className, text ?? "");
  const finite = (value) => (typeof value === "number" && Number.isFinite(value) ? value : null);
  const factory = new Function(
    "$", "clear", "node", "finite", "isPrimaryCodexQuotaWindow", "isSparkQuotaLimitId",
    "isValidQuotaWindowDuration", "selectPrimaryCodexQuotaWindow", "localizedQuotaWindowLabel",
    "providerReportedPlanEvidence", "setLocalizedText", "t", "formatPercent", "formatLocal",
    "formatTimeRemaining", "localizedQuotaWindowDuration", "isPrimaryCodexWeeklyQuotaWindow",
    "forecastTimestamp", "allowanceTimestamp", "quotaExhaustionProjection",
    "formatAllowanceDuration", "CODEX_FIVE_HOUR_ALLOWANCE_MINUTES", `
      const closeInformationPopover = () => {};
      ${declaration("renderQuotaExhaustionProjection")}
      ${declaration("renderQuotaCards")}
      return renderQuotaCards;
    `,
  )(
    (selector) => ({ "#quota-cards": container, "#allowance-context": context })[selector],
    (element) => element.replaceChildren(),
    node, finite,
    () => true, () => false, () => true, (windows) => windows[0] ?? null,
    () => "Seven-day allowance", () => "",
    (element, key) => { element.text = key; },
    (key, values = {}) => translate(key, values, locale),
    (value) => `${value}%`, (value) => value, () => "Remaining time",
    () => "7 days", () => true,
    (value) => (value ? Date.parse(value) : null),
    (label) => node("span", "allowance-timestamp", label),
    quotaExhaustionProjection,
    // Mirrors the production duration wording so the assertion reads the same
    // strings a Chinese reader sees.
    (hours) => {
      if (hours === null || hours < 0) return null;
      if (hours < 1) return "不到 1 小时";
      const whole = Math.floor(hours + 1e-8);
      const days = Math.floor(whole / 24);
      return days > 0 ? `${days} 天 ${whole % 24} 小时` : `${whole} 小时`;
    },
    300,
  );
  factory({ quotaWindows: [quotaWindow], mode: "local" });
  return container;
}

function descendants(element) {
  return [element, ...element.children.flatMap(descendants)];
}

// The card reads the real clock, so the synthetic window is anchored on it.
// This is the live caller path, not a stubbed projection.
const NOW = Date.now();
// A twelve-hour window that opened ten hours ago with 10% used: the
// owner-confirmed reading is 10h ÷ 10% × 90% = 90h of supply left.
function twelveHourWindow(overrides = {}) {
  return {
    limitId: "codex", slot: "primary", durationMinutes: 720,
    usedPercent: 10, remainingPercent: 90, status: "live",
    resetAt: new Date(NOW + 2 * HOUR).toISOString(),
    observedAt: new Date(NOW).toISOString(),
    ...overrides,
  };
}

test("a card shows the projected run-out for its own window and compares it to the reset", () => {
  const container = render({ window: twelveHourWindow() });
  const card = container.children[0];
  const projection = descendants(card).find((e) => e.className === "quota-tank-projection");
  assert.ok(projection, "the card renders a projection block");
  assert.equal(projection.dataset.projectionState, "projected");
  assert.equal(projection.dataset.projectionStale, "false");
  const text = projection.textContent;
  assert.match(text, /预计耗尽/u);
  // 90 hours must be the reading, not a slope-based estimate.
  assert.match(text, /约剩 3 天 18 小时|约剩 90 小时/u);
  // It outlasts the two hours to the reset, and the card says which one wins.
  assert.match(text, /按此速度会超过重置时间/u);
  assert.match(text, /已过 10 小时/u);
  assert.match(text, /已用 10%/u);
  // The formula itself is disclosed in the card, not just in a tooltip.
  assert.match(text, /已过时间 ÷ 已用比例 × 剩余比例/u);
});

test("unknown, unused and exhausted windows stay explicitly labelled in the card", () => {
  const cases = [
    [{ usedPercent: 0, remainingPercent: 100 }, "no_usage", /本窗口尚无用量/u],
    [{ usedPercent: 100, remainingPercent: 0 }, "exhausted", /额度已用完/u],
    [{ resetAt: null }, "unavailable", /暂时无法推算耗尽时间/u],
    [{ durationMinutes: null }, "unavailable", /暂时无法推算耗尽时间/u],
    [{ usedPercent: null, remainingPercent: null }, "unavailable", /暂时无法推算耗尽时间/u],
  ];
  for (const [overrides, state, copy] of cases) {
    const projection = descendants(render({ window: twelveHourWindow(overrides) }))
      .find((e) => e.className === "quota-tank-projection");
    assert.ok(projection, JSON.stringify(overrides));
    assert.equal(projection.dataset.projectionState, state, JSON.stringify(overrides));
    assert.match(projection.textContent, copy, JSON.stringify(overrides));
    assert.doesNotMatch(projection.textContent, /约剩/u, "no duration is invented");
  }
});

test("a stale observation keeps its own reading and says the run-out is not current", () => {
  const projection = descendants(render({
    window: twelveHourWindow({ status: "stale", observedAt: new Date(NOW - HOUR).toISOString() }),
  })).find((e) => e.className === "quota-tank-projection");
  assert.equal(projection.dataset.projectionStale, "true");
  assert.match(projection.textContent, /观测已过期/u);
  // Nine hours elapsed, not ten: the estimate stays bound to the reading.
  assert.equal(projection.dataset.projectionState, "projected");
  assert.match(projection.textContent, /已过 .*9 小时|已过 9 小时/u);
});

test("an English reader gets the same arithmetic in English", () => {
  const projection = descendants(render({ locale: "en-US", window: twelveHourWindow() }))
    .find((e) => e.className === "quota-tank-projection");
  assert.match(projection.textContent, /Estimated run-out/u);
  assert.match(projection.textContent, /About .* left/u);
  assert.match(projection.textContent, /elapsed time ÷ used share × remaining share/u);
});

test("the projection never renders a zero or a guess for missing evidence", () => {
  // A window with no observable start cannot produce a duration.
  const projection = descendants(render({ window: twelveHourWindow({ resetAt: "not-a-date" }) }))
    .find((e) => e.className === "quota-tank-projection");
  assert.equal(projection.dataset.projectionState, "unavailable");
  assert.doesNotMatch(projection.textContent, /0\s*(?:小时|h)\b/u);
  assert.doesNotMatch(projection.textContent, /约剩/u);
});
