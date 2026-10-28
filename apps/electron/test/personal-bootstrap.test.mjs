import assert from "node:assert/strict";
import { mkdtemp, readFile, chmod, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { configurePersonalAppPaths, personalEnvironment, personalPaths, preparePersonalProfile } from "../personal-bootstrap.js";
import { ensureDesktopFirstRunAcknowledged } from "../desktop-first-run.js";
import { launchDesktopRuntime } from "../desktop-runtime.js";
import { createPersonalIcon } from "../personal-runtime.js";

test("personal profile and companion stay isolated from inherited upstream destinations", async () => {
  const root = await realpath(tmpdir());
  const data = await mkdtemp(join(root, "local-usage-test-"));
  try {
    const paths = personalPaths({ appData: data, resourceRoot: data });
    assert.equal(paths.profile, join(data, "TiboTempo"));
    const changes = [];
    configurePersonalAppPaths({
      setName: (value) => changes.push(["name", value]),
      setPath: (key, value) => changes.push([key, value]),
    }, paths);
    assert.deepEqual(changes, [
      ["name", "TiboTempo"], ["userData", paths.profile], ["sessionData", paths.profile],
    ]);
    const env = personalEnvironment({
      HOME: data, PATH: "/synthetic/bin", CODEX_HOME: join(data, "codex"),
      USAGE_MONITOR_CENTRAL_ORIGIN: "https://example.invalid",
      USAGE_MONITOR_ACCOUNTLESS_MODE: "production-v1",
      APP_USAGEMONITOR_EXPORT_SECRET: "must-not-cross",
      USAGE_MONITOR_STATE_ROOT: join(data, "other-app"),
    }, paths, "darwin");
    assert.equal(env.USAGE_MONITOR_STATE_ROOT, paths.stateRoot);
    assert.equal(env.CODEX_HOME, join(data, "codex"));
    for (const key of ["USAGE_MONITOR_CENTRAL_ORIGIN", "USAGE_MONITOR_ACCOUNTLESS_MODE", "APP_USAGEMONITOR_EXPORT_SECRET"]) {
      assert.equal(Object.hasOwn(env, key), false);
    }
    assert.equal(env.USAGE_MONITOR_DEVELOPMENT_EXPORT_SECRET_FILE, paths.exportIdentity);
    const windows = personalEnvironment({ HOME: data }, paths, "win32");
    assert.equal(Object.hasOwn(windows, "USAGE_MONITOR_TEST_LANE"), false);
    assert.throws(() => personalPaths({ appData: "relative", resourceRoot: data }));
  } finally {
    await rm(data, { recursive: true, force: true });
  }
});

test("personal first-run can present its own copy without defaulting to login at startup", async () => {
  let shown;
  let saved = false;
  const result = await ensureDesktopFirstRunAcknowledged({
    dialog: { showMessageBox: async (options) => { shown = options; return { response: 1 }; } },
    receiptBackend: { load: async () => null, save: async () => { saved = true; } },
    defaultStartAtLogin: false,
    dialogCopy: {
      title: "TiboTempo", message: "Usage", detail: "Local analysis",
      checkboxLabel: "Start at login", failureTitle: "Error", failureMessage: "Error",
      failureDetail: "Check access", buttons: ["Continue", "Quit"],
    },
  });
  assert.equal(shown.title, "TiboTempo");
  assert.equal(shown.checkboxChecked, false);
  assert.equal(result.status, "cancelled");
  assert.equal(saved, false);
});

test("personal privacy and disclosure overrides cannot change a production distribution", async () => {
  const app = { on() {} };
  const paths = {
    companionScript: "/synthetic/companion.js", companionCwd: "/synthetic",
    resourceRoot: "/synthetic", preloadPath: "/synthetic/preload.cjs",
  };
  for (const override of [
    { ignoreLegacyStateRoots: true },
    { firstRunDialogCopy: {} },
    { firstRunStartAtLoginDefault: false },
  ]) {
    await assert.rejects(launchDesktopRuntime({
      runtime: {}, app, paths, productionDistribution: {}, ...override,
    }), { code: "electron_shell_electron_configuration_invalid" });
  }
});

test("the personal tray mark stays visible and uses a template only on macOS", () => {
  for (const platform of ["darwin", "win32"]) {
    let bitmap;
    let template = false;
    const icon = createPersonalIcon({
      createFromBitmap: (bytes, options) => {
        bitmap = Buffer.from(bytes);
        assert.deepEqual(options, { width: 32, height: 32, scaleFactor: 2 });
        return { setTemplateImage: (value) => { template = value; } };
      },
    }, platform);
    assert.ok(icon);
    assert.equal(template, platform === "darwin");
    assert.equal(bitmap[3], 0);
    assert.ok(bitmap.some((value, index) => index % 4 === 3 && value === 255));
  }
});

test("Mac development identities survive restart and reject unsafe identity directories", async () => {
  if (process.platform !== "darwin") return;
  const root = await realpath(tmpdir());
  const data = await mkdtemp(join(root, "local-usage-test-"));
  try {
    const paths = personalPaths({ appData: data, resourceRoot: data });
    await preparePersonalProfile(paths, "darwin");
    const originalExport = await readFile(paths.exportIdentity);
    const originalAccount = await readFile(paths.accountIdentity);
    assert.equal((await stat(paths.identityDirectory)).mode & 0o777, 0o700);
    assert.equal((await stat(paths.exportIdentity)).mode & 0o777, 0o600);
    assert.equal((await stat(paths.accountIdentity)).mode & 0o777, 0o600);
    await preparePersonalProfile(paths, "darwin");
    assert.deepEqual(await readFile(paths.exportIdentity), originalExport);
    assert.deepEqual(await readFile(paths.accountIdentity), originalAccount);
    await chmod(paths.identityDirectory, 0o755);
    await assert.rejects(preparePersonalProfile(paths, "darwin"), /personal_identity_directory_invalid/);
    assert.deepEqual(await readFile(paths.accountIdentity), originalAccount);
  } finally {
    await rm(data, { recursive: true, force: true });
  }
});
