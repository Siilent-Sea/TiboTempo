#!/usr/bin/env node
// Build an unsigned, private development directory from the reviewed upstream
// runtime closure and the personal entrypoint. This never installs or publishes.
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { copyFile, mkdir, mkdtemp, open, readFile, rename, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildElectronApp } from "./build-electron-app.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const ownFiles = Object.freeze([
  "apps/electron/personal-bootstrap.js",
  "apps/electron/personal-runtime.js",
  "apps/electron/personal-main.js",
  "apps/electron/assets/tibotempo.png",
  "apps/local/personal-server.js",
  "LICENSE",
]);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

function targetFromArguments(args) {
  if (args.length > 2 || (args.length === 2 && args[0] !== "--target") || args.length === 1) {
    throw new TypeError("Expected no arguments or --target with a supported target");
  }
  const target = args[1] ?? (process.platform === "win32" ? "win32-x64" : "darwin-arm64");
  if (!["darwin-arm64", "win32-x64"].includes(target)) throw new TypeError("Unsupported development target");
  return target;
}

async function runBuilder(target, stage, output) {
  const command = process.execPath;
  const args = [
    require.resolve("electron-builder/cli.js"),
    "--config", join(root, "apps/electron/personal-builder.config.cjs"),
    target === "win32-x64" ? "--win" : "--mac",
    target === "win32-x64" ? "--x64" : "--arm64",
    "--dir", "--publish", "never",
  ];
  const child = spawn(command, args, {
    cwd: root,
    env: {
      ...process.env,
      LOCAL_USAGE_STAGE: stage,
      LOCAL_USAGE_OUTPUT: output,
      TIBOTATTLE_ELECTRON_TARGET: target,
      NODE_USE_ENV_PROXY: "1",
    },
    stdio: "inherit",
    windowsHide: true,
  });
  await new Promise((resolveRun, rejectRun) => {
    child.once("error", rejectRun);
    child.once("close", (code, signal) => {
      if (code === 0) resolveRun();
      else rejectRun(new Error("Personal builder failed: " + (signal ?? code)));
    });
  });
}

async function runPackagedServerSmoke(executable, asar) {
  const child = spawn(executable, [
    join(root, "apps/electron/test/personal-packaged-server-smoke.mjs"), asar,
  ], {
    cwd: root,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    stdio: "inherit",
    windowsHide: true,
  });
  await new Promise((resolveRun, rejectRun) => {
    child.once("error", rejectRun);
    child.once("close", (code, signal) => {
      if (code === 0) resolveRun();
      else rejectRun(new Error("Packaged companion smoke failed: " + (signal ?? code)));
    });
  });
}

// Read just named files from ASAR; never interpret or execute the bundled code.
async function readAsarFile(path, relativePath) {
  const handle = await open(path, "r");
  try {
    const first = Buffer.alloc(16);
    if ((await handle.read(first, 0, 16, 0)).bytesRead !== 16) throw new Error("Invalid ASAR header");
    const headerSize = first.readUInt32LE(4);
    const jsonSize = first.readUInt32LE(12);
    if (jsonSize < 2 || jsonSize > 32 * 1024 * 1024 || headerSize < jsonSize + 8) {
      throw new Error("Invalid ASAR index");
    }
    const json = Buffer.alloc(jsonSize);
    if ((await handle.read(json, 0, jsonSize, 16)).bytesRead !== jsonSize) throw new Error("Truncated ASAR index");
    let node = JSON.parse(json.toString("utf8"));
    for (const component of relativePath.split("/")) node = node?.files?.[component];
    if (!node || node.unpacked || !Number.isSafeInteger(node.size)
        || node.size < 0 || node.size > 1024 * 1024 || !/^\d+$/u.test(node.offset ?? "")) {
      throw new Error("Personal ASAR entry is missing or invalid");
    }
    const offset = Number(node.offset);
    if (!Number.isSafeInteger(offset)) throw new Error("Invalid ASAR offset");
    const bytes = Buffer.alloc(node.size);
    if ((await handle.read(bytes, 0, node.size, 8 + headerSize + offset)).bytesRead !== node.size) {
      throw new Error("Truncated ASAR entry");
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

async function main() {
  const target = targetFromArguments(process.argv.slice(2));
  if ((target === "darwin-arm64" && (process.platform !== "darwin" || process.arch !== "arm64"))
      || (target === "win32-x64" && (process.platform !== "win32" || process.arch !== "x64"))) {
    throw new Error("Build the development package on its matching host");
  }
  const base = join(root, ".release-build", "personal-dev");
  await mkdir(base, { recursive: true });
  const workspace = await mkdtemp(join(base, "build-"));
  const stage = join(workspace, "app");
  const output = join(workspace, "artifacts");
  const staged = await buildElectronApp({
    output: stage, target, packagingProfile: "development",
  });
  // Preserve the upstream closure receipt beside the build; it describes the
  // original staged core, not the modified personal application package.
  const upstreamReceipt = join(workspace, "upstream-core-manifest.json");
  await rename(staged.manifestPath, upstreamReceipt);
  const expected = {};
  for (const name of ownFiles) {
    const source = join(root, ...name.split("/"));
    const destination = join(stage, ...name.split("/"));
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(source, destination, constants.COPYFILE_EXCL);
    expected[name] = hash(await readFile(source));
  }
  const brandSvg = "apps/web/public/tibotempo.svg";
  expected[brandSvg] = hash(await readFile(join(root, brandSvg)));
  if (hash(await readFile(join(stage, brandSvg))) !== expected[brandSvg]) {
    throw new Error("Staged brand asset mismatch");
  }
  const manifest = {
    schema: "local-usage-development-build-v1",
    version: "0.0.1",
    target,
    upstreamReceiptSha256: hash(await readFile(upstreamReceipt)),
    personalFiles: expected,
  };
  await writeFile(join(stage, "local-usage-build.json"), JSON.stringify(manifest, null, 2) + "\n", { flag: "wx" });
  await runBuilder(target, stage, output);
  const asar = target === "darwin-arm64"
    ? join(output, "mac-arm64", "TiboTempo.app", "Contents", "Resources", "app.asar")
    : join(output, "win-unpacked", "resources", "app.asar");
  for (const [name, expectedHash] of Object.entries(expected)) {
    if (hash(await readAsarFile(asar, name)) !== expectedHash) throw new Error("Packaged personal input mismatch");
  }
  const pkg = JSON.parse((await readAsarFile(asar, "package.json")).toString("utf8"));
  if (pkg.name !== "tibotempo" || pkg.main !== "apps/electron/personal-main.js"
      || pkg.tibotempoChannel !== "local-development-v1"
      || pkg.tibotempoSourceReleaseVersion !== staged.manifest.releaseVersion) {
    throw new Error("Packaged application identity mismatch");
  }
  const asarHash = hash(await readFile(asar));
  let packagedServerSmoke = "not_run";
  if (target === "darwin-arm64") {
    const executable = join(output, "mac-arm64", "TiboTempo.app", "Contents", "MacOS", "TiboTempo");
    await runPackagedServerSmoke(executable, asar);
    packagedServerSmoke = "passed";
  }
  const result = { target, workspace, output, asarSha256: asarHash, version: pkg.version, packagedServerSmoke };
  await writeFile(join(workspace, "result.json"), JSON.stringify(result, null, 2) + "\n", { flag: "wx" });
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
}

try {
  await main();
} catch (error) {
  process.stderr.write("Personal development build failed: " + (error?.message ?? "unknown") + "\n");
  process.exitCode = 1;
}
