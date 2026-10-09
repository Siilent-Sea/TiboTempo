import assert from "node:assert/strict";
import test from "node:test";
import { buildCommunityAllowanceChartModel, renderCommunityAllowanceSection } from "../public/community-view.js";
import { COMMUNITY_ALLOWANCE_BREAKDOWN_SCHEMA_VERSIONS, COMMUNITY_DAILY_CACHE_SCHEMA_IDENTITY,
  normalizeCommunityDailySeries, normalizePublicAllowanceBreakdowns, planWeeklyApiEquivalentUsd,
  COMMUNITY_ALLOWANCE_PRO10_BASIS, COMMUNITY_ALLOWANCE_PRO10_NORMALIZATION,
  projectCommunityDailyPayloadForCache, PUBLIC_ALLOWANCE_MODEL_CONFIG, publicAllowanceModels } from "../public/community-data.js";
import { translate, translatePlural } from "../public/localization.js";
import { publicAllowanceFixture } from "./fixtures/public-allowance.js";

// Synthetic presentation data only; never served by a production client.
const summary = (centralUsd, participants = 2) => ({
  centralUsd, participantCount: centralUsd === null ? 0 : participants,
  fitCount: centralUsd === null ? 0 : 4,
  band80Usd: centralUsd === null ? null : { lowerUsd: centralUsd * .8, upperUsd: centralUsd * 1.2 },
});
function series() {
  return {
    state: "published", allowanceState: "ready",
    days: ["2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04", "2026-09-05"].map(day => ({
      day, allowance: summary(1500),
    })),
    breakdowns: {
      modelConfig: [
        { modelId: "gpt-5.5", label: "GPT-5.5" },
        { modelId: "gpt-6-astra", label: "GPT-6 Astra" },
      ],
      days: ["2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04", "2026-09-05"].map((day, index) => ({
        day,
        byPlanType: { pro: summary(2000), prolite: summary(index === 2 ? null : 1000), plus: summary(3000) },
        models: index === 3 ? [["gpt-5.5", 4500, 2], ["gpt-6-astra", 6000, 3],
          ["gpt-6-sol", 3000, 2], ["gpt-6-luna", 500, 1]]
          : index === 4 ? [["gpt-6-astra", 6500, 3]] : [],
      })),
    },
  };
}

test("30-day comparisons keep dates aligned and use view-specific positive dollar axes", () => {
  const models = ["aggregate", "plans", "models"].map(view => buildCommunityAllowanceChartModel(series(), { view, rangeDays: 30 }));
  for (const model of models) {
    assert.ok(model);
    assert.deepEqual(model.dayTicks, models[0].dayTicks);
    assert.equal(model.dollarTicks[0].value > 0, true);
  }
  assert.notDeepEqual(models[0].dollarTicks, models[2].dollarTicks);
  assert.equal(models[0].height, models[1].height * 1.5);
  assert.equal(models[2].height, models[0].height);
  assert.ok(models[2].dollarTicks.at(-1).value >= 6500);
  assert.equal(models[1].legendSeries.length, 3);
  assert.deepEqual(models[1].cardSeries.map(item => item.key), ["plus", "prolite", "pro"]);
  assert.deepEqual(models[1].latestSummaries.map(item => item.seriesKey), ["plus", "prolite", "pro"]);
  assert.deepEqual(models[2].legendSeries.map(item => item.label),
    ["GPT-6 Astra", "GPT-6 Sol", "GPT-6 Luna"]);
});

test("All fits the selected view's evidence dates and dollar scale", () => {
  const data = series();
  const aggregate = buildCommunityAllowanceChartModel(data);
  const model = buildCommunityAllowanceChartModel(data, { view: "models" });
  assert.deepEqual(model.dayTicks.map(tick => tick.day), ["2026-09-04", "2026-09-05"]);
  assert.equal(model.dots[0].x, model.plot.left);
  assert.equal(model.dots.at(-1).x, model.plot.right);
  assert.equal(aggregate.dayTicks[0].day, "2026-09-01");
  assert.ok(model.dollarTicks[0].value > 0);
  assert.notDeepEqual(model.dollarTicks, aggregate.dollarTicks);
});

test("each plan's own-week chart gets a rounded positive floor", () => {
  const data = series();
  for (const key of ["plus", "prolite", "pro"]) {
    const model = buildCommunityAllowanceChartModel(data, { view: "plans", seriesKeys: [key] });
    assert.equal(model.legendSeries[0].key, key);
    assert.ok(model.dollarTicks[0].value > 0);
    assert.ok(model.dollarTicks[0].value < Math.min(...model.dots.map(dot => dot.band80Usd?.lowerUsd ?? dot.centralUsd)));
  }
});

test("public model order is exact across cards, legend and same-day inspection", () => {
  const data = series();
  const preferred = ["gpt-6-astra", "gpt-6-sol", "gpt-6-luna",
    "gpt-5.6-terra", "gpt-5.6-sol", "gpt-5.6-luna"];
  const ids = ["gpt-5.4", ...preferred.toReversed()];
  data.breakdowns.modelConfig = ids.map(modelId => ({ modelId, label: modelId }));
  data.breakdowns.days.at(-1).models = [...ids, "gpt-5.5"].map(id => [id, 1500, 1]);
  const model = buildCommunityAllowanceChartModel(data, { view: "models" });
  assert.deepEqual(model.legendSeries.map(item => item.key), preferred);
  assert.deepEqual(model.cardSeries.map(item => item.key), preferred);
  assert.deepEqual(model.latestSummaries.map(item => item.seriesKey), preferred);
  assert.deepEqual(model.dots.filter(dot => dot.day === "2026-09-05").map(dot => dot.seriesKey), preferred);
  assert.deepEqual(model.legendSeries.map(item => item.theme),
    ["astra", "sol", "luna", "terra", "sol", "luna"]);
  assert.deepEqual(data.breakdowns.modelConfig.map(item => item.modelId), ids, "catalog is never reordered in place");
});

test("dense history thins permanent markers but retains all observations and gap endpoints", () => {
  const data = series();
  data.days = Array.from({ length: 120 }, (_, index) => ({
    day: new Date(Date.parse("2026-05-01") + index * 86400000).toISOString().slice(0, 10), allowance: summary(1500),
  }));
  data.breakdowns.days = data.days.map(({ day }, index) => ({ day,
    byPlanType: { pro: summary(index === 60 ? null : 2000), prolite: summary(null), plus: summary(null) }, models: [],
  }));
  const model = buildCommunityAllowanceChartModel(data, { view: "plans" });
  assert.equal(model.dots.length, 119);
  assert.deepEqual(model.centralSegments.map(segment => segment.length), [60, 59]);
  assert.deepEqual(model.markerDots.map(dot => dot.day), [0, 59, 61, 119].map(index => data.days[index].day));
  const daySpacing = (model.plot.right - model.plot.left) / 119;
  assert.ok(model.dots.every(dot => 2 * dot.radius < daySpacing), "adjacent markers cannot overlap");
  assert.ok(model.dots[60].x - model.dots[59].x > model.dots[1].x - model.dots[0].x, "the missing date keeps its elapsed space");
});

test("model points start with observed evidence and never acquire a fabricated band or reset-fit count", () => {
  const model = buildCommunityAllowanceChartModel(series(), { view: "models" });
  const astra = model.legendSeries.find(item => item.key === "gpt-6-astra");
  assert.deepEqual(astra.dots.map(dot => dot.day), ["2026-09-04", "2026-09-05"]);
  assert.ok(astra.dots.every(dot => dot.fitCount === null && dot.participantCount === 3));
  assert.deepEqual(model.bandSegments, []);
  assert.equal(model.sparse, true);
  assert.equal(model.latestSummaries.length, 3);
  assert.equal(model.cardSeries.length, 6);
  assert.equal(model.cardSeries.filter(item => item.latest === null).length, 3);
});

test("plan lines and uncertainty bands break at missing evidence", () => {
  const model = buildCommunityAllowanceChartModel(series(), { view: "plans" });
  const plan = model.legendSeries.find(item => item.key === "prolite");
  assert.deepEqual(plan.centralSegments.map(points => points.map(point => point.day)), [
    ["2026-09-01", "2026-09-02"], ["2026-09-04", "2026-09-05"],
  ]);
  assert.deepEqual(plan.bandSegments.map(points => points.map(point => point.day)), [
    ["2026-09-01", "2026-09-02"], ["2026-09-04", "2026-09-05"],
  ]);
  assert.equal(plan.dots.some(dot => dot.centralUsd === 0), false);
});

test("date range and absent public breakdowns fail honestly without affecting aggregate", () => {
  const data = series();
  const ranged = buildCommunityAllowanceChartModel(data, { view: "models", rangeDays: 1 });
  assert.deepEqual(ranged.dots.map(dot => dot.day), ["2026-09-05"]);
  assert.ok(ranged.dots.every(dot => Number.isFinite(dot.x) && Number.isFinite(dot.y)));
  const absent = { ...data, breakdowns: null };
  assert.ok(buildCommunityAllowanceChartModel(absent));
  assert.equal(buildCommunityAllowanceChartModel(absent, { view: "models" }), null);
  assert.equal(buildCommunityAllowanceChartModel(data, { view: "unknown" }), null);
  data.breakdowns.days.forEach(day => { day.models = []; });
  assert.equal(buildCommunityAllowanceChartModel(data, { view: "models" }), null);
});

test("public view controls and method caveats are translated in every shipped language", () => {
  for (const locale of ["en-US", "zh-Hans", "es"]) {
    for (const suffix of ["viewLabel", "viewAggregate", "viewPlans", "viewModels", "smallSampleDisclosure", "breakdownsUnavailable", "modelsAccumulating", "noModelEstimate", "planMethod", "modelMethod", "planChartLabel", "modelChartLabel", "planChartDescription", "modelChartDescription", "cardsCaption", "legendFocus", "unrecognizedModels"]) {
      const key = `community.allowance.${suffix}`;
      const value = translate(key, {}, locale);
      assert.notEqual(value, key);
      if (locale !== "en-US") assert.notEqual(value, translate(key, {}, "en-US"));
    }
    for (const count of [1, 3]) assert.match(translatePlural("community.allowance.shortAccountCount", count, {}, locale), new RegExp(String(count)));
  }
});

const NOW = Date.parse("2026-09-07T12:00:00.000Z");
test("actual plan values invert only the supported reference scaling without rounding or inventing missing values", () => {
  assert.equal(planWeeklyApiEquivalentUsd(2011, "pro"), 2011);
  assert.equal(planWeeklyApiEquivalentUsd(1916, "prolite"), 479);
  assert.equal(planWeeklyApiEquivalentUsd(2257, "plus"), 112.85);
  assert.equal(planWeeklyApiEquivalentUsd(0, "plus"), 0);
  for (const value of [null, undefined, NaN, Infinity, -1, "2257"]) {
    assert.equal(planWeeklyApiEquivalentUsd(value, "plus"), null);
  }
  for (const plan of ["free", "team", "constructor", "toString", "__proto__", null, undefined, ["plus"], {}]) {
    assert.equal(planWeeklyApiEquivalentUsd(2257, plan), null);
  }
  for (const locale of ["en-US", "zh-Hans", "es"]) {
    const copy = translate("community.allowance.actualPlanValue", { value: "$479" }, locale);
    assert.ok(copy.includes("$479"));
    assert.ok(!copy.includes("{value}"));
  }
});
test("the closed public wire survives normalization into all three chart views", () => {
  const payload = publicAllowanceFixture(NOW);
  const normalized = normalizeCommunityDailySeries(payload, { nowMs: NOW });
  assert.equal(normalized.state, "published");
  assert.equal(normalized.breakdowns.days.length, 35);
  assert.ok(normalized.breakdowns.modelConfig.some(model => model.modelId === "gpt-6-astra"));
  // GPT-6.1 Sol keeps its roster slot but is held back: it is never pinned, so
  // it has no card until a served publication carries an estimate for it.
  assert.deepEqual(normalized.breakdowns.modelConfig.map(model => model.modelId),
    ["gpt-6-astra", "gpt-6.1-sol", "gpt-6-sol", "gpt-6-luna", "gpt-5.6-terra", "gpt-5.6-sol", "gpt-5.6-luna"]);
  assert.deepEqual(normalized.breakdowns.modelConfig.filter(model => !model.pinned).map(model => model.modelId),
    ["gpt-6.1-sol"]);
  assert.ok(normalized.breakdowns.modelConfig.every(model => model.modelId !== "gpt-5.3-codex-spark"));
  for (const view of ["aggregate", "plans", "models"]) {
    assert.ok(buildCommunityAllowanceChartModel(normalized, { view }).dots.length > 0);
  }
  payload.allowanceBreakdowns.days[0].byPlanType.pro.centralUsd = 9999;
  assert.equal(normalized.breakdowns.days[0].byPlanType.pro.centralUsd, 2000, "fresh copied allowlist");
});

test("v1.1 keeps all graph views on one publication while daily revisions update independently", () => {
  const payload = publicAllowanceFixture(NOW);
  payload.allowanceBreakdowns.schemaVersion = "community-allowance-breakdowns-v1.1";
  for (const [index, day] of payload.allowanceBreakdowns.days.entries()) {
    const { centralUsd, participantCount, fitCount, band80Usd } = payload.days[index].payload.allowance;
    day.combined = { centralUsd, participantCount, fitCount, band80Usd };
    delete payload.days[index].payload.allowance;
  }
  const normalized = normalizeCommunityDailySeries(payload, { nowMs: NOW });
  assert.equal(normalized.breakdowns.hasCombined, true);
  const oldChart = buildCommunityAllowanceChartModel(normalized, { view: "aggregate" });
  assert.equal(oldChart.latest.centralUsd, 1908);
  payload.days.at(-1).payload.allowance = { ...publicAllowanceFixture(NOW).days.at(-1).payload.allowance, centralUsd: 9999 };
  const later = normalizeCommunityDailySeries(payload, { nowMs: NOW + 3 * 86400000 });
  assert.deepEqual(buildCommunityAllowanceChartModel(later, { view: "aggregate" }), oldChart);
  for (const view of ["plans", "models"]) assert.ok(buildCommunityAllowanceChartModel(later, { view }));
  delete payload.allowanceBreakdowns.days[0].combined;
  assert.equal(normalizeCommunityDailySeries(payload, { nowMs: NOW }).breakdowns, null);
});

test("optional public breakdown rejects private extras and invalid evidence without hiding activity", () => {
  const invalid = [
    value => { value.participant_id = "PRIVATE_CANARY"; },
    value => { value.days[0].coverage = { raw: "PRIVATE_CANARY" }; },
    value => { value.days[0].byPlanType.pro.identity = "PRIVATE_CANARY"; },
    value => { value.days[0].byPlanType.pro.band80Usd.raw = "PRIVATE_CANARY"; },
    value => { value.days[0].byPlanType.team = value.days[0].byPlanType.pro; },
    // An UNKNOWN model id no longer invalidates the block: that tuple is
    // dropped and counted instead ("an unknown model id is skipped and
    // counted" below). A reviewed model kept off the primary comparison, an id
    // that is not shaped like a model id, and a repeated id are still producer
    // faults.
    value => { value.days[0].models = [["gpt-5.3-codex-spark", 1234, 1]]; },
    value => { value.days[0].models = [["claude-opus-5", 1234, 1]]; },
    value => { value.days[0].models = [["<private-model-canary>", 1234, 1]]; },
    value => { value.days[0].models = [["private-model-canary", 1234, 1], ["private-model-canary", 1234, 1]]; },
    value => { value.days[0].models = [["gpt-6-astra", 1234, 1, "PRIVATE_CANARY"]]; },
    value => { value.days[0].models = [[null, 1234, 1]]; },
    value => { value.days[0].models = [["gpt-6-astra", 1234, 1], "private-model-canary"]; },
    value => { value.days[0].models = [["private-model-canary", "1234", 1]]; },
    value => { value.days[0].models = [["private-model-canary", 1234, 0]]; },
    value => { value.days[0].models = [["gpt-6-astra", 1234, 1], ["gpt-6-astra", 1234, 1]]; },
    value => { value.days[0].models = [["gpt-6-astra", 1234, 0]]; },
    value => { value.days[0].models = [["gpt-6-astra", "1234", 1]]; },
    value => { value.days[0].byPlanType.pro.participantCount = 5; },
    value => { value.days[0].byPlanType.pro.centralUsd = Infinity; },
    value => { value.days[0].byPlanType.pro.fitCount = 2; },
    value => { value.days[0].byPlanType.pro.band80Usd.lowerUsd = 9000; },
    value => { value.days.reverse(); },
    value => { value.days.push(value.days.at(-1)); },
    value => { value.schemaVersion = "private-admin-preview"; },
    value => { value.modelGate = "unchecked"; },
  ];
  for (const mutate of invalid) {
    const payload = publicAllowanceFixture(NOW);
    mutate(payload.allowanceBreakdowns);
    const normalized = normalizeCommunityDailySeries(payload, { nowMs: NOW });
    assert.equal(normalized.breakdowns, null, mutate.toString());
    assert.equal(normalized.state, "published");
    assert.equal(normalized.days.length, 35);
    assert.equal(buildCommunityAllowanceChartModel(normalized).latest.centralUsd, 1908);
    assert.doesNotMatch(JSON.stringify(normalized), /PRIVATE_CANARY|private-model-canary/u);
  }
});

test("public breakdown dates persist while publication and clock boundaries fail closed", () => {
  const payload = publicAllowanceFixture(NOW);
  const decode = (value, days = payload.days.map(day => day.day), nowMs = NOW) =>
    normalizePublicAllowanceBreakdowns(value, days, nowMs);
  assert.ok(decode(payload.allowanceBreakdowns));
  assert.equal(decode(payload.allowanceBreakdowns, []), null);
  assert.deepEqual(decode(payload.allowanceBreakdowns, undefined, NOW + 3 * 86400000), decode(payload.allowanceBreakdowns));
  assert.ok(decode(payload.allowanceBreakdowns, undefined, NOW + 125 * 60000));
  assert.equal(decode(payload.allowanceBreakdowns, undefined, NOW - 5 * 60000 - 1), null);
  assert.equal(decode(payload.allowanceBreakdowns, undefined, NaN), null);
  for (const day of ["2026-09-07", "2026-09-08", "2026-06-01", "2026-02-30"]) {
    const value = structuredClone(payload.allowanceBreakdowns);
    value.days = [{ ...value.days[0], day }];
    assert.equal(decode(value, [day]), null, day);
  }
  const midnight = Date.parse("2026-09-08T00:01:00.000Z");
  const previousSnapshot = publicAllowanceFixture(midnight - 120000).allowanceBreakdowns;
  previousSnapshot.days = [{ ...previousSnapshot.days[0], day: "2026-09-07" }];
  assert.equal(decode(previousSnapshot, ["2026-09-07"], midnight), null, "snapshot's open day stays withheld after midnight");
  payload.allowanceState = "updating";
  assert.equal(normalizeCommunityDailySeries(payload, { nowMs: NOW }).breakdowns, null);
});

class Element {
  constructor(tag) { this.tag = tag; this.children = []; this.attributes = new Map(); this.textContent = ""; this.className = ""; }
  append(...children) { this.children.push(...children); }
  replaceChildren() { this.children = []; }
  setAttribute(key, value) { this.attributes.set(key, value); }
  descendants() { return this.children.flatMap(child => [child, ...child.descendants()]); }
  get text() { return [this.textContent, ...this.children.map(child => child.text)].join(" "); }
}

function interactiveDocument() {
  const documentRef = { documentElement: { lang: "en-US" }, activeElement: null };
  class InteractiveElement extends Element {
    constructor(tag) { super(tag); this.listeners = new Map(); this.style = { setProperty() {} }; }
    addEventListener(type, callback) { this.listeners.set(type, callback); }
    getBoundingClientRect() { return { left: 0, top: 0, width: 640, height: 260 }; }
    fire(type, fields = {}) { this.listeners.get(type)?.({ preventDefault() {}, ...fields }); }
    contains(element) { return element === this || this.descendants().includes(element); }
    replaceChildren() {
      if (this.descendants().includes(documentRef.activeElement)) documentRef.activeElement = null;
      super.replaceChildren();
    }
    focus(options) {
      documentRef.activeElement?.fire("blur");
      documentRef.activeElement = this;
      this.focusOptions = options;
      this.fire("focus");
    }
  }
  documentRef.createElement = tag => new InteractiveElement(tag);
  documentRef.createElementNS = (_, tag) => new InteractiveElement(tag);
  return documentRef;
}

function chartParts(container) {
  const all = container.descendants();
  return { buttons: all.filter(element => element.tag === "button"),
    astra: all.find(element => element.tag === "button" && element.text.includes("Astra")),
    svg: all.find(element => element.tag === "svg" && element.attributes.has("aria-label")),
    tooltip: all.find(element => element.className === "allowance-tooltip") };
}
test("real public render shows model sample semantics, per-view labels and disclosure", () => {
  const documentRef = { documentElement: { lang: "en-US" }, createElement: tag => new Element(tag),
    createElementNS: (_, tag) => new Element(tag) };
  for (const view of ["aggregate", "plans", "models"]) {
    const container = new Element("div");
    assert.equal(renderCommunityAllowanceSection({ documentRef, container,
      payload: publicAllowanceFixture(), view }), "published");
    assert.match(container.text, /single source.*estimated capacity/u);
    assert.match(container.text, view === "aggregate" ? /per 7 days, API-price equivalent/u
      : view === "plans" ? /API-equivalent USD \/ each plan's own week/u : /API-equivalent USD \/ Pro 20× week/u);
    const svg = container.descendants().find(element => element.tag === "svg" && element.attributes.has("aria-label"));
    assert.ok(svg);
    if (view === "models") {
      assert.doesNotMatch(container.text, /Pro 20x-equivalent:/u);
      assert.match(container.text, /GPT-6 Astra/u);
      assert.match(container.text, /1 source/u);
      const cards = container.descendants().filter(element => element.tag === "article");
      assert.deepEqual(cards.map(card => card.descendants().find(element => element.tag === "h3")?.text),
        ["GPT-6 Astra", "GPT-6 Sol", "GPT-6 Luna", "GPT-5.6 Terra", "GPT-5.6 Sol", "GPT-5.6 Luna"]);
      assert.doesNotMatch(container.text, /GPT-5.5/u);
      // GPT-6.1 Sol has no estimate here, so the page does not name it at all.
      assert.doesNotMatch(container.text, /GPT-6\.1 Sol/u);
      assert.match(cards[3].text, /No published estimate yet/u);
      assert.match(cards[0].text.trim(), /^GPT-6 Astra/u);
      assert.match(cards[0].className, /allowance-model-astra/u);
      assert.ok(cards.every(card => !/\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{1,2}, \d{4}\b/u.test(card.text)),
        "model cards show source counts without repeating the publication day");
      assert.ok(cards.every(card => !card.text.includes("per 7 days")), "one shared unit caption replaces repeated card prose");
      assert.ok(cards.every(card => card.descendants().some(element => element.attributes.get("aria-hidden") === "true")));
      assert.equal(svg.attributes.get("aria-label"), "Community allowance by model");
      assert.match(svg.attributes.get("aria-description"), /contribution sources, not reset fits/u);
      assert.equal(svg.descendants().filter(element => element.attributes.get("class")?.includes("allowance-band-area")).length, 0);
    } else if (view === "plans") {
      // Nothing is scaled any more: each plan is charted on its own axis at its
      // own week, so the old "Pro 5× ×4, Plus ×20" note would be a lie.
      assert.match(container.text, /Shading shows the middle 80% of qualifying reset fits/u);
      assert.doesNotMatch(container.text, /Each plan is charted|Card values repeat/u);
      assert.equal(svg.attributes.get("aria-label"), "Community allowance by plan");
      const normalized = normalizeCommunityDailySeries(publicAllowanceFixture());
      const summaries = buildCommunityAllowanceChartModel(normalized, { view: "plans" }).latestSummaries;
      const cards = container.descendants().filter(element => element.tag === "article");
      assert.equal(cards.length, 3);
      assert.ok(cards.every(card => !/\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{1,2}, \d{4}\b/u.test(card.text)),
        "plan cards show source counts without repeating the publication day");
      cards.forEach((card, index) => {
        // The card LEADS with the plan's own week and carries the reference
        // equivalent underneath, which is the inverse of the old layout.
        const money = value => new Intl.NumberFormat("en-US",
          { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(value);
        const planValue = planWeeklyApiEquivalentUsd(summaries[index].centralUsd, summaries[index].seriesKey);
        assert.ok(card.text.includes(money(planValue)), "own week leads");
        assert.ok(card.text.includes(`Pro 20x-equivalent: ${money(summaries[index].centralUsd)}/week`));
      });
    } else {
      assert.doesNotMatch(container.text, /This plan:/u);
    }
  }
  const emptyModels = publicAllowanceFixture();
  emptyModels.allowanceBreakdowns.days.forEach(day => { day.models = []; });
  const container = new Element("div");
  assert.equal(renderCommunityAllowanceSection({ documentRef, container, payload: emptyModels, view: "models" }), "estimates_accumulating");
  assert.match(container.text, /No identified model estimates/u);
  assert.doesNotMatch(container.text, /no reset fit has qualified/u);
});

test("the source disclosure can sit beside the introduction without leaving a result gap", () => {
  const documentRef = { documentElement: { lang: "en-US" }, createElement: tag => new Element(tag),
    createElementNS: (_, tag) => new Element(tag) };
  const container = new Element("div");
  const sourceContainer = new Element("div");
  const payload = publicAllowanceFixture(NOW);
  assert.equal(renderCommunityAllowanceSection({ documentRef, container, sourceContainer, payload }), "published");
  assert.match(sourceContainer.text, /About these sources/u);
  assert.match(sourceContainer.text, /single source.*estimated capacity/u);
  assert.doesNotMatch(container.text, /About these sources/u);
  payload.allowanceState = "updating";
  assert.equal(renderCommunityAllowanceSection({ documentRef, container, sourceContainer, payload }), "allowance_updating");
  assert.equal(sourceContainer.children.length, 0, "unavailable estimates do not leave a stale disclosure");
});

test("legend focus dims other series without discarding data and limits keyboard inspection to that series", () => {
  const documentRef = interactiveDocument();
  const container = documentRef.createElement("div");
  renderCommunityAllowanceSection({ documentRef, container, payload: publicAllowanceFixture(), view: "models" });
  const all = container.descendants();
  const buttons = all.filter(element => element.tag === "button");
  const astra = buttons.find(button => button.text.includes("Astra"));
  const svg = all.find(element => element.attributes.get("aria-label") === "Community allowance by model");
  const tooltip = all.find(element => element.className === "allowance-tooltip");
  const before = svg.descendants().length;
  astra.fire("click");
  assert.equal(astra.attributes.get("aria-pressed"), "true");
  assert.ok(svg.descendants().some(element => element.attributes.get("data-muted") === "true"));
  assert.equal(svg.descendants().length, before, "all chart evidence is retained");
  for (const key of ["Home", "ArrowRight", "End", "ArrowLeft"]) {
    svg.fire("keydown", { key });
    assert.match(tooltip.text, /GPT-6 Astra/u);
    assert.doesNotMatch(tooltip.text, /GPT-5/u);
  }
  astra.fire("click");
  assert.equal(astra.attributes.get("aria-pressed"), "false");
  assert.ok(svg.descendants().every(element => element.attributes.get("data-muted") !== "true"));
  svg.fire("keydown", { key: "End" });
  assert.match(tooltip.text, /GPT-5.6 Sol/u);
  assert.doesNotMatch(container.text, /GPT-5.5/u);
});

test("a changed publication preserves selected legend, inspected date and chart focus using only new point values", () => {
  const documentRef = interactiveDocument(), container = documentRef.createElement("div");
  const payload = publicAllowanceFixture(NOW);
  const render = () => renderCommunityAllowanceSection({ documentRef, container, payload, view: "models" });
  render(); const before = chartParts(container);
  before.astra.fire("click"); before.svg.focus(); before.svg.fire("keydown", { key: "Home" });
  before.svg.fire("keydown", { key: "ArrowRight" });
  const date = before.tooltip.descendants().find(element => element.className === "allowance-tooltip-date").text;
  const points = buildCommunityAllowanceChartModel(normalizeCommunityDailySeries(payload), { view: "models" })
    .dots.filter(dot => dot.seriesKey === "gpt-6-astra");
  for (const day of payload.allowanceBreakdowns.days) for (const row of day.models) {
    if (row[0] === "gpt-6-astra") row[1] += 1000;
  }
  render(); const after = chartParts(container);
  assert.notEqual(after.svg, before.svg);
  assert.equal(documentRef.activeElement, after.svg);
  assert.deepEqual(after.svg.focusOptions, { preventScroll: true });
  assert.equal(after.astra.attributes.get("aria-pressed"), "true");
  assert.ok(after.svg.descendants().some(element => element.attributes.get("data-muted") === "true"));
  assert.equal(after.tooltip.attributes.get("data-visible"), "true");
  assert.equal(after.tooltip.descendants().find(element => element.className === "allowance-tooltip-date").text, date);
  const dollars = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
  assert.ok(after.tooltip.text.includes(dollars.format(points[1].centralUsd + 1000)));
  assert.ok(!after.tooltip.text.includes(dollars.format(points[1].centralUsd)));
  after.svg.fire("keydown", { key: "ArrowRight" });
  assert.ok(after.tooltip.text.includes(dollars.format(points[2].centralUsd + 1000)));
});

test("refresh restores a focused legend but never steals focus from another control or another chart", () => {
  const documentRef = interactiveDocument(), container = documentRef.createElement("div");
  const payload = publicAllowanceFixture(NOW);
  const render = () => renderCommunityAllowanceSection({ documentRef, container, payload, view: "models" });
  render(); let chart = chartParts(container);
  chart.astra.focus(); chart.astra.fire("click"); render(); chart = chartParts(container);
  assert.equal(documentRef.activeElement, chart.astra);
  assert.equal(chart.astra.attributes.get("aria-pressed"), "true");
  const outside = documentRef.createElement("button"); outside.focus();
  render(); chart = chartParts(container);
  assert.equal(documentRef.activeElement, outside);
  assert.equal(chart.astra.attributes.get("aria-pressed"), "true");
  assert.equal(chart.tooltip.attributes.get("data-visible"), "false");
  const other = documentRef.createElement("div");
  renderCommunityAllowanceSection({ documentRef, container: other, payload, view: "models" });
  assert.equal(chartParts(other).astra.attributes.get("aria-pressed"), "false");
  assert.equal(documentRef.activeElement, outside);
});

test("refresh retains keyboard position and an Escape-dismissed tooltip without reopening it", () => {
  const documentRef = interactiveDocument(), container = documentRef.createElement("div");
  const payload = publicAllowanceFixture(NOW);
  const render = () => renderCommunityAllowanceSection({ documentRef, container, payload, view: "models" });
  render(); const before = chartParts(container);
  before.astra.fire("click"); before.svg.focus(); before.svg.fire("keydown", { key: "Home" });
  before.svg.fire("keydown", { key: "Escape" }); render(); const after = chartParts(container);
  assert.equal(documentRef.activeElement, after.svg);
  assert.equal(after.tooltip.attributes.get("data-visible"), "false");
  after.svg.fire("keydown", { key: "ArrowRight" });
  assert.match(after.tooltip.text, /GPT-6 Astra/u);
  const points = buildCommunityAllowanceChartModel(normalizeCommunityDailySeries(payload), { view: "models" })
    .dots.filter(dot => dot.seriesKey === "gpt-6-astra");
  assert.ok(after.tooltip.text.includes(new Intl.NumberFormat("en-US", {
    style: "currency", currency: "USD", maximumFractionDigits: 0,
  }).format(points[1].centralUsd)));
});

test("removed series or invalidated graph state cannot carry old inspection evidence into a replacement", () => {
  const documentRef = interactiveDocument(), container = documentRef.createElement("div");
  const payload = publicAllowanceFixture(NOW);
  const render = data => renderCommunityAllowanceSection({ documentRef, container, payload: data, view: "models" });
  render(payload); let chart = chartParts(container);
  chart.astra.fire("click"); chart.svg.focus(); chart.svg.fire("keydown", { key: "Home" });
  chart.astra.focus();
  const withoutAstra = structuredClone(payload);
  withoutAstra.allowanceBreakdowns.days.forEach(day => { day.models = day.models.filter(row => row[0] !== "gpt-6-astra"); });
  render(withoutAstra); chart = chartParts(container);
  assert.equal(chart.astra, undefined);
  assert.ok(chart.buttons.every(button => button.attributes.get("aria-pressed") === "false"));
  assert.equal(chart.tooltip.attributes.get("data-visible"), "false");
  assert.doesNotMatch(chart.tooltip.text, /Astra/u);
  assert.equal(documentRef.activeElement, chart.svg);
  render(payload); chart = chartParts(container);
  chart.astra.fire("click"); chart.svg.focus(); chart.svg.fire("keydown", { key: "Home" });
  assert.equal(render({ ...payload, allowanceState: "updating" }), "allowance_updating");
  assert.equal(chartParts(container).svg, undefined);
  assert.equal(documentRef.activeElement, null);
  render(payload); chart = chartParts(container);
  assert.equal(chart.astra.attributes.get("aria-pressed"), "false");
  assert.equal(chart.tooltip.attributes.get("data-visible"), "false");
  assert.equal(documentRef.activeElement, null);
});

test("a removed inspected day clears its tooltip without dropping a still-supported legend selection", () => {
  const documentRef = interactiveDocument(), container = documentRef.createElement("div");
  const payload = publicAllowanceFixture(NOW);
  const render = () => renderCommunityAllowanceSection({ documentRef, container, payload, view: "models" });
  render(); const before = chartParts(container);
  before.astra.fire("click"); before.svg.focus(); before.svg.fire("keydown", { key: "Home" });
  const removedDay = payload.allowanceBreakdowns.days.find(day => day.models.some(row => row[0] === "gpt-6-astra"));
  removedDay.models = removedDay.models.filter(row => row[0] !== "gpt-6-astra");
  render(); const after = chartParts(container);
  assert.equal(after.astra.attributes.get("aria-pressed"), "true");
  assert.equal(after.tooltip.attributes.get("data-visible"), "false");
  assert.equal(after.tooltip.text.trim(), "");
  assert.equal(documentRef.activeElement, after.svg);
  after.svg.fire("keydown", { key: "Home" });
  assert.match(after.tooltip.text, /GPT-6 Astra/u);
  assert.equal(after.tooltip.attributes.get("data-visible"), "true");
  assert.notEqual(after.tooltip.descendants().find(element => element.className === "allowance-tooltip-date").text,
    before.tooltip.descendants().find(element => element.className === "allowance-tooltip-date").text);
});

// ---- Tolerant reader: unknown models, breakdowns v1.3 and the stored copy ----
// Synthetic ids only. `gpt-7-nova` and `gpt-7-mira` stand for models newer than
// this build's catalog; neither is a real identity.

/** Today's live shape on d43c8f92's basis: breakdowns v1.1 with `combined`. */
function v11Fixture(nowMs = NOW) {
  const payload = publicAllowanceFixture(nowMs);
  payload.allowanceBreakdowns.schemaVersion = "community-allowance-breakdowns-v1.1";
  for (const [index, day] of payload.allowanceBreakdowns.days.entries()) {
    const { centralUsd, participantCount, fitCount, band80Usd } = payload.days[index].payload.allowance;
    day.combined = { centralUsd, participantCount, fitCount, band80Usd };
  }
  return payload;
}

/** The six-entry block a KM-V13 producer appends for manifest version 1. */
const SIX_MODEL_BLOCK = Object.freeze([
  ["gpt-6-astra", "GPT-6 Astra", "astra"], ["gpt-6-sol", "GPT-6 Sol", "sol"],
  ["gpt-6-luna", "GPT-6 Luna", "luna"], ["gpt-5.6-terra", "GPT-5.6 Terra", "terra"],
  ["gpt-5.6-sol", "GPT-5.6 Sol", "sol"], ["gpt-5.6-luna", "GPT-5.6 Luna", "luna"],
].map(([id, label, family], order) => Object.freeze({ id, label, family, order })));

/** `block` null leaves the optional block out. */
function v13Fixture(block = SIX_MODEL_BLOCK, nowMs = NOW) {
  const payload = v11Fixture(nowMs);
  payload.allowanceBreakdowns.schemaVersion = "community-allowance-breakdowns-v1.3";
  if (block !== null) payload.allowanceBreakdowns.modelConfig = structuredClone(block);
  return payload;
}

function addTuples(payload, modelId, dayCount, usd = 3100, participants = 1) {
  for (const day of payload.allowanceBreakdowns.days.slice(-dayCount)) day.models.push([modelId, usd, participants]);
  return payload;
}

function renderView(payload, { view = "models", cache, lang = "en-US" } = {}) {
  const documentRef = { documentElement: { lang }, createElement: tag => new Element(tag),
    createElementNS: (_, tag) => new Element(tag) };
  const container = new Element("div");
  const state = renderCommunityAllowanceSection({ documentRef, container, payload, view, cache });
  const cards = container.descendants().filter(element => element.tag === "article")
    .map(card => ({ label: card.descendants().find(element => element.tag === "h3")?.text, className: card.className }));
  return { state, cards, text: container.text };
}

const SIX_CARDS = ["GPT-6 Astra", "GPT-6 Sol", "GPT-6 Luna", "GPT-5.6 Terra", "GPT-5.6 Sol", "GPT-5.6 Luna"];
const NEWER_MODELS = /Estimates for newer models this page does not recognize yet are not shown/u;
const RETAINED = Object.freeze({ fetchedAt: new Date(NOW).toISOString(), ageMs: 60_000 });

test("an unknown model id is skipped and counted, never stored or rendered, and the model view says so", () => {
  const clean = normalizeCommunityDailySeries(v11Fixture(), { nowMs: NOW });
  assert.equal(clean.breakdowns.unrecognizedModelTuples, 0);
  assert.equal(clean.breakdowns.unrecognizedModelCount, 0);
  assert.equal(clean.breakdowns.modelMetadata, "absent");
  assert.doesNotMatch(renderView(v11Fixture()).text, NEWER_MODELS, "no gap, no notice");

  const payload = addTuples(v11Fixture(), "gpt-7-nova", 3);
  payload.allowanceBreakdowns.days.at(-1).models.push(["gpt-7-mira", 120, 1]);
  const normalized = normalizeCommunityDailySeries(payload, { nowMs: NOW });
  assert.equal(normalized.state, "published");
  assert.ok(normalized.breakdowns, "one newer model no longer refuses every breakdown");
  assert.equal(normalized.breakdowns.unrecognizedModelTuples, 4);
  assert.equal(normalized.breakdowns.unrecognizedModelCount, 2);
  assert.equal(normalized.breakdowns.modelMetadata, "absent");
  assert.deepEqual(normalized.breakdowns.days, clean.breakdowns.days, "every known tuple and day is kept as is");
  assert.doesNotMatch(JSON.stringify(normalized), /gpt-7/u, "the unknown id never leaves the normalizer");

  const models = renderView(payload);
  assert.equal(models.state, "published");
  assert.deepEqual(models.cards.map(card => card.label), SIX_CARDS);
  assert.match(models.text, NEWER_MODELS);
  assert.doesNotMatch(models.text, /gpt-7|nova|mira/iu);
  for (const view of ["aggregate", "plans"]) {
    const other = renderView(payload, { view });
    assert.equal(other.text, renderView(v11Fixture(), { view }).text, `${view} never depended on the skipped tuples`);
    assert.doesNotMatch(other.text, NEWER_MODELS);
  }
  for (const locale of ["zh-Hans", "es"]) {
    const localized = renderView(payload, { lang: locale }).text;
    assert.ok(localized.includes(translate("community.allowance.unrecognizedModels", {}, locale)), locale);
  }

  // A view with only unknown estimates still states the gap beside the
  // accumulating copy rather than reading as "no model has an estimate".
  const onlyUnknown = v11Fixture();
  onlyUnknown.allowanceBreakdowns.days.forEach(day => { day.models = [["gpt-7-nova", 100, 1]]; });
  const accumulating = renderView(onlyUnknown);
  assert.equal(accumulating.state, "estimates_accumulating");
  assert.match(accumulating.text, NEWER_MODELS);
  assert.doesNotMatch(accumulating.text, /gpt-7/u);
});

test("breakdowns v1.3 applies a valid closed modelConfig block, requires one, and older versions cannot carry one", () => {
  assert.deepEqual(COMMUNITY_ALLOWANCE_BREAKDOWN_SCHEMA_VERSIONS, ["community-allowance-breakdowns-v1.0",
    "community-allowance-breakdowns-v1.1", "community-allowance-breakdowns-v1.3", "community-allowance-breakdowns-v1.4"]);
  // The KM-V13 block names exactly the six models the page already charts, in
  // its order and with its themes, so cutover renders what v1.1 renders today.
  const v13 = normalizeCommunityDailySeries(v13Fixture(), { nowMs: NOW });
  assert.equal(v13.breakdowns.modelMetadata, "applied");
  assert.equal(v13.breakdowns.hasCombined, true);
  assert.deepEqual(v13.breakdowns.days, normalizeCommunityDailySeries(v11Fixture(), { nowMs: NOW }).breakdowns.days);
  for (const view of ["aggregate", "plans", "models"]) {
    assert.equal(renderView(v13Fixture(), { view }).text, renderView(v11Fixture(), { view }).text, view);
  }

  // A block can name a model this build's catalog has never seen.
  const nova = addTuples(v13Fixture([...SIX_MODEL_BLOCK,
    { id: "gpt-7-nova", label: "GPT-7 Nova", family: "nova", order: 6 }]), "gpt-7-nova", 2);
  const named = normalizeCommunityDailySeries(nova, { nowMs: NOW });
  assert.equal(named.breakdowns.unrecognizedModelTuples, 0);
  assert.ok(named.breakdowns.days.at(-1).models.some(([id]) => id === "gpt-7-nova"));
  const novaRender = renderView(nova);
  assert.deepEqual(novaRender.cards.map(card => card.label), [...SIX_CARDS, "GPT-7 Nova"]);
  assert.match(novaRender.cards.at(-1).className, /allowance-series-\d/u, "an unthemed family keeps the generic colours");
  assert.doesNotMatch(novaRender.text, NEWER_MODELS);

  // v1.3 keeps v1.1's combined rows.
  const noCombined = v13Fixture();
  delete noCombined.allowanceBreakdowns.days[0].combined;
  assert.equal(normalizeCommunityDailySeries(noCombined, { nowMs: NOW }).breakdowns, null);

  // The block is a required v1.3 member and a v1.3 member only: v1.3 without it
  // is off its own contract, and v1.0 and v1.1 envelopes carrying it are
  // refused whole. v1.2 and a v1.4 envelope with crossed Pro 20x claims stay refused.
  const refusals = [
    payload => { delete payload.allowanceBreakdowns.modelConfig; },
    payload => { payload.allowanceBreakdowns.schemaVersion = "community-allowance-breakdowns-v1.1"; },
    payload => {
      payload.allowanceBreakdowns.schemaVersion = "community-allowance-breakdowns-v1.0";
      payload.allowanceBreakdowns.days.forEach(day => { delete day.combined; });
    },
    payload => { payload.allowanceBreakdowns.schemaVersion = "community-allowance-breakdowns-v1.2"; },
    payload => { payload.allowanceBreakdowns.schemaVersion = "community-allowance-breakdowns-v1.4"; },
    payload => {
      payload.allowanceBreakdowns.schemaVersion = "community-allowance-breakdowns-v1.2";
      delete payload.allowanceBreakdowns.modelConfig;
    },
    payload => {
      payload.allowanceBreakdowns.schemaVersion = "community-allowance-breakdowns-v1.4";
      delete payload.allowanceBreakdowns.modelConfig;
    },
  ];
  for (const mutate of refusals) {
    const payload = v13Fixture();
    mutate(payload);
    const normalized = normalizeCommunityDailySeries(payload, { nowMs: NOW });
    assert.equal(normalized.breakdowns, null, mutate.toString());
    assert.equal(normalized.state, "published", "daily activity is never hidden by a refused breakdown");
    assert.equal(normalized.days.length, 35);
    assert.equal(projectCommunityDailyPayloadForCache(payload, { nowMs: NOW }).allowanceBreakdowns, undefined);
  }
});

test("a malformed modelConfig block is rejected whole and the page draws only its own list", () => {
  const entry = { id: "gpt-7-nova", label: "GPT-7 Nova", family: "nova", order: 6 };
  const malformed = [
    {},
    "gpt-7-nova",
    [{ ...entry, extra: "PRIVATE_CANARY" }],
    [{ id: entry.id, label: entry.label, family: entry.family }],
    [entry, entry],
    [{ ...entry, id: "gpt-5.3-codex-spark" }],
    [{ ...entry, id: "claude-opus-5" }],
    [{ ...entry, id: "gpt 7 nova" }],
    [{ ...entry, label: "<b>PRIVATE_CANARY</b>" }],
    [{ ...entry, label: 7 }],
    [{ ...entry, family: "Nova" }],
    [{ ...entry, order: -1 }],
    [{ ...entry, order: 10_000 }],
    [{ ...entry, order: 6.5 }],
    [{ ...entry, order: "6" }],
    Array.from({ length: 129 }, (_, index) => ({ ...entry, id: `gpt-7-nova-${index}`, order: index })),
  ];
  for (const block of malformed) {
    const payload = addTuples(v13Fixture([...SIX_MODEL_BLOCK, ...(Array.isArray(block) ? block : [])]), "gpt-7-nova", 2);
    if (!Array.isArray(block)) payload.allowanceBreakdowns.modelConfig = block;
    const normalized = normalizeCommunityDailySeries(payload, { nowMs: NOW });
    const label = JSON.stringify(block).slice(0, 80);
    assert.ok(normalized.breakdowns, label);
    assert.equal(normalized.breakdowns.modelMetadata, "rejected", label);
    assert.deepEqual(normalized.breakdowns.modelConfig, [...PUBLIC_ALLOWANCE_MODEL_CONFIG], label);
    assert.equal(normalized.breakdowns.unrecognizedModelTuples, 2, label);
    assert.doesNotMatch(JSON.stringify(normalized), /PRIVATE_CANARY|gpt-7/u, label);
    const models = renderView(payload);
    assert.deepEqual(models.cards.map(card => card.label), SIX_CARDS, label);
    assert.match(models.text, NEWER_MODELS, label);
    assert.doesNotMatch(models.text, /GPT-7 Nova|PRIVATE_CANARY/u, label);
  }
});

test("GPT-6.1 Sol is kept on v1.1, charted once it has an estimate, and on v1.3 shown only when a valid block names it", () => {
  // v1.1 cannot carry a block: the roster knows it, so its tuples are kept and it gets a card.
  const kept = addTuples(v11Fixture(), "gpt-6.1-sol", 3, 2500, 2);
  const normalized = normalizeCommunityDailySeries(kept, { nowMs: NOW });
  assert.equal(normalized.breakdowns.unrecognizedModelTuples, 0);
  assert.ok(normalized.breakdowns.days.at(-1).models.some(([id]) => id === "gpt-6.1-sol"));
  const keptRender = renderView(kept);
  assert.deepEqual(keptRender.cards.map(card => card.label),
    ["GPT-6 Astra", "GPT-6.1 Sol", ...SIX_CARDS.slice(1)]);
  assert.doesNotMatch(keptRender.text, NEWER_MODELS);
  // Without an estimate it is never named (the six-card render above, too).
  assert.doesNotMatch(renderView(v11Fixture()).text, /GPT-6\.1 Sol/u);

  // A valid block that does not name it is the served catalog without it.
  const skipped = addTuples(v13Fixture(), "gpt-6.1-sol", 3, 2500, 2);
  const withoutSol = normalizeCommunityDailySeries(skipped, { nowMs: NOW });
  assert.equal(withoutSol.breakdowns.modelMetadata, "applied");
  assert.equal(withoutSol.breakdowns.unrecognizedModelTuples, 3);
  assert.equal(withoutSol.breakdowns.unrecognizedModelCount, 1);
  assert.ok(withoutSol.breakdowns.days.every(day => day.models.every(([id]) => id !== "gpt-6.1-sol")));
  const skippedRender = renderView(skipped);
  assert.deepEqual(skippedRender.cards.map(card => card.label), SIX_CARDS);
  assert.match(skippedRender.text, NEWER_MODELS);
  assert.doesNotMatch(skippedRender.text, /GPT-6\.1 Sol|gpt-6\.1-sol/u);

  // On v1.3 the block is the only authority that can name it (owner round 12,
  // W-WEB-HIDE2: the server decides). A rejected block names nothing, so its
  // tuples are skipped and counted exactly as under a valid block without it,
  // and the page never falls back to its own roster label.
  const solBlock = { id: "gpt-6.1-sol", label: "GPT-6.1 Sol", family: "sol", order: 1 };
  for (const block of [
    [{ ...SIX_MODEL_BLOCK[0], family: "Astra" }],
    [...SIX_MODEL_BLOCK, solBlock, { ...solBlock, id: "gpt-5.3-codex-spark", order: 7 }],
    [...SIX_MODEL_BLOCK, { ...solBlock, label: "<b>GPT-6.1 Sol</b>" }],
    Array.from({ length: 129 }, (_, index) => ({ ...solBlock, id: `gpt-7-nova-${index}`, order: index })),
    { "gpt-6.1-sol": solBlock },
  ]) {
    const label = JSON.stringify(block).slice(0, 80);
    const payload = addTuples(v13Fixture(), "gpt-6.1-sol", 3, 2500, 2);
    payload.allowanceBreakdowns.modelConfig = structuredClone(block);
    const rejected = normalizeCommunityDailySeries(payload, { nowMs: NOW });
    assert.equal(rejected.breakdowns.modelMetadata, "rejected", label);
    assert.equal(rejected.breakdowns.unrecognizedModelTuples, 3, label);
    assert.equal(rejected.breakdowns.unrecognizedModelCount, 1, label);
    assert.deepEqual(rejected.breakdowns.days, withoutSol.breakdowns.days, label);
    const rejectedRender = renderView(payload);
    assert.deepEqual(rejectedRender.cards.map(card => card.label), SIX_CARDS, label);
    assert.match(rejectedRender.text, NEWER_MODELS, label);
    assert.doesNotMatch(rejectedRender.text, /GPT-6\.1 Sol|gpt-6\.1-sol/u, label);
  }
  // v1.3 with no block at all is off its contract: its breakdowns are refused
  // whole, the daily activity still draws, and Sol is never named.
  const bare = addTuples(v13Fixture(null), "gpt-6.1-sol", 3, 2500, 2);
  const bareSeries = normalizeCommunityDailySeries(bare, { nowMs: NOW });
  assert.equal(bareSeries.breakdowns, null);
  assert.equal(bareSeries.state, "published");
  const bareRender = renderView(bare);
  assert.equal(bareRender.state, "breakdowns_unavailable");
  assert.doesNotMatch(bareRender.text, /GPT-6\.1 Sol|gpt-6\.1-sol/u);

  // A block that names it places it at the block's order with its family theme.
  const block = [...SIX_MODEL_BLOCK.map(entry => ({ ...entry, order: entry.order === 0 ? 0 : entry.order + 1 })),
    { id: "gpt-6.1-sol", label: "GPT-6.1 Sol", family: "sol", order: 1 }];
  const namedRender = renderView(addTuples(v13Fixture(block), "gpt-6.1-sol", 3, 2500, 2));
  assert.deepEqual(namedRender.cards.map(card => card.label), ["GPT-6 Astra", "GPT-6.1 Sol", ...SIX_CARDS.slice(1)]);
  assert.match(namedRender.cards[1].className, /allowance-model-sol/u);
  assert.doesNotMatch(namedRender.text, NEWER_MODELS);
});

test("the stored copy keeps the gap as two counters and a live payload cannot carry them", () => {
  // Nothing skipped: no counters, stored under the version that was read.
  const plain = projectCommunityDailyPayloadForCache(v11Fixture(), { nowMs: NOW });
  assert.equal(plain.allowanceBreakdowns.schemaVersion, "community-allowance-breakdowns-v1.1");
  assert.equal(Object.hasOwn(plain.allowanceBreakdowns, "retainedUnrecognizedModels"), false);
  assert.equal(Object.hasOwn(plain.allowanceBreakdowns, "modelConfig"), false);

  const live = addTuples(v11Fixture(), "gpt-7-nova", 3);
  live.allowanceBreakdowns.days.at(-1).models.push(["gpt-7-mira", 120, 1]);
  const liveSeries = normalizeCommunityDailySeries(live, { nowMs: NOW });
  const stored = projectCommunityDailyPayloadForCache(live, { nowMs: NOW });
  assert.deepEqual(stored.allowanceBreakdowns.retainedUnrecognizedModels, { tuples: 4, models: 2 });
  assert.equal(stored.allowanceBreakdowns.schemaVersion, "community-allowance-breakdowns-v1.1");
  assert.doesNotMatch(JSON.stringify(stored), /gpt-7/u, "no unknown id reaches storage");
  // The retained read reproduces the live breakdowns, gap included.
  assert.deepEqual(normalizeCommunityDailySeries(stored, { nowMs: NOW, retained: true }).breakdowns,
    liveSeries.breakdowns);
  const cached = renderView(stored, { cache: RETAINED });
  assert.equal(cached.state, "published");
  assert.match(cached.text, NEWER_MODELS);
  assert.deepEqual(cached.cards, renderView(live).cards);

  // The counters are a stored-copy member only: a live payload with them is
  // off the wire contract, and its breakdowns are refused whole.
  const liveRead = normalizeCommunityDailySeries(stored, { nowMs: NOW });
  assert.equal(liveRead.breakdowns, null);
  assert.equal(liveRead.state, "published");
  assert.equal(liveRead.days.length, 35);
  assert.equal(renderView(stored).state, "breakdowns_unavailable");

  // Malformed counters, or a copy that still holds a skipped tuple, are refused.
  const refusals = [
    value => { value.retainedUnrecognizedModels = null; },
    value => { value.retainedUnrecognizedModels = { tuples: 0, models: 0 }; },
    value => { value.retainedUnrecognizedModels = { tuples: 1, models: 2 }; },
    value => { value.retainedUnrecognizedModels = { tuples: 70 * 256 + 1, models: 1 }; },
    value => { value.retainedUnrecognizedModels = { tuples: 1.5, models: 1 }; },
    value => { value.retainedUnrecognizedModels = { tuples: "4", models: 2 }; },
    value => { value.retainedUnrecognizedModels = { tuples: 4 }; },
    value => { value.retainedUnrecognizedModels = { tuples: 4, models: 2, ids: ["gpt-7-nova"] }; },
    value => { value.days.at(-1).models.push(["gpt-7-nova", 3100, 1]); },
  ];
  for (const mutate of refusals) {
    const copy = structuredClone(stored);
    mutate(copy.allowanceBreakdowns);
    assert.equal(normalizeCommunityDailySeries(copy, { nowMs: NOW, retained: true }).breakdowns, null, mutate.toString());
  }
});

test("the stored copy keeps an applied v1.3 block under v1.3 and never stores a rejected one", () => {
  assert.ok(COMMUNITY_DAILY_CACHE_SCHEMA_IDENTITY.includes("community-allowance-breakdowns-v1.3"),
    "accepting v1.3 changes the cache identity, so a previous deploy's copy is dropped, not reinterpreted");

  // Applied: the block is data the stored tuples depend on, so it is kept,
  // under the only version that may carry it.
  const nova = addTuples(v13Fixture([...SIX_MODEL_BLOCK,
    { id: "gpt-7-nova", label: "GPT-7 Nova", family: "nova", order: 6 }]), "gpt-7-nova", 2);
  const stored = projectCommunityDailyPayloadForCache(nova, { nowMs: NOW });
  assert.equal(stored.allowanceBreakdowns.schemaVersion, "community-allowance-breakdowns-v1.3");
  assert.deepEqual(new Set(stored.allowanceBreakdowns.modelConfig.map(entry => JSON.stringify(entry))),
    new Set(nova.allowanceBreakdowns.modelConfig.map(entry => JSON.stringify(entry))));
  assert.deepEqual(normalizeCommunityDailySeries(stored, { nowMs: NOW, retained: true }).breakdowns,
    normalizeCommunityDailySeries(nova, { nowMs: NOW }).breakdowns);
  assert.deepEqual(renderView(stored, { cache: RETAINED }).cards, renderView(nova).cards);

  // The block applied with GPT-6.1 Sol skipped: block and counters both kept.
  const sol = projectCommunityDailyPayloadForCache(addTuples(v13Fixture(), "gpt-6.1-sol", 3), { nowMs: NOW });
  assert.equal(sol.allowanceBreakdowns.schemaVersion, "community-allowance-breakdowns-v1.3");
  assert.deepEqual(sol.allowanceBreakdowns.retainedUnrecognizedModels, { tuples: 3, models: 1 });
  const solRender = renderView(sol, { cache: RETAINED });
  assert.deepEqual(solRender.cards.map(card => card.label), SIX_CARDS);
  assert.match(solRender.text, NEWER_MODELS);
  assert.doesNotMatch(solRender.text, /GPT-6\.1 Sol/u);

  // Rejected: never stored. With no applied block the copy holds only v1.1's
  // members, so it is stored under v1.1.
  const rejected = addTuples(v13Fixture([{ ...SIX_MODEL_BLOCK[0], order: -1 }]), "gpt-7-nova", 2);
  const liveRejected = normalizeCommunityDailySeries(rejected, { nowMs: NOW }).breakdowns;
  const storedRejected = projectCommunityDailyPayloadForCache(rejected, { nowMs: NOW });
  assert.equal(storedRejected.allowanceBreakdowns.schemaVersion, "community-allowance-breakdowns-v1.1");
  assert.equal(Object.hasOwn(storedRejected.allowanceBreakdowns, "modelConfig"), false);
  const reread = normalizeCommunityDailySeries(storedRejected, { nowMs: NOW, retained: true }).breakdowns;
  assert.equal(liveRejected.modelMetadata, "rejected");
  assert.equal(reread.modelMetadata, "absent");
  assert.deepEqual({ ...reread, modelMetadata: null }, { ...liveRejected, modelMetadata: null });

  // A rejected block with GPT-6.1 Sol tuples: the stored v1.1 copy leaves them
  // out and keeps the gap, so the cached render cannot name Sol from v1.1's roster.
  const rejectedSol = addTuples(v13Fixture([{ ...SIX_MODEL_BLOCK[0], order: -1 }]), "gpt-6.1-sol", 3);
  const storedSol = projectCommunityDailyPayloadForCache(rejectedSol, { nowMs: NOW });
  assert.equal(storedSol.allowanceBreakdowns.schemaVersion, "community-allowance-breakdowns-v1.1");
  assert.deepEqual(storedSol.allowanceBreakdowns.retainedUnrecognizedModels, { tuples: 3, models: 1 });
  assert.doesNotMatch(JSON.stringify(storedSol), /gpt-6\.1-sol/u);
  const rereadSol = normalizeCommunityDailySeries(storedSol, { nowMs: NOW, retained: true }).breakdowns;
  assert.deepEqual({ ...rereadSol, modelMetadata: null },
    { ...normalizeCommunityDailySeries(rejectedSol, { nowMs: NOW }).breakdowns, modelMetadata: null });
  const cachedSol = renderView(storedSol, { cache: RETAINED });
  assert.deepEqual(cachedSol.cards.map(card => card.label), SIX_CARDS);
  assert.match(cachedSol.text, NEWER_MODELS);
  assert.doesNotMatch(cachedSol.text, /GPT-6\.1 Sol/u);
});

test("a later catalog's primary model is charted without a page edit, while hidden and off-track ones are not", () => {
  // The shipped catalog adds nothing beyond the roster (asserted above); a
  // regenerated one may. Synthetic catalog rows, the reviewed shape.
  const row = (id, label, provider = "openai_codex", allowanceTrack = "primary") => ({ id, label, provider, allowanceTrack });
  const { charted, known } = publicAllowanceModels([
    row("gpt-5.5", "GPT-5.5"),
    row("gpt-6-astra", "GPT-6 Astra (catalog label)"),
    row("gpt-7-nova", "GPT-7 Nova"),
    row("gpt-7-spark", "GPT-7 Spark", "openai_codex", "spark"),
    row("claude-opus-9", "Claude Opus 9", "anthropic_claude_code"),
  ]);
  assert.deepEqual(charted.map(model => model.modelId),
    [...PUBLIC_ALLOWANCE_MODEL_CONFIG.map(model => model.modelId), "gpt-7-nova"]);
  assert.equal(charted[0].label, "GPT-6 Astra", "the roster keeps its own label");
  assert.deepEqual(charted.at(-1), { modelId: "gpt-7-nova", label: "GPT-7 Nova" }, "charted, but not pinned");
  assert.ok(known.has("gpt-5.5"), "a hidden model's tuples stay valid on the wire");
  assert.equal(charted.some(model => model.modelId === "gpt-5.5"), false);
  for (const id of ["gpt-7-spark", "claude-opus-9"]) assert.equal(known.has(id), false, id);
});


function v14Fixture(block = SIX_MODEL_BLOCK) {
  const payload = v13Fixture(block);
  const breakdowns = payload.allowanceBreakdowns;
  Object.assign(breakdowns, { schemaVersion: "community-allowance-breakdowns-v1.4",
    basis: COMMUNITY_ALLOWANCE_PRO10_BASIS, normalization: COMMUNITY_ALLOWANCE_PRO10_NORMALIZATION,
    modelBasis: "seven_day_codex_pro10x_equivalent_per_model_composition" });
  for (const [index, day] of breakdowns.days.entries()) {
    day.byPlanType.promax = summary(index === 12 ? null : 2500);
  }
  // The GCP route strips daily allowance and publishes its combined values in
  // the breakdown envelope. No current-basis inference from daily data exists.
  for (const day of payload.days) delete day.payload.allowance;
  return payload;
}

test("exact GCP v1.3 and v1.4 dispatch preserves values, metadata, plan scaling and date alignment", () => {
  const old = normalizeCommunityDailySeries(v13Fixture(), { nowMs: NOW });
  const payload = v14Fixture([...SIX_MODEL_BLOCK,
    { id: "gpt-7-nova", label: "GPT-7 Nova", family: "nova", order: 6 }]);
  payload.allowanceBreakdowns.days.at(-1).models.push(["gpt-7-nova", 4200, 2]);
  const current = normalizeCommunityDailySeries(payload, { nowMs: NOW });
  assert.equal(current.breakdowns.normalization, COMMUNITY_ALLOWANCE_PRO10_NORMALIZATION);
  assert.equal(current.breakdowns.modelMetadata, "applied");
  assert.deepEqual(current.breakdowns.planIds, ["pro", "prolite", "promax", "plus"]);
  assert.deepEqual(current.breakdowns.days.map(day => day.combined), old.breakdowns.days.map(day => day.combined),
    "declared reference estimates are never halved, doubled or repriced by the reader");
  assert.ok(current.days.every(day => day.allowance === null));
  for (const view of ["aggregate", "plans", "models"]) {
    const before = buildCommunityAllowanceChartModel(old, { view });
    const after = buildCommunityAllowanceChartModel(current, { view });
    assert.deepEqual(after.dayTicks, before.dayTicks);
    assert.ok(after.dots.length > 0);
  }
  assert.ok(buildCommunityAllowanceChartModel(current, { view: "models" }).legendSeries.some(item => item.label === "GPT-7 Nova"));
  const plans = buildCommunityAllowanceChartModel(current, { view: "plans" });
  assert.deepEqual(plans.cardSeries.map(item => item.key), ["plus", "prolite", "promax", "pro"]);
  assert.deepEqual(plans.cardSeries.map(item => item.label), ["Plus", "Pro 5×", "Pro 25×", "Pro 10×"]);
  for (const [plan, divisor] of [["pro", 1], ["prolite", 2], ["promax", 0.4], ["plus", 10]]) {
    assert.equal(planWeeklyApiEquivalentUsd(2500, plan, COMMUNITY_ALLOWANCE_PRO10_NORMALIZATION), 2500 / divisor);
    const panel = buildCommunityAllowanceChartModel(current, { view: "plans", seriesKeys: [plan] });
    const original = current.breakdowns.days.find(day => day.day === panel.latest.day).byPlanType[plan];
    assert.equal(panel.latest.centralUsd, original.centralUsd / divisor);
    assert.equal(panel.latest.band80Usd.lowerUsd, original.band80Usd.lowerUsd / divisor);
  }
  assert.equal(planWeeklyApiEquivalentUsd(2500, "promax"), null);
  assert.equal(planWeeklyApiEquivalentUsd(2500, "plus"), 125, "old default remains Pro 20x");
  assert.equal(planWeeklyApiEquivalentUsd(2500, "plus", "future"), null);
});

test("v1.4 refuses crossed basis, model basis, scaling, plan set and wrapper claims without hiding activity", () => {
  for (const mutate of [
    value => { value.schemaVersion = "community-allowance-breakdowns-v1.3"; },
    value => { value.schemaVersion = "community-allowance-breakdowns-v1.2"; },
    value => { value.basis = "seven_day_codex_pro20x_equivalent_personal_plans_trailing_30d"; },
    value => { value.normalization = "pro_x1_prolite_x4_plus_x20"; },
    value => { value.modelBasis = "seven_day_codex_pro20x_equivalent_per_model_composition"; },
    value => { value.modelGate = "another_gate"; },
    value => { delete value.modelConfig; },
    value => { delete value.days[0].combined; },
    value => { delete value.days[0].byPlanType.promax; },
    value => { value.days[0].byPlanType.unknown = summary(1); },
    value => { value.days[0].byPlanType.promax.centralUsd = "2500"; },
  ]) {
    const payload = v14Fixture(); mutate(payload.allowanceBreakdowns);
    const series = normalizeCommunityDailySeries(payload, { nowMs: NOW });
    assert.equal(series.state, "published");
    assert.equal(series.days.length, 35);
    assert.equal(series.breakdowns, null, mutate.toString());
  }
});

test("v1.4 cache keeps the declared basis and both accepted and rejected metadata without a Pro 20x downgrade", () => {
  assert.ok(COMMUNITY_DAILY_CACHE_SCHEMA_IDENTITY.includes(COMMUNITY_ALLOWANCE_PRO10_NORMALIZATION));
  for (const block of [SIX_MODEL_BLOCK, [{ ...SIX_MODEL_BLOCK[0], order: -1 }]]) {
    const payload = v14Fixture(block);
    const normalized = normalizeCommunityDailySeries(payload, { nowMs: NOW });
    const cached = projectCommunityDailyPayloadForCache(payload, { nowMs: NOW });
    assert.equal(cached.allowanceBreakdowns.schemaVersion, "community-allowance-breakdowns-v1.4");
    assert.equal(cached.allowanceBreakdowns.normalization, COMMUNITY_ALLOWANCE_PRO10_NORMALIZATION);
    assert.deepEqual(normalizeCommunityDailySeries(cached, { nowMs: NOW, retained: true }).breakdowns, normalized.breakdowns);
    if (normalized.breakdowns.modelMetadata === "rejected") assert.equal(cached.allowanceBreakdowns.modelConfig, null);
    for (const view of ["aggregate", "plans", "models"]) {
      assert.deepEqual(renderView(cached, { view, cache: RETAINED }).cards, renderView(payload, { view }).cards);
    }
  }
});

test("all Pro 10x labels follow the breakdown basis while the historical GCP response retains Pro 20x copy", () => {
  for (const locale of ["en-US", "zh-Hans", "es"]) for (const view of ["aggregate", "plans", "models"]) {
    const documentRef = { documentElement: { lang: locale }, createElement: tag => new Element(tag),
      createElementNS: (_, tag) => new Element(tag) };
    const container = new Element("div"), heading = new Element("h2"), hero = new Element("p");
    for (const [payload, pro10] of [[v14Fixture(), true], [v13Fixture(), false]]) {
      assert.equal(renderCommunityAllowanceSection({ documentRef, container, headingNode: heading, heroNode: hero,
        payload, view }), "published");
      const prefix = `community.allowance.${pro10 ? "pro10." : ""}`;
      assert.equal(heading.text, translate(`${prefix}heading`, {}, locale));
      assert.equal(hero.text, translate(`${prefix}heroCopy`, {}, locale));
      const copy = container.text;
      if (pro10 && view === "aggregate") {
        const method = translate("community.allowance.pro10.methodNote", {}, locale);
        assert.ok(copy.includes(method), "rendered v1.4 method preserves the calibration qualifier");
        assert.match(method, /25-point observed-span floor|25 个百分点的观测跨度下限|25 puntos de amplitud observada/u);
        assert.doesNotMatch(method, /40-point|40 个百分点|40 puntos/u);
      }
      assert.doesNotMatch(copy, pro10 ? /Pro 20[×x]/u : /Pro 10[×x]|Pro 25[×x]/u);
      if (view !== "aggregate") assert.ok(copy.includes(translate(view === "plans"
        ? "community.allowance.planOwnWeekCaption" : `${prefix}cardsCaption`, {}, locale)));
    }
  }
});

test("mixed daily bases preserve raw estimates and cache provenance while drawing other-basis days as gaps", () => {
  const payload = publicAllowanceFixture(NOW);
  delete payload.allowanceBreakdowns;
  for (const day of payload.days.slice(-2)) Object.assign(day.payload.allowance, {
    basis: COMMUNITY_ALLOWANCE_PRO10_BASIS, normalization: COMMUNITY_ALLOWANCE_PRO10_NORMALIZATION });
  const normalized = normalizeCommunityDailySeries(payload, { nowMs: NOW });
  assert.equal(normalized.days[0].allowance.centralUsd, payload.days[0].payload.allowance.centralUsd);
  assert.equal(normalized.days.at(-1).allowance.centralUsd, payload.days.at(-1).payload.allowance.centralUsd);
  const model = buildCommunityAllowanceChartModel(normalized);
  assert.deepEqual(model.dots.map(dot => dot.day), payload.days.slice(-2).map(day => day.day));
  const cached = projectCommunityDailyPayloadForCache(payload, { nowMs: NOW });
  assert.equal(cached.days[0].payload.allowance.normalization, "pro_x1_prolite_x4_plus_x20");
  assert.equal(cached.days.at(-1).payload.allowance.normalization, COMMUNITY_ALLOWANCE_PRO10_NORMALIZATION);
  assert.deepEqual(normalizeCommunityDailySeries(cached, { nowMs: NOW, retained: true }), normalized);
  const rendered = renderView(payload, { view: "aggregate" });
  assert.match(rendered.text, /Pro 10× basis.*another basis remain gaps/u);
  const crossed = structuredClone(payload);
  crossed.days.at(-1).payload.allowance.normalization = "pro_x1_prolite_x4_plus_x20";
  assert.equal(normalizeCommunityDailySeries(crossed, { nowMs: NOW }).days.at(-1).allowance, null);
  // The reverse direction also retains the actual older reference.
  Object.assign(payload.days.at(-1).payload.allowance, payload.days[0].payload.allowance);
  assert.equal(buildCommunityAllowanceChartModel(normalizeCommunityDailySeries(payload, { nowMs: NOW })).dots
    .some(dot => dot.day === payload.days.at(-2).day), false);
});


test("plan captions and accessible panels describe the converted own-week values, while models retain the reference basis", () => {
  const money = value => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(value);
  for (const [payload, normalization, reference] of [
    [v13Fixture(), "pro_x1_prolite_x4_plus_x20", "Pro 20x"],
    [v14Fixture(), COMMUNITY_ALLOWANCE_PRO10_NORMALIZATION, "Pro 10x"],
  ]) {
    for (const day of payload.allowanceBreakdowns.days) for (const plan of Object.keys(day.byPlanType)) {
      day.byPlanType[plan] = summary(2500);
    }
    const series = normalizeCommunityDailySeries(payload, { nowMs: NOW });
    const model = buildCommunityAllowanceChartModel(series, { view: "plans" });
    const documentRef = { documentElement: { lang: "en-US" }, createElement: tag => new Element(tag),
      createElementNS: (_, tag) => new Element(tag) };
    const container = new Element("div");
    assert.equal(renderCommunityAllowanceSection({ documentRef, container, payload, view: "plans" }), "published");
    const elements = container.descendants();
    const caption = elements.find(element => element.className === "allowance-summary-caption");
    assert.match(caption.text, /each plan's own week/u);
    assert.doesNotMatch(caption.text, /Pro (?:10|20)[×x]/u);
    const cards = elements.filter(element => element.tag === "article");
    const panels = elements.filter(element => element.className.startsWith("allowance-panel "));
    assert.equal(panels.length, cards.length);
    for (const [index, latest] of model.latestSummaries.entries()) {
      const own = planWeeklyApiEquivalentUsd(2500, latest.seriesKey, normalization);
      const headline = cards[index].descendants().find(element => element.className === "allowance-summary-value");
      assert.equal(headline.text, money(own), `${latest.seriesKey}: headline is the plan's own week`);
      const referenceLabel = cards[index].descendants().find(element => element.className === "allowance-plan-value");
      assert.equal(referenceLabel.text, `${reference}-equivalent: ${money(2500)}/week`, "reference stays a separate sublabel");
      const panelModel = buildCommunityAllowanceChartModel(series, { view: "plans", seriesKeys: [latest.seriesKey] });
      assert.equal(panelModel.latest.centralUsd, own);
      assert.equal(panelModel.latest.band80Usd.lowerUsd, own * 0.8);
      const svg = panels[index].descendants().find(element => element.tag === "svg" && element.attributes.has("aria-description"));
      assert.match(svg.attributes.get("aria-description"), /Each plan's own weekly API-equivalent estimate/u);
      assert.doesNotMatch(svg.attributes.get("aria-description"), /Pro (?:10|20)[×x]/u);
    }
    renderCommunityAllowanceSection({ documentRef, container, payload, view: "models" });
    const modelCaption = container.descendants().find(element => element.className === "allowance-summary-caption");
    assert.match(modelCaption.text, reference === "Pro 10x" ? /Pro 10× week/u : /Pro 20× week/u);
  }
});
