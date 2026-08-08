import { describe, expect, it } from "vitest";
import { OpenSourceLicensesService } from "../src/main/services/openSourceLicenses";

describe("OpenSourceLicensesService", () => {
  it("exposes the generated application, font, native, and dependency inventory without build-only provenance", () => {
    const inventory = new OpenSourceLicensesService().list();
    expect(inventory).toMatchObject({ schemaVersion: 1, projectName: "Seeing Stone", projectLicense: "GPL-2.0-or-later" });
    expect(inventory.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ category: "font", name: "Inter", license: "OFL-1.1" }),
      expect.objectContaining({ category: "font", name: "Spectral", license: "OFL-1.1" }),
      expect.objectContaining({ category: "native", name: "Controlled source-built mpv/libmpv runtime", redistributionStatus: "internal-only-controlled-source-build" }),
      expect.objectContaining({ category: "native", name: "Legacy development prebuilt mpv", redistributionStatus: "development-only-not-production-packaged" }),
      expect.objectContaining({ category: "dependency", name: "electron", license: "MIT" }),
    ]));
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
