import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { personalEnvironment, personalPaths, preparePersonalProfile } from "../electron/personal-bootstrap.js";
import { startPersonalCompanion } from "./personal-server.js";

test("personal companion starts on loopback without enabling inherited hosted configuration", {
  skip: process.platform !== "darwin",
}, async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), "local-usage-server-test-"));
  const resourceRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
  const codexHome = join(root, "codex");
  const paths = personalPaths({ appData: root, resourceRoot });
  await mkdir(join(codexHome, "sessions"), { recursive: true });
  await preparePersonalProfile(paths, "darwin");
  let networkCalls = 0;
  let app;
  try {
    const environment = {
      ...personalEnvironment({ HOME: root, PATH: process.env.PATH ?? "", CODEX_HOME: codexHome }, paths, "darwin"),
      USAGE_MONITOR_CENTRAL_ORIGIN: "https://invalid.example",
      USAGE_MONITOR_ACCOUNTLESS_MODE: "production-v1",
      APP_USAGEMONITOR_EXPORT_SECRET: "not-a-secret-for-this-test",
    };
    app = await startPersonalCompanion({
      environment, resourceRoot, stateRoot: paths.stateRoot, codexHome, port: 0,
      centralOrigin: "https://invalid.example",
      contributionServiceOrigin: "https://invalid.example",
      legacyContributionDeviceStateFile: join(root, "unrelated-legacy-record"),
      centralFetch: async () => { networkCalls += 1; throw new Error("unexpected_network"); },
    });
    await app.snapshotReady;
    const response = await fetch("http://127.0.0.1:" + app.port + "/api/local/desktop-status");
    assert.equal(response.status, 200);
    assert.equal(networkCalls, 0);
  } finally {
    await app?.close();
    await rm(root, { recursive: true, force: true });
  }
});
