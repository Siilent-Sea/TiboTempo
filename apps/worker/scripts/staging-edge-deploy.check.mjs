import test, { after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { edgeModeForbiddenPathClass } from "./check-deployment-endpoints.mjs";
import { EDGE_MODE_TRANSITIONS } from "./edge-mode-configuration.mjs";
import { recheckProductionEdgeHealth } from "./production-deploy.mjs";
import {
  PRODUCTION_EDGE_MODE_OVERLAY,
  createEdgeModeConfigTools,
  prepareEdgeModeDeployment,
} from "./production-edge-mode.mjs";
import {
  createProductionLiveConfigSnapshot,
  renderProductionLiveConfig,
  verifyProductionLiveConfig,
} from "./production-live-config.mjs";
import {
  STAGING_DRY_RUN_FIXTURE,
  STAGING_DRY_RUN_ORIGIN_COMMIT,
  STAGING_DRY_RUN_READERS,
  STAGING_DRY_RUN_SOURCE,
  stagingDryRunAdvance,
  stagingDryRunInputs,
  stagingDryRunWithGcpSecrets,
  writeStagingDryRunSite,
} from "./staging-edge-dry-run.mjs";
import {
  STAGING_EDGE_CANDIDATE_FILE,
  STAGING_EDGE_DEPLOY_CONFIRMATION,
  assertPrivateSecretsFile,
  createStagingOutputDirectory,
  parseStagingEdgeArguments,
  prepareStagingEdgeDeployment,
  reconcileStagingEdgeDeployment,
  rehearsalStepAgreesWithMatrix,
  runStagingEdgeDeployment,
  serializeStagingEdgeCandidate,
  stagingEdgeEndpointMatrix,
  stagingEdgeRehearsalSequence,
  stagingWranglerEnvironment,
  verifyStagingEdgeEndpoints,
} from "./staging-edge-deploy.mjs";
import {
  STAGING_EDGE_WORKER_DIRECTORY,
  readStagingEdgeTemplate,
  readStagingEdgeTrackedConfigs,
  stagingEdgeInventoryOf,
} from "./staging-edge-target.mjs";

// Synthetic inputs, fake providers and a fake Wrangler only. The synthetic
// token below must never appear in any file, result or code this suite sees.
const SYNTHETIC_API_TOKEN = "synthetic-cloudflare-token-0123456789";
const SECRETS_SENTINEL = "SYNTHETIC_SECRET_VALUE_NEVER_READ";
const PRODUCTION_INVENTORY = stagingEdgeInventoryOf(JSON.parse(readFileSync(STAGING_DRY_RUN_FIXTURE, "utf8")));
const temporary = [];
after(async () => {
  for (const directory of temporary) await rm(directory, { recursive: true, force: true });
});

async function tempDirectory(prefix) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  temporary.push(directory);
  return directory;
}

let shared;
async function context() {
  if (shared) return shared;
  const directory = await tempDirectory("staging-edge-deploy-check-");
  shared = {
    directory,
    inputs: await stagingDryRunInputs(),
    template: await readStagingEdgeTemplate(),
    trackedConfigs: await readStagingEdgeTrackedConfigs(),
    unmarked: await writeStagingDryRunSite(join(directory, "site-unmarked"), false),
    marked: await writeStagingDryRunSite(join(directory, "site-marked"), true),
  };
  return shared;
}

async function base(overrides = {}) {
  const ctx = await context();
  return {
    inputs: ctx.inputs["<inputs.json>"],
    template: ctx.template,
    trackedConfigs: ctx.trackedConfigs,
    productionInventory: PRODUCTION_INVENTORY,
    productionPlan: null,
    siteDirectory: ctx.unmarked,
    sourceCommit: STAGING_DRY_RUN_SOURCE,
    readBlob: STAGING_DRY_RUN_READERS.readBlob,
    isAncestor: STAGING_DRY_RUN_READERS.isAncestor,
    verifyOrigin: STAGING_DRY_RUN_READERS.verifyOrigin,
    ...overrides,
  };
}

let versions = 100;
/** Prepare a step and return the simulated next live snapshot. */
async function deployTo(live, mode, overrides = {}) {
  const prepared = await prepareStagingEdgeDeployment(await base({
    mode,
    ...(live === null
      ? { genesis: true }
      : { stagingInventory: stagingEdgeInventoryOf(live), expectedPreviousSourceCommit: live.sourceCommit }),
    ...overrides,
  }));
  assert.equal(prepared.ok, true, prepared.code);
  return { prepared, live: stagingDryRunAdvance(prepared.expected, ++versions) };
}

async function states() {
  const worker = (await deployTo(null, "worker")).live;
  const fenced = (await deployTo(worker, "fenced")).live;
  const secrets = stagingDryRunWithGcpSecrets(fenced, ++versions);
  const ctx = await context();
  const gcp = (await deployTo(secrets, "gcp", {
    siteDirectory: ctx.marked,
    candidatePublicManifestSha256: "a".repeat(64),
    originCommit: STAGING_DRY_RUN_ORIGIN_COMMIT,
    obtainOriginIdentityToken: STAGING_DRY_RUN_READERS.obtainOriginIdentityToken,
  })).live;
  return { worker, fenced, gcp };
}

async function outputDirectory() {
  const directory = join(await tempDirectory("staging-edge-out-"), "operation");
  await mkdir(directory, { mode: 0o700 });
  return directory;
}

function fakeProvider(captures) {
  const calls = { capture: 0, identity: null };
  return {
    calls,
    create: (identity) => {
      calls.identity = { accountId: identity.accountId, workerName: identity.workerName };
      return {
        async capture() {
          const next = captures[calls.capture++];
          if (next instanceof Error) throw next;
          if (next === undefined) throw new Error("unexpected capture");
          return structuredClone(next);
        },
      };
    },
  };
}

function fakeSpawn(status = 0) {
  const calls = [];
  return { calls, spawn: (command, args, options) => { calls.push({ command, args, options }); return { status, stdout: "", stderr: "" }; } };
}

const ENVIRONMENT = Object.freeze({ PATH: "/usr/bin:/bin", HOME: "/home/synthetic", CLOUDFLARE_API_TOKEN: SYNTHETIC_API_TOKEN });

async function filesUnder(directory) {
  const out = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) out.push(...await filesUnder(path));
    else out.push(path);
  }
  return out;
}

async function assertPrivateAndTokenFree(directory, result) {
  for (const path of await filesUnder(directory)) {
    const info = await lstat(path);
    assert.equal(info.mode & 0o777, 0o600, path);
    const text = await readFile(path, "utf8");
    assert.ok(!text.includes(SYNTHETIC_API_TOKEN), path);
    assert.ok(!text.includes(SECRETS_SENTINEL), path);
  }
  assert.ok(!JSON.stringify(result).includes(SYNTHETIC_API_TOKEN));
  assert.ok(!JSON.stringify(result).includes(SECRETS_SENTINEL));
}

test("E10 takes the staging overlay and keeps production as its default", async () => {
  const tracked = (await context()).trackedConfigs[0];
  const typed = { createSnapshot: createProductionLiveConfigSnapshot, render: renderProductionLiveConfig, verify: verifyProductionLiveConfig };
  assert.equal(PRODUCTION_EDGE_MODE_OVERLAY.target, "production");
  assert.throws(() => createEdgeModeConfigTools({ mode: "worker", trackedConfig: tracked, base: typed, overlay: {} }),
    (error) => error.code === "EDGE_MODE_INPUT_INVALID");
  const prepared = await prepareEdgeModeDeployment({
    edgeMode: "worker", inventory: PRODUCTION_INVENTORY, baseConfigTools: typed, workerDirectory: STAGING_EDGE_WORKER_DIRECTORY,
    sourceCommit: STAGING_DRY_RUN_SOURCE, overlay: { config: null },
  });
  assert.deepEqual(prepared, { ok: false, code: "EDGE_MODE_INPUT_INVALID" });
});

test("the staging deploy refuses production inputs and a production inventory", async () => {
  const { worker } = await states();
  const ctx = await context();
  const prepare = async (overrides) => prepareStagingEdgeDeployment(await base({
    mode: "worker", stagingInventory: stagingEdgeInventoryOf(worker), expectedPreviousSourceCommit: worker.sourceCommit, ...overrides,
  }));
  assert.equal((await prepare({})).ok, true);
  // The production Worker's own inventory is never a staging baseline.
  assert.deepEqual(await prepare({ stagingInventory: PRODUCTION_INVENTORY }),
    { ok: false, code: "STAGING_EDGE_INVENTORY_TARGET_MISMATCH" });
  assert.deepEqual(await prepare({ productionPlan: undefined }), { ok: false, code: "STAGING_EDGE_PRODUCTION_INPUT_INVALID" });
  assert.deepEqual(await prepare({ productionInventory: { workerName: "app-usagemonitor" } }),
    { ok: false, code: "STAGING_EDGE_PRODUCTION_INPUT_INVALID" });
  // A live staging version that binds a production D1 is refused by EP-9's isolation guard.
  const primary = PRODUCTION_INVENTORY.version.resources.bindings.find((binding) => binding.name === "USAGE_MONITOR_DB");
  const leaking = structuredClone(stagingEdgeInventoryOf(worker));
  for (const list of [leaking.version.resources.bindings, leaking.settings.bindings]) {
    const binding = list.find((entry) => entry.name === "USAGE_MONITOR_DB");
    binding.id = primary.id;
    binding.database_id = primary.database_id;
  }
  assert.deepEqual(await prepare({ stagingInventory: leaking }), { ok: false, code: "EDGE_MODE_STAGING_PRODUCTION_REFERENCE" });
  const renamedInputs = { ...structuredClone(JSON.parse(readFileSync(new URL("../ops/staging-edge/staging-edge-inputs.example.json", import.meta.url), "utf8"))),
    edgeWorkerName: "app-usagemonitor-staging" };
  assert.deepEqual(await prepare({ inputs: renamedInputs }), { ok: false, code: "STAGING_EDGE_PRODUCTION_WORKER" });
  assert.equal(ctx.inputs["<inputs.json>"].edgeWorkerName, "app-usagemonitor-staging-edge");
});

test("genesis is worker only, takes no live inputs, and names the edge entry", async () => {
  const genesis = await prepareStagingEdgeDeployment(await base({ mode: "worker", genesis: true }));
  assert.equal(genesis.ok, true);
  assert.equal(genesis.liveMode, null);
  assert.equal(genesis.candidateConfig.env.production.main, "src/edge-entry.ts");
  assert.equal(genesis.candidateConfig.env.production.vars.EDGE_UPSTREAM_MODE, "worker");
  assert.equal(genesis.candidateConfig.env.production.vars.DEPLOYMENT_SOURCE_COMMIT, STAGING_DRY_RUN_SOURCE);
  assert.deepEqual(await prepareStagingEdgeDeployment(await base({ mode: "fenced", genesis: true })),
    { ok: false, code: "STAGING_EDGE_GENESIS_MODE_INVALID" });
  assert.deepEqual(await prepareStagingEdgeDeployment(await base({ mode: "worker", genesis: true, expectedPreviousSourceCommit: "a".repeat(40) })),
    { ok: false, code: "STAGING_EDGE_GENESIS_INPUT_INVALID" });
  assert.deepEqual(await prepareStagingEdgeDeployment(await base({ mode: "worker", genesis: true, readBlob: () => null })),
    { ok: false, code: "EDGE_MODE_ENTRY_UNAVAILABLE" });
});

test("the candidate is written with absolute entry and assets, and the dry run never deploys", async () => {
  const ctx = await context();
  const directory = await outputDirectory();
  const provider = fakeProvider([]);
  const wrangler = fakeSpawn();
  const result = await runStagingEdgeDeployment({
    ...(await base({ mode: "worker", genesis: true })),
    outputDirectory: directory,
    sourceState: () => ({ commit: STAGING_DRY_RUN_SOURCE, clean: false }),
    spawn: wrangler.spawn,
    createProvider: provider.create,
    environment: ENVIRONMENT,
  });
  assert.equal(result.ok, true, result.code);
  assert.equal(result.dryRun, true);
  assert.equal(result.plan.sourceTreeClean, false);
  assert.equal(result.plan.typedSchemaInspection, "not_applicable_staging_json_topology");
  assert.equal(wrangler.calls.length, 0);
  assert.equal(provider.calls.capture, 0);
  const candidate = JSON.parse(await readFile(join(directory, STAGING_EDGE_CANDIDATE_FILE), "utf8"));
  assert.equal(candidate.env.production.main, join(STAGING_EDGE_WORKER_DIRECTORY, "src", "edge-entry.ts"));
  assert.equal(candidate.env.production.assets.directory, ctx.unmarked);
  assert.deepEqual((await readdir(directory)).sort(),
    ["baseline-snapshot.json", "candidate.wrangler.json", "expected-snapshot.json", "plan.json", "target.json"]);
  await assertPrivateAndTokenFree(directory, result);
  const bytes = serializeStagingEdgeCandidate({ candidateConfig: (await prepareStagingEdgeDeployment(await base({ mode: "worker", genesis: true }))).candidateConfig,
    siteDirectory: ctx.unmarked });
  assert.equal(result.plan.candidateConfigSha256, (await import("node:crypto")).createHash("sha256").update(bytes).digest("hex"));
});

test("execute needs the confirmation, a clean source and the dry run's candidate", async () => {
  const run = async (overrides) => runStagingEdgeDeployment({
    ...(await base({ mode: "worker", genesis: true })),
    outputDirectory: await outputDirectory(),
    sourceState: () => ({ commit: STAGING_DRY_RUN_SOURCE, clean: true }),
    spawn: fakeSpawn().spawn,
    createProvider: fakeProvider([]).create,
    environment: ENVIRONMENT,
    ...overrides,
  });
  assert.equal((await run({ execute: true })).code, "STAGING_EDGE_CONFIRMATION_REQUIRED");
  assert.equal((await run({ confirmation: STAGING_EDGE_DEPLOY_CONFIRMATION })).code, "STAGING_EDGE_CONFIRMATION_REQUIRED");
  assert.equal((await run({ execute: true, confirmation: "DEPLOY_PRODUCTION", expectedCandidateSha256: "a".repeat(64) })).code,
    "STAGING_EDGE_CONFIRMATION_REQUIRED");
  const confirmed = { execute: true, confirmation: STAGING_EDGE_DEPLOY_CONFIRMATION, expectedCandidateSha256: "a".repeat(64) };
  assert.equal((await run({ ...confirmed, sourceState: () => ({ commit: STAGING_DRY_RUN_SOURCE, clean: false }) })).code,
    "STAGING_EDGE_SOURCE_DIRTY");
  assert.equal((await run(confirmed)).code, "STAGING_EDGE_SECRETS_FILE_INVALID");
  const secrets = join(await tempDirectory("staging-edge-secrets-"), "secrets.env");
  await writeFile(secrets, `${SECRETS_SENTINEL}\n`, { mode: 0o644 });
  assert.equal((await run({ ...confirmed, secretsFile: secrets })).code, "STAGING_EDGE_SECRETS_FILE_INVALID");
  await chmod(secrets, 0o600);
  assert.equal(await assertPrivateSecretsFile(secrets), secrets);
  assert.equal((await run({ ...confirmed, secretsFile: secrets })).code, "STAGING_EDGE_CANDIDATE_CHANGED");
});

test("an executed genesis deploys the reviewed candidate with the secrets file by path and verifies it", async () => {
  const directory = await outputDirectory();
  const options = { ...(await base({ mode: "worker", genesis: true })), outputDirectory: directory };
  const dry = await runStagingEdgeDeployment({ ...options, sourceState: () => ({ commit: STAGING_DRY_RUN_SOURCE, clean: true }) });
  const secrets = join(await tempDirectory("staging-edge-secrets-"), "secrets.env");
  await writeFile(secrets, `${SECRETS_SENTINEL}\n`, { mode: 0o600 });
  const live = stagingDryRunAdvance(JSON.parse(await readFile(join(directory, "expected-snapshot.json"), "utf8")), ++versions);
  const existing = fakeProvider([stagingEdgeInventoryOf(live)]);
  const second = await outputDirectory();
  const exists = await runStagingEdgeDeployment({
    ...options, outputDirectory: second, execute: true, confirmation: STAGING_EDGE_DEPLOY_CONFIRMATION,
    expectedCandidateSha256: dry.plan.candidateConfigSha256, secretsFile: secrets,
    sourceState: () => ({ commit: STAGING_DRY_RUN_SOURCE, clean: true }), spawn: fakeSpawn().spawn,
    createProvider: existing.create, environment: ENVIRONMENT, checkWorkspacePackages: async () => {},
  });
  assert.equal(exists.code, "STAGING_EDGE_GENESIS_WORKER_EXISTS");

  const provider = fakeProvider([new Error("not found"), stagingEdgeInventoryOf(live)]);
  const wrangler = fakeSpawn();
  const third = await outputDirectory();
  const result = await runStagingEdgeDeployment({
    ...options, outputDirectory: third, execute: true, confirmation: STAGING_EDGE_DEPLOY_CONFIRMATION,
    expectedCandidateSha256: dry.plan.candidateConfigSha256, secretsFile: secrets,
    sourceState: () => ({ commit: STAGING_DRY_RUN_SOURCE, clean: true }), spawn: wrangler.spawn,
    createProvider: provider.create, environment: ENVIRONMENT, checkWorkspacePackages: async () => {},
  });
  assert.equal(result.ok, true, result.code);
  assert.equal(result.outcome, "verified");
  assert.deepEqual(provider.calls.identity, { accountId: options.inputs.accountId, workerName: "app-usagemonitor-staging-edge" });
  assert.equal(wrangler.calls.length, 1);
  const [call] = wrangler.calls;
  assert.deepEqual(call.args, ["deploy", "--config", join(third, STAGING_EDGE_CANDIDATE_FILE), "--env", "production", "--strict",
    "--secrets-file", secrets]);
  assert.deepEqual(Object.keys(call.options.env).sort(), ["CI", "CLOUDFLARE_API_TOKEN", "HOME", "PATH", "WRANGLER_SEND_METRICS"]);
  assert.equal(call.options.cwd, STAGING_EDGE_WORKER_DIRECTORY);
  const operation = JSON.parse(await readFile(join(third, "operation.json"), "utf8"));
  assert.equal(operation.outcome, "verified");
  assert.ok((await readdir(third)).includes("post-deploy-inventory.json"));
  await assertPrivateAndTokenFree(third, result);
});

test("an executed redeploy checks the predecessor before Wrangler and the live version after it", async () => {
  const { worker } = await states();
  const options = {
    ...(await base({ mode: "fenced", stagingInventory: stagingEdgeInventoryOf(worker), expectedPreviousSourceCommit: worker.sourceCommit })),
    sourceState: () => ({ commit: STAGING_DRY_RUN_SOURCE, clean: true }),
    environment: ENVIRONMENT,
    checkWorkspacePackages: async () => {},
  };
  const dryDirectory = await outputDirectory();
  const dry = await runStagingEdgeDeployment({ ...options, outputDirectory: dryDirectory });
  assert.equal(dry.ok, true, dry.code);
  assert.equal(dry.plan.liveMode, "worker");
  assert.equal(dry.plan.identity, "binding");
  const expected = JSON.parse(await readFile(join(dryDirectory, "expected-snapshot.json"), "utf8"));
  const confirmed = { execute: true, confirmation: STAGING_EDGE_DEPLOY_CONFIRMATION, expectedCandidateSha256: dry.plan.candidateConfigSha256 };

  const moved = stagingDryRunAdvance(expected, ++versions);
  const changed = fakeSpawn();
  const refused = await runStagingEdgeDeployment({ ...options, ...confirmed, outputDirectory: await outputDirectory(),
    spawn: changed.spawn, createProvider: fakeProvider([stagingEdgeInventoryOf(moved)]).create });
  assert.equal(refused.code, "STAGING_EDGE_PREDECESSOR_CHANGED");
  assert.equal(changed.calls.length, 0);

  const failing = await runStagingEdgeDeployment({ ...options, ...confirmed, outputDirectory: await outputDirectory(),
    spawn: fakeSpawn(1).spawn, createProvider: fakeProvider([stagingEdgeInventoryOf(worker)]).create });
  assert.equal(failing.code, "STAGING_EDGE_WRANGLER_FAILED");
  assert.equal(failing.outcome, "outcome_unknown");

  const drift = await runStagingEdgeDeployment({ ...options, ...confirmed, outputDirectory: await outputDirectory(),
    spawn: fakeSpawn().spawn, createProvider: fakeProvider([stagingEdgeInventoryOf(worker), stagingEdgeInventoryOf(worker)]).create });
  assert.equal(drift.code, "STAGING_EDGE_LIVE_DRIFT");
  assert.equal(drift.outcome, "deployed_unverified");

  const directory = await outputDirectory();
  const deployed = stagingDryRunAdvance(expected, ++versions);
  const verified = await runStagingEdgeDeployment({ ...options, ...confirmed, outputDirectory: directory,
    spawn: fakeSpawn().spawn, createProvider: fakeProvider([stagingEdgeInventoryOf(worker), stagingEdgeInventoryOf(deployed)]).create });
  assert.equal(verified.ok, true, verified.code);
  await assertPrivateAndTokenFree(directory, verified);
});

test("reconcile reads a captured inventory against the deploy's plan", async () => {
  const { worker } = await states();
  const directory = await outputDirectory();
  const dry = await runStagingEdgeDeployment({
    ...(await base({ mode: "fenced", stagingInventory: stagingEdgeInventoryOf(worker), expectedPreviousSourceCommit: worker.sourceCommit })),
    outputDirectory: directory, sourceState: () => ({ commit: STAGING_DRY_RUN_SOURCE, clean: true }),
  });
  assert.equal(dry.ok, true);
  const expected = JSON.parse(await readFile(join(directory, "expected-snapshot.json"), "utf8"));
  const reconcile = (inventory) => reconcileStagingEdgeDeployment({ operationDirectory: directory, inventory });
  assert.equal((await reconcile(stagingEdgeInventoryOf(worker))).state, "not_deployed");
  const verified = await reconcile(stagingEdgeInventoryOf(stagingDryRunAdvance(expected, ++versions)));
  assert.equal(verified.state, "verified");
  assert.equal(verified.ok, true);
  const other = stagingEdgeInventoryOf(stagingDryRunAdvance(worker, ++versions));
  assert.equal((await reconcile(other)).state, "drift");
  assert.equal((await reconcile(PRODUCTION_INVENTORY)).code, "STAGING_EDGE_INVENTORY_TARGET_MISMATCH");
});

test("Wrangler gets the token only through its environment, never an endpoint override", () => {
  assert.throws(() => stagingWranglerEnvironment({ PATH: "/bin" }), (error) => error.code === "STAGING_EDGE_CREDENTIAL_REQUIRED");
  assert.throws(() => stagingWranglerEnvironment({ ...ENVIRONMENT, CLOUDFLARE_API_BASE_URL: "https://example.invalid" }),
    (error) => error.code === "STAGING_EDGE_ENVIRONMENT_OVERRIDE");
  const env = stagingWranglerEnvironment({ ...ENVIRONMENT, CLOUDFLARE_ACCOUNT_ID: "0".repeat(32), OTHER: "x" });
  assert.deepEqual(Object.keys(env).sort(), ["CI", "CLOUDFLARE_API_TOKEN", "HOME", "PATH", "WRANGLER_SEND_METRICS"]);
});

test("the output directory must be new, private and outside the repository", async () => {
  await assert.rejects(createStagingOutputDirectory(join(STAGING_EDGE_WORKER_DIRECTORY, ".staging-edge-out")),
    (error) => error.code === "STAGING_EDGE_OUTPUT_INSIDE_REPOSITORY");
  const parent = await tempDirectory("staging-edge-parent-");
  const created = await createStagingOutputDirectory(join(parent, "run"));
  assert.equal((await lstat(created)).mode & 0o777, 0o700);
  await assert.rejects(createStagingOutputDirectory(join(parent, "run")));
});

test("the argument parser accepts exactly each subcommand's combinations", () => {
  const hex = (n) => "a".repeat(n);
  const deploy = ["deploy", "--edge-mode", "worker", "--inputs", "i.json", "--production-inventory", "p.json",
    "--production-inventory-sha256", hex(64), "--production-plan-absent", "--site", "site", "--output-directory", "out"];
  const live = ["--inventory", "s.json", "--inventory-sha256", hex(64), "--expected-previous-source", hex(40)];
  const ok = (argv) => assert.equal(parseStagingEdgeArguments(argv).subcommand, argv[0]);
  const bad = (argv) => assert.throws(() => parseStagingEdgeArguments(argv), (error) => error.code === "STAGING_EDGE_ARGUMENTS_INVALID", argv.join(" "));
  ok([...deploy, "--genesis"]);
  ok([...deploy, "--genesis", "--secrets-file", "s.env", "--execute", "--confirm", "DEPLOY_STAGING_EDGE", "--expected-candidate-sha256", hex(64)]);
  ok([...deploy, ...live]);
  ok([...deploy, ...live, "--fence-receipt", "f.json", "--fence-receipt-sha256", hex(64)]);
  ok([...deploy.map((value) => (value === "worker" ? "gcp" : value)), ...live, "--origin-commit", hex(40),
    "--origin-verifier-account", "v@p.iam.gserviceaccount.com", "--candidate-site"]);
  bad([...deploy]);
  bad([...deploy, "--genesis", ...live]);
  bad([...deploy, "--genesis", "--execute", "--confirm", "DEPLOY_STAGING_EDGE", "--expected-candidate-sha256", hex(64)]);
  bad([...deploy, "--genesis", "--secrets-file", "s.env"]);
  bad([...deploy, ...live, "--secrets-file", "s.env"]);
  bad([...deploy, ...live, "--confirm", "DEPLOY_STAGING_EDGE"]);
  bad([...deploy, ...live, "--execute"]);
  bad([...deploy, ...live, "--production-plan", "plan.json"]);
  bad([...deploy, ...live, "--fence-receipt", "f.json"]);
  bad([...deploy.map((value) => (value === "worker" ? "fenced" : value)), ...live, "--fence-receipt", "f.json",
    "--fence-receipt-sha256", hex(64)]);
  bad([...deploy.map((value) => (value === "worker" ? "gcp" : value)), ...live]);
  bad([...deploy, ...live, "--origin-commit", hex(40), "--origin-verifier-account", "v@p.iam.gserviceaccount.com"]);
  bad([...deploy, ...live, "--edge-mode", "fenced"]);
  bad([...deploy, ...live, "--expected-previous-source", "HEAD"]);
  bad([...deploy, ...live, "--env", "production"]);
  bad(["deploy", "--edge-mode", "auto", "--inputs", "i"]);
  bad(["publish"]);
  ok(["render", "--inputs", "i.json"]);
  ok(["render", "--inputs", "i.json", "--write", "--output-directory", "out"]);
  bad(["render", "--inputs", "i.json", "--write"]);
  bad(["render", "--inputs", "i.json", "--execute"]);
  ok(["reconcile", "--operation", "op", "--inventory", "s.json", "--inventory-sha256", hex(64)]);
  ok(["reconcile", "--operation", "op", "--execute"]);
  bad(["reconcile", "--operation", "op"]);
  bad(["reconcile", "--operation", "op", "--execute", "--inventory", "s.json", "--inventory-sha256", hex(64)]);
  ok(["endpoints", "--edge-mode", "fenced", "--inputs", "i.json", "--expected-source", hex(40)]);
  ok(["endpoints", "--edge-mode", "gcp", "--inputs", "i.json", "--expected-source", hex(40), "--origin-commit", hex(40), "--execute"]);
  bad(["endpoints", "--edge-mode", "gcp", "--inputs", "i.json", "--expected-source", hex(40)]);
  ok(["rehearsal"]);
  bad(["rehearsal", "--execute"]);
});

test("every rehearsal command parses and every expected outcome agrees with the matrix", () => {
  const sequence = stagingEdgeRehearsalSequence();
  const sha256Flags = new Set(["--production-inventory-sha256", "--inventory-sha256", "--fence-receipt-sha256",
    "--expected-candidate-sha256"]);
  const shaFlags = new Set(["--expected-previous-source", "--origin-commit"]);
  for (const step of sequence) {
    assert.ok(rehearsalStepAgreesWithMatrix(step), step.id);
    if (step.kind !== "deploy") {
      assert.equal(step.command[2], step.subcommand);
      continue;
    }
    const argv = step.command.slice(step.command.indexOf("--") + 1).map((value, index, list) => {
      if (!value.startsWith("<")) return value;
      if (sha256Flags.has(list[index - 1])) return "b".repeat(64);
      if (shaFlags.has(list[index - 1])) return "c".repeat(40);
      return "/private/synthetic";
    });
    const parsed = parseStagingEdgeArguments(argv);
    assert.equal(parsed.edgeMode, step.to, step.id);
    if (step.expect.ok && step.from !== null) {
      assert.ok(EDGE_MODE_TRANSITIONS.some((entry) => entry.from === step.from && entry.to === step.to), step.id);
    }
  }
  const okModes = sequence.filter((step) => step.kind === "deploy" && step.expect.ok).map((step) => step.to);
  assert.deepEqual(okModes, ["worker", "worker", "fenced", "fenced", "worker", "fenced", "gcp", "gcp", "fenced", "gcp", "fenced"]);
  assert.equal(sequence.at(-1).to, "fenced");
});

test("the endpoint matrix follows the mode table and is read without credentials", async () => {
  const { inputs } = await context();
  const target = inputs["<inputs.json>"];
  const source = "d".repeat(40);
  const fenced = stagingEdgeEndpointMatrix({ mode: "fenced", inputs: target, expectedSourceCommit: source });
  assert.equal(fenced.origin, `https://${target.publicHostname}`);
  assert.ok(fenced.checks.some((check) => check.id === "ready" && check.expect.status === 503));
  assert.ok(fenced.checks.every((check) => new URL(check.url).hostname.endsWith(target.publicHostname)));
  assert.equal(fenced.checks.find((check) => check.id === "admin-access").expect.locationHost, target.access.teamDomain);
  assert.throws(() => stagingEdgeEndpointMatrix({ mode: "gcp", inputs: target, expectedSourceCommit: source }));
  const worker = stagingEdgeEndpointMatrix({ mode: "worker", inputs: target, expectedSourceCommit: source });
  assert.equal(worker.checks.some((check) => check.id === "ready"), false);

  const requests = [];
  const respond = (status, body, headers) => ({ status, url: null, headers: new Headers(headers), text: async () => body });
  const secure = { "content-type": "application/json", "cache-control": "no-store", "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff" };
  const fetchImpl = async (url, init) => {
    requests.push({ url, init });
    const path = new URL(url).pathname;
    const host = new URL(url).hostname;
    let response;
    if (host.startsWith("admin.")) {
      response = respond(302, "", { location: `https://${target.access.teamDomain}/cdn-cgi/access/login/${host}` });
    } else if (path === "/api/health") {
      response = respond(200, JSON.stringify({ status: "ok", mode: "migration-mutation-barrier",
        maintenance: { state: "fenced", storageQualified: false }, deployment: { sourceCommit: source } }), secure);
    } else if (path === "/release-site-manifest.json") {
      response = respond(200, "{}", { "content-type": "application/json" });
    } else if (path === "/") {
      response = respond(200, "<!doctype html><title>site</title>", { "content-type": "text/html" });
    } else if (path === "/api/ready" || edgeModeForbiddenPathClass(path) !== "public-asset") {
      response = respond(503, JSON.stringify({ error: { code: "MUTATION_BARRIER_ACTIVE" } }),
        { "content-type": "application/json", "cache-control": "no-store", "retry-after": "300" });
    } else {
      response = respond(404, "", {});
    }
    response.url = url;
    return response;
  };
  const result = await verifyStagingEdgeEndpoints({ mode: "fenced", inputs: target, expectedSourceCommit: source, fetchImpl });
  assert.equal(result.ok, true, JSON.stringify(result.checks.filter((check) => !check.ok)));
  assert.ok(requests.every((request) => request.init.method === "GET" && request.init.credentials === "omit"
    && request.init.headers?.authorization === undefined));
  const wrong = await verifyStagingEdgeEndpoints({ mode: "worker", inputs: target, expectedSourceCommit: source, fetchImpl });
  assert.equal(wrong.ok, false);
});

test("the edge health recheck takes a staging origin and refuses a non-canonical one", async () => {
  const seen = [];
  const fetchImpl = async (url) => { seen.push(url); throw new Error("offline"); };
  const staging = await recheckProductionEdgeHealth({ fetchImpl, mode: "worker", expectedSourceCommit: "a".repeat(40),
    origin: "https://staging.synthetic-edge.example" });
  assert.equal(staging.code, "PRODUCTION_EDGE_HEALTH_UNREACHABLE");
  assert.deepEqual(seen, ["https://staging.synthetic-edge.example/api/health"]);
  for (const origin of ["http://staging.synthetic-edge.example", "https://staging.synthetic-edge.example/path", "not a url"]) {
    assert.equal((await recheckProductionEdgeHealth({ fetchImpl, mode: "worker", expectedSourceCommit: "a".repeat(40), origin })).code,
      "PRODUCTION_EDGE_HEALTH_INPUT_INVALID", origin);
  }
});
