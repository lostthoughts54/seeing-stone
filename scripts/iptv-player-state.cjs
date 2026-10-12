"use strict";
// Read-only diagnosis of the application's active mpv instance. Never print command lines or stream URLs.
const { spawnSync } = require("node:child_process");
const { MpvIpcClient } = require("../dist/main/services/mpvIpc.js");
async function run() {
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "Get-CimInstance Win32_Process -Filter \"Name='mpv.exe'\" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress"], { encoding: "utf8", windowsHide: true });
  const rows = JSON.parse(result.stdout.trim() || "[]");
  const report = [];
  for (const process of Array.isArray(rows) ? rows : [rows]) {
    if (!/Seeing Stone|seeing-stone/i.test(process.CommandLine ?? "")) continue;
    const pipe = /--input-ipc-server=([^"\s]+)/.exec(process.CommandLine)?.[1];
    if (!pipe) continue;
    const ipc = new MpvIpcClient();
    try {
      await ipc.connect(pipe, 2000);
      const state = { processId: process.ProcessId };
      for (const property of ["time-pos", "pause", "mute", "volume", "paused-for-cache", "demuxer-cache-duration", "video-format", "current-vo", "vo-configured", "idle-active", "eof-reached"]) {
        state[property] = await Promise.race([ipc.command(["get_property", property]).catch(() => null), new Promise(resolve => setTimeout(() => resolve("timeout"), 1500))]);
      }
      report.push(state);
    } finally { ipc.close(); }
  }
  console.log(JSON.stringify(report));
}
run().catch(() => { console.error("Player state could not be read; no private details exposed."); process.exitCode = 1; });
