import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertLicensePolicy,
  evaluateLicensePolicy,
  loadDependencyManifest,
} from "../scripts/license-audit.mjs";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "seeing-stone-license-audit-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("dependency manifest failures", () => {
  it("fails when an expected manifest is missing", async () => {
    const directory = await temporaryDirectory();
    await expect(loadDependencyManifest(join(directory, "missing.json"), "missing-fixture"))
      .rejects.toThrow("Dependency manifest for missing-fixture is unreadable (ENOENT).");
  });

  it("fails when an expected manifest cannot be read as a file", async () => {
    const directory = await temporaryDirectory();
    const manifest = join(directory, "package.json");
    await mkdir(manifest);
    await expect(loadDependencyManifest(manifest, "unreadable-fixture"))
      .rejects.toThrow(/Dependency manifest for unreadable-fixture is unreadable \([A-Z]+\)\./);
  });

  it("fails when a manifest contains malformed JSON", async () => {
    const directory = await temporaryDirectory();
    const manifest = join(directory, "package.json");
    await writeFile(manifest, '{"name":"broken",');
    await expect(loadDependencyManifest(manifest, "broken-fixture"))
      .rejects.toThrow("Dependency manifest for broken-fixture contains malformed JSON.");
  });

  it("fails when a valid manifest omits a required license", async () => {
    const directory = await temporaryDirectory();
    const manifest = join(directory, "package.json");
    await writeFile(manifest, JSON.stringify({ name: "missing-license", version: "1.0.0" }));
    await expect(loadDependencyManifest(manifest, "missing-license-fixture"))
      .rejects.toThrow("missing required field(s): license");
  });
});

describe("explicit SPDX license policy", () => {
  it.each([
    "BUSL-1.1",
    "SSPL-1.0",
    "PolyForm-Noncommercial-1.0.0",
    "Elastic-2.0",
    "MIT AND Commons Clause",
    "CC-BY-NC-4.0",
    "noncommercial",
    "Proprietary",
    "UNKNOWN",
    "UNLICENSED",
    "SEE LICENSE IN LICENSE.txt",
  ])("rejects restricted license text %s", (license) => {
    expect(evaluateLicensePolicy(license)).toMatchObject({
      approved: false,
      reason: "restricted or non-redistributable license",
    });
  });

  it("accepts an explicitly reviewed compound expression", () => {
    expect(evaluateLicensePolicy("(MIT OR CC0-1.0)")).toEqual({
      approved: true,
      reason: "explicitly reviewed SPDX compound expression",
    });
  });

  it("does not infer approval for an arbitrary compound expression", () => {
    expect(evaluateLicensePolicy("MIT OR Apache-2.0")).toEqual({
      approved: false,
      reason: "compound license expression has not been explicitly reviewed",
    });
  });

  it("fails the aggregate audit when any package is restricted", () => {
    expect(() => assertLicensePolicy([
      { name: "safe", version: "1.0.0", license: "MIT" },
      { name: "restricted", version: "2.0.0", license: "SSPL-1.0" },
    ])).toThrow(/restricted@2\.0\.0: SSPL-1\.0/);
  });
});
