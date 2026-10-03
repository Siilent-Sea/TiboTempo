import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { identityDigest } from "../../../scripts/lib/release-operation.mjs";
import fileValidation from "./d1-storage-file-preload.cjs";
import {
  D1_STORAGE_CONFIRMATION,
  D1_STORAGE_STAGING_EDGE_ROLES,
  stagingEdgeStorageDatabaseName,
  storageSchemaDigest,
  storageSha256,
  validateStoragePlan,
} from "./d1-storage-plan.mjs";
import { runStorageOperation } from "./d1-storage-operator.mjs";
import { parseStagingEdgeArguments } from "./staging-edge-deploy.mjs";
import {
  STORAGE_SCHEMA_QUERY,
  WRANGLER_LEDGER_RETIREMENT_SQL,
  createStorageWranglerAdapter,
} from "./d1-storage-wrangler.mjs";
import {
  STAGING_EDGE_STORAGE_LOCK_FILE,
  STAGING_EDGE_STORAGE_RETIRE_CONFIRMATION,
  assertQualifiedMirrorMatchesCheckout,
  assertStagingEdgeStorageEnvironment,
  assertStagingEdgeStoragePlan,
  buildStagingEdgeStoragePlan,
  createStagingEdgeStorageLock,
  retireStagingEdgeWranglerLedger,
  stagingEdgeStorageRoles,
  runStagingEdgeStorageMigration,
  verifyStagingEdgeStorage,
} from "./staging-edge-storage.mjs";
import {
  STAGING_EDGE_INPUTS_EXAMPLE_PATH,
  STAGING_EDGE_WORKER_DIRECTORY,
  parseStagingEdgeInputs,
  readStagingEdgeTemplate,
  renderStagingEdgeTemplate,
  stagingEdgeMigrationTool,
} from "./staging-edge-target.mjs";

// Synthetic only: the committed example inputs, a fake pinned Wrangler that is
// never executed, and an in-memory SQLite database standing in for the remote
// D1. The import transport executes each submitted file whole, as D1's import
// does; nothing reaches a network or a credential.

const RAW_INPUTS = JSON.parse(readFileSync(STAGING_EDGE_INPUTS_EXAMPLE_PATH, "utf8"));
const INPUTS = parseStagingEdgeInputs(RAW_INPUTS);
const SOURCE = "a".repeat(40);
const DELIVERY_STATE = readFileSync(join(STAGING_EDGE_WORKER_DIRECTORY, "analytics-migrations", "0001_delivery_state.sql"), "utf8");
// A trigger whose CASE expressions end in "END;" inside BEGIN ... END: the shape
// Wrangler's remote `migrations apply` splits mid-trigger.
const CASE_TRIGGER = `CREATE TABLE staging_case_probe(id INTEGER PRIMARY KEY, kind TEXT NOT NULL);
CREATE TRIGGER staging_case_probe_guard BEFORE INSERT ON staging_case_probe
BEGIN
  SELECT CASE WHEN NEW.kind NOT IN ('a','b') THEN RAISE(ABORT,'staging_case_probe_kind') END;
  SELECT CASE WHEN NEW.id < 0 THEN RAISE(ABORT,'staging_case_probe_id') END;
END;
`;
// Wrangler 4.114.0's ledger DDL (getCreateMigrationsTableQuery).
const WRANGLER_LEDGER_DDL = `CREATE TABLE IF NOT EXISTS "d1_migrations"(
		id         INTEGER PRIMARY KEY AUTOINCREMENT,
		name       TEXT UNIQUE,
		applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
);`;

async function privateTemp(t, prefix) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  await chmod(directory, 0o700);
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

/** A qualified analytics role mirror over the given SQL files, with real before/after schema digests. */
async function qualifiedMirror(root, files) {
  const directory = join(root, "worker", "analytics-migrations");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const scratch = new DatabaseSync(":memory:");
  const schema = () => storageSchemaDigest(scratch.prepare(STORAGE_SCHEMA_QUERY).all());
  const migrations = [];
  for (const [name, sql] of files) {
    const beforeSchemaSha256 = schema();
    scratch.exec(sql);
    migrations.push({ name, sha256: storageSha256(sql), beforeSchemaSha256, afterSchemaSha256: schema() });
    await writeFile(join(directory, name), sql);
  }
  scratch.close();
  const evidence = JSON.stringify({ schema: "synthetic-qualification", status: "passed" });
  await writeFile(join(directory, "qualification-evidence.json"), evidence);
  const qualification = JSON.stringify({ schema: "d1-storage-schema-qualification-v1", status: "qualified", role: "analytics",
    directory: "analytics-migrations", sourceCommit: SOURCE, evidenceSha256: storageSha256(evidence), migrations });
  await writeFile(join(directory, "qualification.json"), qualification);
  return { workerRoot: join(root, "worker"), qualificationSha256: storageSha256(qualification), migrations };
}

/** The fake pinned CLI, and a spawn that answers inventory and executes queries and imports on `db`. */
async function syntheticWrangler(root, db, { name = INPUTS.d1.analytics.name, id = INPUTS.d1.analytics.id } = {}) {
  const cliPath = join(root, "node_modules", "wrangler", "wrangler-dist", "cli.js");
  await mkdir(join(root, "node_modules", "wrangler", "wrangler-dist"), { recursive: true });
  await writeFile(cliPath, "// synthetic CLI, never executed\n");
  await writeFile(join(root, "node_modules", "wrangler", "package.json"),
    JSON.stringify({ name: "wrangler", version: "4.114.0", main: "wrangler-dist/cli.js" }));
  const calls = [];
  const spawn = (command, args, options) => {
    calls.push({ args, env: options.env });
    const queryArg = args.find((arg) => arg.startsWith("--tibo-query-path="));
    if (queryArg) {
      const sql = readFileSync(queryArg.slice("--tibo-query-path=".length), "utf8");
      if (!args.includes(fileValidation.PLACEHOLDER)) {
        return { status: 0, stdout: JSON.stringify([{ success: true, results: db.prepare(sql).all() }]) };
      }
      const rewritten = fileValidation.fileArguments(args.slice(4), args[3]);
      assert.equal(readFileSync(rewritten[rewritten.indexOf("--file") + 1], "utf8"), sql);
      db.exec("BEGIN");
      try {
        db.exec(sql);
        db.exec("COMMIT");
      } catch {
        db.exec("ROLLBACK");
        return { status: 1, stdout: "", stderr: "synthetic import failure" };
      }
      return { status: 0, stdout: `├ Checking if file needs uploading\n│\n${JSON.stringify([{ success: true, results: [],
        finalBookmark: "synthetic-bookmark", meta: { duration: 1 } }])}` };
    }
    if (args.includes("list")) return { status: 0, stdout: JSON.stringify([{ uuid: id, name }]) };
    if (args.includes("info")) return { status: 0, stdout: JSON.stringify({ uuid: id, name, database_size: 16384 }) };
    return assert.fail("unexpected external command");
  };
  return { cliPath, spawn, calls, adapterFactory: (input) => createStorageWranglerAdapter({ ...input, cliPath, spawn }) };
}

async function fixture(t, files = [["0001_delivery_state.sql", DELIVERY_STATE], ["0002_case_end_trigger.sql", CASE_TRIGGER]]) {
  const root = await privateTemp(t, "staging-edge-storage-");
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  const mirror = await qualifiedMirror(root, files);
  const wrangler = await syntheticWrangler(root, db);
  const plan = buildStagingEdgeStoragePlan({ inputs: INPUTS, role: "analytics", sourceCommit: SOURCE,
    qualificationSha256: mirror.qualificationSha256 });
  const operations = join(root, "storage");
  await mkdir(operations, { mode: 0o700 });
  const execute = (operation, extra = {}) => runStagingEdgeStorageMigration({ plan, workerRoot: mirror.workerRoot,
    operationDirectory: join(operations, operation), cliPath: wrangler.cliPath, execute: true,
    confirmation: D1_STORAGE_CONFIRMATION, approvedPlanSha256: identityDigest(plan), adapterFactory: wrangler.adapterFactory,
    ...extra });
  const retire = async (output, extra = {}) => {
    const directory = join(operations, output);
    if (extra.execute !== false) await mkdir(directory, { mode: 0o700 });
    return retireStagingEdgeWranglerLedger({ plan, workerRoot: mirror.workerRoot, directory, cliPath: wrangler.cliPath,
      execute: true, confirmation: STAGING_EDGE_STORAGE_RETIRE_CONFIRMATION, approvedPlanSha256: identityDigest(plan),
      adapterFactory: wrangler.adapterFactory, ...extra });
  };
  const verify = async (output) => {
    const directory = join(operations, output);
    await mkdir(directory, { mode: 0o700 });
    return verifyStagingEdgeStorage({ plan, workerRoot: mirror.workerRoot, directory, cliPath: wrangler.cliPath,
      adapterFactory: wrangler.adapterFactory });
  };
  const ledger = () => db.prepare("SELECT name, sha256 FROM d1_storage_migrations ORDER BY name").all()
    .map((row) => ({ ...row }));
  const objects = () => db.prepare("SELECT type, name FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' ORDER BY type, name").all()
    .map((row) => ({ ...row }));
  return { root, db, mirror, wrangler, plan, operations, execute, retire, verify, ledger, objects };
}

test("a trigger with CASE ... END applies whole through the storage runner and records d1_storage_migrations", async (t) => {
  const f = await fixture(t);
  const result = await f.execute("apply-1");
  assert.equal(result.status, "completed");
  assert.deepEqual(f.ledger(), f.mirror.migrations.map(({ name, sha256 }) => ({ name, sha256 })));
  assert.equal(f.objects().some((row) => row.name === "d1_migrations"), false);

  // Every trigger kept its whole body: the real analytics 0001 and the synthetic probe.
  const sql = (name) => f.db.prepare("SELECT sql FROM sqlite_schema WHERE type='trigger' AND name=?").get(name).sql;
  const delivery = sql("analytics_delivery_validate");
  for (const reason of ["analytics_sequence_conflict", "analytics_owner_revision_conflict", "analytics_owner_erased",
    "analytics_owner_ineligible", "analytics_owner_uninitialized", "analytics_authority_conflict",
    "analytics_public_authority_conflict"]) {
    assert.ok(delivery.includes(`RAISE(ABORT,'${reason}')`), reason);
  }
  assert.match(sql("staging_case_probe_guard"), /staging_case_probe_kind[\s\S]*staging_case_probe_id[\s\S]*END$/u);
  assert.throws(() => f.db.exec("INSERT INTO staging_case_probe VALUES(1,'z')"), /staging_case_probe_kind/u);
  assert.throws(() => f.db.exec("INSERT INTO staging_case_probe VALUES(-1,'a')"), /staging_case_probe_id/u);
  f.db.exec("INSERT INTO staging_case_probe VALUES(1,'a')");

  // One whole-file import per migration, never Wrangler's migration commands.
  const imports = f.wrangler.calls.filter((call) => call.args.includes(fileValidation.PLACEHOLDER));
  assert.equal(imports.length, 2);
  assert.equal(f.wrangler.calls.some((call) => call.args.includes("migrations") || call.args.includes("apply")), false);
  // The staging lock is a local file, released; the operation is journaled.
  await assert.rejects(readFile(join(f.operations, STAGING_EDGE_STORAGE_LOCK_FILE)), { code: "ENOENT" });
  assert.ok((await readdir(join(f.operations, "apply-1"))).includes("operation.json"));

  const verified = await f.verify("verify-1");
  assert.equal(verified.status, "verified");
  assert.deepEqual(verified.targets.map(({ role, ledger, applied, expected, wranglerLedgerPresent }) =>
    ({ role, ledger, applied, expected, wranglerLedgerPresent })),
  [{ role: "analytics", ledger: "d1_storage_migrations", applied: 2, expected: 2, wranglerLedgerPresent: false }]);
  assert.equal(JSON.stringify(verified).includes(INPUTS.d1.analytics.id), false);
});

test("a stray Wrangler ledger is refused by the runner and retired only while it is empty and alone", async (t) => {
  const f = await fixture(t);
  f.db.exec(WRANGLER_LEDGER_DDL);

  // The staging wrapper refuses before any journal or lock.
  await assert.rejects(f.execute("apply-early"), { code: "STAGING_EDGE_STORAGE_WRANGLER_LEDGER_PRESENT" });
  await assert.rejects(readdir(join(f.operations, "apply-early")), { code: "ENOENT" });
  // Rerunning the same --operation after a refused preflight names its refusal: a new --operation is needed.
  await assert.rejects(f.execute("apply-early"), { code: "STAGING_EDGE_STORAGE_PREFLIGHT_DIRECTORY_EXISTS" });
  await assert.rejects(readdir(join(f.operations, "apply-early")), { code: "ENOENT" });
  // The bare runner refuses too, on its own schema fingerprint, and writes nothing.
  const bare = join(f.root, "bare");
  await mkdir(bare, { mode: 0o700 });
  await assert.rejects(runStorageOperation({ plan: f.plan, workerRoot: f.mirror.workerRoot, repositoryRoot: f.root,
    directory: join(bare, "operation"), execute: true, confirmation: D1_STORAGE_CONFIRMATION,
    approvedPlanSha256: identityDigest(f.plan), adapterFactory: f.wrangler.adapterFactory,
    lockFactory: () => createStagingEdgeStorageLock({ operationDirectory: join(bare, "operation") }) }),
  { code: "D1_STORAGE_SCHEMA_RECEIPT_MISMATCH" });
  assert.deepEqual(f.objects(), [{ type: "table", name: "d1_migrations" }]);
  await assert.rejects(f.verify("verify-early"), { code: "STAGING_EDGE_STORAGE_WRANGLER_LEDGER_PRESENT" });

  // A non-empty ledger is never dropped, by the precheck or by the import's own guard rows.
  f.db.exec("INSERT INTO d1_migrations(name) VALUES('0001_delivery_state.sql')");
  await assert.rejects(f.retire("retire-nonempty"), { code: "D1_STORAGE_WRANGLER_LEDGER_NOT_EMPTY" });
  f.db.exec("BEGIN");
  assert.throws(() => f.db.exec(WRANGLER_LEDGER_RETIREMENT_SQL), /CHECK constraint failed/u);
  // Executed without a transaction, the import stops at the guard and leaves only the guard table, which
  // every later retirement then refuses (fail closed) until it is inspected.
  assert.deepEqual(f.objects().map((row) => row.name), ["d1_migrations", "tibotattle_wrangler_ledger_retirement"]);
  f.db.exec("ROLLBACK");
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM d1_migrations").get().n, 1);
  f.db.exec("DELETE FROM d1_migrations");
  // Nor while another application object sits beside it.
  f.db.exec("CREATE TABLE unrelated(id INTEGER)");
  await assert.rejects(f.retire("retire-crowded"), { code: "D1_STORAGE_WRANGLER_LEDGER_NOT_EMPTY" });
  f.db.exec("DROP TABLE unrelated");

  // Approval is exact; the dry run reads nothing remote.
  await assert.rejects(f.retire("retire-unapproved", { approvedPlanSha256: "0".repeat(64) }),
    { code: "STAGING_EDGE_STORAGE_RETIRE_NOT_APPROVED" });
  const calls = f.wrangler.calls.length;
  const planned = await f.retire("retire-dry", { execute: false });
  assert.equal(planned.status, "planned");
  assert.equal(f.wrangler.calls.length, calls);

  const retired = await f.retire("retire-1");
  assert.deepEqual(retired.targets, [{ role: "analytics", status: "retired", wranglerLedgerPresent: false, otherObjects: 0 }]);
  assert.deepEqual(f.objects(), []);
  assert.equal((await f.retire("retire-2")).targets[0].status, "absent");
  await assert.rejects(readFile(join(f.operations, STAGING_EDGE_STORAGE_LOCK_FILE)), { code: "ENOENT" });

  assert.equal((await f.execute("apply-1")).status, "completed");
  assert.equal((await f.verify("verify-1")).status, "verified");
  // Retirement after migration is a no-op that leaves the storage ledger alone.
  assert.equal((await f.retire("retire-3")).targets[0].status, "absent");
  assert.equal(f.ledger().length, 2);
});

test("retirement establishes the database's identity from the server's list and info before any query or import", async (t) => {
  const f = await fixture(t);
  f.db.exec(WRANGLER_LEDGER_DDL);
  // The server lists the plan's name under another ID, or does not list it at all, or lists it twice.
  const cases = [
    [{ id: "99999999-9999-4999-8999-999999999999" }, "D1_STORAGE_RESOURCE_IDENTITY_OR_CAPACITY_MISMATCH"],
    [{ name: "tibotattle-staging-edge-analytics-other" }, "D1_STORAGE_RESOURCE_IDENTITY_OR_CAPACITY_MISMATCH"],
  ];
  for (const [index, [server, code]] of cases.entries()) {
    const wrangler = await syntheticWrangler(f.root, f.db, server);
    await assert.rejects(f.retire(`retire-identity-${index}`, { adapterFactory: wrangler.adapterFactory }), { code });
    // Only inventory ran: no query and no import addressed the plan's ID.
    assert.equal(wrangler.calls.length > 0, true);
    assert.equal(wrangler.calls.every((call) => call.args.includes("list") || call.args.includes("info")), true);
    await assert.rejects(readFile(join(f.operations, STAGING_EDGE_STORAGE_LOCK_FILE)), { code: "ENOENT" });
  }
  const duplicated = await syntheticWrangler(f.root, f.db);
  const listed = duplicated.spawn;
  const spawn = (command, args, options) => (args.includes("list")
    ? { status: 0, stdout: JSON.stringify([{ uuid: f.plan.targets[0].databaseId, name: f.plan.targets[0].name },
      { uuid: "99999999-9999-4999-8999-999999999999", name: f.plan.targets[0].name }]) }
    : listed(command, args, options));
  await assert.rejects(f.retire("retire-identity-duplicate", { adapterFactory: (input) =>
    createStorageWranglerAdapter({ ...input, cliPath: duplicated.cliPath, spawn }) }),
  { code: "D1_STORAGE_RESOURCE_IDENTITY_OR_CAPACITY_MISMATCH" });
  assert.deepEqual(f.objects(), [{ type: "table", name: "d1_migrations" }]);

  // With the plan's exact name and ID listed, list and info run first, then the guarded reads and the import.
  const calls = f.wrangler.calls.length;
  assert.equal((await f.retire("retire-identity-ok")).targets[0].status, "retired");
  const kinds = f.wrangler.calls.slice(calls).map((call) => (call.args.includes(fileValidation.PLACEHOLDER) ? "import"
    : call.args.some((arg) => arg.startsWith("--tibo-query-path=")) ? "query"
      : call.args.includes("list") ? "list" : "info"));
  assert.deepEqual(kinds, ["list", "info", "query", "query", "import", "query"]);
  assert.deepEqual(f.objects(), []);
});

test("retirement is staging-only and the storage plan admits the staging-edge name only for a staging migration", async (t) => {
  const f = await fixture(t);
  const target = f.plan.targets[0];
  assert.equal(target.name, stagingEdgeStorageDatabaseName("analytics"));
  // The exact staging-edge name: admitted for staging migrate, refused for production, creation and other names.
  assert.equal(validateStoragePlan(f.plan).targets[0].name, "tibotattle-staging-edge-analytics");
  for (const change of [
    { environment: "production" },
    { phase: "create", targets: [{ ...target, databaseId: null }] },
    { targets: [{ ...target, name: "tibotattle-staging-edge-analytics-2" }] },
    { targets: [{ ...target, name: "tibotattle-staging-edge-ingestion" }] },
    // The exception is the staging storage-ledger roles' only: the other roles keep Wrangler's ledger.
    { targets: [{ ...target, role: "ingestion", name: "tibotattle-staging-edge-ingestion" }] },
    { targets: [{ ...target, role: "control", name: "tibotattle-staging-edge-control" }] },
  ]) {
    assert.throws(() => validateStoragePlan({ ...f.plan, ...change }), { code: "D1_STORAGE_TARGET_INVALID" });
  }
  assert.deepEqual(D1_STORAGE_STAGING_EDGE_ROLES, stagingEdgeStorageRoles().map((role) => role.storageRole));
  // A production-shaped plan for the same database never reaches the adapter's retirement.
  const production = { ...f.plan, environment: "production",
    targets: [{ ...target, name: `tibotattle-production-analytics-${f.plan.operationId}` }] };
  const directory = join(f.operations, "production-adapter");
  await mkdir(directory, { mode: 0o700 });
  const adapter = await createStorageWranglerAdapter({ plan: production, qualifications: {}, directory,
    cliPath: f.wrangler.cliPath, spawn: f.wrangler.spawn });
  await assert.rejects(adapter.retireEmptyWranglerLedger(production.targets[0]),
    { code: "D1_STORAGE_WRANGLER_LEDGER_RETIREMENT_REFUSED" });
  assert.throws(() => assertStagingEdgeStoragePlan(production), { code: "STAGING_EDGE_STORAGE_PLAN_NOT_STAGING_MIGRATION" });
  // Inputs whose analytics D1 is not the staging-edge name do not get a plan.
  const renamed = parseStagingEdgeInputs({ ...RAW_INPUTS, d1: { ...RAW_INPUTS.d1,
    analytics: { ...RAW_INPUTS.d1.analytics, name: "tibotattle-staging-analytics-other" } } });
  assert.throws(() => buildStagingEdgeStoragePlan({ inputs: renamed, role: "analytics", sourceCommit: SOURCE,
    qualificationSha256: f.mirror.qualificationSha256 }), { code: "STAGING_EDGE_STORAGE_DATABASE_NAME_UNADMITTED" });
});

test("render refuses Wrangler for analytics and the storage runner for the Wrangler-ledger roles", async () => {
  assert.throws(() => stagingEdgeMigrationTool("analytics", "wrangler"),
    { code: "STAGING_EDGE_MIGRATION_REQUIRES_STORAGE_RUNNER" });
  for (const role of ["ingestion", "deletion-ledger", "catchupControl", "releaseGuard"]) {
    assert.equal(stagingEdgeMigrationTool(role, "wrangler").ledger, "d1_migrations");
    assert.throws(() => stagingEdgeMigrationTool(role, "storage"), { code: "STAGING_EDGE_MIGRATION_REQUIRES_WRANGLER" });
  }
  assert.throws(() => stagingEdgeMigrationTool("analytics", "raw"), { code: "STAGING_EDGE_MIGRATION_TOOL_INVALID" });
  assert.throws(() => buildStagingEdgeStoragePlan({ inputs: INPUTS, role: "ingestion", sourceCommit: SOURCE,
    qualificationSha256: "d".repeat(64) }), { code: "STAGING_EDGE_MIGRATION_REQUIRES_WRANGLER" });
  const rendered = renderStagingEdgeTemplate({ template: await readStagingEdgeTemplate(), inputs: INPUTS });
  assert.equal(rendered.migrationConfigs.some((entry) => entry.binding === "ANALYTICS_DB"), false);
  assert.equal(rendered.migrationConfigs.some((entry) => entry.config.d1_databases
    .some((database) => database.migrations_dir.endsWith("analytics-migrations"))), false);
  assert.deepEqual(rendered.storageTargets.map((entry) => [entry.role, entry.ledger]), [["analytics", "d1_storage_migrations"]]);
});

test("the staging lock is local, exclusive and owner-checked, and the runner's environment is OAuth with logs off", async (t) => {
  const root = await privateTemp(t, "staging-edge-storage-lock-");
  const lock = createStagingEdgeStorageLock({ operationDirectory: join(root, "operation") });
  const owner = await lock.createOwner({ id: "11111111-1111-4111-8111-111111111111", sourceCommit: SOURCE,
    previousSourceCommit: SOURCE });
  assert.equal(await lock.status(), null);
  await lock.acquire(owner);
  assert.equal(await lock.status(), owner);
  const other = createStagingEdgeStorageLock({ operationDirectory: join(root, "another-operation") });
  await assert.rejects(other.acquire("e".repeat(64)), { code: "STAGING_EDGE_STORAGE_LOCK_BUSY" });
  await assert.rejects(lock.release("e".repeat(64)), { code: "STAGING_EDGE_STORAGE_LOCK_NOT_OWNER" });
  await lock.release(owner);
  assert.equal(await lock.status(), null);
  await chmod(root, 0o755);
  await assert.rejects(lock.status(), { code: "STAGING_EDGE_STORAGE_PRIVATE_DIRECTORY_UNSAFE" });

  assert.doesNotThrow(() => assertStagingEdgeStorageEnvironment({ WRANGLER_WRITE_LOGS: "false" }));
  assert.throws(() => assertStagingEdgeStorageEnvironment({}), { code: "STAGING_EDGE_STORAGE_WRANGLER_WRITE_LOGS_REQUIRED_FALSE" });
  for (const key of ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_API_KEY", "CLOUDFLARE_EMAIL", "CF_API_TOKEN"]) {
    assert.throws(() => assertStagingEdgeStorageEnvironment({ WRANGLER_WRITE_LOGS: "false", [key]: "x" }),
      { code: "STAGING_EDGE_STORAGE_OAUTH_LOGIN_REQUIRED" });
  }
});

test("the qualified mirror must carry exactly the checkout's analytics SQL", async (t) => {
  const root = await privateTemp(t, "staging-edge-storage-mirror-");
  const directory = join(root, "worker", "analytics-migrations");
  await mkdir(directory, { recursive: true });
  const source = join(STAGING_EDGE_WORKER_DIRECTORY, "analytics-migrations");
  const names = (await readdir(source)).filter((name) => name.endsWith(".sql")).sort();
  for (const name of names) await writeFile(join(directory, name), await readFile(join(source, name)));
  assert.equal(await assertQualifiedMirrorMatchesCheckout({ qualifiedWorkerRoot: join(root, "worker"), role: "analytics" }),
    names.length);
  await writeFile(join(directory, names[0]), `${await readFile(join(source, names[0]), "utf8")}\n-- changed\n`);
  await assert.rejects(assertQualifiedMirrorMatchesCheckout({ qualifiedWorkerRoot: join(root, "worker"), role: "analytics" }),
    { code: "STAGING_EDGE_STORAGE_QUALIFIED_MIRROR_NOT_CHECKOUT" });
});

test("the storage subcommands take closed flags: execution needs its confirmation, digest and new private directory", () => {
  const plan = ["--plan", "/private/plan.json", "--qualified-worker-root", "/private/worker", "--cli", "/private/cli.js"];
  const approved = ["--execute", "--confirm", "EXECUTE_REVIEWED_D1_STORAGE_PLAN", "--approved-plan-sha256", "a".repeat(64)];
  assert.equal(parseStagingEdgeArguments(["storage-apply", ...plan]).subcommand, "storage-apply");
  assert.equal(parseStagingEdgeArguments(["storage-apply", ...plan, ...approved, "--operation", "/private/op"]).execute, true);
  assert.equal(parseStagingEdgeArguments(["storage-apply", ...plan, ...approved, "--operation", "/private/op", "--resume"])
    .resume, true);
  assert.equal(parseStagingEdgeArguments(["storage-verify", ...plan]).execute, undefined);
  for (const argv of [
    ["storage-apply", ...plan, "--execute", "--operation", "/private/op"],
    ["storage-apply", ...plan, ...approved],
    ["storage-apply", ...plan, "--operation", "/private/op"],
    ["storage-apply", ...plan, "--resume"],
    ["storage-apply", "--plan", "/private/plan.json", "--cli", "/private/cli.js"],
    ["storage-retire-wrangler-ledger", ...plan, ...approved.slice(0, 3), "--output-directory", "/private/out"],
    ["storage-verify", ...plan, "--output-directory", "/private/out"],
    ["storage-plan", "--role", "analytics", "--inputs", "/private/inputs.json", "--qualified-worker-root", "/private/worker",
      "--qualification-sha256", "a".repeat(64), "--plan-output", "/private/plan.json"],
    ["deploy", "--plan", "/private/plan.json"],
  ]) {
    assert.throws(() => parseStagingEdgeArguments(argv), { code: "STAGING_EDGE_ARGUMENTS_INVALID" }, argv.join(" "));
  }
});
