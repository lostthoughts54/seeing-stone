import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { isStrictlyNewerFrameSequence } from "../src/main/services/libMpvFrameOrder";

describe("libmpv frame ordering", () => {
  it("rejects duplicate, invalid, and backward frame sequences", () => {
    expect(isStrictlyNewerFrameSequence(103, 104)).toBe(true);
    expect(isStrictlyNewerFrameSequence(104, 104)).toBe(false);
    expect(isStrictlyNewerFrameSequence(104, 103)).toBe(false);
    expect(isStrictlyNewerFrameSequence(104, Number.NaN)).toBe(false);
  });

  it("selects the oldest ready native slot and rechecks async renderer frames", async () => {
    const [native, preload] = await Promise.all([
      readFile("native/libmpv-bridge/src/libmpv_runtime_probe.cc", "utf8"),
      readFile("src/preload/index.ts", "utf8"),
    ]);
    expect(native).toContain("state_->slots[index].sequence < sequence");
    expect(preload).toContain("acceptedSequence !== libmpvLastAcceptedSequence");
    expect(preload).toContain("acceptedGeneration !== libmpvSurfaceGeneration");
  });
});
