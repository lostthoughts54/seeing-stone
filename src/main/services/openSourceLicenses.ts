import type { OpenSourceLicenseInventory } from "../../shared/contracts";
import { OPEN_SOURCE_LICENSES } from "../../shared/generated/openSourceLicenses";

export class OpenSourceLicensesService {
  constructor(private readonly inventory: OpenSourceLicenseInventory = OPEN_SOURCE_LICENSES) {}

  list(): OpenSourceLicenseInventory {
    return {
      schemaVersion: 1,
      projectName: this.inventory.projectName,
      projectLicense: this.inventory.projectLicense,
      entries: this.inventory.entries.map((entry) => ({ ...entry })),
    };
  }
}
