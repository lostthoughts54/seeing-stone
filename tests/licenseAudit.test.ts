import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertLicensePolicy,
  evaluateLicensePolicy,
  loadDependencyManifest,
  loadLegalComponents,
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

describe("versioned legal component manifest", () => {
  async function fixture(componentOverrides: Record<string, unknown> = {}): Promise<{ directory: string; manifest: string }> {
    const directory = await temporaryDirectory();
    const artifact = "font.woff2";
    const licenseFile = "OFL.txt";
    const artifactContent = "verified-font-fixture";
    const licenseContent = "Open Font License fixture";
    const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
    await writeFile(join(directory, artifact), artifactContent);
    await writeFile(join(directory, licenseFile), licenseContent);
    const component = {
      category: "font",
      name: "Fixture Font",
      version: "1.0.0",
      license: "OFL-1.1",
      projectUrl: "https://example.invalid/fixture-font",
      sourceRevision: "1111111111111111111111111111111111111111",
      redistributionStatus: "source-and-binary",
      artifacts: [{ path: artifact, sha256: sha256(artifactContent) }],
      licenseFile: { path: licenseFile, sha256: sha256(licenseContent) },
      ...componentOverrides,
    };
    const manifest = join(directory, "legal-components.json");
    await writeFile(manifest, JSON.stringify({ schemaVersion: 1, components: [component] }));
    return { directory, manifest };
  }

  it("accepts pinned, hashed, redistributable font provenance", async () => {
    const value = await fixture();
    await expect(loadLegalComponents(value.manifest, value.directory)).resolves.toMatchObject([{
      category: "font",
      name: "Fixture Font",
      license: "OFL-1.1",
      redistributionStatus: "source-and-binary",
    }]);
  });

  it("fails unknown categories and redistribution statuses", async () => {
    const category = await fixture({ category: "theme" });
    await expect(loadLegalComponents(category.manifest, category.directory)).rejects.toThrow("unknown category: theme");
    const status = await fixture({ redistributionStatus: "private-binary" });
    await expect(loadLegalComponents(status.manifest, status.directory)).rejects.toThrow("unknown redistribution status: private-binary");
  });

  it("fails proprietary component licenses before generating notices", async () => {
    const value = await fixture({ license: "Proprietary" });
    await expect(loadLegalComponents(value.manifest, value.directory)).rejects.toThrow(/Proprietary.*restricted or non-redistributable/);
  });

  it("fails missing artifacts and incorrect hashes", async () => {
    const missing = await fixture({ artifacts: [{ path: "missing.woff2", sha256: "0".repeat(64) }] });
    await expect(loadLegalComponents(missing.manifest, missing.directory)).rejects.toThrow(/artifact 1 is unreadable/);
    const incorrect = await fixture({ artifacts: [{ path: "font.woff2", sha256: "0".repeat(64) }] });
    await expect(loadLegalComponents(incorrect.manifest, incorrect.directory)).rejects.toThrow(/failed SHA-256 verification/);
  });
});
