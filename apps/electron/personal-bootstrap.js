import { randomBytes } from "node:crypto";
import { constants, lstatSync, mkdirSync } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

import { loadOrCreateParticipantSecret } from "../../src/platform/index.js";
import { readDevelopmentAccountObservationSecretFile } from "../../src/account-observation-secret.js";

const PROFILE_DIRECTORY = "TiboTempo";
const INHERITED_ENVIRONMENT_KEYS = Object.freeze([
  "PATH", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "PROGRAMDATA",
  "SystemRoot", "WINDIR", "ComSpec", "PATHEXT", "OS", "TEMP", "TMP", "TMPDIR",
  "PROCESSOR_ARCHITECTURE", "PROCESSOR_ARCHITEW6432", "LANG", "LC_ALL", "TZ",
  "CODEX_HOME", "CODEX_BIN",
]);

/** Return only the roots owned by this product, never the original app profile. */
export function personalPaths({ appData, resourceRoot }) {
  if (typeof appData !== "string" || !isAbsolute(appData)
      || typeof resourceRoot !== "string" || !isAbsolute(resourceRoot)) {
    throw new TypeError("absolute application and resource paths are required");
  }
  const profile = join(resolve(appData), PROFILE_DIRECTORY);
  const identityDirectory = join(profile, "identity");
  const root = resolve(resourceRoot);
  return Object.freeze({
    profile,
    stateRoot: join(profile, "companion-state"),
    identityDirectory,
    exportIdentity: join(identityDirectory, "export-identity"),
    accountIdentity: join(identityDirectory, "account-observation-development"),
    resourceRoot: root,
    companionScript: join(root, "apps", "local", "personal-server.js"),
    companionCwd: root,
    preloadPath: join(root, "apps", "electron", "preload.cjs"),
  });
}

/** Ambient hosted destinations and identity overrides never enter this app. */
export function personalEnvironment(environment, paths, platform) {
  if (!environment || typeof environment !== "object" || !paths) {
    throw new TypeError("environment and paths are required");
  }
  const selected = {};
  for (const key of INHERITED_ENVIRONMENT_KEYS) {
    if (typeof environment[key] === "string") selected[key] = environment[key];
  }
  selected.USAGE_MONITOR_RESOURCE_ROOT = paths.resourceRoot;
  selected.USAGE_MONITOR_STATE_ROOT = paths.stateRoot;
  selected.USAGE_MONITOR_ACCOUNTING_SOURCE_MODE = "unified";
  if (platform === "darwin") {
    selected.USAGE_MONITOR_TEST_LANE = "macos-electron-local-qa-v1";
    selected.USAGE_MONITOR_ENABLE_DEVELOPMENT_IDENTITY = "1";
    selected.USAGE_MONITOR_DEVELOPMENT_EXPORT_SECRET_FILE = paths.exportIdentity;
    selected.USAGE_MONITOR_DEVELOPMENT_ACCOUNT_SECRET_FILE = paths.accountIdentity;
  }
  return selected;
}

/** Set Chromium paths before Electron's ready event, even on a slow disk. */
export function configurePersonalAppPaths(app, paths) {
  if (!app || typeof app.setName !== "function" || typeof app.setPath !== "function") {
    throw new TypeError("Electron application is required");
  }
  mkdirSync(paths.profile, { recursive: true, mode: 0o700 });
  const profile = lstatSync(paths.profile);
  if (!profile.isDirectory() || profile.isSymbolicLink()) {
    throw new Error("personal_profile_invalid");
  }
  app.setName("TiboTempo");
  app.setPath("userData", paths.profile);
  app.setPath("sessionData", paths.profile);
}

/** Create only new, independent Mac development identities; never rotate an existing one. */
export async function preparePersonalProfile(paths, platform = process.platform) {
  await mkdir(paths.profile, { recursive: true, mode: 0o700 });
  const profile = await lstat(paths.profile);
  if (!profile.isDirectory() || profile.isSymbolicLink()) {
    throw new Error("personal_profile_invalid");
  }
  if (platform !== "darwin") return;
  await mkdir(paths.identityDirectory, { recursive: true, mode: 0o700 });
  const identity = await lstat(paths.identityDirectory);
  if (!identity.isDirectory() || identity.isSymbolicLink()
      || (identity.mode & 0o777) !== 0o700
      || typeof process.getuid !== "function" || identity.uid !== process.getuid()
      || await realpath(paths.identityDirectory) !== paths.identityDirectory) {
    throw new Error("personal_identity_directory_invalid");
  }
  const exportIdentity = await loadOrCreateParticipantSecret({
    environmentSecret: null, secretFile: paths.exportIdentity, legacySecretFile: null,
  });
  exportIdentity.secret?.fill?.(0);
  let handle;
  const secret = randomBytes(32);
  try {
    try {
      handle = await open(paths.accountIdentity,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
      await handle.writeFile(secret);
      await handle.sync();
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
  } finally {
    secret.fill(0);
    await handle?.close();
  }
  const checked = await readDevelopmentAccountObservationSecretFile(paths.accountIdentity, {
    exportIdentityFile: paths.exportIdentity,
  });
  checked.fill(0);
}
