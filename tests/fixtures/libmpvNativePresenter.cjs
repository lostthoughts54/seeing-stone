// In-process native boundary fixture. Never loads libmpv or opens a window.
const instances = [];

class LibMpvVideoProducer {
  constructor(options) {
    this.options = options;
    this.frames = [{ slot: 0, sequence: 1, width: 1, height: 1, timestampMicroseconds: 0, pixels: Buffer.alloc(4), pixelFormat: "rgba", ntHandle: Buffer.alloc(8) }];
    this.suspensions = [];
    this.commands = [];
    this.outstandingFrames = 0;
    this.destroyCalls = 0;
    instances.push(this);
  }
  nextFrame() { return this.frames.shift() ?? null; }
  releaseFrame() { return true; }
  command(values) { this.commands.push(values); }
  getProperty(name) { return name === "path" ? this.options.sourcePath : null; }
  drainDiagnostics() { return []; }
  setSuspended(value) { this.suspensions.push(value); }
  getStats() { return { renderedFrames: 1, droppedFrames: 0, outstandingFrames: this.outstandingFrames, poolSize: 3, unusable: false }; }
  destroy() { this.destroyCalls += 1; }
}

module.exports = { instances, LibMpvVideoProducer, probeLibMpvRuntime: () => ({ clientApiVersion: "2.3", completedIterations: 1 }) };
