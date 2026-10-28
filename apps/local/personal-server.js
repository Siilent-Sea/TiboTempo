import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { startLocalCompanionServer } from "./server.js";

/** Compose the existing local engine without an upstream service or legacy binding. */
export async function startPersonalCompanion({ environment = process.env, ...options } = {}) {
  const selected = { ...environment };
  delete selected.USAGE_MONITOR_CENTRAL_ORIGIN;
  delete selected.USAGE_MONITOR_ACCOUNTLESS_ORIGIN;
  delete selected.USAGE_MONITOR_ACCOUNTLESS_MODE;
  delete selected.APP_USAGEMONITOR_EXPORT_SECRET;
  return startLocalCompanionServer({
    ...options,
    environment: selected,
    centralOrigin: null,
    contributionServiceOrigin: null,
    legacyContributionDeviceStateFile: null,
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.USAGE_MONITOR_PORT ?? 8787);
  const app = await startPersonalCompanion({ port, terminateProcessOnParentDeath: true });
  process.stdout.write("USAGE_MONITOR_READY http://" + app.host + ":" + app.port + "/\n");
  let closing = false;
  const finish = (code) => {
    if (closing) return;
    closing = true;
    app.server.closeAllConnections?.();
    void app.close().then(() => process.exit(code), () => process.exit(1));
  };
  app.snapshotReady.catch(() => finish(1));
  process.once("SIGINT", () => finish(0));
  process.once("SIGTERM", () => finish(0));
}
