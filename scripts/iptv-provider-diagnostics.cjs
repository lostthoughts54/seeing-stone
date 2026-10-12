"use strict";
// Inspect the saved preview account without accepting or printing credentials.
const { join } = require("node:path");
if (!process.versions.electron) {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const result = require("node:child_process").spawnSync(require("electron"), [__filename], { env, windowsHide: true, stdio: "inherit", timeout: 180000 });
  process.exitCode = result.status ?? 1;
} else {
  run().catch(() => { console.error("Provider diagnostics failed; no upstream details exposed."); require("electron").app.exit(1); });
}
async function run() {
  const { app } = require("electron");
  app.disableHardwareAcceleration();
  const profile = join(app.getPath("appData"), "Seeing Stone");
  app.setPath("userData", profile);
  if (!app.requestSingleInstanceLock()) throw new Error("Close preview first");
  await app.whenReady();
  const { SqlitePersistenceService } = require("../dist/main/services/persistence.js");
  const { IptvProviderStore } = require("../dist/main/services/iptvProviderStore.js");
  const { createSafeStorageProtector } = require("../dist/main/electronSecurity.js");
  const { jsonArray } = require("../dist/main/services/iptvProviderClient.js");
  const persistence = new SqlitePersistenceService(profile);
  try {
    const store = new IptvProviderStore(persistence, createSafeStorageProtector());
    const provider = (await store.list()).find(row => row.kind === "xtream");
    if (!provider) throw new Error("No saved account");
    const setup = await store.readConfiguration(provider.providerId);
    const report = {};
    let category = null;
    for (const action of ["get_vod_categories", "get_vod_streams", "get_vod_streams_by_category"]) {
      if (action.endsWith("_by_category") && !category) continue;
      const url = new URL(setup.address);
      url.pathname = url.pathname.replace(/\/(?:player_api|get|xmltv)\.php\/?$/i, "").replace(/\/$/, "") + "/player_api.php";
      url.searchParams.set("username", setup.username); url.searchParams.set("password", setup.password);
      url.searchParams.set("action", action.replace("_by_category", ""));
      if (action.endsWith("_by_category")) url.searchParams.set("category_id", category);
      const response = await fetch(url, { signal: AbortSignal.timeout(60000), redirect: "error" });
      let count = 0;
      for await (const row of jsonArray(response)) {
        count++;
        if (action === "get_vod_categories" && !category && /^\d+$/.test(String(row.category_id))) category = String(row.category_id);
      }
      report[action] = { httpStatus: response.status, entries: count };
    }
    console.log(JSON.stringify(report, null, 2));
    require("node:fs").writeFileSync(join(__dirname, "../artifacts/iptv-beta/provider-diagnostics.json"), JSON.stringify(report, null, 2));
  } finally { await persistence.close(); }
  app.exit(0);
}
