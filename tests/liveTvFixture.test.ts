import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const fixture = require("../scripts/live-tv-test-server.cjs") as {
  channels: Array<{ id: string; number: string; name: string }>;
  createLiveTvTestServer(options: { port: number; bind: string; publicBase: string }): {
    listen(): Promise<void>;
    close(): Promise<void>;
  };
  ffmpegStreamArguments(sourcePath: string): string[];
  guideHours: number;
  guideSlotMinutes: number;
  lineup(baseUrl: string): string;
  guideXml(now: Date): string;
};

describe("synthetic Jellyfin Live TV fixture", () => {
  it("provides aligned M3U channels and deterministic XMLTV programs", () => {
    const lineup = fixture.lineup("http://127.0.0.1:9876");
    const guide = fixture.guideXml(new Date("2026-07-29T12:15:00.000Z"));
    expect(fixture.channels).toHaveLength(3);
    for (const channel of fixture.channels) {
      expect(lineup).toContain(`tvg-id="${channel.id}"`);
      expect(lineup).toContain(`/channel/${channel.number}`);
      expect(guide).toContain(`<channel id="${channel.id}">`);
      expect(guide).toContain(`channel="${channel.id}"`);
    }
    expect(fixture.guideSlotMinutes).toBe(5);
    expect((guide.match(/<programme /g) || [])).toHaveLength(
      fixture.channels.length * fixture.guideHours * 60 / fixture.guideSlotMinutes,
    );
    expect(guide).toContain('start="20260729061500 +0000" stop="20260729062000 +0000"');
    expect(guide).not.toMatch(/token|password|provider/i);
  });

  it("keeps the checked-in MPEG-TS payloads pinned to their provenance hashes", () => {
    const provenance = JSON.parse(readFileSync("assets/fixtures/live-tv/provenance.json", "utf8")) as {
      artifacts: Array<{ file: string; sha256: string }>;
    };
    for (const artifact of provenance.artifacts) {
      const actual = createHash("sha256")
        .update(readFileSync(`assets/fixtures/live-tv/${artifact.file}`))
        .digest("hex")
        .toUpperCase();
      expect(actual).toBe(artifact.sha256);
    }
  });

  it("answers Jellyfin's stream MIME-type HEAD probe without waiting for media", async () => {
    const port = 19876;
    const server = fixture.createLiveTvTestServer({
      port,
      bind: "127.0.0.1",
      publicBase: `http://127.0.0.1:${port}`,
    });
    await server.listen();
    try {
      const startedAt = performance.now();
      const response = await fetch(`http://127.0.0.1:${port}/channel/101`, { method: "HEAD" });
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("video/mp2t");
      expect((await response.arrayBuffer()).byteLength).toBe(0);
      expect(performance.now() - startedAt).toBeLessThan(1_000);
    } finally {
      await server.close();
    }
  });

  it("loops fixture media through FFmpeg with regenerated continuous timestamps", () => {
    const args = fixture.ffmpegStreamArguments("channel.ts");
    expect(args).toContain("-re");
    expect(args).toContain("-stream_loop");
    expect(args).toContain("+genpts");
    expect(args).toContain("make_zero");
    expect(args.slice(-2)).toEqual(["mpegts", "pipe:1"]);
  });
});
