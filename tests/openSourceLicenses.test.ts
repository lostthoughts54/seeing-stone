import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { OpenSourceLicensesService } from "../src/main/services/openSourceLicenses";

describe("OpenSourceLicensesService", () => {
  it("exposes every current distributable legal component and dependency without build-only provenance", async () => {
    const inventory = new OpenSourceLicensesService().list();
    expect(inventory).toMatchObject({ schemaVersion: 1, projectName: "Seeing Stone", projectLicense: "GPL-2.0-or-later" });
    const [legalComponents, dependencyInventory] = await Promise.all([
      readFile(new URL("../legal-components.json", import.meta.url), "utf8").then(JSON.parse),
      readFile(new URL("../dependency-licenses.json", import.meta.url), "utf8").then(JSON.parse),
    ]);
    const expected = [
      ...legalComponents.components
        .filter((entry: { redistributionStatus: string }) => entry.redistributionStatus !== "development-only-not-production-packaged")
        .map((entry: { category: string; name: string; version: string; license: string; projectUrl: string | null; redistributionStatus: string }) => ({
          category: entry.category,
          name: entry.name,
          version: entry.version,
          license: entry.license,
          projectUrl: entry.projectUrl,
          redistributionStatus: entry.redistributionStatus,
        })),
      ...dependencyInventory.packages.map((entry: { name: string; version: string; license: string; repository: string | null }) => {
        const repository = typeof entry.repository === "string" ? entry.repository.replace(/^git\+/, "").replace(/\.git$/, "") : "";
        return {
          category: "dependency",
          name: entry.name,
          version: entry.version,
          license: entry.license,
          projectUrl: /^https:\/\//i.test(repository) ? repository : null,
          redistributionStatus: "source-and-binary",
        };
      }),
    ].sort((left, right) => `${left.category}:${left.name}@${left.version}`.localeCompare(`${right.category}:${right.name}@${right.version}`));
    const actual = inventory.entries
      .map(({ category, name, version, license, projectUrl, redistributionStatus }) => ({ category, name, version, license, projectUrl, redistributionStatus }))
      .sort((left, right) => `${left.category}:${left.name}@${left.version}`.localeCompare(`${right.category}:${right.name}@${right.version}`));
    expect(new Set(actual.map((entry) => `${entry.category}:${entry.name}@${entry.version}`)).size).toBe(actual.length);
    expect(actual).toEqual(expected);
    const serialized = JSON.stringify(inventory);
    expect(serialized).not.toMatch(/sha256|licenseFile|artifacts|src\/renderer|\\|accessToken|api[_-]?key/i);
  });

  it("returns defensive copies", () => {
    const service = new OpenSourceLicensesService();
    const first = service.list();
    first.entries.splice(0);
    expect(service.list().entries.length).toBeGreaterThan(0);
  });
});
