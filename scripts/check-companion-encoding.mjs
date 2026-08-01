import { readFile, readdir } from "node:fs/promises";
import { extname, join } from "node:path";

const roots = [
  "src/companion",
  "src/main/index.ts",
  "src/main/ipc.ts",
  "src/main/services/companionArtwork.ts",
  "src/main/services/companionAuthentication.ts",
  "src/main/services/companionCredentialStore.ts",
  "src/main/services/companionNetwork.ts",
  "src/main/services/companionPairing.ts",
  "src/main/services/companionRemoteManager.ts",
  "src/main/services/companionServer.ts",
  "src/main/services/companionState.ts",
  "src/main/services/liveTvContext.ts",
  "src/main/services/playbackCommandService.ts",
  "src/main/services/playbackContinuationResolver.ts",
  "src/main/services/playbackQueue.ts",
  "src/preload/index.ts",
  "src/shared/companionContracts.ts",
  "src/shared/companionSchemas.ts",
  "src/renderer/app.ts",
  "src/renderer/index.html",
  "src/renderer/styles.css",
  "package.json",
  "vite.companion.config.ts",
  "tsconfig.companion.json",
  "COMPANION_REMOTE.md",
  "README.md",
  "ARCHITECTURE.md",
  "SEEING_STONE_ACCEPTANCE.md",
  "dist/companion",
];
const extensions = new Set([".ts", ".html", ".css", ".json", ".webmanifest", ".svg", ".md"]);
const mojibake = ["â€”", "â€œ", "â€", "Ã—", "44Ã—44"];
const files = [];

async function collect(path) {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    for (const entry of entries) await collect(join(path, entry.name));
  } catch {
    if (extensions.has(extname(path))) files.push(path);
  }
}

for (const root of roots) await collect(root);
const failures = [];
for (const file of files) {
  const source = await readFile(file, "utf8");
  for (const sentinel of mojibake) if (source.includes(sentinel)) failures.push(`${file}: ${sentinel}`);
}
if (failures.length) {
  console.error(`Companion UTF-8 scan failed:\n${failures.join("\n")}`);
  process.exitCode = 1;
} else {
  console.log(`Companion UTF-8 scan passed (${files.length} files).`);
}
