import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { personalEnvironment, personalPaths, preparePersonalProfile } from "../electron/personal-bootstrap.js";
import { startPersonalCompanion } from "./personal-server.js";
import { writeSyntheticPerformanceFixture } from "../electron/test/personal-fixture.mjs";

test("personal HTTP report measures model speed and TTFT without counting copied fork history", {
  skip: process.platform !== "darwin",
  timeout: 20_000,
}, async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), "tibotempo-performance-test-"));
  const resourceRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
  const codexHome = join(root, "codex");
  const sessions = join(codexHome, "sessions");
  const paths = personalPaths({ appData: root, resourceRoot });
  await mkdir(sessions, { recursive: true });
  await preparePersonalProfile(paths, "darwin");
  await writeSyntheticPerformanceFixture(codexHome);
  let app;
  try {
    const environment = personalEnvironment({
      HOME: root, PATH: process.env.PATH ?? "", CODEX_HOME: codexHome, CODEX_BIN: "/usr/bin/false",
    }, paths, "darwin");
    app = await startPersonalCompanion({
      environment, resourceRoot, stateRoot: paths.stateRoot, codexHome, port: 0,
    });
    await app.snapshotReady;
    const url = "http://127.0.0.1:" + app.port
      + "/api/local/model-performance?period=7&speedMode=standard&timeZone=Asia%2FShanghai";
    const deadline = Date.now() + 12_000;
    let result;
    do {
      const response = await fetch(url);
      assert.equal(response.status, 200);
      result = await response.json();
      if (result.status === "ready" && !result.collecting && !result.stale && result.models.length === 2) break;
      await new Promise((done) => setTimeout(done, 30));
    } while (Date.now() < deadline);
    assert.equal(result.status, "ready");
    assert.equal(result.timeZone, "Asia/Shanghai");
    assert.equal(result.models.length, 2);
    for (const model of result.models) {
      assert.equal(model.turns, 6, model.id + " should not include the copied parent");
      assert.equal(model.speedTurns, 6);
      assert.equal(model.ttftTurns, 6);
      assert.equal(model.speed[0].points[0].median, 100);
      assert.equal(model.ttft[0].median, 0.2);
    }
  } finally {
    await app?.close();
    await rm(root, { recursive: true, force: true });
  }
});
