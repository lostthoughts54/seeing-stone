"use strict";

const assert = require("node:assert/strict");
const { existsSync, readFileSync, writeFileSync } = require("node:fs");
const { spawnSync } = require("node:child_process");
const { join, resolve } = require("node:path");
const { MpvPlayerService } = require("../dist/main/services/mpvPlayer.js");

const TICKS_PER_SECOND = 10_000_000;
const root = resolve(__dirname, "..");
const runtimeDirectory = join(root, ".runtime", "mpv");
const runtime = {
  executable: join(runtimeDirectory, "mpv.exe"),
  inputConfig: join(root, "assets", "mpv", "input.conf"),
};
const fixtures = {
  movie: join(root, ".runtime", "mpv-completion-movie.mp4"),
  episode: join(root, ".runtime", "mpv-completion-episode.mkv"),
  subtitle: join(root, ".runtime", "mpv-completion-external.srt"),
};

async function run() {
  assert.equal(existsSync(runtime.executable), true, "Run pnpm setup:mpv first.");
  createFixture(fixtures.movie);
  createFixture(fixtures.episode);
  if (!existsSync(fixtures.subtitle)) {
    writeFileSync(fixtures.subtitle, "1\n00:00:00,000 --> 00:00:02,500\nExternal subtitle acceptance\n", "utf8");
  }

  await verifyLocalExternalSubtitle();
  await verifyMovieCompletion();
  await verifyEpisodeAutoplay();
  await verifyCountdownCancellation();
  process.stdout.write("mpv completion acceptance passed (local external subtitle, MP4 movie close, MKV 10-second autoplay, cancellation).\n");
}

async function verifyLocalExternalSubtitle() {
  const harness = createHarness(fixtures);
  const playback = await harness.player.start("subtitle-local", "start-over");
  assert.equal(harness.window.minimized, true, "The main app should remain reachable as a minimized taskbar window.");
  await waitFor(() => harness.player.getState().subtitleTracks.some((track) => track.title === "English - Jellyfin external"), 10000);
  const state = harness.player.getState();
  const subtitle = state.subtitleTracks.find((track) => track.title === "English - Jellyfin external");
  assert.ok(subtitle, "The Jellyfin external subtitle was not added to local playback.");
  assert.equal(state.source, "local");
  await harness.player.selectSubtitle(playback.playbackId, subtitle.id);
  assert.equal(harness.playback.subtitleFetches, 1);
  await harness.player.stop(playback.playbackId);
  assert.equal(harness.window.minimized, false, "Stopping playback should restore the main app window.");
}

async function verifyMovieCompletion() {
  const harness = createHarness({ movie: fixtures.movie, episode: fixtures.episode });
  const playback = await harness.player.start("movie-1", "start-over");
  try {
    await waitFor(() => harness.player.getState().phase === "ended" && harness.window.showCount === 1, 15000);
  } catch (error) {
    const state = harness.player.getState();
    if (state.playbackId) await harness.player.stop(state.playbackId).catch(() => undefined);
    throw new Error("Movie completion timed out before mpv reached the ended state.", { cause: error });
  }
  const lifecycle = harness.reports.filter(({ kind }) => kind !== "progress");
  assert.deepEqual(lifecycle.map(({ kind, itemId }) => ({ kind, itemId })), [
    { kind: "start", itemId: "movie-1" },
    { kind: "stop", itemId: "movie-1" },
  ]);
  assert.equal(harness.reports.filter(({ kind }) => kind === "stop").length, 1);
  assert.equal(harness.player.getState().playbackId, null);
  assert.equal(playback.playbackId.startsWith("playback-"), true);
}

async function verifyEpisodeAutoplay() {
  const harness = createHarness({ movie: fixtures.movie, episode: fixtures.episode });
  const startedAt = Date.now();
  await harness.player.start("episode-1", "start-over");
  await waitFor(() => {
    const state = harness.player.getState();
    return state.itemId === "episode-2" && state.phase === "playing";
  }, 25000);

  const elapsed = Date.now() - startedAt;
  assert.ok(elapsed >= 11500, `Episode transition skipped the 10-second countdown (${elapsed}ms).`);
  const lifecycle = harness.reports.filter(({ kind }) => kind !== "progress");
  assert.deepEqual(lifecycle.slice(0, 3).map(({ kind, itemId }) => ({ kind, itemId })), [
    { kind: "start", itemId: "episode-1" },
    { kind: "stop", itemId: "episode-1" },
    { kind: "start", itemId: "episode-2" },
  ]);
  assert.equal(harness.playback.nextUpQueries, 1);
  await harness.player.stop(harness.player.getState().playbackId);
}

async function verifyCountdownCancellation() {
  const harness = createHarness({ movie: fixtures.movie, episode: fixtures.episode });
  const playback = await harness.player.start("episode-1", "start-over");
  await waitFor(() => harness.playback.nextUpQueries === 1, 15000);
  await harness.player.stop(playback.playbackId);
  await delay(1500);
  assert.equal(harness.player.getState().playbackId, null);
  assert.equal(harness.reports.some((event) => event.kind === "start" && event.itemId === "episode-2"), false);
}

function createHarness(paths) {
  const reports = [];
  const window = {
    minimized: false,
    showCount: 0,
    isDestroyed: () => false,
    minimize() { this.minimized = true; },
    isMinimized() { return this.minimized; },
    restore() { this.minimized = false; },
    show() { this.showCount += 1; },
    focus() {},
  };
  const playback = new FixturePlayback(paths);
  const player = new MpvPlayerService(
    window,
    playback,
    { acceptAuthoritativeEvent: async (event) => { reports.push({ ...event, at: Date.now() }); } },
    { get: async () => ({ windowMaximized: true }), setWindowMaximized: async () => undefined },
    runtime,
  );
  // Completion behavior does not require a visible legacy window. Append
  // headless output flags after the production arguments so this autonomous
  // harness cannot cover the desktop or take focus.
  const spawnProcess = player.spawnProcess.bind(player);
  player.spawnProcess = (executable, args) => {
    const separator = args.indexOf("--");
    const optionsEnd = separator < 0 ? args.length : separator;
    return spawnProcess(executable, [
      ...args.slice(0, optionsEnd),
      "--force-window=no",
      "--vo=null",
      "--ao=null",
      ...args.slice(optionsEnd),
    ]);
  };
  return { player, playback, reports, window };
}

class FixturePlayback {
  constructor(paths) {
    this.paths = paths;
    this.sequence = 0;
    this.current = null;
    this.nextUpQueries = 0;
    this.subtitleFetches = 0;
  }

  async start(itemId) {
    const localSubtitle = itemId === "subtitle-local";
    const itemType = itemId.startsWith("movie") || localSubtitle ? "Movie" : "Episode";
    const playbackId = `playback-${++this.sequence}`;
    this.current = { playbackId, itemId, itemType };
    return {
      playbackId,
      serverPlaySessionId: `server-session-${this.sequence}`,
      itemId,
      itemType,
      seriesId: itemType === "Episode" ? "series-1" : null,
      mediaSourceId: `source-${itemId}`,
      mediaUrl: localSubtitle ? this.paths.movie : `jellyfin-media://stream/${playbackId}`,
      delivery: localSubtitle ? "local" : "direct",
      sourceKind: localSubtitle ? "matched-local" : "direct-play",
      usesServerTimelineOffset: false,
      resumePositionTicks: 0,
      durationTicks: 3 * TICKS_PER_SECOND,
      source: localSubtitle ? "local" : "server",
      externalSubtitles: localSubtitle ? [{
        streamIndex: 4,
        format: "srt",
        title: "English - Jellyfin external",
        language: "eng",
        isDefault: false,
        isForced: false,
      }] : [],
      initialAction: "progress",
    };
  }

  stop(playbackId) {
    if (!this.current || this.current.playbackId !== playbackId) throw new Error("Playback is no longer active.");
    this.current = null;
    return {};
  }

  clear() { this.current = null; }

  async getNextUpForSeries() {
    this.nextUpQueries += 1;
    return { id: "episode-2", type: "Episode", playable: true, seriesId: "series-1" };
  }

  async handle(request) {
    if (!this.current) return new Response(null, { status: 404 });
    const path = this.current.itemType === "Movie" ? this.paths.movie : this.paths.episode;
    const contentType = this.current.itemType === "Movie" ? "video/mp4" : "video/x-matroska";
    const bytes = readFileSync(path);
    const range = request.headers.get("range");
    if (!range) {
      return new Response(bytes, {
        status: 200,
        headers: { "Content-Type": contentType, "Content-Length": String(bytes.length), "Accept-Ranges": "bytes" },
      });
    }
    const match = /^bytes=(\d+)-(\d*)$/.exec(range);
    if (!match) return new Response(null, { status: 416 });
    const start = Number(match[1]);
    const end = match[2] ? Math.min(Number(match[2]), bytes.length - 1) : bytes.length - 1;
    if (start > end || start >= bytes.length) return new Response(null, { status: 416 });
    const body = bytes.subarray(start, end + 1);
    return new Response(body, {
      status: 206,
      headers: {
        "Content-Type": contentType,
        "Content-Length": String(body.length),
        "Content-Range": `bytes ${start}-${end}/${bytes.length}`,
        "Accept-Ranges": "bytes",
      },
    });
  }

  async fetchExternalSubtitle(playbackId, subtitle) {
    if (!this.current || this.current.playbackId !== playbackId || subtitle.streamIndex !== 4) {
      return new Response(null, { status: 404 });
    }
    this.subtitleFetches += 1;
    const bytes = readFileSync(this.paths.subtitle);
    return new Response(bytes, {
      headers: { "Content-Type": "application/x-subrip", "Content-Length": String(bytes.length) },
    });
  }
}

function createFixture(outputPath) {
  if (existsSync(outputPath)) return;
  const result = spawnSync(join(runtimeDirectory, "mpv.com"), [
    "--no-config",
    "--no-audio",
    "--ovc=mpeg4",
    `--o=${outputPath}`,
    "av://lavfi:testsrc2=duration=3:size=640x360:rate=24",
  ], { cwd: root, encoding: "utf8", windowsHide: true });
  if (result.status !== 0 || !existsSync(outputPath)) throw new Error("Could not generate the local completion fixture.");
}

async function waitFor(predicate, timeoutMilliseconds) {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(50);
  }
  throw new Error("Timed out waiting for real mpv completion behavior.");
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

void run().catch((error) => {
  process.stderr.write(`mpv completion acceptance failed: ${safeFailureMessage(error)}\n`);
  process.exitCode = 1;
});

function safeFailureMessage(error) {
  return String(error?.message || error || "Unknown failure")
    .replace(/https?:\/\/[^\s"')]+/gi, "<url>")
    .replace(/[A-Za-z]:[\\/][^\r\n"')]+/g, "<path>")
    .slice(0, 500);
}
