import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const personal = Object.freeze({
  name: "tibotempo",
  productName: "TiboTempo",
  type: "module",
  version: "0.0.1",
  tibotempoChannel: "local-development-v1",
  tibotempoSourceReleaseVersion: "0.1.29",
});

async function withFixture(manifest, run) {
  const root = await mkdtemp(join(tmpdir(), "personal-release-metadata-"));
  try {
    await mkdir(join(root, "config"));
    for (const name of ["release-manifest.js", "product-brand.js"]) {
      await copyFile(new URL("../config/" + name, import.meta.url), join(root, "config", name));
    }
    await writeFile(join(root, "package.json"), JSON.stringify(manifest));
    await run(pathToFileURL(join(root, "config", "release-manifest.js")).href);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("personal package keeps its own version while the reused engine retains its source version", async () => {
  await withFixture(personal, async (entry) => {
    const result = await import(entry);
    assert.equal(result.RELEASE_VERSION, "0.1.29");
    assert.equal(result.RELEASE_TAG, "v0.1.29");
  });
});

test("malformed or mixed personal and upstream distribution identities fail closed", async () => {
  for (const changed of [
    { productName: "TiboTattle" },
    { tibotempoChannel: "production" },
    { tibotempoSourceReleaseVersion: "not-a-version" },
    { tibotattleDistribution: {} },
    { tibotattleSourceReleaseVersion: "0.1.29" },
    { name: "app-usagemonitor" },
  ]) {
    await withFixture({ ...personal, ...changed }, async (entry) => {
      await assert.rejects(import(entry), /Invalid app-usagemonitor release metadata/);
    });
  }
});
