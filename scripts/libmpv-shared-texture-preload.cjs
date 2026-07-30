"use strict";

const electron = require("electron");
const { ipcRenderer, sharedTexture } = electron;

ipcRenderer.send("seeing-stone:synthetic-texture-bootstrap", {
  sharedTextureAvailable: Boolean(sharedTexture),
  sharedTextureMethods: sharedTexture ? Object.keys(sharedTexture).sort() : [],
  sandboxed: process.sandboxed,
});

let writer = null;
let track = null;
let video = null;
let canvas = null;
let bitmapContext = null;
let resizeObserver = null;
let mechanism = null;
let surfaceGeneration = 0;
let stopped = false;

function presentationCapabilities() {
  const contextAvailable = (name) => Boolean(document.createElement("canvas").getContext(name));
  return {
    mediaStreamTrackGenerator: typeof globalThis.MediaStreamTrackGenerator === "function",
    videoFrame: typeof globalThis.VideoFrame === "function",
    webgl2: contextAvailable("webgl2"),
    imageBitmapRenderer: contextAvailable("bitmaprenderer"),
    webgpu: Boolean(globalThis.navigator?.gpu),
    offscreenCanvas: typeof globalThis.OffscreenCanvas === "function",
  };
}

async function mountPresenter(generation, requestedMechanism) {
  surfaceGeneration = generation;
  stopped = false;
  const viewport = document.getElementById("playerViewport");
  if (!viewport) throw new Error("The existing player viewport is missing.");
  mechanism = requestedMechanism;
  viewport.style.position = "relative";

  if (mechanism === "image-bitmap-renderer") {
    canvas = document.createElement("canvas");
    canvas.id = "libmpvSyntheticTextureSurface";
    canvas.style.position = "absolute";
    canvas.style.inset = "0";
    canvas.style.width = "100%";
    canvas.style.height = "100%";
    canvas.style.background = "#020407";
    bitmapContext = canvas.getContext("bitmaprenderer");
    if (!bitmapContext) throw new Error("ImageBitmapRenderingContext is unavailable.");
    const sizeCanvas = () => {
      const bounds = viewport.getBoundingClientRect();
      const scale = Math.max(0.5, Math.min(4, window.devicePixelRatio || 1));
      canvas.width = Math.max(1, Math.round(bounds.width * scale));
      canvas.height = Math.max(1, Math.round(bounds.height * scale));
    };
    resizeObserver = new ResizeObserver(sizeCanvas);
    resizeObserver.observe(viewport);
    sizeCanvas();
    viewport.replaceChildren(canvas);
    return;
  }

  if (mechanism !== "media-stream-track-generator" || typeof globalThis.MediaStreamTrackGenerator !== "function") {
    throw new Error("The requested GPU-backed presenter is unavailable.");
  }

  video = document.createElement("video");
  video.id = "libmpvSyntheticTextureSurface";
  video.autoplay = true;
  video.muted = true;
  video.playsInline = true;
  video.style.position = "absolute";
  video.style.inset = "0";
  video.style.width = "100%";
  video.style.height = "100%";
  video.style.objectFit = "contain";
  video.style.background = "#020407";
  viewport.replaceChildren(video);

  track = new globalThis.MediaStreamTrackGenerator({ kind: "video" });
  writer = track.writable.getWriter();
  video.srcObject = new MediaStream([track]);
  // play() does not resolve until the generator receives its first frame; the
  // main process needs the ready acknowledgement before it can send that frame.
  void video.play().catch(() => undefined);
}

async function stopPresenter() {
  if (stopped) return;
  stopped = true;
  try { await writer?.abort(new Error("Synthetic presenter stopped.")); } catch { /* Renderer teardown can close the stream first. */ }
  writer = null;
  try { track?.stop(); } catch { /* Best-effort renderer cleanup. */ }
  track = null;
  if (video) {
    video.pause();
    video.srcObject = null;
    video.remove();
  }
  video = null;
  resizeObserver?.disconnect();
  resizeObserver = null;
  bitmapContext = null;
  canvas?.remove();
  canvas = null;
  mechanism = null;
}

sharedTexture?.setSharedTextureReceiver(async ({ importedSharedTexture }, metadata) => {
  const started = performance.now();
  let frame = null;
  try {
    if (stopped || (!writer && mechanism !== "image-bitmap-renderer") || metadata?.surfaceGeneration !== surfaceGeneration) return;
    ipcRenderer.send("seeing-stone:synthetic-texture-received", {
      sequence: metadata.sequence,
      surfaceGeneration,
      desiredSize: writer?.desiredSize ?? null,
    });
    frame = importedSharedTexture.getVideoFrame();
    if (mechanism === "image-bitmap-renderer") {
      const bitmap = await createImageBitmap(frame);
      bitmapContext.transferFromImageBitmap(bitmap);
    } else {
      await writer.write(frame);
    }
    ipcRenderer.send("seeing-stone:synthetic-texture-presented", {
      sequence: metadata.sequence,
      surfaceGeneration,
      presentationMilliseconds: performance.now() - started,
      desiredSize: writer?.desiredSize ?? null,
    });
  } finally {
    frame?.close();
    importedSharedTexture.release();
  }
});

ipcRenderer.on("seeing-stone:synthetic-texture-start", async (_event, input) => {
  ipcRenderer.send("seeing-stone:synthetic-texture-start-received", input);
  try {
    await stopPresenter();
    await mountPresenter(input.surfaceGeneration, input.mechanism);
    const viewport = document.getElementById("playerViewport").getBoundingClientRect();
    ipcRenderer.send("seeing-stone:synthetic-texture-ready", {
      surfaceGeneration,
      mechanism,
      capabilities: presentationCapabilities(),
      deviceScaleFactor: window.devicePixelRatio,
      viewport: { x: viewport.x, y: viewport.y, width: viewport.width, height: viewport.height },
    });
  } catch (error) {
    ipcRenderer.send("seeing-stone:synthetic-texture-error", {
      surfaceGeneration: input.surfaceGeneration,
      code: "PRESENTER_INITIALIZATION_FAILED",
      message: error instanceof Error ? error.message : "Presenter initialization failed.",
    });
  }
});

ipcRenderer.on("seeing-stone:synthetic-texture-stop", () => { void stopPresenter(); });
window.addEventListener("beforeunload", () => { void stopPresenter(); }, { once: true });
ipcRenderer.send("seeing-stone:synthetic-texture-listener-ready");
