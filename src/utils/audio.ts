import { clamp } from "./math";

export function computeDecibels(frame: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < frame.length; i++) {
    sum += frame[i] * frame[i];
  }

  const rms = Math.sqrt(sum / Math.max(frame.length, 1));
  if (rms <= 0) {
    return -100;
  }

  return 20 * Math.log10(rms);
}

export function concatFrames(
  frames: Float32Array[],
  expectedSamples: number,
): Float32Array {
  const output = new Float32Array(expectedSamples);
  let offset = 0;

  for (const frame of frames) {
    output.set(frame, offset);
    offset += frame.length;
  }

  return output;
}

export function encodeWav(samples: Float32Array, sampleRate: number): Blob {
  const bytesPerSample = 2;
  const blockAlign = bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataSize = samples.length * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let i = 0; i < samples.length; i++) {
    const value = clamp(samples[i], -1, 1);
    const pcm = value < 0 ? value * 0x8000 : value * 0x7fff;
    view.setInt16(offset, pcm, true);
    offset += 2;
  }

  return new Blob([buffer], { type: "audio/wav" });
}

function writeAscii(view: DataView, offset: number, value: string): void {
  for (let i = 0; i < value.length; i++) {
    view.setUint8(offset + i, value.charCodeAt(i));
  }
}
