import { describe, expect, it } from "vitest";
import { IptvProviderClient, jsonArray } from "../src/main/services/iptvProviderClient";

async function collect(response: Response) { const rows = []; for await (const row of jsonArray(response)) rows.push(row); return rows; }
describe("streaming provider catalogue boundary", () => {
  it("retries an empty section when categories exist, without duplicating the other sections", async () => {
    let movieAttempts = 0;
    const client = new IptvProviderClient(async (url) => {
      const action = new URL(String(url)).searchParams.get("action");
      if (action === "get_vod_categories") return Response.json([{ category_id: "1", category_name: "Movies" }]);
      if (action === "get_vod_streams") return Response.json(++movieAttempts === 1 ? [] : [{ stream_id: 12, name: "Recovered movie", category_id: "1" }]);
      return Response.json([]);
    });
    const rows = [];
    for await (const row of client.catalogue({ kind: "xtream", name: "Test", address: "http://example.test", username: "viewer", password: "fixture-password" }, new AbortController().signal)) rows.push(row);
    expect(movieAttempts).toBe(2);
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe("Recovered movie");
  });
  it("bounds retries for a persistently inconsistent empty section", async () => {
    let attempts = 0;
    const client = new IptvProviderClient(async (url) => {
      if (new URL(String(url)).searchParams.get("action")?.endsWith("categories")) return Response.json([{ category_id: "1", category_name: "Live" }]);
      attempts++; return Response.json([]);
    });
    const run = async () => { for await (const _row of client.catalogue({ kind: "xtream", name: "Test", address: "http://example.test", username: "viewer", password: "fixture-password" }, new AbortController().signal)) { /* consume */ } };
    await expect(run()).rejects.toMatchObject({ code: "IPTV_INCOMPLETE_CATALOGUE" });
    expect(attempts).toBe(3);
  });
  it("parses arbitrarily split UTF-8 and nested values without buffering the catalogue", async () => {
    const rows = [{ name: "日本語 café", nested: { text: '\\"[{}],', array: [1, { id: 2 }] } }, { name: "الأخبار" }];
    const bytes = new TextEncoder().encode(JSON.stringify(rows));
    let index = 0;
    const body = new ReadableStream({ pull(controller) { if (index === bytes.length) controller.close(); else controller.enqueue(bytes.slice(index, ++index)); } });
    expect(await collect(new Response(body))).toEqual(rows);
  });
  it.each(['[{"id":1},]', '[{"id":1}', '[{"id":1}{}]', '{"user_info":{"auth":0}}', '[1]', '[{}] trailing'])("rejects incomplete or invalid arrays: %s", async (value) => {
    await expect(collect(new Response(value))).rejects.toMatchObject({ code: "IPTV_INVALID_FEED" });
  });
  it("rejects overlarge individual records and releases the response stream", async () => {
    await expect(collect(new Response(JSON.stringify([{ name: "x".repeat(1024 * 1024) }])))).rejects.toMatchObject({ code: "IPTV_INVALID_FEED" });
  });
  it("does not follow redirects to non-HTTP resources or downgrade HTTPS", async () => {
    const setup = { kind: "xtream" as const, name: "Test", address: "https://example.test", username: "viewer", password: "fixture-password" };
    for (const location of ["file:///C:/secret", "http://example.test/api"]) {
      const client = new IptvProviderClient(async () => new Response(null, { status: 302, headers: { location } }));
      await expect(client.authenticate(setup, new AbortController().signal)).rejects.toMatchObject({ code: "IPTV_INVALID_FEED" });
    }
  });
  it("rejects expired authentication even if auth is 1", async () => {
    const client = new IptvProviderClient(async () => Response.json({ user_info: { auth: 1, status: "Active", exp_date: "1" } }));
    await expect(client.authenticate({ kind: "xtream", name: "Test", address: "http://example.test", username: "viewer", password: "fixture-password" }, new AbortController().signal)).rejects.toMatchObject({ code: "IPTV_AUTHENTICATION" });
  });
  it("imports M3U only as live metadata, preserving duplicate names with separate identities", async () => {
    const client = new IptvProviderClient(async () => new Response('#EXTM3U\n#EXTINF:-1 tvg-id="x" group-title="News, international" tvg-chno="10",日本語\nhttps://example.test/private-token/1\n#EXTINF:-1 tvg-id="y",日本語\nhttps://example.test/private-token/2\n'));
    const rows = [];
    for await (const item of client.catalogue({ kind: "m3u", name: "Test", playlistUrl: "https://example.test/list" }, new AbortController().signal)) rows.push(item);
    expect(rows).toHaveLength(2);
    expect(rows[0].groupName).toBe("News, international");
    expect(rows[0].contentType).toBe("live");
    expect(rows[0].itemId).not.toBe(rows[1].itemId);
    expect(JSON.stringify(rows)).not.toMatch(/https:|private-token/);
  });
});
