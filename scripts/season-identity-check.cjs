"use strict";
const { join } = require("node:path");
let stage = "startup";
if (!process.versions.electron) {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const result = require("node:child_process").spawnSync(require("electron"), [__filename], { env, windowsHide: true, stdio: "inherit", timeout: 120000 });
  process.exitCode = result.status ?? 1;
} else run().catch(() => { console.error(`Season check could not finish (${stage}); no session details exposed.`); require("electron").app.exit(1); });
async function run() {
  const { app } = require("electron");
  const { existsSync, statSync } = require("node:fs");
  const profile = ["Seeing Stone", "Seeing Stone IPTV Beta", "LocalFirst Jellyfin"].map(name => join(app.getPath("appData"), name))
    .filter(path => existsSync(join(path, "session.safe"))).sort((a, b) => statSync(join(b, "session.safe")).mtimeMs - statSync(join(a, "session.safe")).mtimeMs)[0];
  if (!profile) throw new Error();
  app.setPath("userData", profile); app.disableHardwareAcceleration();
  await app.whenReady();
  const { SecureSessionStore } = require("../dist/main/services/secureSession.js");
  const { createSafeStorageProtector } = require("../dist/main/electronSecurity.js");
  stage = "protected session restore";
  const saved = await new SecureSessionStore(profile, createSafeStorageProtector()).restore();
  if (!saved) throw new Error();
  const request = async (path, query = {}) => {
    const url = new URL(saved.serverUrl.replace(/\/$/, "") + path);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    const response = await fetch(url, { headers: { "X-Emby-Token": saved.accessToken }, signal: AbortSignal.timeout(20000) });
    if (!response.ok) { stage = `HTTP ${response.status}`; throw new Error(); }
    return response.json();
  };
  stage = "series lookup";
  const series = (await request(`/Users/${saved.userId}/Items`, { SearchTerm: "Abbott Elementary", IncludeItemTypes: "Series", Recursive: "true", Limit: "5" })).Items;
  const report = [];
  const { SqlitePersistenceService } = require("../dist/main/services/persistence.js");
  const { OfflineSynchronizationService } = require("../dist/main/services/offlineSynchronization.js");
  const { sanitizeMediaItem } = require("../dist/main/services/jellyfinApi.js");
  const directory = require("node:fs").mkdtempSync(join(require("node:os").tmpdir(), "ss-season-check-"));
  const persistence = new SqlitePersistenceService(directory);
  const identity = { serverId: "season-check-server", userId: "season-check-user", serverAddress: "http://127.0.0.1", serverName: "Season check", userName: "Test" };
  await persistence.upsertCatalogIdentity(identity);
  const sync = new OfflineSynchronizationService({ getAuthenticatedContext: () => identity }, persistence, { info() {}, warn() {}, error() {} });
  for (const show of series.slice(0, 2)) {
    const seasons = (await request(`/Shows/${show.Id}/Seasons`, { UserId: saved.userId })).Items;
    for (const season of seasons) {
      stage = "episode identity comparison";
      const episodes = (await request(`/Shows/${show.Id}/Episodes`, { UserId: saved.userId, SeasonId: season.Id, Fields: "SeriesId,SeasonId,ParentIndexNumber" })).Items;
      const norm = value => String(value ?? "").replaceAll("-", "").toLowerCase();
      const cached = await sync.cacheEpisodes(show.Id, season.Id, episodes.map(sanitizeMediaItem));
      if (cached.length !== episodes.length || cached.some((item, index) => item.seasonId !== episodes[index].SeasonId)) throw new Error();
      report.push({ season: season.IndexNumber, episodes: episodes.length, missingSeries: episodes.filter(e => !e.SeriesId).length, missingSeason: episodes.filter(e => !e.SeasonId).length, seriesMismatch: episodes.filter(e => e.SeriesId && e.SeriesId !== show.Id).length, seasonMismatch: episodes.filter(e => e.SeasonId && e.SeasonId !== season.Id).length, normalizedSeriesMismatch: episodes.filter(e => e.SeriesId && norm(e.SeriesId) !== norm(show.Id)).length, normalizedSeasonMismatch: episodes.filter(e => e.SeasonId && norm(e.SeasonId) !== norm(season.Id)).length, returnedSeasonNumbers: [...new Set(episodes.map(e => e.ParentIndexNumber))] });
    }
  }
  await sync.shutdown(); await persistence.close();
  console.log(JSON.stringify({ cacheValidationPassed: true, seasons: report })); app.exit(0);
}
