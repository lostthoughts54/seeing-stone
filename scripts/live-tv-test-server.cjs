"use strict";

const http = require("node:http");
const { existsSync, statSync } = require("node:fs");
const { resolve } = require("node:path");
const { spawn } = require("node:child_process");

const root = resolve(__dirname, "..");
const fixtureRoot = resolve(root, "assets", "fixtures", "live-tv");
const channels = [
  { id: "seeing-stone-test-101", number: "101", name: "Seeing Stone Test Pattern", file: "channel-101.ts" },
  { id: "seeing-stone-test-102", number: "102", name: "Seeing Stone Color Bars", file: "channel-102.ts" },
  { id: "seeing-stone-test-103", number: "103", name: "Seeing Stone Fractal", file: "channel-103.ts" },
];
const guideSlotMinutes = 5;
const guideHours = 36;

function argument(name, fallback) {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length) || fallback;
}

function xml(value) {
  return String(value).replace(/[<>&'"]/g, (character) => ({
    "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;",
  })[character]);
}

function xmltvDate(value) {
  const pad = (number) => String(number).padStart(2, "0");
  return `${value.getUTCFullYear()}${pad(value.getUTCMonth() + 1)}${pad(value.getUTCDate())}${pad(value.getUTCHours())}${pad(value.getUTCMinutes())}${pad(value.getUTCSeconds())} +0000`;
}

function guideXml(now = new Date()) {
  const start = new Date(now);
  start.setUTCMinutes(Math.floor(start.getUTCMinutes() / guideSlotMinutes) * guideSlotMinutes, 0, 0);
  start.setUTCHours(start.getUTCHours() - 6);
  const channelElements = channels.map((channel) =>
    `<channel id="${xml(channel.id)}"><display-name>${xml(channel.number)} ${xml(channel.name)}</display-name></channel>`,
  );
  const programs = [];
  const programCount = guideHours * 60 / guideSlotMinutes;
  for (const channel of channels) {
    for (let index = 0; index < programCount; index += 1) {
      const programStart = new Date(start.getTime() + index * guideSlotMinutes * 60_000);
      const programEnd = new Date(programStart.getTime() + guideSlotMinutes * 60_000);
      programs.push(
        `<programme start="${xmltvDate(programStart)}" stop="${xmltvDate(programEnd)}" channel="${xml(channel.id)}">`
        + `<title>Test Program ${index + 1}</title>`
        + `<sub-title>${xml(channel.name)}</sub-title>`
        + `<desc>Synthetic non-DRM MPEG-TS/H.264 playback and DVR validation program.</desc>`
        + `<category>Test</category></programme>`,
      );
    }
  }
  return `<?xml version="1.0" encoding="UTF-8"?><tv generator-info-name="Seeing Stone">${channelElements.join("")}${programs.join("")}</tv>`;
}

function lineup(baseUrl) {
  return [
    "#EXTM3U",
    ...channels.flatMap((channel) => [
      `#EXTINF:-1 tvg-id="${channel.id}" tvg-chno="${channel.number}" tvg-name="${channel.name}",${channel.name}`,
      `${baseUrl}/channel/${channel.number}`,
    ]),
    "",
  ].join("\n");
}

function ffmpegStreamArguments(sourcePath) {
  return [
    "-nostdin",
    "-hide_banner",
    "-loglevel", "error",
    "-re",
    "-stream_loop", "-1",
    "-i", sourcePath,
    "-map", "0:v:0",
    "-map", "0:a:0",
    "-c", "copy",
    "-fflags", "+genpts",
    "-avoid_negative_ts", "make_zero",
    "-f", "mpegts",
    "pipe:1",
  ];
}

function resolveFfmpeg(configuredPath) {
  const candidates = [
    configuredPath,
    process.env.SEEING_STONE_TEST_FFMPEG,
    process.platform === "win32" ? "D:\\Program Files\\Jellyfin\\Server\\ffmpeg.exe" : null,
    process.platform === "win32" ? "C:\\Program Files\\Jellyfin\\Server\\ffmpeg.exe" : null,
  ].filter(Boolean);
  return candidates.find((candidate) => existsSync(candidate)) || "ffmpeg";
}

function createLiveTvTestServer(options = {}) {
  const port = Number(options.port ?? 9876);
  const bind = options.bind || "0.0.0.0";
  const publicBase = String(options.publicBase || `http://127.0.0.1:${port}`).replace(/\/$/, "");
  const ffmpegPath = resolveFfmpeg(options.ffmpegPath);
  const sources = new Map(channels.map((channel) => {
    const path = resolve(fixtureRoot, channel.file);
    if (!statSync(path).isFile()) throw new Error(`Missing Live TV fixture: ${path}`);
    return [channel.number, path];
  }));
  const server = http.createServer((request, response) => {
    const url = new URL(request.url || "/", publicBase);
    if (url.pathname === "/xmltv.php") {
      const start = Math.floor(Date.now() / 1800000) * 1800000;
      const stamp = time => new Date(time).toISOString().replace(/[-:]/g, "").replace("T", "").slice(0, 14) + " +0000";
      response.writeHead(200, { "Content-Type": "application/xml" });
      response.end(`<tv><programme channel="${channels[0].id}" start="${stamp(start)}" stop="${stamp(start + 10800000)}"><title>College Football</title><desc>Fixture guide search match</desc></programme></tv>`); return;
    }
    if (url.pathname === "/fixture-poster.png") {
      response.writeHead(200, { "Content-Type": "image/png" });
      response.end(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aO1sAAAAASUVORK5CYII=", "base64")); return;
    }
    if (url.pathname === "/player_api.php") {
      response.setHeader("Content-Type", "application/json; charset=utf-8");
      response.setHeader("Cache-Control", "no-store");
      const action = url.searchParams.get("action");
      const username = url.searchParams.get("username");
      if (url.searchParams.get("password") !== "fixture-password" || !["viewer", "expired"].includes(username)) {
        response.end(JSON.stringify({ user_info: { auth: 0, status: "Disabled" } })); return;
      }
      if (!action) {
        response.end(JSON.stringify({ user_info: { auth: 1, status: username === "expired" ? "Expired" : "Active", exp_date: "4102444800" } })); return;
      }
      if (options.providerState?.failAction === action) { response.statusCode = 503; response.end("Synthetic refresh failure"); return; }
      const send = (value) => response.end(JSON.stringify(value));
      if (action === "get_vod_info" || action === "get_series_info") { send({ info: { cover: `http://${request.headers.host}/fixture-poster.png` } }); return; }
      if (action === "get_simple_data_table") {
        const start = Math.floor(Date.now() / 1800000) * 1800;
        send({ epg_listings: Array.from({ length: 12 }, (_, index) => ({ id: index + 1, title: Buffer.from(index === 0 ? "日本語 · Current programme" : `Programme ${index + 1}`).toString("base64"), description: Buffer.from("Fixture schedule description.").toString("base64"), start_timestamp: String(start + index * 1800), stop_timestamp: String(start + (index + 1) * 1800) })) }); return;
      }
      if (action.endsWith("_categories")) { send([{ category_id: "1", category_name: "International" }, { category_id: "2", category_name: "Entertainment" }]); return; }
      if (action === "get_live_streams") {
        const count = options.catalogueSize ?? channels.length;
        const names = ["日本語 ニュース", "Café français", "الأخبار", "Duplicate News", "Duplicate News"];
        send(Array.from({ length: count }, (_, index) => ({ stream_id: index + 1, num: index + 101, name: names[index] ?? `Fixture Channel ${index + 1}`, category_id: index % 2 ? "2" : "1", epg_channel_id: channels[index % channels.length].id,
          stream_icon: `${publicBase}/private/fixture-password/icon.png`, direct_source: `${publicBase}/private/fixture-password/stream` })));
        return;
      }
      if (action === "get_vod_streams") { send([{ stream_id: 1, name: "Fixture Movie", category_id: "2", container_extension: "mp4" }]); return; }
      if (action === "get_series") { send([{ series_id: 1, name: "Fixture Series", category_id: "2" }]); return; }
      send([]); return;
    }
    if (url.pathname === "/health") {
      response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      response.end(JSON.stringify({ ready: true, channels: channels.length }));
      return;
    }
    if (url.pathname === "/lineup.m3u") {
      response.writeHead(200, { "Content-Type": "audio/x-mpegurl; charset=utf-8", "Cache-Control": "no-store" });
      response.end(lineup(publicBase));
      return;
    }
    if (url.pathname === "/guide.xml") {
      response.writeHead(200, { "Content-Type": "application/xml; charset=utf-8", "Cache-Control": "no-store" });
      response.end(guideXml());
      return;
    }
    const iptvMatch = /^\/live\/viewer\/fixture-password\/(\d+)\.ts$/.exec(url.pathname);
    const match = iptvMatch ? [iptvMatch[0], String(101 + (Number(iptvMatch[1]) - 1) % 3)] : /^\/channel\/(101|102|103)$/.exec(url.pathname);
    const sourcePath = match ? sources.get(match[1]) : null;
    if (!sourcePath) {
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Not found");
      return;
    }
    const streamHeaders = {
      "Content-Type": "video/mp2t",
      "Cache-Control": "no-store",
      "Connection": "keep-alive",
      "Access-Control-Allow-Origin": "*",
    };
    response.writeHead(200, streamHeaders);
    // Jellyfin checks an M3U stream's MIME type with HEAD before opening it.
    // A HEAD response has no body, so finish it immediately instead of
    // entering the intentionally endless live-stream write loop.
    if (request.method === "HEAD") {
      response.end();
      return;
    }
    // Replaying the same MPEG-TS bytes resets PTS/DTS on every loop. Jellyfin
    // can display that stream live, but a DVR recording then appears only as
    // the final loop and cannot be remuxed. FFmpeg's stream loop preserves the
    // encoded media while regenerating a continuous timestamp timeline.
    const child = spawn(ffmpegPath, ffmpegStreamArguments(sourcePath), {
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    let closed = false;
    const closeChild = () => {
      if (closed) return;
      closed = true;
      if (!child.killed) child.kill();
    };
    response.once("close", closeChild);
    child.once("error", () => {
      if (!response.destroyed) response.destroy();
    });
    child.once("exit", (code, signal) => {
      if (!closed && !response.destroyed) {
        if (code === 0 || signal) response.end();
        else response.destroy();
      }
    });
    child.stdout.pipe(response);
  });
  return {
    server,
    port,
    bind,
    publicBase,
    listen: () => new Promise((resolveListen, reject) => {
      server.once("error", reject);
      server.listen(port, bind, () => {
        server.off("error", reject);
        resolveListen();
      });
    }),
    close: () => new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose())),
  };
}

module.exports = {
  channels,
  createLiveTvTestServer,
  ffmpegStreamArguments,
  guideHours,
  guideSlotMinutes,
  guideXml,
  lineup,
};

if (require.main === module) {
  const fixture = createLiveTvTestServer({
    port: argument("port", "9876"),
    bind: argument("bind", "0.0.0.0"),
    publicBase: argument("base", undefined),
  });
  fixture.listen().then(() => {
    process.stdout.write([
      "Seeing Stone synthetic Live TV server is ready.",
      `M3U tuner URL: ${fixture.publicBase}/lineup.m3u`,
      `XMLTV guide URL: ${fixture.publicBase}/guide.xml`,
      "Keep this window open while Jellyfin uses the test channels.",
      "",
    ].join("\n"));
  }).catch((error) => {
    process.stderr.write(`${error?.stack || String(error)}\n`);
    process.exitCode = 1;
  });
}
