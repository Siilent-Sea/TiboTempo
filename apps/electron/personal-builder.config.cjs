const path = require("node:path");
const base = require("./electron-builder.config.cjs");

const root = path.resolve(__dirname, "../..");
const sourceVersion = require(path.join(root, "package.json")).version;
const permitted = path.join(root, ".release-build", "personal-dev");
const inside = (value) => {
  if (typeof value !== "string" || !path.isAbsolute(value)) return false;
  const rel = path.relative(permitted, path.resolve(value));
  return rel !== "" && rel !== ".." && !rel.startsWith(".." + path.sep) && !path.isAbsolute(rel);
};
const app = process.env.LOCAL_USAGE_STAGE;
const output = process.env.LOCAL_USAGE_OUTPUT;
if (!inside(app) || !inside(output)) throw new Error("Personal build requires task-owned output paths");

const { icon: ignoredIcon, mac: oldMac, directories: ignoredDirectories, ...config } = base;
void ignoredIcon;
void ignoredDirectories;
const { icon: ignoredMacIcon, ...mac } = oldMac ?? {};
void ignoredMacIcon;
const files = base.files.map((entry) => ({
  ...entry,
  filter: entry.from === "." ? [...entry.filter, "LICENSE", "local-usage-build.json"] : [...entry.filter],
}));
const dollar = "$";
module.exports = {
  ...config,
  appId: "dev.tibotempo.desktop",
  productName: "TiboTempo",
  artifactName: "TiboTempo-" + dollar + "{version}-" + dollar + "{os}-" + dollar + "{arch}." + dollar + "{ext}",
  icon: path.join(root, "apps/electron/assets/tibotempo.png"),
  directories: { app, output },
  files,
  extraMetadata: {
    main: "apps/electron/personal-main.js",
    name: "tibotempo",
    productName: "TiboTempo",
    version: "0.0.1",
    tibotempoChannel: "local-development-v1",
    tibotempoSourceReleaseVersion: sourceVersion,
  },
  ...(oldMac ? { mac: { ...mac, icon: path.join(root, "apps/electron/assets/tibotempo.png") } } : {}),
  publish: null,
};
