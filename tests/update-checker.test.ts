import { describe, expect, it } from "vitest";
import { UpdateChecker, canonicalReleasePageUrl, compareSeeingStoneVersions, parseSeeingStoneVersion, selectNewestRelease } from "../src/main/services/updateChecker";

const logger = { info() {}, warn() {}, error() {} };
const release = (tagName: string, overrides: Partial<{ draft: boolean; prerelease: boolean }> = {}) => ({ tagName, name: tagName, publishedAt: "2026-01-01T00:00:00Z", draft: false, prerelease: tagName.includes("-"), ...overrides });

describe("update release selection", () => {
  it("orders prereleases and stable releases using semver precedence", () => {
    expect(compareSeeingStoneVersions(parseSeeingStoneVersion("v0.7.1-beta.4")!, parseSeeingStoneVersion("v0.7.1-beta.3")!)).toBeGreaterThan(0);
    expect(compareSeeingStoneVersions(parseSeeingStoneVersion("v0.7.1")!, parseSeeingStoneVersion("v0.7.1-beta.4")!)).toBeGreaterThan(0);
  });
  it("normalizes Seeing Stone beta tags and ignores malformed tags and drafts", () => {
    expect(parseSeeingStoneVersion("Seeing.Stone.beta.2.v.0.7.0")).toEqual(parseSeeingStoneVersion("0.7.0-beta.2"));
    expect(parseSeeingStoneVersion("Seeing.Stone.beta.3.v.0.7.1")).toEqual(parseSeeingStoneVersion("0.7.1-beta.3"));
    expect(parseSeeingStoneVersion("beta-two")).toBeNull();
    expect(selectNewestRelease("0.7.0", [release("Seeing.Stone.beta.2.v.0.7.0"), release("v0.7.1-beta.3"), release("v9.0.0", { draft: true })])?.tagName).toBe("v0.7.1-beta.3");
  });
  it("does not offer prereleases to a stable build", () => {
    expect(selectNewestRelease("0.7.1", [release("v0.7.2-beta.1"), release("v0.7.1")])?.tagName).toBe("v0.7.1");
  });
  it("only generates canonical URLs for recognized tags", () => {
    expect(canonicalReleasePageUrl("v0.7.1-beta.3")).toBe("https://github.com/lostthoughts54/seeing-stone/releases/tag/v0.7.1-beta.3");
    expect(canonicalReleasePageUrl("Seeing.Stone.beta.3.v.0.7.1")).toBe("https://github.com/lostthoughts54/seeing-stone/releases/tag/Seeing.Stone.beta.3.v.0.7.1");
    expect(canonicalReleasePageUrl("https://evil.invalid")).toBeNull();
  });
  it("returns safe manual and quiet automatic failures", async () => {
    const failing = new UpdateChecker("0.7.0", logger, async () => { throw new Error("network"); });
    expect((await failing.check("automatic")).error).toBeUndefined();
    expect((await failing.check("manual")).error).toMatch(/Couldn't check/);
  });
  it("finds a newer prerelease for Beta 2 without treating Beta 2 as newer", async () => {
    const apiRelease = (tag: string) => ({ tag_name: tag, name: tag, published_at: "2026-01-01T00:00:00Z", draft: false, prerelease: tag.includes("-") });
    const checker = new UpdateChecker("0.7.0", logger, async () => new Response(JSON.stringify([apiRelease("Seeing.Stone.beta.2.v.0.7.0"), apiRelease("v0.7.1-beta.3")])));
    const result = await checker.check("manual");
    expect(result.isUpdateAvailable).toBe(true);
    expect(result.latestVersion).toBe("0.7.1-beta.3");
  });
});
