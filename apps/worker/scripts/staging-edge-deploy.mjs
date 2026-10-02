#!/usr/bin/env node
// Typed staging-edge deploy, reconcile and endpoint driver (STG-DRV).
//
// It drives the staging edge Worker (its own name, hostnames, Access app and
// release-guard D1; design/staging-edge-plan-2026-10-02.md in the parity home)
// through worker, fenced and gcp with E10's own gates: production-edge-mode.mjs
// prepareEdgeModeDeployment runs with EP-9's staging overlay bound to the
// production isolation inputs, so the transition matrix, the fence-history
// abort rule, source descent, the entry and contract blobs, the six edge-tier
// bindings, the edge secrets, the pre-gcp origin verifier, the contract-blob
// identity, the release-guard migration gate and the privacy-marker rule are
// the production code paths, aimed at the staging Worker.
//
// Every subcommand is a dry run unless --execute is given:
//   render     the committed template, stand-in, migration configs, EP-8 fence
//              plan and gcp plan from the owner's private non-secret inputs
//              (--write writes them into a new private directory);
//   deploy     every pre-upload gate, then the candidate config and a
//              content-free plan in a new private directory; --execute
//              --confirm DEPLOY_STAGING_EDGE then deploys it with Wrangler and
//              verifies the captured live version;
//   reconcile  compares a captured staging inventory with a deploy's plan
//              (--execute captures it read-only instead);
//   endpoints  the per-mode public-surface matrix (--execute reads it);
//   rehearsal  the R1/R2 sequence with each step's expected outcome.
//
// It refuses any production Worker name, hostname, D1, bucket or rate-limit
// namespace, and any staging inventory that is not the staging Worker's. It
// never reads a secret: CLOUDFLARE_API_TOKEN is passed to the read-only
// provider and to Wrangler and never printed, and the genesis secrets file is
// checked by metadata only and handed to Wrangler by path.

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readFile, realpath, rename } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { parseEdgeUpstreamMode } from "../src/edge-origin-contract.ts";
import {
  EDGE_MODE_FORBIDDEN_PATH_EXPECTATIONS,
  edgeModeForbiddenPathClass,
} from "./check-deployment-endpoints.mjs";
import { checkLocalWorkspacePackages } from "./check-local-workspace-packages.mjs";
import {
  EDGE_MODE_TRANSITIONS,
  assertEdgeModeTransition,
  serializeEdgeModeConfig,
  verifyEdgeModeLiveSnapshot,
} from "./edge-mode-configuration.mjs";
import {
  PRODUCTION_PUBLIC_SURFACE_FORBIDDEN_PATHS,
  determinePendingD1Migrations,
  recheckProductionEdgeHealth,
} from "./production-deploy.mjs";
import {
  EDGE_ENTRY_PATH,
  EDGE_MODE_RELEASE_GUARD_DATABASE,
  EDGE_ORIGIN_CONTRACT_PATH,
  assertEdgePrivacyPage,
  createEdgeModeConfigTools,
  createFenceHistorySource,
  createGcloudIdentityTokenSource,
  gitIsAncestor,
  prepareEdgeModeDeployment,
  readEdgeModePlan,
  readGitBlob,
  resolveEdgeModeRequest,
} from "./production-edge-mode.mjs";
import {
  createProductionLiveConfigSnapshot,
  renderProductionLiveConfig,
  verifyProductionLiveConfig,
} from "./production-live-config.mjs";
import { createProductionLiveProvider } from "./production-live-provider.mjs";
import { readMaintenanceFile } from "./production-maintenance.mjs";
import {
  createPrivateReconciliationOutputDirectory,
  readPrivateProductionInventory,
} from "./production-reconcile.mjs";
import {
  STAGING_EDGE_WORKER_DIRECTORY,
  assertStagingEdgeTarget,
  buildStagingFencePlan,
  buildStagingGcpPlan,
  createStagingEdgeOverlay,
  createStagingGenesisSnapshot,
  parseStagingEdgeInputs,
  readStagingEdgeTemplate,
  readStagingEdgeTrackedConfigs,
  renderStagingEdgeTemplate,
  resolveStagingEdgeInputs,
  stagingEdgeInputsSha256,
} from "./staging-edge-target.mjs";

export const STAGING_EDGE_DEPLOY_CONFIRMATION = "DEPLOY_STAGING_EDGE";
export const STAGING_EDGE_PLAN_SCHEMA = "staging-edge-deploy-plan-v1";
export const STAGING_EDGE_RECEIPT_SCHEMA = "staging-edge-deploy-receipt-v1";
export const STAGING_EDGE_OPERATION_SCHEMA = "staging-edge-deploy-operation-v1";
export const STAGING_EDGE_RECONCILE_SCHEMA = "staging-edge-reconcile-v1";
export const STAGING_EDGE_RENDER_SCHEMA = "staging-edge-render-v1";
export const STAGING_EDGE_CANDIDATE_FILE = "candidate.wrangler.json";
/** U-4: the staging edge runs JSON storage, so E10's typed schema inspection does not apply. */
export const STAGING_EDGE_TYPED_SCHEMA_INSPECTION = "not_applicable_staging_json_topology";
const SHA = /^[0-9a-f]{40}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const CODE = /^(?:STAGING_EDGE|EDGE|PRODUCTION_LIVE|PRODUCTION_TYPED|PRODUCTION_RECONCILE|PRODUCTION_MIGRATION|PRODUCTION_EDGE_HEALTH|FENCE|RELEASE_OPERATION|MAINTENANCE)_[A-Z0-9_]+$/u;
const SITE_MANIFEST = "release-site-manifest.json";
const SITE_MANIFEST_MAX_BYTES = 512 * 1024;
const WRANGLER_ENVIRONMENT_OVERRIDES = Object.freeze(["CLOUDFLARE_API_BASE_URL", "CF_API_BASE_URL",
  "WRANGLER_API_ENVIRONMENT", "CLOUDFLARE_ENV"]);

const typedTools = Object.freeze({
  createSnapshot: createProductionLiveConfigSnapshot,
  render: renderProductionLiveConfig,
  verify: verifyProductionLiveConfig,
});

function fail(code) {
  throw Object.assign(new Error(code), { code });
}

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stagingCode(error, fallback) {
  return typeof error?.code === "string" && CODE.test(error.code) ? error.code : fallback;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function canonicalProduction(inventory, code = "STAGING_EDGE_PRODUCTION_INPUT_INVALID") {
  try {
    return createProductionLiveConfigSnapshot(inventory);
  } catch {
    return fail(code);
  }
}

/** E10's typed schema inspector is never called for the JSON-topology staging Worker (U-4). */
async function stagingTypedInspection() {
  return { ok: true, code: STAGING_EDGE_TYPED_SCHEMA_INSPECTION, roles: [] };
}

/**
 * The first deploy has no live predecessor: no inventory, no source to
 * descend from and no fence. It runs every gate that does not need one (the
 * request, null -> worker, the entry and contract blobs, the staging overlay
 * and its isolation guard on the declared genesis snapshot). The first typed
 * worker -> worker redeploy (R1 step 1) then runs every E10 gate.
 */
function prepareGenesis({ mode, target, rendered, trackedConfig, overlay, sourceCommit, readBlob }) {
  if (mode !== "worker") fail("STAGING_EDGE_GENESIS_MODE_INVALID");
  const { plan, overlaySha256 } = resolveEdgeModeRequest({ edgeMode: "worker" });
  assertEdgeModeTransition({ liveMode: null, targetMode: "worker" });
  if (!SHA.test(sourceCommit ?? "") || typeof readBlob !== "function") fail("EDGE_MODE_INPUT_INVALID");
  if (readBlob(sourceCommit, EDGE_ENTRY_PATH) === null) fail("EDGE_MODE_ENTRY_UNAVAILABLE");
  const contractBlobSha = readBlob(sourceCommit, EDGE_ORIGIN_CONTRACT_PATH);
  if (contractBlobSha === null) fail("EDGE_CONTRACT_UNAVAILABLE");
  const baseline = createStagingGenesisSnapshot({ edgeTracked: rendered.edgeTracked, inputs: target });
  const expected = overlay.expected({ snapshot: baseline, mode, plan, trackedConfig });
  return {
    ok: true,
    code: null,
    mode,
    liveMode: null,
    gcpEra: false,
    identity: "health",
    originCommit: null,
    baseline,
    expected,
    receipt: Object.freeze({
      edgeMode: mode, liveMode: null, edgeOverlaySha256: overlaySha256, contractBlobSha, originCommit: null,
    }),
    configTools: createEdgeModeConfigTools({
      mode, plan, trackedConfig, base: typedTools, overlay, renderTrackedConfig: rendered.edgeTracked,
    }),
  };
}

/**
 * Every pre-upload gate of a staging edge deploy, offline except for the
 * injected readers (origin verifier and token for gcp, fence history for the
 * abort). Returns the candidate config (it carries staging identifiers: keep
 * it private), the baseline and expected snapshots, and the content-free
 * receipt fields.
 *
 * `trackedConfigs[0]` is the checked-in wrangler.jsonc. `productionPlan` is
 * the production gcp plan or an explicit null (EP-9); undefined is refused.
 */
export async function prepareStagingEdgeDeployment({
  mode,
  genesis = false,
  inputs,
  template,
  trackedConfigs,
  productionInventory,
  productionBaselineInventory,
  productionPlan,
  stagingInventory,
  expectedPreviousSourceCommit = null,
  workerDirectory = STAGING_EDGE_WORKER_DIRECTORY,
  sourceCommit,
  siteDirectory,
  candidatePublicManifestSha256 = null,
  originCommit,
  obtainOriginIdentityToken,
  edgeHistory,
  fetchImpl = globalThis.fetch,
  readBlob = (commit, path) => readGitBlob({ repositoryDirectory: workerDirectory, commit, path }),
  isAncestor = (previous, candidate) => gitIsAncestor({ repositoryDirectory: workerDirectory, previous, candidate }),
  verifyOrigin,
} = {}) {
  try {
    const edgeMode = parseEdgeUpstreamMode(mode);
    if (edgeMode === null) fail("EDGE_MODE_INVALID");
    if (typeof genesis !== "boolean" || !Array.isArray(trackedConfigs) || trackedConfigs.length === 0
        || typeof siteDirectory !== "string") {
      fail("STAGING_EDGE_INPUT_INVALID");
    }
    if (productionPlan === undefined) fail("STAGING_EDGE_PRODUCTION_INPUT_INVALID");
    const productionSnapshot = canonicalProduction(productionInventory);
    const productionBaselineSnapshot = productionBaselineInventory === undefined
      ? undefined
      : canonicalProduction(productionBaselineInventory);
    const target = assertStagingEdgeTarget({
      inputs,
      template,
      trackedConfigs,
      productionSnapshots: [productionSnapshot, ...(productionBaselineSnapshot ? [productionBaselineSnapshot] : [])],
      productionPlan,
    });
    const rendered = renderStagingEdgeTemplate({ template, inputs: target, workerDirectory });
    const trackedConfig = trackedConfigs[0];
    const overlay = createStagingEdgeOverlay({
      productionSnapshot,
      productionBaselineSnapshot,
      productionPlan,
      expectedDomains: [target.publicHostname, target.adminHostname],
    });
    const gcp = edgeMode === "gcp" ? buildStagingGcpPlan(target) : null;
    let prepared;
    if (genesis) {
      if (stagingInventory !== undefined || expectedPreviousSourceCommit !== null || edgeHistory !== undefined
          || originCommit !== undefined) {
        fail("STAGING_EDGE_GENESIS_INPUT_INVALID");
      }
      prepared = prepareGenesis({ mode: edgeMode, target, rendered, trackedConfig, overlay, sourceCommit, readBlob });
    } else {
      if (!object(stagingInventory) || stagingInventory.workerName !== target.edgeWorkerName
          || stagingInventory.accountId !== target.accountId) {
        fail("STAGING_EDGE_INVENTORY_TARGET_MISMATCH");
      }
      prepared = await prepareEdgeModeDeployment({
        edgeMode,
        edgePlan: gcp?.plan,
        originCommit,
        inventory: stagingInventory,
        baseConfigTools: typedTools,
        inspectTyped: stagingTypedInspection,
        workerDirectory,
        sourceCommit,
        expectedPreviousSourceCommit,
        candidatePublicManifestSha256,
        edgeHistory,
        obtainOriginIdentityToken,
        fetchImpl,
        readBlob,
        isAncestor,
        ...(verifyOrigin === undefined ? {} : { verifyOrigin }),
        overlay,
        renderTrackedConfig: rendered.edgeTracked,
      });
      if (!prepared.ok) return { ok: false, code: prepared.code };
    }
    const candidateConfig = prepared.configTools.render({
      trackedConfig: rendered.edgeTracked,
      snapshot: prepared.baseline,
      sourceCommit,
    });
    const verification = typedTools.verify({ snapshot: prepared.expected, candidateConfig, sourceCommit });
    if (!verification.ok) return { ok: false, code: verification.code ?? "STAGING_EDGE_CANDIDATE_UNVERIFIED" };
    const page = await assertEdgePrivacyPage({
      mode: edgeMode,
      siteDirectory,
      candidateSite: candidatePublicManifestSha256 !== null,
      gcpEra: prepared.gcpEra,
    });
    if (!page.ok) return { ok: false, code: page.code };
    return {
      ok: true,
      code: null,
      target,
      genesis,
      mode: edgeMode,
      liveMode: prepared.liveMode,
      identity: prepared.identity,
      gcpEra: prepared.gcpEra,
      originCommit: prepared.originCommit,
      baseline: prepared.baseline,
      expected: prepared.expected,
      candidateConfig,
      edgePlan: gcp?.plan ?? null,
      receipt: prepared.receipt,
      expectedDomains: overlay.expectedDomains,
    };
  } catch (error) {
    return { ok: false, code: stagingCode(error, "STAGING_EDGE_PREPARATION_FAILED") };
  }
}

/**
 * The bytes Wrangler deploys: the candidate with its entry, assets and
 * migration directories made absolute, so the private file works from outside
 * the repository. verifyProductionLiveConfig does not compare these paths.
 */
export function serializeStagingEdgeCandidate({ candidateConfig, workerDirectory = STAGING_EDGE_WORKER_DIRECTORY, siteDirectory }) {
  const value = structuredClone(candidateConfig);
  const environment = value.env?.production;
  if (!object(environment) || typeof siteDirectory !== "string") fail("STAGING_EDGE_CANDIDATE_INVALID");
  for (const config of [value, environment]) {
    if (typeof config.main === "string" && !isAbsolute(config.main)) config.main = join(workerDirectory, config.main);
  }
  environment.assets = { ...environment.assets, directory: resolve(siteDirectory) };
  for (const database of environment.d1_databases ?? []) {
    if (typeof database.migrations_dir === "string") database.migrations_dir = join(workerDirectory, database.migrations_dir);
  }
  return serializeEdgeModeConfig(value);
}

/** The content-free deploy plan: modes, digests, commits and the exact Wrangler command shape. */
export function stagingEdgeDeployPlan({ prepared, sourceCommit, expectedPreviousSourceCommit, stagingInventorySha256,
  candidateSha256, candidatePublicManifestSha256, sourceTreeClean, releaseGuardPendingMigrations }) {
  return {
    schema: STAGING_EDGE_PLAN_SCHEMA,
    target: "staging",
    genesis: prepared.genesis,
    edgeMode: prepared.mode,
    liveMode: prepared.liveMode,
    identity: prepared.identity,
    edgeOverlaySha256: prepared.receipt.edgeOverlaySha256,
    contractBlobSha: prepared.receipt.contractBlobSha,
    originCommit: prepared.originCommit,
    sourceCommit,
    sourceTreeClean,
    expectedPreviousSourceCommit,
    stagingInventorySha256,
    inputsSha256: stagingEdgeInputsSha256(prepared.target),
    baselineLiveConfigurationFingerprint: prepared.baseline.fingerprint,
    expectedLiveConfigurationFingerprint: prepared.expected.fingerprint,
    candidateConfigSha256: candidateSha256,
    candidatePublicManifestSha256,
    typedSchemaInspection: STAGING_EDGE_TYPED_SCHEMA_INSPECTION,
    releaseGuardPendingMigrations,
    wrangler: ["deploy", "--config", `<output-directory>/${STAGING_EDGE_CANDIDATE_FILE}`, "--env", "production", "--strict",
      ...(prepared.genesis ? ["--secrets-file", "<owner-private secrets file>"] : [])],
  };
}

async function writePrivateFile(directory, name, bytes) {
  const handle = await open(join(directory, name),
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writePrivateJson(directory, name, value) {
  await writePrivateFile(directory, name, `${JSON.stringify(value, null, 2)}\n`);
}

async function replacePrivateJson(directory, name, value) {
  const temporary = `.${name}.${process.pid}.${Date.now()}`;
  await writePrivateJson(directory, temporary, value);
  await rename(join(directory, temporary), join(directory, name));
}

/** The genesis secrets file, by metadata only: a regular 0600 file of the caller's, never read. */
export async function assertPrivateSecretsFile(path) {
  let info;
  try {
    info = await lstat(path);
  } catch {
    return fail("STAGING_EDGE_SECRETS_FILE_INVALID");
  }
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size < 1 || info.size > 32 * 1024
      || (info.mode & 0o777) !== 0o600 || (typeof process.getuid === "function" && info.uid !== process.getuid())) {
    fail("STAGING_EDGE_SECRETS_FILE_INVALID");
  }
  return resolve(path);
}

/** Wrangler's environment for an executed deploy: PATH, HOME and the API token, no endpoint override. */
export function stagingWranglerEnvironment(env = process.env) {
  if (WRANGLER_ENVIRONMENT_OVERRIDES.some((key) => Object.hasOwn(env, key))) fail("STAGING_EDGE_ENVIRONMENT_OVERRIDE");
  if (typeof env.CLOUDFLARE_API_TOKEN !== "string" || env.CLOUDFLARE_API_TOKEN.length < 16) {
    fail("STAGING_EDGE_CREDENTIAL_REQUIRED");
  }
  return {
    PATH: env.PATH ?? "",
    HOME: env.HOME ?? "",
    CLOUDFLARE_API_TOKEN: env.CLOUDFLARE_API_TOKEN,
    WRANGLER_SEND_METRICS: "false",
    CI: "1",
  };
}

function singleVersion(snapshot) {
  return { versions: [{ version_id: snapshot.versionId, percentage: 100 }] };
}

/**
 * Whether a captured live snapshot is the deployed candidate: the expected
 * snapshot's fingerprint (a genesis deploy, whose namespace ids are new,
 * compares the candidate config with the live version instead), a new version,
 * and EP-9's live check for the mode with the staging domains.
 */
export function verifyStagingEdgeLive({ live, plan, expected, candidateConfig, expectedDomains, baselineVersionId }) {
  if (plan.genesis) {
    const config = verifyProductionLiveConfig({ snapshot: live, candidateConfig, sourceCommit: plan.sourceCommit });
    if (!config.ok) return { ok: false, code: config.code ?? "STAGING_EDGE_LIVE_DRIFT" };
  } else if (live.fingerprint !== expected.fingerprint) {
    return { ok: false, code: "STAGING_EDGE_LIVE_DRIFT" };
  }
  if (live.versionId === baselineVersionId) return { ok: false, code: "STAGING_EDGE_VERSION_UNCHANGED" };
  return verifyEdgeModeLiveSnapshot({
    snapshot: live,
    mode: plan.edgeMode,
    deployment: singleVersion(live),
    sourceCommit: plan.sourceCommit,
    expectedDomains,
  });
}

function defaultSourceState(workerDirectory) {
  const repository = resolve(workerDirectory, "..", "..");
  const git = (args) => execFileSync("/usr/bin/git", ["-C", repository, ...args],
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 4 * 1024 * 1024 }).trim();
  try {
    return { commit: git(["rev-parse", "HEAD"]), clean: git(["status", "--porcelain", "--untracked-files=all"]) === "" };
  } catch {
    return { commit: null, clean: false };
  }
}

/**
 * Prepare, write the candidate and the plan, and (only with execute and the
 * confirmation) deploy it and verify the live version. `outputDirectory` is a
 * new owner-private directory. Remote reads (origin verifier, fence history,
 * release-guard ledger) run in the dry run too; remote writes never do.
 */
export async function runStagingEdgeDeployment({
  execute = false,
  confirmation,
  expectedCandidateSha256,
  outputDirectory,
  secretsFile,
  stagingInventorySha256 = null,
  wrangler = join(STAGING_EDGE_WORKER_DIRECTORY, "node_modules", ".bin", "wrangler"),
  spawn = spawnSync,
  sourceState = defaultSourceState,
  pendingD1Migrations = determinePendingD1Migrations,
  checkWorkspacePackages = checkLocalWorkspacePackages,
  createProvider = createProductionLiveProvider,
  environment = process.env,
  ...prepareOptions
} = {}) {
  if (execute !== true && execute !== false) return { ok: false, code: "STAGING_EDGE_INPUT_INVALID" };
  if (execute ? confirmation !== STAGING_EDGE_DEPLOY_CONFIRMATION : confirmation !== undefined) {
    return { ok: false, code: "STAGING_EDGE_CONFIRMATION_REQUIRED" };
  }
  if (execute && !SHA256.test(expectedCandidateSha256 ?? "")) return { ok: false, code: "STAGING_EDGE_INPUT_INVALID" };
  const workerDirectory = prepareOptions.workerDirectory ?? STAGING_EDGE_WORKER_DIRECTORY;
  const source = sourceState(workerDirectory);
  if (!SHA.test(source?.commit ?? "")) return { ok: false, code: "STAGING_EDGE_SOURCE_UNAVAILABLE" };
  if (execute && source.clean !== true) return { ok: false, code: "STAGING_EDGE_SOURCE_DIRTY" };
  if (execute && prepareOptions.genesis === true) {
    try {
      secretsFile = await assertPrivateSecretsFile(secretsFile);
    } catch (error) {
      return { ok: false, code: stagingCode(error, "STAGING_EDGE_SECRETS_FILE_INVALID") };
    }
  } else if (secretsFile !== undefined) {
    return { ok: false, code: "STAGING_EDGE_INPUT_INVALID" };
  }
  const prepared = await prepareStagingEdgeDeployment({ ...prepareOptions, workerDirectory, sourceCommit: source.commit });
  if (!prepared.ok) return prepared;

  try {
    const candidateBytes = serializeStagingEdgeCandidate({
      candidateConfig: prepared.candidateConfig, workerDirectory, siteDirectory: prepareOptions.siteDirectory,
    });
    const candidateSha256 = sha256(candidateBytes);
    await writePrivateFile(outputDirectory, STAGING_EDGE_CANDIDATE_FILE, candidateBytes);
    const candidatePath = join(outputDirectory, STAGING_EDGE_CANDIDATE_FILE);
    let releaseGuardPendingMigrations = null;
    if (prepared.mode === "gcp") {
      const guard = await pendingD1Migrations({
        wrangler, workerDirectory, configPath: candidatePath, environment: "production",
        databases: [EDGE_MODE_RELEASE_GUARD_DATABASE], spawn,
      });
      if (!guard?.ok || !Array.isArray(guard.pending)) {
        return { ok: false, code: typeof guard?.code === "string" && CODE.test(guard.code) ? guard.code : "PRODUCTION_MIGRATION_STATE_UNKNOWN" };
      }
      if (guard.pending.length > 0) return { ok: false, code: "EDGE_MODE_RELEASE_GUARD_MIGRATIONS_PENDING" };
      releaseGuardPendingMigrations = 0;
    }
    const plan = stagingEdgeDeployPlan({
      prepared,
      sourceCommit: source.commit,
      expectedPreviousSourceCommit: prepareOptions.expectedPreviousSourceCommit ?? null,
      stagingInventorySha256,
      candidateSha256,
      candidatePublicManifestSha256: prepareOptions.candidatePublicManifestSha256 ?? null,
      sourceTreeClean: source.clean === true,
      releaseGuardPendingMigrations,
    });
    await writePrivateJson(outputDirectory, "plan.json", plan);
    await writePrivateJson(outputDirectory, "baseline-snapshot.json", prepared.baseline);
    await writePrivateJson(outputDirectory, "expected-snapshot.json", prepared.expected);
    await writePrivateJson(outputDirectory, "target.json", {
      accountId: prepared.target.accountId,
      edgeWorkerName: prepared.target.edgeWorkerName,
      expectedDomains: prepared.expectedDomains,
    });
    if (!execute) return { ok: true, code: null, dryRun: true, plan };

    if (candidateSha256 !== expectedCandidateSha256) return { ok: false, code: "STAGING_EDGE_CANDIDATE_CHANGED", plan };
    try {
      await checkWorkspacePackages();
    } catch {
      return { ok: false, code: "STAGING_EDGE_WORKSPACE_PACKAGES_STALE", plan };
    }
    const wranglerEnvironment = stagingWranglerEnvironment(environment);
    const provider = createProvider({
      accountId: prepared.target.accountId, workerName: prepared.target.edgeWorkerName, environment,
    });
    if (prepared.genesis) {
      let exists = true;
      try {
        await provider.capture();
      } catch {
        exists = false;
      }
      if (exists) return { ok: false, code: "STAGING_EDGE_GENESIS_WORKER_EXISTS", plan };
    } else {
      const current = createProductionLiveConfigSnapshot(await provider.capture());
      if (current.fingerprint !== prepared.baseline.fingerprint || current.versionId !== prepared.baseline.versionId
          || current.sourceCommit !== prepared.baseline.sourceCommit) {
        return { ok: false, code: "STAGING_EDGE_PREDECESSOR_CHANGED", plan };
      }
    }
    const operation = { schema: STAGING_EDGE_OPERATION_SCHEMA, planCandidateSha256: candidateSha256,
      stage: "deploy", outcome: "outcome_unknown", code: null };
    await writePrivateJson(outputDirectory, "operation.json", operation);
    const deployment = spawn(wrangler, ["deploy", "--config", candidatePath, "--env", "production", "--strict",
      ...(prepared.genesis ? ["--secrets-file", secretsFile] : [])], {
      cwd: workerDirectory, env: wranglerEnvironment, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 16 * 1024 * 1024,
    });
    const after = sourceState(workerDirectory);
    let result;
    if (deployment?.error || deployment?.status !== 0) {
      result = { ok: false, code: "STAGING_EDGE_WRANGLER_FAILED" };
    } else if (after?.commit !== source.commit || after?.clean !== true) {
      result = { ok: false, code: "STAGING_EDGE_SOURCE_CHANGED" };
    } else {
      const inventory = await provider.capture();
      const live = createProductionLiveConfigSnapshot(inventory);
      const inventoryBytes = `${JSON.stringify(inventory, null, 2)}\n`;
      await writePrivateFile(outputDirectory, "post-deploy-inventory.json", inventoryBytes);
      const verified = verifyStagingEdgeLive({
        live, plan, expected: prepared.expected, candidateConfig: prepared.candidateConfig,
        expectedDomains: prepared.expectedDomains, baselineVersionId: prepared.baseline.versionId,
      });
      result = {
        ok: verified.ok === true,
        code: verified.ok === true ? null : verified.code,
        postDeployInventorySha256: sha256(inventoryBytes),
        liveVersionIdSha256: sha256(live.versionId),
        warnings: verified.warnings ?? [],
      };
    }
    const receipt = {
      schema: STAGING_EDGE_RECEIPT_SCHEMA,
      outcome: result.ok ? "verified" : (deployment?.status === 0 ? "deployed_unverified" : "outcome_unknown"),
      ...result,
      plan,
    };
    await writePrivateJson(outputDirectory, "receipt.json", receipt);
    await replacePrivateJson(outputDirectory, "operation.json", { ...operation, stage: result.ok ? "verified" : "failed",
      outcome: receipt.outcome, code: result.code });
    return { ...receipt, ok: result.ok, code: result.code };
  } catch (error) {
    return { ok: false, code: stagingCode(error, "STAGING_EDGE_DEPLOYMENT_FAILED") };
  }
}

async function readOperationJson(directory, name) {
  try {
    return JSON.parse((await readMaintenanceFile(join(directory, name), 4 * 1024 * 1024)).toString("utf8"));
  } catch {
    return fail("STAGING_EDGE_OPERATION_UNREADABLE");
  }
}

/**
 * Compare a captured staging inventory with a deploy's private plan:
 * `verified` when the live version is the deployed candidate, `not_deployed`
 * when the baseline version is still live, `drift` otherwise. Read-only.
 */
export async function reconcileStagingEdgeDeployment({ operationDirectory, inventory } = {}) {
  try {
    const plan = await readOperationJson(operationDirectory, "plan.json");
    const expected = await readOperationJson(operationDirectory, "expected-snapshot.json");
    const baseline = await readOperationJson(operationDirectory, "baseline-snapshot.json");
    const target = await readOperationJson(operationDirectory, "target.json");
    const candidateConfig = await readOperationJson(operationDirectory, STAGING_EDGE_CANDIDATE_FILE);
    if (plan?.schema !== STAGING_EDGE_PLAN_SCHEMA || !object(inventory)
        || inventory.workerName !== target.edgeWorkerName || inventory.accountId !== target.accountId) {
      fail("STAGING_EDGE_INVENTORY_TARGET_MISMATCH");
    }
    const live = createProductionLiveConfigSnapshot(inventory);
    let state;
    let code = null;
    if (!plan.genesis && live.versionId === baseline.versionId && live.fingerprint === baseline.fingerprint) {
      state = "not_deployed";
    } else {
      const verified = verifyStagingEdgeLive({
        live, plan, expected, candidateConfig, expectedDomains: target.expectedDomains,
        baselineVersionId: baseline.versionId,
      });
      state = verified.ok ? "verified" : "drift";
      code = verified.ok ? null : verified.code;
    }
    return {
      ok: state === "verified",
      code,
      schema: STAGING_EDGE_RECONCILE_SCHEMA,
      state,
      edgeMode: plan.edgeMode,
      expectedLiveConfigurationFingerprint: plan.expectedLiveConfigurationFingerprint,
      liveConfigurationFingerprint: live.fingerprint,
    };
  } catch (error) {
    return { ok: false, code: stagingCode(error, "STAGING_EDGE_RECONCILE_FAILED") };
  }
}

// ---------------------------------------------------------------------------
// Endpoints

/**
 * The staging public surface per mode (plan section 6 and the Access table in
 * 4.3). Health is checked with E10's own edge health rule; the forbidden
 * paths follow check-deployment-endpoints.mjs's mode table; the admin host
 * must redirect an unauthenticated request to the Access team domain in every
 * mode (N10). The staging Worker has no www host, so the www redirect is not
 * part of it.
 */
export function stagingEdgeEndpointMatrix({ mode, inputs, expectedSourceCommit, originCommit = null } = {}) {
  const target = resolveStagingEdgeInputs(inputs);
  if (parseEdgeUpstreamMode(mode) === null || !SHA.test(expectedSourceCommit ?? "")
      || (mode === "gcp" ? !SHA.test(originCommit ?? "") : originCommit !== null)) {
    fail("STAGING_EDGE_INPUT_INVALID");
  }
  const origin = `https://${target.publicHostname}`;
  const checks = [
    { id: "health", url: `${origin}/api/health`,
      expect: { status: 200, mode, sourceCommit: mode === "gcp" ? originCommit : expectedSourceCommit,
        barrier: mode === "fenced" } },
    { id: "release-manifest", url: `${origin}/release-site-manifest.json`,
      expect: { status: 200, contentType: "application/json" } },
    { id: "root", url: `${origin}/`, expect: { status: 200, contentType: "text/html", dashboardMarkers: false } },
    ...(mode === "fenced"
      ? [{ id: "ready", url: `${origin}/api/ready`, expect: EDGE_MODE_FORBIDDEN_PATH_EXPECTATIONS.api.fenced }]
      : []),
    ...PRODUCTION_PUBLIC_SURFACE_FORBIDDEN_PATHS.map((path) => ({
      id: `forbidden:${path}`,
      url: `${origin}${path}`,
      expect: EDGE_MODE_FORBIDDEN_PATH_EXPECTATIONS[edgeModeForbiddenPathClass(path)][mode],
    })),
    { id: "admin-access", url: `https://${target.adminHostname}/`,
      expect: { status: 302, locationHost: target.access.teamDomain } },
  ];
  return { origin, checks };
}

const DASHBOARD_MARKERS = Object.freeze(['src="./app.js"', 'id="share-panel"', 'id="identity-google-signin"',
  'id="contribution-cta"', 'id="blind-spot-list"']);

async function boundedText(response, max = 1024 * 1024) {
  if (typeof response?.text !== "function") return null;
  try {
    const text = await response.text();
    return Buffer.byteLength(text, "utf8") <= max ? text : null;
  } catch {
    return null;
  }
}

async function checkEndpoint(check, fetchImpl, timeoutMs) {
  let response;
  try {
    response = await fetchImpl(check.url, {
      method: "GET", credentials: "omit", redirect: "manual", signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return "STAGING_EDGE_ENDPOINT_UNREACHABLE";
  }
  const { expect } = check;
  if (response?.status !== expect.status) return "STAGING_EDGE_ENDPOINT_STATUS";
  const contentType = response.headers?.get("content-type")?.split(";", 1)[0];
  if (check.id === "admin-access") {
    let host = null;
    try {
      host = new URL(response.headers?.get("location") ?? "").hostname;
    } catch {
      host = null;
    }
    return host === expect.locationHost ? null : "STAGING_EDGE_ACCESS_REDIRECT_INVALID";
  }
  if (expect.status === 404) return null;
  if (expect.contentType !== undefined && contentType !== expect.contentType) return "STAGING_EDGE_ENDPOINT_CONTENT_TYPE";
  if (check.id === "root") {
    const body = await boundedText(response);
    return body !== null && !DASHBOARD_MARKERS.some((marker) => body.includes(marker))
      ? null
      : "STAGING_EDGE_PRIVATE_ROOT_EXPOSED";
  }
  if (expect.errorCode !== undefined) {
    if (response.headers.get("cache-control") !== expect.cacheControl
        || response.headers.get("retry-after") !== expect.retryAfter) {
      return "STAGING_EDGE_FENCE_INVALID";
    }
    const body = await boundedText(response, 64 * 1024);
    let code = null;
    try {
      code = JSON.parse(body ?? "")?.error?.code ?? null;
    } catch {
      code = null;
    }
    return code === expect.errorCode ? null : "STAGING_EDGE_FENCE_INVALID";
  }
  return null;
}

/** Read the staging matrix (GET only, no credentials). Returns codes and statuses, never bodies. */
export async function verifyStagingEdgeEndpoints({ mode, inputs, expectedSourceCommit, originCommit = null,
  fetchImpl = globalThis.fetch, timeoutMs = 10_000 } = {}) {
  let matrix;
  try {
    matrix = stagingEdgeEndpointMatrix({ mode, inputs, expectedSourceCommit, originCommit });
  } catch (error) {
    return { ok: false, code: stagingCode(error, "STAGING_EDGE_INPUT_INVALID"), checks: [] };
  }
  const checks = [];
  for (const check of matrix.checks) {
    let code;
    if (check.id === "health") {
      const health = await recheckProductionEdgeHealth({
        fetchImpl, timeoutMs, mode, expectedSourceCommit: check.expect.sourceCommit, origin: matrix.origin,
      });
      code = health?.ok === true ? null : health?.code ?? "PRODUCTION_EDGE_HEALTH_INVALID";
    } else {
      code = await checkEndpoint(check, fetchImpl, timeoutMs);
    }
    checks.push({ id: check.id, ok: code === null, code });
  }
  const failed = checks.find((check) => !check.ok);
  return { ok: failed === undefined, code: failed?.code ?? null, checks };
}

// ---------------------------------------------------------------------------
// Rehearsal

const DEPLOY = ["npm", "run", "staging-edge", "--", "deploy"];
const COMMON = ["--inputs", "<inputs.json>", "--production-inventory", "<production-inventory.json>",
  "--production-inventory-sha256", "<sha256>", "--production-plan-absent", "--site", "<candidate-site>"];
const LIVE = ["--inventory", "<fresh staging inventory>", "--inventory-sha256", "<sha256>",
  "--expected-previous-source", "<live DEPLOYMENT_SOURCE_COMMIT>"];
const OUT = ["--output-directory", "<new private directory>"];
const GCP = ["--origin-commit", "<origin commit>", "--origin-verifier-account", "<staging verifier account>"];
const FENCE = ["node", "scripts/cloudflare-writer-fence.mjs"];

function deployStep({ id, cycle, from, to, extra = [], expect, note, live = true, inputs, site }) {
  const common = COMMON.map((value) => (value === "<inputs.json>" && inputs ? inputs
    : value === "<candidate-site>" && site ? site : value));
  return Object.freeze({
    id, cycle, kind: "deploy", from, to,
    command: [...DEPLOY, "--edge-mode", to, ...common, ...(live ? LIVE : []), ...extra, ...OUT],
    expect, note,
  });
}

function fenceStep({ id, cycle, subcommand, receipts = "<new private receipts directory>", extra = [], expect, note }) {
  return Object.freeze({
    id, cycle, kind: "fence", subcommand,
    command: [...FENCE, subcommand, "--plan", "<fence-plan.json>", "--receipts", receipts, ...extra],
    expect, note,
  });
}

/**
 * The rehearsal (plan section 7): worker -> fenced (EP-8 drill) -> abort to
 * worker, then a fresh fenced and fence -> gcp -> brake to fenced. Worker ->
 * gcp is forbidden, so the abort and gcp are separated by a fresh fenced step
 * and a fresh fence in a new receipts directory. Every deploy step is first
 * run without --execute, which must give the expected outcome; ok steps are
 * then run again with --execute --confirm DEPLOY_STAGING_EDGE
 * --expected-candidate-sha256 <the dry run's candidateConfigSha256>.
 * Refusals are never executed. Phase F (the four gcp secrets) runs between
 * R1 and R2.
 */
export function stagingEdgeRehearsalSequence() {
  const ok = Object.freeze({ ok: true });
  const refused = (code) => Object.freeze({ ok: false, code });
  const r1 = "<R1 receipts directory>";
  const r2 = "<R2 receipts directory, new>";
  const marked = "<marker-bearing site>";
  return Object.freeze([
    deployStep({ id: "R1.0", cycle: "R1", from: null, to: "worker", live: false, expect: ok, extra: ["--genesis"],
      note: "Genesis (phase D): no live predecessor; null -> worker. Its --execute run adds --secrets-file "
        + "<owner-private 0600 file with the three worker-mode secrets>" }),
    deployStep({ id: "R1.1", cycle: "R1", from: "worker", to: "worker", expect: ok,
      note: "worker -> worker: every E10 gate on a live staging inventory" }),
    deployStep({ id: "R1.2", cycle: "R1", from: "worker", to: "gcp", expect: refused("EDGE_MODE_TRANSITION_FORBIDDEN"),
      extra: GCP, inputs: "<inputs with a placeholder origin>", note: "N3: worker -> gcp is never allowed" }),
    deployStep({ id: "R1.3", cycle: "R1", from: "worker", to: "fenced", expect: ok,
      note: "worker -> fenced; then endpoints --edge-mode fenced; stand-in heartbeats still increase" }),
    fenceStep({ id: "R1.4", cycle: "R1", subcommand: "inventory", receipts: r1, expect: ok,
      note: "EP-8 inventory (read-only)" }),
    fenceStep({ id: "R1.5", cycle: "R1", subcommand: "plan", receipts: r1, expect: ok,
      note: "EP-8 plan (read-only); review the writer set; note the plan receipt sha256" }),
    fenceStep({ id: "R1.6", cycle: "R1", subcommand: "apply", receipts: r1,
      extra: ["--confirm=<plan receipt sha256>", "--analytics-drain-complete"], expect: ok,
      note: "EP-8 apply: the stand-in's schedule is removed" }),
    fenceStep({ id: "R1.7", cycle: "R1", subcommand: "verify", receipts: r1, extra: ["--fence=<plan receipt sha256>"],
      expect: ok, note: "After the quiet window: zero heartbeat writes and stand-in invocations; keep the fence receipt and its sha256" }),
    deployStep({ id: "R1.8", cycle: "R1", from: "fenced", to: "fenced", expect: ok,
      note: "fenced -> fenced redeploy while fenced" }),
    deployStep({ id: "R1.9", cycle: "R1", from: "fenced", to: "gcp", extra: GCP, inputs: "<inputs with origin null>",
      expect: refused("EDGE_MODE_PLAN_REQUIRED"), note: "fenced -> gcp without a gcp plan" }),
    deployStep({ id: "R1.10", cycle: "R1", from: "fenced", to: "gcp", extra: GCP,
      inputs: "<inputs with a placeholder origin>", expect: refused("EDGE_MODE_SECRET_MISSING"),
      note: "N1: before phase F puts the four gcp secrets" }),
    deployStep({ id: "R1.11", cycle: "R1", from: "fenced", to: "fenced", site: marked,
      expect: refused("EDGE_PRIVACY_PAGE_PREMATURE"), note: "N4: a marked privacy page before gcp" }),
    deployStep({ id: "R1.12", cycle: "R1", from: "fenced", to: "worker",
      expect: refused("EDGE_MODE_TRANSITION_FORBIDDEN"), note: "The abort without the fence receipt" }),
    deployStep({ id: "R1.13", cycle: "R1", from: "fenced", to: "worker",
      extra: ["--fence-receipt", "<R1 fence receipt>", "--fence-receipt-sha256", "<sha256>"], expect: ok,
      note: "Abort: fenced -> worker while the fence is still applied" }),
    fenceStep({ id: "R1.14", cycle: "R1", subcommand: "release", receipts: r1,
      extra: ["--confirm=<plan receipt sha256>", "--pre-gcp"], expect: ok,
      note: "Release: the stand-in's cron is restored exactly; heartbeats resume" }),
    fenceStep({ id: "R1.15", cycle: "R1", subcommand: "verify", receipts: r1, extra: ["--fence=<plan receipt sha256>"],
      expect: refused("FENCE_RELEASED"), note: "N7: a released fence is terminal" }),
    deployStep({ id: "R2.0", cycle: "R2", from: "worker", to: "fenced", expect: ok,
      note: "A fresh fenced step (after phase F's secrets)" }),
    fenceStep({ id: "R2.1", cycle: "R2", subcommand: "inventory", receipts: r2, expect: ok, note: "A fresh fence" }),
    fenceStep({ id: "R2.2", cycle: "R2", subcommand: "plan", receipts: r2, expect: ok, note: "Note the new plan receipt sha256" }),
    fenceStep({ id: "R2.3", cycle: "R2", subcommand: "apply", receipts: r2,
      extra: ["--confirm=<R2 plan receipt sha256>", "--analytics-drain-complete"], expect: ok, note: "EP-8 apply" }),
    fenceStep({ id: "R2.4", cycle: "R2", subcommand: "verify", receipts: r2, extra: ["--fence=<R2 plan receipt sha256>"],
      expect: ok, note: "After the quiet window" }),
    deployStep({ id: "R2.5", cycle: "R2", from: "fenced", to: "gcp", extra: [...GCP, "--candidate-site"],
      inputs: "<inputs naming an unmigrated throwaway guard D1>", site: marked,
      expect: refused("EDGE_MODE_RELEASE_GUARD_MIGRATIONS_PENDING"),
      note: "N2: the staging origin ready and the secrets present, but the named guard D1 is unmigrated" }),
    deployStep({ id: "R2.6", cycle: "R2", from: "fenced", to: "gcp", extra: GCP,
      expect: refused("EDGE_PRIVACY_PAGE_NOT_CUTOVER"), note: "N4: the first gcp deploy needs the marked candidate site" }),
    deployStep({ id: "R2.7", cycle: "R2", from: "fenced", to: "gcp", extra: [...GCP, "--candidate-site"], site: marked,
      expect: ok, note: "The switch: fenced -> gcp; then endpoints --edge-mode gcp and the gcp drills" }),
    deployStep({ id: "R2.8", cycle: "R2", from: "gcp", to: "gcp", extra: GCP, site: marked, expect: ok,
      note: "gcp -> gcp redeploy" }),
    deployStep({ id: "R2.9", cycle: "R2", from: "gcp", to: "fenced", site: marked, expect: ok,
      note: "Brake: gcp -> fenced, no plan; then endpoints --edge-mode fenced" }),
    deployStep({ id: "R2.10", cycle: "R2", from: "fenced", to: "worker", site: marked,
      extra: ["--fence-receipt", "<R2 fence receipt>", "--fence-receipt-sha256", "<sha256>"],
      expect: refused("EDGE_MODE_TRANSITION_FORBIDDEN"), note: "No way back to worker once gcp ran" }),
    fenceStep({ id: "R2.11", cycle: "R2", subcommand: "release", receipts: r2,
      extra: ["--confirm=<R2 plan receipt sha256>", "--pre-gcp"], expect: refused("FENCE_RELEASE_AFTER_GCP"), note: "N6" }),
    deployStep({ id: "R2.12", cycle: "R2", from: "fenced", to: "gcp", extra: GCP, site: marked, expect: ok,
      note: "Leave the brake only forward, with every gcp check again" }),
    deployStep({ id: "R2.13", cycle: "R2", from: "gcp", to: "fenced", site: marked, expect: ok,
      note: "Brake once more; the rehearsal ends fenced" }),
  ]);
}

/** Whether a deploy step's expected outcome agrees with the transition matrix. */
export function rehearsalStepAgreesWithMatrix(step) {
  if (step.kind !== "deploy") return true;
  const allowed = EDGE_MODE_TRANSITIONS.some((entry) => entry.from === step.from && entry.to === step.to);
  return allowed || (step.expect.ok === false && step.expect.code === "EDGE_MODE_TRANSITION_FORBIDDEN");
}

// ---------------------------------------------------------------------------
// CLI

const VALUE_FLAGS = Object.freeze({
  "--edge-mode": "edgeMode",
  "--inputs": "inputsPath",
  "--production-inventory": "productionInventoryPath",
  "--production-inventory-sha256": "productionInventorySha256",
  "--production-baseline-inventory": "productionBaselineInventoryPath",
  "--production-baseline-inventory-sha256": "productionBaselineInventorySha256",
  "--production-plan": "productionPlanPath",
  "--inventory": "inventoryPath",
  "--inventory-sha256": "inventorySha256",
  "--expected-previous-source": "expectedPreviousSourceCommit",
  "--fence-receipt": "fenceReceiptPath",
  "--fence-receipt-sha256": "fenceReceiptSha256",
  "--origin-commit": "originCommit",
  "--origin-verifier-account": "originVerifierAccount",
  "--site": "siteDirectory",
  "--output-directory": "outputDirectory",
  "--secrets-file": "secretsFile",
  "--confirm": "confirmation",
  "--expected-candidate-sha256": "expectedCandidateSha256",
  "--operation": "operationDirectory",
  "--expected-source": "expectedSourceCommit",
});
const SWITCH_FLAGS = Object.freeze({
  "--genesis": "genesis",
  "--candidate-site": "candidateSite",
  "--production-plan-absent": "productionPlanAbsent",
  "--execute": "execute",
  "--write": "write",
});
const SUBCOMMAND_FLAGS = Object.freeze({
  render: ["inputsPath", "outputDirectory", "write", "productionInventoryPath", "productionInventorySha256"],
  deploy: ["edgeMode", "inputsPath", "productionInventoryPath", "productionInventorySha256",
    "productionBaselineInventoryPath", "productionBaselineInventorySha256", "productionPlanPath", "productionPlanAbsent",
    "inventoryPath", "inventorySha256", "expectedPreviousSourceCommit", "fenceReceiptPath", "fenceReceiptSha256",
    "originCommit", "originVerifierAccount", "siteDirectory", "candidateSite", "outputDirectory", "secretsFile",
    "genesis", "execute", "confirmation", "expectedCandidateSha256"],
  reconcile: ["operationDirectory", "inventoryPath", "inventorySha256", "execute"],
  endpoints: ["edgeMode", "inputsPath", "expectedSourceCommit", "originCommit", "execute"],
  rehearsal: [],
});

function argumentsInvalid() {
  return fail("STAGING_EDGE_ARGUMENTS_INVALID");
}

function pairs(result, names) {
  const present = names.filter((name) => result[name] !== undefined);
  if (present.length !== 0 && present.length !== names.length) argumentsInvalid();
  return present.length === names.length;
}

/** Closed argument parser: each subcommand takes exactly its flags and combinations. */
export function parseStagingEdgeArguments(argv) {
  const [subcommand, ...rest] = argv;
  if (!Object.hasOwn(SUBCOMMAND_FLAGS, subcommand ?? "")) argumentsInvalid();
  const result = { subcommand };
  for (let index = 0; index < rest.length; index += 1) {
    const [flag, inline] = rest[index].split(/=(.*)/su, 2);
    const valueKey = VALUE_FLAGS[flag];
    const switchKey = SWITCH_FLAGS[flag];
    const key = valueKey ?? switchKey;
    if (key === undefined || !SUBCOMMAND_FLAGS[subcommand].includes(key) || Object.hasOwn(result, key)) argumentsInvalid();
    if (switchKey !== undefined) {
      if (inline !== undefined) argumentsInvalid();
      result[key] = true;
      continue;
    }
    const value = inline ?? rest[++index];
    if (typeof value !== "string" || value.length === 0 || value.startsWith("--")) argumentsInvalid();
    result[key] = value;
  }
  const sha = (name) => result[name] === undefined || SHA.test(result[name]) || argumentsInvalid();
  const sha256Value = (name) => result[name] === undefined || SHA256.test(result[name]) || argumentsInvalid();
  for (const name of ["expectedPreviousSourceCommit", "originCommit", "expectedSourceCommit"]) sha(name);
  for (const name of ["productionInventorySha256", "productionBaselineInventorySha256", "inventorySha256",
    "fenceReceiptSha256", "expectedCandidateSha256"]) sha256Value(name);
  if (result.edgeMode !== undefined && parseEdgeUpstreamMode(result.edgeMode) === null) argumentsInvalid();
  if (subcommand === "render") {
    if (!result.inputsPath || (result.write === true) !== (result.outputDirectory !== undefined)) argumentsInvalid();
    pairs(result, ["productionInventoryPath", "productionInventorySha256"]);
  }
  if (subcommand === "deploy") {
    if (!result.edgeMode || !result.inputsPath || !result.siteDirectory || !result.outputDirectory) argumentsInvalid();
    if (!pairs(result, ["productionInventoryPath", "productionInventorySha256"])) argumentsInvalid();
    pairs(result, ["productionBaselineInventoryPath", "productionBaselineInventorySha256"]);
    if ((result.productionPlanPath !== undefined) === (result.productionPlanAbsent === true)) argumentsInvalid();
    const live = pairs(result, ["inventoryPath", "inventorySha256", "expectedPreviousSourceCommit"]);
    if (result.genesis === true) {
      if (live || result.edgeMode !== "worker" || result.fenceReceiptPath !== undefined
          || (result.execute === true) !== (result.secretsFile !== undefined)) {
        argumentsInvalid();
      }
    } else if (!live || result.secretsFile !== undefined) {
      argumentsInvalid();
    }
    if (pairs(result, ["fenceReceiptPath", "fenceReceiptSha256"]) && result.edgeMode !== "worker") argumentsInvalid();
    if (pairs(result, ["originCommit", "originVerifierAccount"]) !== (result.edgeMode === "gcp")) argumentsInvalid();
    if (result.execute === true) {
      if (result.confirmation === undefined || result.expectedCandidateSha256 === undefined) argumentsInvalid();
    } else if (result.confirmation !== undefined || result.expectedCandidateSha256 !== undefined) {
      argumentsInvalid();
    }
  }
  if (subcommand === "reconcile") {
    if (!result.operationDirectory) argumentsInvalid();
    if (pairs(result, ["inventoryPath", "inventorySha256"]) === (result.execute === true)) argumentsInvalid();
  }
  if (subcommand === "endpoints") {
    if (!result.edgeMode || !result.inputsPath || !result.expectedSourceCommit) argumentsInvalid();
    if ((result.originCommit !== undefined) !== (result.edgeMode === "gcp")) argumentsInvalid();
  }
  return result;
}

async function readInputs(path) {
  let value;
  try {
    value = JSON.parse((await readMaintenanceFile(resolve(path), 64 * 1024)).toString("utf8"));
  } catch {
    return fail("STAGING_EDGE_INPUTS_UNREADABLE");
  }
  return parseStagingEdgeInputs(value);
}

/** A new owner-only output directory outside the repository (identifiers never land in a checkout). */
export async function createStagingOutputDirectory(requested, workerDirectory = STAGING_EDGE_WORKER_DIRECTORY) {
  if (typeof requested !== "string" || requested.length === 0) fail("STAGING_EDGE_ARGUMENTS_INVALID");
  const repository = await realpath(resolve(workerDirectory, "..", ".."));
  let parent;
  try {
    parent = await realpath(dirname(resolve(requested)));
  } catch {
    return fail("STAGING_EDGE_OUTPUT_UNSAFE");
  }
  const relation = relative(repository, join(parent, basename(resolve(requested))));
  if (relation === "" || (!relation.startsWith(`..${sep}`) && relation !== ".." && !isAbsolute(relation))) {
    fail("STAGING_EDGE_OUTPUT_INSIDE_REPOSITORY");
  }
  return createPrivateReconciliationOutputDirectory(requested);
}

async function siteManifestSha256(siteDirectory) {
  const path = join(siteDirectory, SITE_MANIFEST);
  let info;
  try {
    info = await lstat(path);
  } catch {
    return fail("STAGING_EDGE_SITE_MANIFEST_INVALID");
  }
  if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > SITE_MANIFEST_MAX_BYTES) {
    fail("STAGING_EDGE_SITE_MANIFEST_INVALID");
  }
  return sha256(await readFile(path));
}

async function productionPlanOption(options) {
  if (options.productionPlanAbsent === true) return null;
  return readEdgeModePlan(resolve(options.productionPlanPath));
}

function migrationFile(role) {
  return `migrations-${role.replace(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`)}.wrangler.json`;
}

async function cliRender(options) {
  const inputs = await readInputs(options.inputsPath);
  const template = await readStagingEdgeTemplate();
  const trackedConfigs = await readStagingEdgeTrackedConfigs();
  const productionSnapshots = options.productionInventoryPath === undefined ? [] : [canonicalProduction(
    await readPrivateProductionInventory(resolve(options.productionInventoryPath), options.productionInventorySha256))];
  const target = assertStagingEdgeTarget({ inputs, template, trackedConfigs, productionSnapshots });
  const rendered = renderStagingEdgeTemplate({ template, inputs: target });
  const fence = buildStagingFencePlan(target);
  const gcp = buildStagingGcpPlan(target);
  const files = [
    ["staging-edge.tracked.json", rendered.edgeTracked],
    ["standin.wrangler.json", rendered.standIn],
    ...rendered.migrationConfigs.map((entry) => [migrationFile(entry.role), entry.config]),
    ["fence-plan.json", fence.plan],
    ...(gcp === null ? [] : [["gcp-plan.json", gcp.plan]]),
  ];
  const summary = {
    schema: STAGING_EDGE_RENDER_SCHEMA,
    dryRun: options.write !== true,
    productionInventoryChecked: productionSnapshots.length > 0,
    inputsSha256: stagingEdgeInputsSha256(target),
    fencePlanSha256: fence.planSha256,
    gcpPlanOverlaySha256: gcp?.overlaySha256 ?? null,
    files: files.map(([name, value]) => ({ name, sha256: sha256(`${JSON.stringify(value, null, 2)}\n`) })),
    migrations: rendered.migrationConfigs.map((entry) => ({
      role: entry.role,
      command: ["wrangler", "d1", "migrations", "apply", "<database name>", "--remote", "--config",
        `<output-directory>/${migrationFile(entry.role)}`],
    })),
    standIn: ["wrangler", "deploy", "--config", "<output-directory>/standin.wrangler.json", "--strict"],
  };
  if (options.write === true) {
    const directory = await createStagingOutputDirectory(options.outputDirectory);
    for (const [name, value] of files) await writePrivateJson(directory, name, value);
  }
  return { ok: true, code: null, ...summary };
}

async function cliDeploy(options) {
  const workerDirectory = STAGING_EDGE_WORKER_DIRECTORY;
  const inputs = await readInputs(options.inputsPath);
  const productionInventory = await readPrivateProductionInventory(
    resolve(options.productionInventoryPath), options.productionInventorySha256);
  const productionBaselineInventory = options.productionBaselineInventoryPath === undefined
    ? undefined
    : await readPrivateProductionInventory(resolve(options.productionBaselineInventoryPath),
      options.productionBaselineInventorySha256);
  const stagingInventory = options.inventoryPath === undefined
    ? undefined
    : await readPrivateProductionInventory(resolve(options.inventoryPath), options.inventorySha256);
  const gcp = options.edgeMode === "gcp" ? buildStagingGcpPlan(inputs) : null;
  const outputDirectory = await createStagingOutputDirectory(options.outputDirectory, workerDirectory);
  return runStagingEdgeDeployment({
    execute: options.execute === true,
    confirmation: options.confirmation,
    expectedCandidateSha256: options.expectedCandidateSha256,
    outputDirectory,
    secretsFile: options.secretsFile === undefined ? undefined : resolve(options.secretsFile),
    stagingInventorySha256: options.inventorySha256 ?? null,
    mode: options.edgeMode,
    genesis: options.genesis === true,
    inputs,
    template: await readStagingEdgeTemplate(),
    trackedConfigs: await readStagingEdgeTrackedConfigs(workerDirectory),
    productionInventory,
    productionBaselineInventory,
    productionPlan: await productionPlanOption(options),
    stagingInventory,
    expectedPreviousSourceCommit: options.expectedPreviousSourceCommit ?? null,
    workerDirectory,
    siteDirectory: resolve(options.siteDirectory),
    candidatePublicManifestSha256: options.candidateSite === true ? await siteManifestSha256(options.siteDirectory) : null,
    originCommit: options.originCommit,
    obtainOriginIdentityToken: options.edgeMode === "gcp" && gcp !== null
      ? createGcloudIdentityTokenSource({ verifierAccount: options.originVerifierAccount, audience: gcp.plan.originAudience })
      : undefined,
    edgeHistory: options.fenceReceiptPath === undefined
      ? undefined
      : createFenceHistorySource({
        receiptPath: resolve(options.fenceReceiptPath),
        receiptSha256: options.fenceReceiptSha256,
        accountId: inputs.accountId,
        workerName: inputs.edgeWorkerName,
      }),
  });
}

async function cliReconcile(options) {
  const directory = resolve(options.operationDirectory);
  let inventory;
  if (options.execute === true) {
    const target = await readOperationJson(directory, "target.json");
    inventory = await createProductionLiveProvider({ accountId: target.accountId, workerName: target.edgeWorkerName })
      .capture();
  } else {
    inventory = await readPrivateProductionInventory(resolve(options.inventoryPath), options.inventorySha256);
  }
  return reconcileStagingEdgeDeployment({ operationDirectory: directory, inventory });
}

async function cliEndpoints(options) {
  const inputs = await readInputs(options.inputsPath);
  const request = {
    mode: options.edgeMode, inputs, expectedSourceCommit: options.expectedSourceCommit,
    originCommit: options.originCommit ?? null,
  };
  if (options.execute !== true) {
    const matrix = stagingEdgeEndpointMatrix(request);
    return { ok: true, code: null, dryRun: true, checks: matrix.checks };
  }
  return verifyStagingEdgeEndpoints(request);
}

const USAGE = "Usage: staging-edge-deploy.mjs <render|deploy|reconcile|endpoints|rehearsal> [flags]\n"
  + "  render --inputs PRIVATE_JSON [--production-inventory PRIVATE_JSON --production-inventory-sha256 SHA256] "
  + "[--write --output-directory NEW_PRIVATE_DIR]\n"
  + "  deploy --edge-mode worker|fenced|gcp --inputs PRIVATE_JSON --production-inventory PRIVATE_JSON "
  + "--production-inventory-sha256 SHA256 (--production-plan PRIVATE_JSON | --production-plan-absent) "
  + "[--production-baseline-inventory PRIVATE_JSON --production-baseline-inventory-sha256 SHA256] "
  + "(--genesis [--secrets-file PRIVATE_0600] | --inventory PRIVATE_JSON --inventory-sha256 SHA256 "
  + "--expected-previous-source FULL_SHA) [--fence-receipt PRIVATE_JSON --fence-receipt-sha256 SHA256] "
  + "[--origin-commit FULL_SHA --origin-verifier-account EMAIL] --site DIR [--candidate-site] "
  + "--output-directory NEW_PRIVATE_DIR [--execute --confirm DEPLOY_STAGING_EDGE --expected-candidate-sha256 SHA256]\n"
  + "  reconcile --operation PRIVATE_DIR (--inventory PRIVATE_JSON --inventory-sha256 SHA256 | --execute)\n"
  + "  endpoints --edge-mode MODE --inputs PRIVATE_JSON --expected-source FULL_SHA [--origin-commit FULL_SHA] [--execute]\n"
  + "  rehearsal\n"
  + "Every subcommand is a dry run unless --execute is given.\n";

async function main() {
  let options;
  try {
    options = parseStagingEdgeArguments(process.argv.slice(2));
  } catch {
    process.stderr.write(USAGE);
    process.exitCode = 2;
    return;
  }
  let result;
  try {
    if (options.subcommand === "rehearsal") {
      for (const step of stagingEdgeRehearsalSequence()) process.stdout.write(`${JSON.stringify(step)}\n`);
      return;
    }
    result = await ({ render: cliRender, deploy: cliDeploy, reconcile: cliReconcile, endpoints: cliEndpoints })[
      options.subcommand](options);
  } catch (error) {
    result = { ok: false, code: stagingCode(error, "STAGING_EDGE_FAILED") };
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.ok) process.exitCode = 1;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) await main();
