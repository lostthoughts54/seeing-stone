# Seeing Stone synthetic Live TV

This fixture provides three local, non-DRM MPEG-TS/H.264 channels and matching XMLTV guide data. It requires no IPTV subscription and sends no credentials outside the computer.

The fixture media and server are development-only. They are not included in Seeing Stone release installers.

## Start the fixture

```powershell
npm run test:live-tv-fixture
```

Keep that terminal open. If Jellyfin runs on this same computer, configure:

- M3U tuner URL: `http://127.0.0.1:9876/lineup.m3u`
- XMLTV guide URL: `http://127.0.0.1:9876/guide.xml`

In Jellyfin, add the M3U source under Dashboard → Live TV → Tuner Devices, then add the XMLTV source under TV Guide Data Providers. Refresh guide data after saving both.

If Jellyfin runs on another computer, start the fixture with an address that computer can reach:

```powershell
node scripts/live-tv-test-server.cjs --base=http://192.168.1.50:9876
```

Replace `192.168.1.50` with this computer's LAN address and allow TCP port `9876` through the local firewall if needed.

The fixture uses FFmpeg to pace and continuously retimestamp its repeating MPEG-TS payloads. On this test computer it automatically uses Jellyfin's bundled FFmpeg. Set `SEEING_STONE_TEST_FFMPEG` to an FFmpeg executable on other installations. The continuous timestamps allow completed DVR recordings to be probed and played normally.

Test programs are five minutes long, so a newly scheduled recording can finish and become playable quickly. Seeing Stone currently plays completed recordings; use **Watch Live** while a test program is still recording.
