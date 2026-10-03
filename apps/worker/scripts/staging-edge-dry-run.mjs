#!/usr/bin/env node
// Offline dry run of the staging edge (STG-DRV), with no remote call.
//
// 1. Renders the committed template with the synthetic example inputs
//    (ops/staging-edge/staging-edge-inputs.example.json) against EP-9's
//    synthetic production snapshot (scripts/fixtures/edge-mode-live-snapshot.
//    synthetic.json) and the checked-in configs.
// 2. Walks the whole rehearsal sequence (stagingEdgeRehearsalSequence) through
//    the driver's own dry run, runStagingEdgeDeployment without --execute:
//    every deploy step runs E10's gates with the staging overlay and must give
//    its expected outcome. The live staging Worker is simulated by applying
//    each ok step's expected snapshot as the next live version; the origin
//    verifier, identity token, git blobs and fence history are synthetic
//    readers. The release-guard gate is production's own
//    determinePendingD1Migrations over a synthetic Wrangler that answers the
//    ledger read as Wrangler does: rows for a migrated guard D1, no rows for
//    the throwaway (its ledger initialised by `d1 migrations list`), and a
//    failed "no such table: d1_migrations" for a D1 whose ledger was never
//    created. The production isolation inputs are EP-9's synthetic production
//    capture and a synthetic production EP-8 fence plan that matches it.
//    EP-8's own steps are covered by cloudflare-writer-fence.check.mjs and
//    only move the simulated fence here.
// 3. Bundles the worker, fenced, gcp and brake candidates the walk wrote,
//    exactly as the owner would deploy them, and the stand-in Worker, with
//    `wrangler deploy --dry-run` under PATH and HOME only, so wrangler
//    validates each config and builds its entry; nothing is uploaded.
//
// Prints one JSON line per rehearsal step and per bundle.

import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import {
  EDGE_MODE_DRY_RUN_WORKER_ROOT,
  bundleExportNames,
  dryRunViolations,
  wranglerEnvironment,
} from "./edge-mode-dry-run.mjs";
import { FENCE_PLAN_SCHEMA } from "./cloudflare-writer-fence.mjs";
import { EDGE_MODE_GCP_REQUIRED_SECRETS, EDGE_MODE_PRODUCTION_WORKER_NAME } from "./edge-mode-configuration.mjs";
import { determinePendingD1Migrations } from "./production-deploy.mjs";
import { EDGE_PRIVACY_TOPOLOGY_MARKER, EDGE_MODE_RELEASE_GUARD_DATABASE } from "./production-edge-mode.mjs";
import { createProductionLiveConfigSnapshot } from "./production-live-config.mjs";
import {
  STAGING_EDGE_CANDIDATE_FILE,
  runStagingEdgeDeployment,
  stagingEdgeRehearsalSequence,
} from "./staging-edge-deploy.mjs";
import {
  STAGING_EDGE_INPUTS_EXAMPLE_PATH,
  parseStagingEdgeInputs,
  readStagingEdgeTemplate,
  readStagingEdgeTrackedConfigs,
  renderStagingEdgeTemplate,
  stagingEdgeInventoryOf,
} from "./staging-edge-target.mjs";

const execFileAsync = promisify(execFile);
const FIXTURE = join(EDGE_MODE_DRY_RUN_WORKER_ROOT, "scripts", "fixtures", "edge-mode-live-snapshot.synthetic.json");
/** Synthetic commits and blobs: the candidate source, and the origin it fronts (same contract blob). */
export const STAGING_DRY_RUN_SOURCE = "5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e";
export const STAGING_DRY_RUN_ORIGIN_COMMIT = "0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e";
const CONTRACT_BLOB = "c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0";
const ENTRY_BLOB = "e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0";
const SYNTHETIC_TOKEN = "eyJzeW50aGV0aWMiOiJoZWFkZXIifQ.eyJzeW50aGV0aWMiOiJjbGFpbXMifQ.c3ludGhldGljLXNpZ25hdHVyZQ";
/** The synthetic readers every simulated step uses: blobs, ancestry and the origin verifier. */
export const STAGING_DRY_RUN_READERS = Object.freeze({
  readBlob: (commit, path) => (path.endsWith("edge-entry.ts") ? ENTRY_BLOB : CONTRACT_BLOB),
  isAncestor: () => true,
  verifyOrigin: async () => ({ ok: true, code: null, originCommit: STAGING_DRY_RUN_ORIGIN_COMMIT }),
  obtainOriginIdentityToken: async () => SYNTHETIC_TOKEN,
});
export const STAGING_DRY_RUN_FIXTURE = FIXTURE;
const THROWAWAY_GUARD = Object.freeze({ id: "5a00000f-0000-4000-8000-00000000000f", name: "tibotattle-staging-release-guard-throwaway" });
/** The synthetic production catch-up control D1, bound only by a production consumer other than the edge Worker. */
export const STAGING_DRY_RUN_PRODUCTION_CATCHUP_ID = "0c000004-0000-4000-8000-0000000000c4";
const RELEASE_GUARD_MIGRATION = "0001_sparkle_appcast_guard_nonces.sql";
const VERIFIER = "tibotattle-staging-verifier@synthetic-project.iam.gserviceaccount.com";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * The synthetic production EP-8 fence plan: the production Worker, a cron
 * catch-up consumer, the production capture's three D1s and quarantine
 * bucket, and a catch-up control D1 only that consumer binds.
 */
export function stagingDryRunProductionFencePlan(productionSnapshot) {
  const d1 = (name) => productionSnapshot.bindings.find((binding) => binding.type === "d1" && binding.name === name)?.database_id;
  return {
    schema: FENCE_PLAN_SCHEMA,
    accountId: productionSnapshot.accountId,
    productionWorker: EDGE_MODE_PRODUCTION_WORKER_NAME,
    fencedScripts: [{ name: "tibotattle-analytics-catchup-synthetic", kind: "cron", expectedCrons: ["*/5 * * * *"] }],
    dataResources: [
      { kind: "d1", id: d1("USAGE_MONITOR_DB"), label: "ingestion" },
      { kind: "d1", id: d1("ANALYTICS_DB"), label: "analytics" },
      { kind: "d1", id: d1("DELETION_LEDGER"), label: "deletion-ledger" },
      { kind: "d1", id: STAGING_DRY_RUN_PRODUCTION_CATCHUP_ID, label: "catchup-control" },
      { kind: "r2", bucket: productionSnapshot.bindings.find((binding) => binding.name === "QUARANTINE")?.bucket_name },
    ],
    outOfScopeScripts: [],
    quietWindowMinutes: 15,
  };
}

/**
 * A synthetic Wrangler for the release-guard ledger read only. It answers
 * `d1 execute RELEASE_GUARD_DB ... --json` for the D1 the candidate config
 * binds as Wrangler 4.114.0 does: the rows of an initialised ledger (from
 * `ledgers`, by database name), or exit 1 with "no such table: d1_migrations"
 * for a D1 whose ledger was never created.
 */
export function stagingDryRunLedgerSpawn(ledgers) {
  return (command, args) => {
    const config = args.indexOf("--config");
    if (args[0] !== "d1" || args[1] !== "execute" || args[2] !== EDGE_MODE_RELEASE_GUARD_DATABASE.binding || config < 0) {
      return { status: 1, stdout: "", stderr: "synthetic wrangler: unexpected command" };
    }
    const environment = JSON.parse(readFileSync(args[config + 1], "utf8")).env.production;
    const database = environment.d1_databases.find((entry) => entry.binding === EDGE_MODE_RELEASE_GUARD_DATABASE.binding);
    const rows = ledgers.get(database?.database_name);
    if (rows === undefined) {
      return { status: 1, stdout: `${JSON.stringify({ error: { text: "no such table: d1_migrations: SQLITE_ERROR" } })}\n`, stderr: "" };
    }
    const results = rows.map((name, index) => ({ id: index + 1, name }));
    return { status: 0, stdout: JSON.stringify([{ results, success: true, meta: {} }]), stderr: "" };
  };
}

/** The release-guard ledgers of the rehearsal: the staging guard migrated, the throwaway initialised and empty. */
export function stagingDryRunLedgers(inputs) {
  return new Map([[inputs.d1.releaseGuard.name, [RELEASE_GUARD_MIGRATION]], [THROWAWAY_GUARD.name, []]]);
}

/** The example inputs, and the three variants the rehearsal's negative steps name. */
export async function stagingDryRunInputs() {
  const raw = JSON.parse(await readFile(STAGING_EDGE_INPUTS_EXAMPLE_PATH, "utf8"));
  const variant = (change) => parseStagingEdgeInputs(change(structuredClone(raw)));
  return {
    "<inputs.json>": parseStagingEdgeInputs(raw),
    "<inputs with origin null>": variant((value) => ({ ...value, origin: null })),
    "<inputs with a placeholder origin>": variant((value) => ({
      ...value, origin: { ...value.origin, upstreamOrigin: "https://staging-origin-placeholder.a.run.app" },
    })),
    "<inputs naming the throwaway guard D1>": variant((value) => ({
      ...value, d1: { ...value.d1, releaseGuard: { ...THROWAWAY_GUARD } },
    })),
  };
}

/** A one-page synthetic candidate site, with or without the gcp privacy marker. */
export async function writeStagingDryRunSite(directory, marked) {
  await mkdir(directory, { mode: 0o700 });
  await writeFile(join(directory, "index.html"), "<!doctype html><title>synthetic staging edge</title>\n", { mode: 0o600 });
  await writeFile(join(directory, "privacy.html"),
    `<!doctype html><main${marked ? ` ${EDGE_PRIVACY_TOPOLOGY_MARKER}` : ""}>synthetic</main>\n`, { mode: 0o600 });
  await writeFile(join(directory, "release-site-manifest.json"), `{"synthetic":${marked}}\n`, { mode: 0o600 });
  return directory;
}

/**
 * What Cloudflare's settings API reported on 2026-10-03 (staging edge genesis
 * and production) for a Worker declaring only
 * { enabled: true, head_sampling_rate: 1 }. Kept separate from the verifier's
 * pinned-defaults table so the rehearsal cross-checks it rather than echoing it.
 */
const CLOUDFLARE_REPORTED_OBSERVABILITY = Object.freeze({
  redact_query_string: false,
  logs: Object.freeze({ enabled: true, head_sampling_rate: 1, persist: true, invocation_logs: true }),
  traces: Object.freeze({ enabled: false, persist: true, head_sampling_rate: 1 }),
});

/**
 * The observability a live capture reads after deploying `declared`: for the
 * observed declaration, Cloudflare fills every unset field with its default;
 * any other declaration is simulated unchanged.
 */
function cloudflareReportedObservability(declared) {
  if (declared?.enabled !== true || declared.head_sampling_rate !== 1) return declared;
  return {
    redact_query_string: CLOUDFLARE_REPORTED_OBSERVABILITY.redact_query_string,
    ...declared,
    logs: { ...CLOUDFLARE_REPORTED_OBSERVABILITY.logs, ...declared.logs },
    traces: { ...CLOUDFLARE_REPORTED_OBSERVABILITY.traces, ...declared.traces },
  };
}

/**
 * The simulated next live version: the expected snapshot, deployed from the
 * synthetic source, with observability as Cloudflare's settings API expands it.
 */
export function stagingDryRunAdvance(expected, versionNumber) {
  const bindings = expected.bindings.filter((binding) => binding.name !== "DEPLOYMENT_SOURCE_COMMIT");
  bindings.push({ name: "DEPLOYMENT_SOURCE_COMMIT", type: "plain_text", text: STAGING_DRY_RUN_SOURCE });
  const versionId = `5e000000-0000-4000-8000-${String(versionNumber).padStart(12, "0")}`;
  const settings = { ...expected.settings, observability: cloudflareReportedObservability(expected.settings?.observability) };
  return createProductionLiveConfigSnapshot(stagingEdgeInventoryOf({ ...expected, bindings, settings, versionId }));
}

/** Phase F, simulated: the four gcp secrets put on the live version. */
export function stagingDryRunWithGcpSecrets(snapshot, versionNumber) {
  const names = new Set(snapshot.bindings.map((binding) => binding.name));
  const bindings = [...snapshot.bindings, ...EDGE_MODE_GCP_REQUIRED_SECRETS
    .filter((name) => !names.has(name)).map((name) => ({ name, type: "secret_text" }))];
  const versionId = `5e000000-0000-4000-8000-${String(versionNumber).padStart(12, "0")}`;
  return createProductionLiveConfigSnapshot(stagingEdgeInventoryOf({ ...snapshot, bindings, versionId }));
}

function option(command, flag) {
  const index = command.indexOf(flag);
  return index < 0 ? undefined : command[index + 1];
}

/**
 * Walk the rehearsal sequence through the driver's dry run. Returns one
 * result per step, the candidate config path of each ok deploy step, and the
 * simulated live snapshots. `directory` is a private temporary directory.
 */
export async function simulateStagingEdgeRehearsal({ directory }) {
  const template = await readStagingEdgeTemplate();
  const trackedConfigs = await readStagingEdgeTrackedConfigs();
  const inputsByName = await stagingDryRunInputs();
  const productionSnapshot = JSON.parse(await readFile(FIXTURE, "utf8"));
  const productionInventory = stagingEdgeInventoryOf(productionSnapshot);
  const productionFencePlan = stagingDryRunProductionFencePlan(productionSnapshot);
  const ledgerSpawn = stagingDryRunLedgerSpawn(stagingDryRunLedgers(inputsByName["<inputs.json>"]));
  const sites = {
    "<candidate-site>": await writeStagingDryRunSite(join(directory, "site-unmarked"), false),
    "<marker-bearing site>": await writeStagingDryRunSite(join(directory, "site-marked"), true),
  };
  let live = null;
  let versionNumber = 0;
  const deployments = [];
  let fence = null;
  const results = [];
  const candidates = {};
  for (const step of stagingEdgeRehearsalSequence()) {
    if (step.kind === "fence") {
      // EP-8 itself is covered by cloudflare-writer-fence.check.mjs. Here a
      // plan/apply pins the fenced deployment the abort's history walks to.
      if (step.subcommand === "apply") fence = deployments[0]?.deploymentId ?? null;
      if (step.subcommand === "release" && step.expect.ok) fence = null;
      results.push({ id: step.id, kind: "fence", simulated: false, expected: step.expect });
      continue;
    }
    if (step.cycle === "R2" && step.id === "R2.0" && live !== null) {
      // Phase F, between the cycles: the four gcp secrets are put in worker
      // mode; each put is a new version with otherwise identical bindings.
      live = stagingDryRunWithGcpSecrets(live, ++versionNumber);
      deployments.unshift({ deploymentId: `deployment-${versionNumber}`, modes: ["worker"] });
    }
    const inputs = inputsByName[option(step.command, "--inputs")];
    const siteDirectory = sites[option(step.command, "--site")];
    const candidateSite = step.command.includes("--candidate-site");
    const outputDirectory = join(directory, `out-${step.id}`);
    await mkdir(outputDirectory, { mode: 0o700 });
    const fenceReceipt = step.command.includes("--fence-receipt");
    const result = await runStagingEdgeDeployment({
      outputDirectory,
      sourceState: () => ({ commit: STAGING_DRY_RUN_SOURCE, clean: true }),
      pendingD1Migrations: determinePendingD1Migrations,
      spawn: ledgerSpawn,
      mode: step.to,
      genesis: step.command.includes("--genesis"),
      inputs,
      template,
      trackedConfigs,
      productionInventory,
      productionPlan: null,
      productionFencePlan,
      stagingInventory: live === null ? undefined : stagingEdgeInventoryOf(live),
      expectedPreviousSourceCommit: live === null ? null : live.sourceCommit,
      siteDirectory,
      candidatePublicManifestSha256: candidateSite
        ? sha256(await readFile(join(siteDirectory, "release-site-manifest.json"))) : null,
      originCommit: step.to === "gcp" ? STAGING_DRY_RUN_ORIGIN_COMMIT : undefined,
      obtainOriginIdentityToken: step.to === "gcp" ? STAGING_DRY_RUN_READERS.obtainOriginIdentityToken : undefined,
      edgeHistory: fenceReceipt ? async () => ({ fenceDeploymentId: fence ?? "no-fence", deployments }) : undefined,
      readBlob: STAGING_DRY_RUN_READERS.readBlob,
      isAncestor: STAGING_DRY_RUN_READERS.isAncestor,
      verifyOrigin: STAGING_DRY_RUN_READERS.verifyOrigin,
    });
    const matched = step.expect.ok ? result.ok === true : result.ok === false && result.code === step.expect.code;
    results.push({
      id: step.id, kind: "deploy", from: step.from, to: step.to, simulated: true, expected: step.expect,
      actual: result.ok ? { ok: true } : { ok: false, code: result.code }, matched,
      ...(result.ok ? { edgeOverlaySha256: result.plan.edgeOverlaySha256 } : {}),
    });
    if (result.ok) {
      const expected = JSON.parse(await readFile(join(outputDirectory, "expected-snapshot.json"), "utf8"));
      live = stagingDryRunAdvance(expected, ++versionNumber);
      deployments.unshift({ deploymentId: `deployment-${versionNumber}`, modes: [step.to] });
      candidates[step.id] = join(outputDirectory, STAGING_EDGE_CANDIDATE_FILE);
    }
  }
  return { results, candidates, live, verifier: VERIFIER };
}

/** The bundles: genesis worker (R1.0), fenced (R1.3), gcp (R2.7) and the brake (R2.9). */
export const STAGING_DRY_RUN_BUNDLES = Object.freeze({ worker: "R1.0", fenced: "R1.3", gcp: "R2.7", brake: "R2.9" });

async function bundle({ configPath, outdir, env, extraArgs = [] }) {
  await execFileAsync(join(EDGE_MODE_DRY_RUN_WORKER_ROOT, "node_modules", ".bin", "wrangler"),
    ["deploy", "--dry-run", "--outdir", outdir, "--config", configPath, ...extraArgs],
    { cwd: EDGE_MODE_DRY_RUN_WORKER_ROOT, env: wranglerEnvironment(env), maxBuffer: 16 * 1024 * 1024, timeout: 300_000 });
}

export async function dryRunStagingEdge({ env = process.env } = {}) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "staging-edge-dry-run-")));
  try {
    const simulation = await simulateStagingEdgeRehearsal({ directory });
    const bundles = [];
    for (const [mode, stepId] of Object.entries(STAGING_DRY_RUN_BUNDLES)) {
      const configPath = simulation.candidates[stepId];
      if (configPath === undefined) {
        bundles.push({ mode, step: stepId, missing: true });
        continue;
      }
      const outdir = join(directory, `bundle-${mode}`);
      await bundle({ configPath, outdir, env, extraArgs: ["--env", "production"] });
      const config = JSON.parse(await readFile(configPath, "utf8")).env.production;
      const source = await readFile(join(outdir, "edge-entry.js"), "utf8");
      bundles.push({
        mode: mode === "brake" ? "fenced" : mode,
        bundle: mode,
        step: stepId,
        worker: config.name,
        main: "src/edge-entry.ts",
        mainIsEdgeEntry: config.main === join(EDGE_MODE_DRY_RUN_WORKER_ROOT, "src", "edge-entry.ts"),
        modeVar: config.vars?.EDGE_UPSTREAM_MODE ?? null,
        d1: (config.d1_databases ?? []).map((database) => database.binding).sort(),
        r2: (config.r2_buckets ?? []).map((bucket) => bucket.binding).sort(),
        ratelimits: (config.ratelimits ?? []).map((limit) => limit.name).sort(),
        durableObjects: (config.durable_objects?.bindings ?? []).map((binding) => binding.name).sort(),
        crons: config.triggers?.crons ?? null,
        domains: (config.routes ?? []).map((route) => route.pattern).sort(),
        bundleBytes: Buffer.byteLength(source),
        exports: bundleExportNames(source),
      });
    }
    const rendered = renderStagingEdgeTemplate({
      template: await readStagingEdgeTemplate(), inputs: (await stagingDryRunInputs())["<inputs.json>"],
    });
    const standInPath = join(directory, "standin.wrangler.json");
    await writeFile(standInPath, `${JSON.stringify(rendered.standIn, null, 2)}\n`, { mode: 0o600 });
    const standInOut = join(directory, "bundle-standin");
    await bundle({ configPath: standInPath, outdir: standInOut, env });
    const standInSource = await readFile(join(standInOut, "index.js"), "utf8");
    bundles.push({
      bundle: "standin",
      worker: rendered.standIn.name,
      d1: rendered.standIn.d1_databases.map((database) => database.binding),
      crons: rendered.standIn.triggers.crons,
      bundleBytes: Buffer.byteLength(standInSource),
      exports: bundleExportNames(standInSource),
    });
    return { steps: simulation.results, bundles };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/** Every property the walk and the bundles must have; returns the violations. */
export function stagingDryRunViolations({ steps, bundles }) {
  const violations = [];
  for (const step of steps) {
    if (step.simulated && !step.matched) violations.push(`${step.id}: expected ${JSON.stringify(step.expected)}, got ${JSON.stringify(step.actual)}`);
  }
  const modes = bundles.filter((entry) => !entry.missing && ["worker", "fenced", "gcp"].includes(entry.bundle));
  for (const entry of bundles) if (entry.missing) violations.push(`${entry.mode}: no candidate from ${entry.step}`);
  if (modes.length === 3) violations.push(...dryRunViolations(modes));
  const brake = bundles.find((entry) => entry.bundle === "brake");
  if (brake && !brake.missing) {
    if (brake.modeVar !== "fenced") violations.push("brake: mode var");
    if (!brake.d1.includes("RELEASE_GUARD_DB") || brake.d1.includes("USAGE_MONITOR_DB")) {
      violations.push("brake: the gcp storage reduction is not kept");
    }
  }
  for (const entry of bundles.filter((item) => !item.missing && item.bundle !== "standin")) {
    if (!entry.mainIsEdgeEntry) violations.push(`${entry.bundle}: main is not the edge entry`);
    if (entry.worker === "app-usagemonitor") violations.push(`${entry.bundle}: production worker name`);
    if (entry.domains.length !== 2) violations.push(`${entry.bundle}: custom domains`);
  }
  const standIn = bundles.find((entry) => entry.bundle === "standin");
  if (!standIn || JSON.stringify(standIn.d1) !== JSON.stringify(["STORAGE_ANALYTICS_CATCHUP_CONTROL_DB"])
      || standIn.crons.length !== 1 || JSON.stringify(standIn.exports) !== JSON.stringify(["default"])) {
    violations.push("standin: binding, cron or default export");
  }
  return violations;
}

if (process.argv[1] && process.argv[1].endsWith("staging-edge-dry-run.mjs")) {
  dryRunStagingEdge().then((result) => {
    for (const step of result.steps) process.stdout.write(`${JSON.stringify(step)}\n`);
    for (const entry of result.bundles) process.stdout.write(`${JSON.stringify(entry)}\n`);
    const violations = stagingDryRunViolations(result);
    if (violations.length > 0) {
      process.stderr.write(`${JSON.stringify({ status: "failed", violations })}\n`);
      process.exitCode = 1;
    }
  }, (error) => {
    process.stderr.write(`${JSON.stringify({ status: "error", code: error?.code ?? "STAGING_EDGE_DRY_RUN_FAILED" })}\n`);
    process.exitCode = 1;
  });
}
