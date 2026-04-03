export function createWorkletUrl(frameSize: number): string {
  const code = `
class VadRecorderWorklet extends AudioWorkletProcessor {
  constructor() {
    super();
    this.size = ${frameSize};
    this.buffer = new Float32Array(this.size);
    this.index = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (input && input[0]) {
      const channel = input[0];
      for (let i = 0; i < channel.length; i++) {
        this.buffer[this.index++] = channel[i];
        if (this.index === this.size) {
          this.port.postMessage({ buffer: this.buffer.slice(0) });
          this.index = 0;
        }
      }
    }
    return true;
  }
}

registerProcessor("vad-recorder-worklet", VadRecorderWorklet);
`;

  return URL.createObjectURL(new Blob([code], { type: "text/javascript" }));
}
