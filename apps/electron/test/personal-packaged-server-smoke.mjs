// Run with the packaged Electron binary in Node mode and a disposable profile.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const asar = resolve(process.argv[2] ?? "");
const bootstrap = await import(pathToFileURL(join(asar, "apps/electron/personal-bootstrap.js")));
const server = await import(pathToFileURL(join(asar, "apps/local/personal-server.js")));
const root = await mkdtemp(join(await realpath(tmpdir()), "tibotempo-package-smoke-"));
const codexHome = join(root, "codex");
const paths = bootstrap.personalPaths({ appData: root, resourceRoot: asar });
await mkdir(join(codexHome, "sessions"), { recursive: true });
let app;
try {
  await bootstrap.preparePersonalProfile(paths, process.platform);
  const environment = bootstrap.personalEnvironment({
    HOME: root, USERPROFILE: root, CODEX_HOME: codexHome,
    PATH: process.env.PATH ?? "", CODEX_BIN: "/usr/bin/false",
  }, paths, process.platform);
  let networkCalls = 0;
  app = await server.startPersonalCompanion({
    environment, resourceRoot: asar, stateRoot: paths.stateRoot, codexHome, port: 0,
    centralFetch: async () => { networkCalls += 1; throw new Error("unexpected_network"); },
  });
  await app.snapshotReady;
  const origin = "http://127.0.0.1:" + app.port;
  const health = await fetch(origin + "/api/local/health");
  assert.equal(health.status, 200);
  const capabilities = (await health.json()).capabilities;
  assert.equal(capabilities.centralServiceProxy, false);
  assert.equal(capabilities.contributionDevicePairing, false);
  assert.equal(capabilities.incrementalContributionSync, false);
  const icon = await fetch(origin + "/tibotempo.svg");
  assert.equal(icon.status, 200);
  assert.match(icon.headers.get("content-type"), /^image\/svg\+xml/u);
  assert.equal(networkCalls, 0);
  process.stdout.write(JSON.stringify({ packagedServer: "ready", svg: "served", externalCalls: networkCalls }) + "\n");
} finally {
  await app?.close();
  await rm(root, { recursive: true, force: true });
}
