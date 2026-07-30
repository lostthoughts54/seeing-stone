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
  const port = Number(options.port || 9876);
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
    const match = /^\/channel\/(101|102|103)$/.exec(url.pathname);
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
