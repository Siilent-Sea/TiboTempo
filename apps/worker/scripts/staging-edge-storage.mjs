import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, realpath, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { identityDigest } from "../../../scripts/lib/release-operation.mjs";
import {
  D1_STORAGE_CONFIRMATION,
  D1_STORAGE_OPERATING_CAP,
  D1_STORAGE_SCHEMA_DIRECTORIES,
  prepareStoragePlan,
  stagingEdgeStorageDatabaseName,
  storageError,
  storageSha256,
  validateStoragePlan,
} from "./d1-storage-plan.mjs";
import { runStorageOperation } from "./d1-storage-operator.mjs";
import { WRANGLER_LEDGER_RETIREMENT_SQL, createStorageWranglerAdapter } from "./d1-storage-wrangler.mjs";
import {
  STAGING_EDGE_D1_ROLES,
  STAGING_EDGE_STORAGE_LEDGER,
  STAGING_EDGE_WORKER_DIRECTORY,
  resolveStagingEdgeInputs,
  stagingEdgeMigrationTool,
} from "./staging-edge-target.mjs";

/**
 * The staging edge's storage-ledger migrations (STG-DRV, analytics).
 *
 * Production's analytics D1 was built by the d1-storage runner and records
 * `d1_storage_migrations`, with no Wrangler `d1_migrations`. The staging
 * analytics D1 is applied the same way: the qualified analytics role, the
 * runner's journal and its whole-file import transport (which keeps a trigger's
 * `CASE ... END;` intact, where `wrangler d1 migrations apply --remote` splits
 * it). Only two things differ from a production storage operation:
 *
 * - the target keeps its created name `tibotattle-staging-edge-<role>`, which
 *   the storage plan admits only for a staging migration of an existing ID;
 * - the coordination lock is a local owner-only file, never the shared
 *   production deployment lock (a git ref pushed to the repository's remote).
 *
 * Wrangler runs through the runner's adapter only: its pinned CLI, private
 * one-database config and closed environment, with the operator's own Wrangler
 * OAuth login (no API token in the environment) and WRANGLER_WRITE_LOGS=false.
 */

export const STAGING_EDGE_STORAGE_RETIRE_CONFIRMATION = "RETIRE_STAGING_WRANGLER_LEDGER";
export const STAGING_EDGE_STORAGE_LOCK_FILE = "staging-edge-storage.lock";
export const STAGING_EDGE_STORAGE_PLAN_TTL_MINUTES = Object.freeze({ default: 120, max: 1_440 });
/** The approved growth allowance for one migration of a fresh staging analytics D1. */
export const STAGING_EDGE_STORAGE_GROWTH_BUDGET_BYTES = 268_435_456;
/** Credentials that would replace the operator's Wrangler OAuth login. */
const TOKEN_ENVIRONMENT = Object.freeze(["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_API_KEY", "CLOUDFLARE_EMAIL", "CF_API_TOKEN"]);
const SHA = /^[0-9a-f]{40}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;

function fail(code) {
  throw Object.assign(new Error(`STAGING_EDGE_STORAGE_${code}`), { code: `STAGING_EDGE_STORAGE_${code}` });
}

/** The staging roles that take the storage ledger (today: analytics). */
export function stagingEdgeStorageRoles() {
  return STAGING_EDGE_D1_ROLES.filter((role) => role.ledger === STAGING_EDGE_STORAGE_LEDGER);
}

function storageRole(roleKey) {
  return stagingEdgeMigrationTool(roleKey, "storage");
}

/**
 * The d1-storage plan for one staging storage-ledger role: environment
 * staging, phase migrate, the existing database by its exact staging-edge name
 * and ID, the qualified role, and the checkout's own source commit. Staging has
 * no predecessor storage source, so the previous source is the source itself.
 */
export function buildStagingEdgeStoragePlan({
  inputs, role: roleKey, sourceCommit, qualificationSha256, now = Date.now(),
  ttlMinutes = STAGING_EDGE_STORAGE_PLAN_TTL_MINUTES.default, operationId = randomUUID(),
} = {}) {
  const target = resolveStagingEdgeInputs(inputs);
  const role = storageRole(roleKey);
  const database = target.d1[role.key];
  if (database.name !== stagingEdgeStorageDatabaseName(role.storageRole)) fail("DATABASE_NAME_UNADMITTED");
  if (!SHA.test(sourceCommit ?? "") || !SHA256.test(qualificationSha256 ?? "")) fail("PLAN_INPUT_INVALID");
  if (!Number.isSafeInteger(ttlMinutes) || ttlMinutes < 1 || ttlMinutes > STAGING_EDGE_STORAGE_PLAN_TTL_MINUTES.max) {
    fail("PLAN_INPUT_INVALID");
  }
  const createdAt = new Date(Math.floor(now / 1000) * 1000 - 1000).toISOString();
  const plan = {
    schema: "d1-storage-plan-v1",
    operationId,
    environment: "staging",
    accountId: target.accountId,
    sourceCommit,
    previousSourceCommit: sourceCommit,
    createdAt,
    expiresAt: new Date(Date.parse(createdAt) + ttlMinutes * 60_000).toISOString(),
    phase: "migrate",
    operatingCapBytes: D1_STORAGE_OPERATING_CAP,
    targets: [{
      role: role.storageRole,
      name: database.name,
      binding: role.binding,
      databaseId: database.id,
      qualificationSha256,
      migrationGrowthBudgetBytes: STAGING_EDGE_STORAGE_GROWTH_BUDGET_BYTES,
    }],
  };
  return assertStagingEdgeStoragePlan(plan, { now });
}

/**
 * A staging-edge storage plan and nothing wider: the runner's own validation,
 * then environment staging, phase migrate, and every target a staging
 * storage-ledger role by its binding and exact staging-edge name.
 */
export function assertStagingEdgeStoragePlan(plan, { now = Date.now(), allowExpired = false } = {}) {
  const validated = validateStoragePlan(plan, { now, allowExpired });
  if (validated.environment !== "staging" || validated.phase !== "migrate") fail("PLAN_NOT_STAGING_MIGRATION");
  const roles = stagingEdgeStorageRoles();
  for (const target of validated.targets) {
    const role = roles.find((entry) => entry.storageRole === target.role && entry.binding === target.binding);
    if (role === undefined || target.name !== stagingEdgeStorageDatabaseName(role.storageRole)
        || target.databaseId === null) {
      fail("PLAN_TARGET_NOT_STAGING_STORAGE");
    }
  }
  return validated;
}

/**
 * The qualified role mirror must carry exactly the checkout's role SQL: the
 * same file names and bytes the source commit holds, so staging applies what
 * the deploy line checks in.
 */
export async function assertQualifiedMirrorMatchesCheckout({ qualifiedWorkerRoot, workerDirectory = STAGING_EDGE_WORKER_DIRECTORY,
  role: roleKey }) {
  const role = storageRole(roleKey);
  const directory = D1_STORAGE_SCHEMA_DIRECTORIES[role.storageRole];
  if (directory !== role.migrationsDir) fail("ROLE_DIRECTORY_MISMATCH");
  const listing = async (root) => {
    const names = (await readdir(join(root, directory))).filter((name) => name.endsWith(".sql")).sort();
    return Promise.all(names.map(async (name) => [name, storageSha256(await readFile(join(root, directory, name)))]));
  };
  let mirror;
  let checkout;
  try {
    [mirror, checkout] = await Promise.all([listing(resolve(qualifiedWorkerRoot)), listing(workerDirectory)]);
  } catch {
    return fail("QUALIFIED_MIRROR_UNREADABLE");
  }
  if (identityDigest(mirror) !== identityDigest(checkout)) fail("QUALIFIED_MIRROR_NOT_CHECKOUT");
  return mirror.length;
}

/**
 * Wrangler's credentials come only from the operator's OAuth login: an API
 * token in the environment would replace it, so it is refused. Wrangler's
 * debug log files are off (WRANGLER_WRITE_LOGS=false), set by the caller.
 */
export function assertStagingEdgeStorageEnvironment(environment = process.env) {
  if (TOKEN_ENVIRONMENT.some((key) => Object.hasOwn(environment, key))) fail("OAUTH_LOGIN_REQUIRED");
  if (environment.WRANGLER_WRITE_LOGS !== "false") fail("WRANGLER_WRITE_LOGS_REQUIRED_FALSE");
}

async function privateParent(path) {
  const parent = await realpath(dirname(resolve(path)));
  const info = await lstat(parent);
  const uid = process.getuid?.();
  if (!info.isDirectory() || (info.mode & 0o077) !== 0 || (uid !== undefined && info.uid !== uid)) fail("PRIVATE_DIRECTORY_UNSAFE");
  return parent;
}

/**
 * A local staging coordination lock with the shared lock's interface
 * (createOwner, acquire, assertOwned, status, release): one owner-only file in
 * the private parent of the operation directory. It never touches git or a
 * remote. Like the production lock it has no expiry: a lost owner is
 * reconciled through the operation journal, never stolen.
 */
export function createStagingEdgeStorageLock({ operationDirectory }) {
  if (typeof operationDirectory !== "string" || operationDirectory.length === 0) fail("LOCK_INPUT_INVALID");
  const lockPath = async () => join(await privateParent(operationDirectory), STAGING_EDGE_STORAGE_LOCK_FILE);
  const status = async () => {
    const path = await lockPath();
    let info;
    try {
      info = await lstat(path);
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
    const uid = process.getuid?.();
    if (!info.isFile() || info.nlink !== 1 || (info.mode & 0o077) !== 0 || (uid !== undefined && info.uid !== uid)
        || info.size !== 65) {
      fail("LOCK_STATE_UNKNOWN");
    }
    const owner = (await readFile(path, "utf8")).trim();
    return SHA256.test(owner) ? owner : fail("LOCK_STATE_UNKNOWN");
  };
  const assertOwned = async (owner) => {
    if (!SHA256.test(owner ?? "") || await status() !== owner) fail("LOCK_NOT_OWNER");
  };
  return {
    status,
    assertOwned,
    async createOwner({ id, sourceCommit, previousSourceCommit } = {}) {
      if (!/^[a-f0-9-]{36}$/u.test(id ?? "") || !SHA.test(sourceCommit ?? "") || !SHA.test(previousSourceCommit ?? "")) {
        fail("LOCK_INPUT_INVALID");
      }
      return createHash("sha256").update(JSON.stringify({ schema: "staging-edge-storage-lock-v1", id, sourceCommit,
        previousSourceCommit, nonce: randomUUID() })).digest("hex");
    },
    async acquire(owner) {
      if (!SHA256.test(owner ?? "")) fail("LOCK_INPUT_INVALID");
      try {
        await writeFile(await lockPath(), `${owner}\n`, { mode: 0o600, flag: "wx" });
      } catch (error) {
        if (error?.code === "EEXIST") fail("LOCK_BUSY");
        throw error;
      }
      await assertOwned(owner);
    },
    async release(owner) {
      await assertOwned(owner);
      await unlink(await lockPath());
      if (await status() !== null) fail("LOCK_RELEASE_UNCERTAIN");
    },
  };
}

/**
 * Apply the plan's migrations with the d1-storage runner (runStorageOperation):
 * its journal, intents, exact schema-and-ledger prefix checks and uncertain-
 * outcome rules, with the staging lock in place of the production lock. The
 * default is the runner's own local plan validation; mutation needs execute,
 * the runner's confirmation and the exact reviewed plan digest.
 *
 * A fresh execution first reads, read-only, whether a Wrangler ledger is
 * present and refuses before any journal or lock: the runner would refuse it
 * anyway (its schema fingerprint no longer matches the empty qualified start),
 * but only after taking the lock the retirement needs.
 */
export async function runStagingEdgeStorageMigration({
  plan, workerRoot, operationDirectory, cliPath, execute = false, confirmation, approvedPlanSha256, resume = false,
  now = Date.now(), adapterFactory, lockFactory,
} = {}) {
  const staged = assertStagingEdgeStoragePlan(plan, { now, allowExpired: execute && resume });
  if (execute && !resume) {
    if (confirmation !== D1_STORAGE_CONFIRMATION || approvedPlanSha256 !== identityDigest(staged)) {
      throw storageError("EXECUTE_NOT_APPROVED");
    }
    const directory = `${resolve(operationDirectory)}-preflight`;
    await privateParent(directory);
    await mkdir(directory, { mode: 0o700 });
    const { adapter } = await stagingAdapter({ plan: staged, workerRoot, directory, cliPath, allowExpired: false,
      adapterFactory });
    for (const target of staged.targets) {
      if ((await adapter.wranglerLedger(target)).present) fail("WRANGLER_LEDGER_PRESENT");
    }
  }
  return runStorageOperation({
    plan: staged, workerRoot, repositoryRoot: workerRoot, directory: operationDirectory, execute, confirmation,
    approvedPlanSha256, resume, now,
    adapterFactory: adapterFactory ?? ((input) => createStorageWranglerAdapter({ ...input, cliPath })),
    lockFactory: lockFactory ?? (() => createStagingEdgeStorageLock({ operationDirectory })),
  });
}

async function stagingAdapter({ plan, workerRoot, directory, cliPath, allowExpired, adapterFactory }) {
  const prepared = await prepareStoragePlan({ plan, workerRoot, allowExpired });
  const adapter = await (adapterFactory ?? ((input) => createStorageWranglerAdapter({ ...input, cliPath })))({
    plan: prepared.plan, qualifications: prepared.qualifications, directory, allowExpiredPlan: allowExpired,
    approvalExtensions: [],
  });
  return { prepared, adapter };
}

/**
 * Retire the stray, empty Wrangler ledger a `wrangler d1 migrations` command
 * left on a staging storage-ledger D1, under the reviewed plan and the staging
 * lock. Production's storage-ledger D1s have no `d1_migrations`, and the seal
 * refuses one. Only an empty ledger that is the database's only application
 * object is dropped (the import's own guard rows refuse anything else); an
 * absent ledger is a no-op. Without execute it only validates locally.
 */
export async function retireStagingEdgeWranglerLedger({
  plan, workerRoot, directory, cliPath, execute = false, confirmation, approvedPlanSha256, adapterFactory, lockFactory,
  now = Date.now(),
} = {}) {
  const staged = assertStagingEdgeStoragePlan(plan, { now });
  const planSha256 = identityDigest(staged);
  const local = { planSha256, retirementSqlSha256: storageSha256(WRANGLER_LEDGER_RETIREMENT_SQL) };
  if (!execute) {
    await prepareStoragePlan({ plan: staged, workerRoot, now });
    return { status: "planned", ...local, targetCount: staged.targets.length };
  }
  if (confirmation !== STAGING_EDGE_STORAGE_RETIRE_CONFIRMATION || approvedPlanSha256 !== planSha256) fail("RETIRE_NOT_APPROVED");
  const lock = (lockFactory ?? (() => createStagingEdgeStorageLock({ operationDirectory: directory })))();
  const owner = await lock.createOwner({ id: staged.operationId, sourceCommit: staged.sourceCommit,
    previousSourceCommit: staged.previousSourceCommit });
  await lock.acquire(owner);
  const targets = [];
  // The retirement is idempotent and its import guards itself, so the lock is
  // released on failure too; a rerun reads the ledger again before any drop.
  try {
    const { adapter } = await stagingAdapter({ plan: staged, workerRoot, directory, cliPath, allowExpired: false,
      adapterFactory });
    for (const target of staged.targets) {
      await lock.assertOwned(owner);
      const result = await adapter.retireEmptyWranglerLedger(target);
      targets.push({ role: target.role, status: result.status, wranglerLedgerPresent: result.present,
        otherObjects: result.otherObjects });
    }
  } catch (error) {
    await Promise.resolve(lock.release(owner)).catch(() => {});
    throw error;
  }
  await lock.release(owner);
  return { status: "completed", ...local, targets };
}

/**
 * Read-only verification of a staging storage-ledger D1 against its qualified
 * role: no Wrangler ledger, the complete `d1_storage_migrations` chain by name
 * and SHA-256, and the exact final schema fingerprint. Content-free output.
 */
export async function verifyStagingEdgeStorage({ plan, workerRoot, directory, cliPath, adapterFactory, now = Date.now() } = {}) {
  const staged = assertStagingEdgeStoragePlan(plan, { now, allowExpired: true });
  const { prepared, adapter } = await stagingAdapter({ plan: staged, workerRoot, directory, cliPath, allowExpired: true,
    adapterFactory });
  const targets = [];
  for (const target of staged.targets) {
    const expected = prepared.qualifications[target.binding].migrations;
    const inventory = await adapter.inventory(target);
    if (!Array.isArray(inventory) || inventory.length !== 1) fail("DATABASE_NOT_FOUND");
    const wrangler = await adapter.wranglerLedger(target);
    if (wrangler.present) fail("WRANGLER_LEDGER_PRESENT");
    const observed = await adapter.inspect(target);
    const ledgerMatches = observed.migrations.length === expected.length
      && observed.migrations.every((row, index) => row.name === expected[index].name && row.sha256 === expected[index].sha256);
    if (!ledgerMatches) fail("LEDGER_INCOMPLETE");
    if (observed.schemaSha256 !== expected.at(-1).afterSchemaSha256) fail("SCHEMA_MISMATCH");
    targets.push({ role: target.role, ledger: STAGING_EDGE_STORAGE_LEDGER, applied: observed.migrations.length,
      expected: expected.length, lastMigration: expected.at(-1).name, schemaSha256: observed.schemaSha256,
      wranglerLedgerPresent: false });
  }
  return { status: "verified", planSha256: identityDigest(staged), targets };
}

export { D1_STORAGE_CONFIRMATION as STAGING_EDGE_STORAGE_APPLY_CONFIRMATION };
