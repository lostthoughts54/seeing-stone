"use strict";

const { createHash } = require("node:crypto");
const { readFileSync, writeFileSync } = require("node:fs");
const { join, resolve } = require("node:path");

const root = resolve(__dirname, "..");
const services = join(root, "dist", "main", "services");
const files = ["persistenceWorker.js", "persistenceTypes.js"];
const manifest = {
  schemaVersion: 1,
  algorithm: "sha256",
  files: Object.fromEntries(files.map((file) => [
    file,
    createHash("sha256").update(readFileSync(join(services, file))).digest("hex"),
  ])),
};

writeFileSync(
  join(services, "persistence-worker-integrity.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
  { encoding: "utf8", mode: 0o600 },
);
