const { app, BrowserWindow } = require("electron");
const { mkdirSync, writeFileSync } = require("node:fs");
const { dirname, resolve } = require("node:path");

const output = resolve(__dirname, "..", "assets", "fixtures", "libmpv-h264-gate.mp4");

async function generate() {
  const window = new BrowserWindow({
    show: false,
    width: 160,
    height: 90,
    webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false },
  });
  await window.loadURL("data:text/html,<meta charset=utf-8><title>Seeing Stone fixture generator</title>");
  const result = await window.webContents.executeJavaScript(`(async () => {
    const candidates = [
      "video/mp4;codecs=avc1.42001E",
      "video/mp4;codecs=avc1",
      "video/mp4",
    ];
    const mimeType = candidates.find((candidate) => MediaRecorder.isTypeSupported(candidate));
    if (!mimeType) throw new Error("H264 MediaRecorder support is unavailable.");
    const canvas = document.createElement("canvas");
    canvas.width = 160;
    canvas.height = 90;
    const context = canvas.getContext("2d", { alpha: false });
    const stream = canvas.captureStream(30);
    const track = stream.getVideoTracks()[0];
    const chunks = [];
    const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 350000 });
    recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
    const stopped = new Promise((resolveStopped, reject) => {
      recorder.onstop = resolveStopped;
      recorder.onerror = () => reject(new Error("MediaRecorder failed."));
    });
    recorder.start();
    for (let frame = 0; frame < 60; frame += 1) {
      const phase = frame / 59;
      context.fillStyle = "rgb(7, 10, 28)";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.fillStyle = "rgb(38, 217, 174)";
      context.fillRect(Math.round(phase * 130), 8, 30, 74);
      context.fillStyle = "white";
      context.font = "16px sans-serif";
      context.fillText(String(frame).padStart(2, "0"), 6, 20);
      track.requestFrame?.();
      await new Promise((resolveFrame) => setTimeout(resolveFrame, 34));
    }
    recorder.stop();
    await stopped;
    track.stop();
    const blob = new Blob(chunks, { type: mimeType });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    }
    return { mimeType, base64: btoa(binary), bytes: bytes.length };
  })()`);
  window.destroy();
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, Buffer.from(result.base64, "base64"));
  process.stdout.write(`${JSON.stringify({ output, mimeType: result.mimeType, bytes: result.bytes })}\n`);
}

app.whenReady().then(generate).then(() => app.quit()).catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : "Fixture generation failed."}\n`);
  app.exit(1);
});
