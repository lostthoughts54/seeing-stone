"use strict";
// Read setup from stdin only. Never put account details in an argument, source file or report.
const { spawn } = require("node:child_process");
const { createServer, connect } = require("node:net");
const { randomUUID } = require("node:crypto");
const { join, resolve } = require("node:path");
const { mkdirSync, writeFileSync, readFileSync } = require("node:fs");
const root = resolve(__dirname, "..");
let stage = "startup";
if (!process.versions.electron) {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const input = readFileSync(0);
  // Windows GUI Electron does not reliably inherit stdin. Transfer once over an opaque local pipe.
  const pipeName = `\\\\.\\pipe\\seeing-stone-iptv-${randomUUID()}`;
  let delivered = false;
  const server = createServer(socket => {
    if (delivered) { socket.destroy(); return; }
    delivered = true;
    socket.on("error", () => {});
    socket.end(input, () => input.fill(0));
    server.close();
  });
  server.listen(pipeName, () => {
    const child = spawn(require("electron"), [__filename, "--account-check-child", `--input-pipe=${pipeName}`], { cwd: root, env, stdio: "inherit", windowsHide: true });
    const timer = setTimeout(() => child.kill(), 600000);
    child.on("error", () => { clearTimeout(timer); input.fill(0); server.close(); console.error("Account check could not start."); process.exitCode = 1; });
    child.on("exit", code => { clearTimeout(timer); input.fill(0); server.close(); process.exitCode = code ?? 1; });
  });
} else {
  run().catch(error => { console.error(`Account check failed during ${stage} (${error?.name === "ZodError" ? "invalid setup" : error?.code && /^[A-Z_]+$/.test(error.code) ? error.code : "runtime error"}). No provider credentials were written to the report.`); require("electron").app.exit(1); });
}

async function run() {
  const { app } = require("electron");
  if (!process.argv.includes("--account-check-child")) throw new Error("Wrapper required");
  app.disableHardwareAcceleration(); app.commandLine.appendSwitch("disable-gpu");
  app.setPath("userData", join(app.getPath("appData"), "Seeing Stone"));
  if (!app.requestSingleInstanceLock()) { console.error("Close the IPTV preview before running the account check."); app.exit(1); return; }
  stage = "reading setup";
  let input = "";
  const pipeName = process.argv.find(value => value.startsWith("--input-pipe="))?.slice("--input-pipe=".length);
  if (!pipeName || !pipeName.startsWith("\\\\.\\pipe\\seeing-stone-iptv-")) throw new Error("Input pipe required");
  const incoming = connect(pipeName);
  incoming.setTimeout(10000, () => incoming.destroy(new Error("Input timeout")));
  for await (const chunk of incoming) {
    input += chunk.toString("utf8");
    if (input.length > 32768) throw new Error("Input limit");
  }
  stage = "validating setup";
  const { iptvSetupSchema } = require("../dist/shared/iptv.js");
  const request = JSON.parse(input.replace(/^\uFEFF/, "")); input = "";
  const useSaved = request.useSaved === true;
  let setup = useSaved ? null : iptvSetupSchema.parse(request);
  stage = "initializing Windows storage";
  await app.whenReady();
  const { createSafeStorageProtector } = require("../dist/main/electronSecurity.js");
  const { SqlitePersistenceService } = require("../dist/main/services/persistence.js");
  const { IptvProviderStore } = require("../dist/main/services/iptvProviderStore.js");
  const { IptvService } = require("../dist/main/services/iptvService.js");
  const persistence = new SqlitePersistenceService(app.getPath("userData"));
  const store = new IptvProviderStore(persistence, createSafeStorageProtector());
  const service = new IptvService(store, persistence);
  const output = join(root, "artifacts", "iptv-beta"); mkdirSync(output, { recursive: true });
  let exitCode = 1;
  try {
    stage = "saving protected provider";
    const provider = useSaved ? (await store.list()).find(row => row.kind === "xtream") : await service.setup(setup); setup = null;
    if (!provider) throw new Error("No saved provider");
    if (useSaved) await service.refresh(provider.providerId);
    stage = "testing provider";
    const deadline = Date.now() + 9 * 60 * 1000;
    let previous = ""; let status;
    while (Date.now() < deadline) {
      status = (await service.list()).find(row => row.provider.providerId === provider.providerId);
      const progress = `${status.phase}: ${status.imported.toLocaleString()} catalogue entries received`;
      if (progress !== previous) { console.log(progress); previous = progress; }
      if (["ready", "failed"].includes(status.phase)) break;
      await new Promise(resolveDelay => setTimeout(resolveDelay, 2000));
    }
    const checks = {};
    if (status?.phase === "ready") {
      for (const contentType of ["live", "movie", "series"]) {
        const start = performance.now();
        const first = await service.catalogue({ providerId: provider.providerId, contentType });
        const groups = await service.groups(provider.providerId, contentType);
        const second = first.nextCursor ? await service.catalogue({ providerId: provider.providerId, contentType, cursor: first.nextCursor }) : null;
        const identifiers = new Set(first.items.map(item => item.identity.itemId));
        const noDuplicates = !second || second.items.every(item => !identifiers.has(item.identity.itemId));
        const title = first.items[0]?.name;
        const search = title ? await service.catalogue({ providerId: provider.providerId, contentType, query: title.slice(0, 100) }) : null;
        checks[contentType] = { firstPage: first.items.length, secondPage: second?.items.length ?? 0, categories: groups.length, noDuplicatePageItems: noDuplicates, titleSearchFound: !title || !!search?.items.some(item => item.name === title), checksElapsedMs: Math.round(performance.now() - start) };
        if (!noDuplicates || !checks[contentType].titleSearchFound) throw new Error("Catalogue check failed");
      }
      exitCode = 0;
    }
    const report = { testedAt: new Date().toISOString(), phase: status?.phase ?? "timeout", message: status?.message ?? "Account check timed out.", counts: status?.counts ?? null, lastSuccessfulAt: status?.lastSuccessfulAt ?? null, checks };
    writeFileSync(join(output, "account-check.json"), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  } finally { await service.shutdown(); await persistence.close(); }
  app.exit(exitCode);
}
