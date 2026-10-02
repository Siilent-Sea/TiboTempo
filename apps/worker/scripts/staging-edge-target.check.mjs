import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { parse } from "jsonc-parser";
import standIn from "../ops/staging-edge/catchup-standin/index.mjs";
import { validateCloudflareWriterFencePlan } from "./cloudflare-writer-fence.mjs";
import { edgeModeOverlaySha256 } from "./edge-mode-configuration.mjs";
import { renderProductionLiveConfig, verifyProductionLiveConfig } from "./production-live-config.mjs";
import {
  STAGING_EDGE_D1_ROLES,
  STAGING_EDGE_GENESIS_VERSION_ID,
  STAGING_EDGE_INPUTS_EXAMPLE_PATH,
  STAGING_EDGE_TEMPLATE_PATH,
  STAGING_EDGE_WORKER_DIRECTORY,
  assertStagingEdgeTarget,
  buildStagingFencePlan,
  buildStagingGcpPlan,
  createStagingGenesisSnapshot,
  parseStagingEdgeInputs,
  parseStagingEdgeTemplate,
  renderStagingEdgeTemplate,
  stagingEdgeInventoryOf,
  stagingEdgeRefusedReferences,
} from "./staging-edge-target.mjs";

// Synthetic inputs only: the committed example and EP-9's synthetic
// production snapshot. Nothing here reads a secret or reaches a network.
const FIXTURE = JSON.parse(readFileSync(new URL("./fixtures/edge-mode-live-snapshot.synthetic.json", import.meta.url), "utf8"));
const TEMPLATE_TEXT = readFileSync(STAGING_EDGE_TEMPLATE_PATH, "utf8");
const RAW_INPUTS = JSON.parse(readFileSync(STAGING_EDGE_INPUTS_EXAMPLE_PATH, "utf8"));
const SOURCE = "c".repeat(40);

function tracked(file) {
  const errors = [];
  const value = parse(readFileSync(join(STAGING_EDGE_WORKER_DIRECTORY, file), "utf8"), errors);
  assert.deepEqual(errors, []);
  return value;
}
const TRACKED = [tracked("wrangler.jsonc"), tracked("wrangler.dogfood.jsonc")];

function template() {
  return parseStagingEdgeTemplate(TEMPLATE_TEXT);
}

function raw(change = (value) => value) {
  return change(structuredClone(RAW_INPUTS));
}

function refused(fn, code) {
  assert.throws(fn, (error) => error?.code === code, code);
}

function target(change, options = {}) {
  return assertStagingEdgeTarget({
    inputs: raw(change), template: template(), trackedConfigs: TRACKED, productionSnapshots: [FIXTURE], ...options,
  });
}

test("the template keeps env.staging's vars and changes only the plan's section 3.2", () => {
  const environment = template().edgeWorker.env.production;
  const staging = TRACKED[0].env.staging.vars;
  const added = ["ACCESS_ADMIN_EMAIL", "ACCESS_AUD", "ACCESS_TEAM_DOMAIN", "SPARKLE_APPCAST_GUARD_MODE"];
  assert.deepEqual(
    Object.keys(environment.vars).sort(),
    [...Object.keys(staging).filter((name) => name !== "TELEMETRY_STORAGE_NAMESPACE"), ...added].sort(),
  );
  for (const [name, value] of Object.entries(staging)) {
    if (["PUBLIC_ORIGIN", "IDENTITY_LINK_SECRET_VERSION", "TELEMETRY_STORAGE_NAMESPACE"].includes(name)) continue;
    assert.equal(environment.vars[name], value, name);
  }
  assert.equal(environment.vars.IDENTITY_LINK_SECRET_VERSION, "staging-edge-v1");
  assert.equal(environment.vars.SPARKLE_APPCAST_GUARD_MODE, "disabled");
  assert.equal(environment.vars.TELEMETRY_STORAGE_MODE, "json");
  assert.equal(environment.vars.EDGE_UPSTREAM_MODE, undefined, "the overlay sets the mode, never the template");
  assert.deepEqual(environment.secrets.required, TRACKED[0].env.staging.secrets.required);
  assert.equal(environment.workers_dev, false);
  assert.equal(environment.preview_urls, false);
  assert.deepEqual(environment.assets, { ...TRACKED[0].env.production.assets });
  assert.ok(environment.d1_databases.every((entry) => entry.migrations_dir === undefined));
  assert.ok(!TEMPLATE_TEXT.includes("tibotattle.com"), "no hostname is committed");
});

test("both rate-limit profiles use their own namespaces; load raises only the ingress limits", () => {
  const { rehearsal, load } = template().rateLimitProfiles;
  const taken = new Set(TRACKED.flatMap((config) => [config, ...Object.values(config.env ?? {})])
    .flatMap((environment) => environment.ratelimits ?? []).map((entry) => String(entry.namespace_id)));
  for (const profile of [rehearsal, load]) {
    assert.deepEqual(profile.map((entry) => entry.namespace_id), ["4001", "4002", "4003", "4004", "4005", "4006", "4007", "4008"]);
    assert.ok(profile.every((entry) => !taken.has(entry.namespace_id)));
  }
  const production = new Map(TRACKED[0].env.production.ratelimits.map((entry) => [entry.name, entry.simple]));
  for (const entry of rehearsal) assert.deepEqual(entry.simple, production.get(entry.name), entry.name);
  for (const [index, entry] of load.entries()) {
    const ingress = entry.name.startsWith("UPLOAD_INGRESS_");
    assert.equal(entry.simple.limit, ingress ? 4 * rehearsal[index].simple.limit : rehearsal[index].simple.limit, entry.name);
  }
});

test("the example inputs render a complete staging target with no placeholder left", () => {
  const rendered = renderStagingEdgeTemplate({ template: template(), inputs: raw() });
  const text = JSON.stringify(rendered);
  assert.ok(!text.includes("{{"));
  const environment = rendered.edgeTracked.env.production;
  assert.equal(environment.name, "app-usagemonitor-staging-edge");
  assert.equal(environment.vars.PUBLIC_ORIGIN, `https://${RAW_INPUTS.publicHostname}`);
  assert.deepEqual(environment.routes.map((route) => route.pattern),
    [RAW_INPUTS.publicHostname, `admin.${RAW_INPUTS.publicHostname}`]);
  assert.equal(environment.ratelimits.length, 8);
  assert.ok(isAbsolute(rendered.standIn.main) && existsSync(rendered.standIn.main));
  assert.equal(rendered.standIn.d1_databases.length, 1);
  assert.deepEqual(rendered.standIn.triggers.crons, [RAW_INPUTS.standInCron]);
  assert.deepEqual(rendered.migrationConfigs.map((entry) => entry.binding), STAGING_EDGE_D1_ROLES.map((role) => role.binding));
  for (const entry of rendered.migrationConfigs) {
    const [database] = entry.config.d1_databases;
    assert.ok(isAbsolute(database.migrations_dir) && existsSync(database.migrations_dir), entry.role);
    assert.ok(entry.config.name.includes("staging"));
  }
  const load = renderStagingEdgeTemplate({ template: template(), inputs: raw((value) => ({ ...value, rateLimitProfile: "load" })) });
  assert.equal(load.edgeTracked.env.production.ratelimits.find((entry) => entry.name === "UPLOAD_INGRESS_CLIENT_RATE_LIMIT")
    .simple.limit, 12000);
});

test("the genesis snapshot is exactly what the rendered config declares", () => {
  const inputs = parseStagingEdgeInputs(raw());
  const rendered = renderStagingEdgeTemplate({ template: template(), inputs });
  const genesis = createStagingGenesisSnapshot({ edgeTracked: rendered.edgeTracked, inputs });
  assert.equal(genesis.versionId, STAGING_EDGE_GENESIS_VERSION_ID);
  assert.equal(genesis.sourceCommit, null);
  assert.equal(genesis.bindings.some((binding) => binding.name === "EDGE_UPSTREAM_MODE"), false);
  assert.deepEqual(genesis.domains.map((domain) => domain.hostname), [inputs.adminHostname, inputs.publicHostname]);
  const config = renderProductionLiveConfig({ trackedConfig: rendered.edgeTracked, snapshot: genesis, sourceCommit: SOURCE });
  assert.equal(verifyProductionLiveConfig({ snapshot: genesis, candidateConfig: config, sourceCommit: SOURCE }).ok, true);
  assert.deepEqual(stagingEdgeInventoryOf(genesis).workerName, inputs.edgeWorkerName);
});

test("the inputs schema is closed and requires staging names", () => {
  refused(() => parseStagingEdgeInputs(raw((value) => ({ ...value, extra: 1 }))), "STAGING_EDGE_INPUTS_INVALID");
  refused(() => parseStagingEdgeInputs(raw((value) => ({ ...value, adminHostname: "admin.x" }))), "STAGING_EDGE_INPUTS_INVALID");
  refused(() => parseStagingEdgeInputs(raw((value) => { delete value.origin; return value; })), "STAGING_EDGE_INPUTS_INVALID");
  refused(() => parseStagingEdgeInputs(raw((value) => ({ ...value, accountId: "A".repeat(32) }))), "STAGING_EDGE_INPUTS_INVALID");
  refused(() => parseStagingEdgeInputs(raw((value) => ({ ...value, edgeWorkerName: "app-usagemonitor" }))),
    "STAGING_EDGE_NAME_NOT_STAGING");
  refused(() => parseStagingEdgeInputs(raw((value) => ({ ...value, publicHostname: "tibotattle.com" }))),
    "STAGING_EDGE_HOSTNAME_NOT_STAGING");
  refused(() => parseStagingEdgeInputs(raw((value) => ({ ...value, publicHostname: "www.tibotattle.com" }))),
    "STAGING_EDGE_HOSTNAME_NOT_STAGING");
  refused(() => parseStagingEdgeInputs(raw((value) => ({ ...value, publicHostname: "staging.com" }))),
    "STAGING_EDGE_HOSTNAME_NOT_STAGING");
  refused(() => parseStagingEdgeInputs(raw((value) => {
    value.d1.releaseGuard.name = "tibotattle-release-guard";
    return value;
  })), "STAGING_EDGE_NAME_NOT_STAGING");
  refused(() => parseStagingEdgeInputs(raw((value) => ({ ...value, r2: { ...value.r2, sparkleReleases: "tibotattle-updates" } }))),
    "STAGING_EDGE_NAME_NOT_STAGING");
  refused(() => parseStagingEdgeInputs(raw((value) => {
    value.d1.analytics.id = value.d1.ingestion.id;
    return value;
  })), "STAGING_EDGE_INPUTS_INVALID");
  refused(() => parseStagingEdgeInputs(raw((value) => ({ ...value, quietWindowMinutes: 14 }))), "STAGING_EDGE_INPUTS_INVALID");
  refused(() => parseStagingEdgeInputs(raw((value) => ({ ...value, rateLimitProfile: "production" }))), "STAGING_EDGE_INPUTS_INVALID");
  refused(() => parseStagingEdgeInputs(raw((value) => ({ ...value, access: { ...value.access, teamDomain: "evil.example" } }))),
    "STAGING_EDGE_INPUTS_INVALID");
});

test("every production Worker name is refused", () => {
  refused(() => target((value) => ({ ...value, edgeWorkerName: "app-usagemonitor-staging" })), "STAGING_EDGE_PRODUCTION_WORKER");
  refused(() => target((value) => ({ ...value, standInWorkerName: "app-usagemonitor-staging" })), "STAGING_EDGE_PRODUCTION_WORKER");
  const renamed = { ...FIXTURE, workerName: RAW_INPUTS.edgeWorkerName };
  refused(() => target(undefined, { productionSnapshots: [renamed] }), "STAGING_EDGE_PRODUCTION_WORKER");
  const references = stagingEdgeRefusedReferences({ trackedConfigs: TRACKED, productionSnapshots: [FIXTURE] });
  for (const name of ["app-usagemonitor", "app-usagemonitor-staging", "app-usagemonitor-synthetic",
    "tibotattle-dogfood-release-guard"]) {
    assert.ok(references.workerNames.has(name), name);
  }
});

test("every production hostname is refused", () => {
  const references = stagingEdgeRefusedReferences({ trackedConfigs: TRACKED, productionSnapshots: [FIXTURE] });
  for (const host of ["tibotattle.com", "www.tibotattle.com", "admin.tibotattle.com", "updates.tibotattle.com",
    "dogfood-release.tibotattle.com"]) {
    assert.ok(references.hostnames.has(host), host);
  }
  const zoned = { ...FIXTURE, domains: [...FIXTURE.domains, { hostname: RAW_INPUTS.publicHostname }] };
  refused(() => target(undefined, { productionSnapshots: [zoned] }), "STAGING_EDGE_PRODUCTION_HOSTNAME");
  const admin = { ...FIXTURE, routes: [{ pattern: `admin.${RAW_INPUTS.publicHostname}/*` }] };
  refused(() => target(undefined, { productionSnapshots: [admin] }), "STAGING_EDGE_PRODUCTION_HOSTNAME");
});

test("every production D1 id or name is refused", () => {
  const withD1 = (role, entry) => (value) => {
    value.d1[role] = { ...value.d1[role], ...entry };
    return value;
  };
  const productionPrimary = TRACKED[0].env.production.d1_databases[0].database_id;
  const stagingPrimary = TRACKED[0].env.staging.d1_databases[0];
  const dogfood = TRACKED[1].d1_databases[0].database_id;
  const fixturePrimary = FIXTURE.bindings.find((binding) => binding.name === "USAGE_MONITOR_DB").database_id;
  for (const [role, entry] of [
    ["ingestion", { id: productionPrimary }],
    ["analytics", { id: fixturePrimary }],
    ["deletionLedger", { id: stagingPrimary.database_id }],
    ["catchupControl", { name: stagingPrimary.database_name }],
    ["releaseGuard", { id: dogfood }],
  ]) {
    refused(() => target(withD1(role, entry)), "STAGING_EDGE_PRODUCTION_DATABASE");
  }
  const productionPlan = {
    upstreamOrigin: "https://tibotattle-origin-synthetic.a.run.app",
    originAudience: "synthetic-production-audience",
    invokerServiceAccount: "edge-invoker@synthetic-project.iam.gserviceaccount.com",
    releaseGuardDatabase: { id: RAW_INPUTS.d1.releaseGuard.id, name: "tibotattle-release-guard" },
  };
  refused(() => target(undefined, { productionPlan }), "STAGING_EDGE_PRODUCTION_DATABASE");
  refused(() => target(undefined, { productionPlan: { invalid: true } }), "STAGING_EDGE_PRODUCTION_INPUT_INVALID");
});

test("every production bucket and rate-limit namespace is refused", () => {
  refused(() => target((value) => ({ ...value, r2: { ...value.r2, quarantine: "app-usagemonitor-staging-quarantine" } })),
    "STAGING_EDGE_PRODUCTION_BUCKET");
  const bucket = { ...FIXTURE, bindings: [...FIXTURE.bindings.filter((binding) => binding.name !== "QUARANTINE"),
    { name: "QUARANTINE", type: "r2_bucket", bucket_name: RAW_INPUTS.r2.quarantine }] };
  refused(() => target(undefined, { productionSnapshots: [bucket] }), "STAGING_EDGE_PRODUCTION_BUCKET");
  const clashing = template();
  clashing.rateLimitProfiles.rehearsal[0] = { ...clashing.rateLimitProfiles.rehearsal[0], namespace_id: "3001" };
  refused(() => assertStagingEdgeTarget({ inputs: raw(), template: clashing, trackedConfigs: TRACKED }),
    "STAGING_EDGE_PRODUCTION_RATE_LIMIT");
});

test("the EP-8 fence plan is the staging Worker, its stand-in and the staging resources", () => {
  const { plan, planSha256 } = buildStagingFencePlan(raw());
  const validated = validateCloudflareWriterFencePlan(plan);
  assert.equal(validated.planSha256, planSha256);
  assert.equal(plan.productionWorker, RAW_INPUTS.edgeWorkerName);
  assert.deepEqual(plan.fencedScripts, [{ name: RAW_INPUTS.standInWorkerName, kind: "cron", expectedCrons: [RAW_INPUTS.standInCron] }]);
  assert.deepEqual(validated.d1, {
    ingestion: RAW_INPUTS.d1.ingestion.id,
    analytics: RAW_INPUTS.d1.analytics.id,
    "deletion-ledger": RAW_INPUTS.d1.deletionLedger.id,
    "catchup-control": RAW_INPUTS.d1.catchupControl.id,
  });
  assert.deepEqual(validated.r2, { bucket: RAW_INPUTS.r2.quarantine });
  assert.equal(plan.dataResources.some((entry) => entry.id === RAW_INPUTS.d1.releaseGuard.id), false);
});

test("the gcp plan is EP-9's closed plan, and null until the staging origin exists", () => {
  const gcp = buildStagingGcpPlan(raw());
  assert.deepEqual(Object.keys(gcp.plan).sort(),
    ["invokerServiceAccount", "originAudience", "releaseGuardDatabase", "upstreamOrigin"]);
  assert.deepEqual(gcp.plan.releaseGuardDatabase, RAW_INPUTS.d1.releaseGuard);
  assert.equal(gcp.overlaySha256, edgeModeOverlaySha256({ mode: "gcp", plan: gcp.plan }));
  assert.equal(buildStagingGcpPlan(raw((value) => ({ ...value, origin: null }))), null);
  refused(() => buildStagingGcpPlan(raw((value) => ({ ...value, origin: { ...value.origin, upstreamOrigin: "https://example.com" } }))),
    "STAGING_EDGE_GCP_PLAN_INVALID");
  const timed = buildStagingGcpPlan(raw((value) => ({ ...value, origin: { ...value.origin, upstreamHeadersTimeoutSeconds: 30 } })));
  assert.equal(timed.plan.upstreamHeadersTimeoutSeconds, 30);
});

test("the stand-in writes one heartbeat per run and reads nothing else", async () => {
  const calls = [];
  const database = {
    prepare(sql) {
      calls.push({ sql });
      return { bind: (...values) => ({ run: async () => { calls.push({ values }); return { success: true }; } }) };
    },
  };
  const env = new Proxy({ STORAGE_ANALYTICS_CATCHUP_CONTROL_DB: database }, {
    get(targetObject, name) {
      if (name !== "STORAGE_ANALYTICS_CATCHUP_CONTROL_DB") throw new Error(`unexpected binding ${String(name)}`);
      return targetObject[name];
    },
  });
  await standIn.scheduled({ scheduledTime: 1_700_000_000_000, cron: "*/5 * * * *" }, env);
  assert.deepEqual(calls, [
    { sql: "INSERT INTO staging_edge_heartbeat (scheduled_at_ms, cron) VALUES (?1, ?2)" },
    { values: [1_700_000_000_000, "*/5 * * * *"] },
  ]);
  assert.deepEqual(Object.keys(standIn), ["scheduled"]);
  const migration = readFileSync(join(STAGING_EDGE_WORKER_DIRECTORY, "ops", "staging-edge", "catchup-standin", "migrations",
    "0001_staging_edge_heartbeat.sql"), "utf8");
  assert.match(migration, /CREATE TABLE staging_edge_heartbeat/u);
  assert.equal((migration.match(/CREATE /gu) ?? []).length, 1);
});
