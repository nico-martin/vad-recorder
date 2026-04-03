import { AutoModel, ModelRegistry, Tensor, type ProgressInfo } from "@huggingface/transformers";

const MODEL_ID = "onnx-community/silero-vad";
const MODEL_NAME = "silero-vad";
const FRAME_SIZE = 512;
const MODEL_OPTIONS = { dtype: "fp32" } as const;

const DEFAULT_OPTIONS: Required<VadRecorderOptions> = {
  threshold: 0.5,
  minSpeechDuration: 250,
  minSilenceDuration: 1000,
  sampleRate: 16000,
  channelCount: 1,
  mimeType: "audio/webm",
  prependSilence: 100,
  appendSilence: 300,
};

type ProgressEvent =
  | { status: "downloading"; name: string; progress: number }
  | { status: "loading"; name: string; progress: number }
  | { status: "ready" };

export type VadRecorderInfo = {
  isCached: boolean;
  downloadSize: number;
};

export type VadRecorderOptions = {
  threshold?: number;
  minSpeechDuration?: number;
  minSilenceDuration?: number;
  sampleRate?: number;
  channelCount?: number;
  mimeType?: string;
  prependSilence?: number;
  appendSilence?: number;
};

type VadModelOutput = {
  stateN: Tensor;
  output: Tensor;
};

type VadModel = {
  (inputs: { input: Tensor; sr: Tensor; state: Tensor }): Promise<VadModelOutput>;
  dispose?: () => Promise<unknown>;
};

type VoidListener = (() => void) | null;
type ErrorListener = ((error: Error) => void) | null;
type RecordListener = ((blob: Blob) => void) | null;
type NumberListener = ((value: number) => void) | null;

export class VadRecorder {
  private readonly options: Required<VadRecorderOptions>;

  private model: VadModel | null = null;
  private modelInitPromise: Promise<void> | null = null;

  private audioContext: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private workletUrl: string | null = null;

  private readonly frameQueue: Float32Array[] = [];
  private processingFrameQueue = false;
  private paused = false;
  private started = false;
  private destroyed = false;

  private srTensor: Tensor | null = null;
  private vadState: Tensor | null = null;

  private consecutiveSpeechMs = 0;
  private consecutiveSilenceMs = 0;
  private isSpeechSegmentActive = false;
  private appendCountdownMs = 0;

  private prependFrames: Float32Array[] = [];
  private prependSamples = 0;

  private segmentFrames: Float32Array[] = [];
  private segmentSamples = 0;
  private segmentSpeechMs = 0;

  private onRecordListener: RecordListener = null;
  private onSpeechStartListener: VoidListener = null;
  private onSpeechEndListener: VoidListener = null;
  private onReadyListener: VoidListener = null;
  private onErrorListener: ErrorListener = null;
  private onVolumeChangeListener: NumberListener = null;
  private onSpeechProbabilityListener: NumberListener = null;

  constructor(options: VadRecorderOptions = {}) {
    this.options = {
      ...DEFAULT_OPTIONS,
      ...options,
      threshold: clamp(options.threshold ?? DEFAULT_OPTIONS.threshold, 0, 1),
      minSpeechDuration: Math.max(0, options.minSpeechDuration ?? DEFAULT_OPTIONS.minSpeechDuration),
      minSilenceDuration: Math.max(0, options.minSilenceDuration ?? DEFAULT_OPTIONS.minSilenceDuration),
      sampleRate: Math.max(8000, options.sampleRate ?? DEFAULT_OPTIONS.sampleRate),
      channelCount: Math.max(1, options.channelCount ?? DEFAULT_OPTIONS.channelCount),
      prependSilence: Math.max(0, options.prependSilence ?? DEFAULT_OPTIONS.prependSilence),
      appendSilence: Math.max(0, options.appendSilence ?? DEFAULT_OPTIONS.appendSilence),
    };
  }

  static async info(): Promise<VadRecorderInfo> {
    const [isCached, downloadSize] = await Promise.all([
      ModelRegistry.is_cached(MODEL_ID, MODEL_OPTIONS),
      (async () => {
        const files = await ModelRegistry.get_model_files(MODEL_ID, MODEL_OPTIONS);
        const metadata = await Promise.all(
          files.map((file) => ModelRegistry.get_file_metadata(MODEL_ID, file)),
        );

        return metadata.reduce((total, file) => total + (file.size ?? 0), 0);
      })(),
    ]);

    return { isCached, downloadSize };
  }

  async initialize(onProgress?: (progress: ProgressEvent) => void): Promise<void> {
    this.assertNotDestroyed();

    if (this.model) {
      onProgress?.({ status: "ready" });
      return;
    }

    if (!this.modelInitPromise) {
      this.modelInitPromise = this.loadModel(onProgress).finally(() => {
        this.modelInitPromise = null;
      });
    }

    await this.modelInitPromise;
    onProgress?.({ status: "ready" });
  }

  async start(): Promise<void> {
    this.assertNotDestroyed();

    if (!this.model) {
      throw new Error("VadRecorder.start() requires initialize() to be called first.");
    }

    if (this.started) {
      this.paused = false;
      return;
    }

    this.resetSegmentState();
    this.paused = false;

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: this.options.channelCount,
          sampleRate: this.options.sampleRate,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });

      this.stream = stream;
      this.audioContext = new AudioContext({ sampleRate: this.options.sampleRate });
      this.srTensor = new Tensor("int64", [BigInt(this.audioContext.sampleRate)], []);

      this.sourceNode = this.audioContext.createMediaStreamSource(stream);
      this.workletUrl = createWorkletUrl(FRAME_SIZE);
      await this.audioContext.audioWorklet.addModule(this.workletUrl);

      this.workletNode = new AudioWorkletNode(this.audioContext, "vad-recorder-worklet");
      this.workletNode.port.onmessage = (event: MessageEvent<{ buffer: Float32Array }>) => {
        if (!event.data?.buffer) {
          return;
        }

        this.frameQueue.push(event.data.buffer);
        this.processFrameQueue();
      };

      this.sourceNode.connect(this.workletNode);
      this.workletNode.connect(this.audioContext.destination);

      this.started = true;
      this.onReadyListener?.();
    } catch (error) {
      const normalized = normalizeError(error);
      this.emitError(normalized);
      throw normalized;
    }
  }

  stop(): void {
    if (!this.started) {
      return;
    }

    this.teardownAudio();
    this.resetSegmentState();
    this.started = false;
    this.paused = false;
  }

  pause(): void {
    this.assertNotDestroyed();
    if (!this.started) {
      return;
    }
    this.paused = true;
  }

  resume(): void {
    this.assertNotDestroyed();
    if (!this.started) {
      return;
    }
    this.paused = false;
  }

  async destroy(): Promise<void> {
    if (this.destroyed) {
      return;
    }

    this.stop();
    this.destroyed = true;

    if (this.model?.dispose) {
      await this.model.dispose();
    }

    this.model = null;
    this.srTensor = null;
    this.vadState = null;
    this.clearListeners();
  }

  onRecord(listener: (blob: Blob) => void): void {
    this.onRecordListener = listener;
  }

  onSpeechStart(listener: () => void): void {
    this.onSpeechStartListener = listener;
  }

  onSpeechEnd(listener: () => void): void {
    this.onSpeechEndListener = listener;
  }

  onReady(listener: () => void): void {
    this.onReadyListener = listener;
  }

  onError(listener: (error: Error) => void): void {
    this.onErrorListener = listener;
  }

  onVolumeChange(listener: (db: number) => void): void {
    this.onVolumeChangeListener = listener;
  }

  onSpeechProbability(listener: (probability: number) => void): void {
    this.onSpeechProbabilityListener = listener;
  }

  private async loadModel(onProgress?: (progress: ProgressEvent) => void): Promise<void> {
    let lastProgress = -1;

    const progressCallback = (info: ProgressInfo): void => {
      if (!onProgress) {
        return;
      }

      if (info.status === "progress_total") {
        const progress = Math.round(clamp(info.progress / 100, 0, 1) * 100) / 100;
        if (progress === lastProgress) {
          return;
        }

        lastProgress = progress;
        onProgress({
          status: "downloading",
          name: MODEL_NAME,
          progress,
        });
      }
    };

    const loaded = (await AutoModel.from_pretrained(MODEL_ID, {
      // Silero VAD in transformers.js requires model_type=custom.
      // @ts-expect-error Upstream typing does not include this custom config use-case.
      config: { model_type: "custom" },
      ...MODEL_OPTIONS,
      progress_callback: progressCallback,
    })) as unknown as VadModel;

    this.model = loaded;
    this.vadState = new Tensor("float32", new Float32Array(2 * 1 * 128), [2, 1, 128]);
  }

  private async processFrameQueue(): Promise<void> {
    if (this.processingFrameQueue) {
      return;
    }

    this.processingFrameQueue = true;

    try {
      while (this.frameQueue.length > 0) {
        const frame = this.frameQueue.shift();
        if (!frame) {
          continue;
        }

        if (this.destroyed || !this.started || this.paused || !this.model || !this.srTensor || !this.vadState) {
          continue;
        }

        const frameMs = this.frameDurationMs(frame.length);

        this.pushPrependFrame(frame);
        this.onVolumeChangeListener?.(computeDecibels(frame));

        const input = new Tensor("float32", frame, [1, frame.length]);
        const { output, stateN } = await this.model({
          input,
          sr: this.srTensor,
          state: this.vadState,
        });

        this.vadState = stateN;
        const probability = Number(output.data[0] ?? 0);
        this.onSpeechProbabilityListener?.(probability);

        const isSpeech = probability >= this.options.threshold;

        if (!this.isSpeechSegmentActive) {
          if (isSpeech) {
            this.consecutiveSpeechMs += frameMs;
            if (this.consecutiveSpeechMs >= this.options.minSpeechDuration) {
              this.beginSegment();
              this.appendFrameToSegment(frame, true);
            }
          } else {
            this.consecutiveSpeechMs = 0;
          }

          continue;
        }

        this.appendFrameToSegment(frame, isSpeech);

        if (isSpeech) {
          this.consecutiveSilenceMs = 0;
          this.appendCountdownMs = 0;
          continue;
        }

        this.consecutiveSilenceMs += frameMs;

        if (this.appendCountdownMs <= 0 && this.consecutiveSilenceMs >= this.options.minSilenceDuration) {
          this.onSpeechEndListener?.();
          this.appendCountdownMs = this.options.appendSilence;
        }

        if (this.appendCountdownMs > 0) {
          this.appendCountdownMs -= frameMs;
          if (this.appendCountdownMs <= 0) {
            this.finishSegment();
          }
        }
      }
    } catch (error) {
      this.emitError(normalizeError(error));
    } finally {
      this.processingFrameQueue = false;
    }
  }

  private beginSegment(): void {
    this.isSpeechSegmentActive = true;
    this.segmentFrames = [...this.prependFrames.map((frame) => frame.slice())];
    this.segmentSamples = this.segmentFrames.reduce((sum, frame) => sum + frame.length, 0);
    this.segmentSpeechMs = 0;
    this.consecutiveSilenceMs = 0;
    this.appendCountdownMs = 0;
    this.onSpeechStartListener?.();
  }

  private appendFrameToSegment(frame: Float32Array, containsSpeech: boolean): void {
    this.segmentFrames.push(frame.slice());
    this.segmentSamples += frame.length;

    if (containsSpeech) {
      this.segmentSpeechMs += this.frameDurationMs(frame.length);
    }
  }

  private finishSegment(): void {
    if (!this.isSpeechSegmentActive) {
      return;
    }

    const totalSpeechMs = this.segmentSpeechMs;
    const frames = this.segmentFrames;

    this.resetSegmentState();

    if (totalSpeechMs < this.options.minSpeechDuration) {
      return;
    }

    const pcm = concatFrames(frames, this.segmentSamples);
    const blob = encodeWav(pcm, this.audioContext?.sampleRate ?? this.options.sampleRate, this.options.mimeType);
    this.onRecordListener?.(blob);
  }

  private frameDurationMs(samples: number): number {
    const sampleRate = this.audioContext?.sampleRate ?? this.options.sampleRate;
    return (samples / sampleRate) * 1000;
  }

  private pushPrependFrame(frame: Float32Array): void {
    if (this.options.prependSilence <= 0) {
      return;
    }

    const maxPrependSamples = Math.floor((this.options.prependSilence / 1000) * (this.audioContext?.sampleRate ?? this.options.sampleRate));

    this.prependFrames.push(frame.slice());
    this.prependSamples += frame.length;

    while (this.prependSamples > maxPrependSamples && this.prependFrames.length > 0) {
      const removed = this.prependFrames.shift();
      if (removed) {
        this.prependSamples -= removed.length;
      }
    }
  }

  private resetSegmentState(): void {
    this.frameQueue.length = 0;
    this.consecutiveSpeechMs = 0;
    this.consecutiveSilenceMs = 0;
    this.isSpeechSegmentActive = false;
    this.appendCountdownMs = 0;
    this.segmentFrames = [];
    this.segmentSamples = 0;
    this.segmentSpeechMs = 0;
    this.prependFrames = [];
    this.prependSamples = 0;

    if (this.audioContext) {
      this.srTensor = new Tensor("int64", [BigInt(this.audioContext.sampleRate)], []);
    }
    this.vadState = new Tensor("float32", new Float32Array(2 * 1 * 128), [2, 1, 128]);
  }

  private teardownAudio(): void {
    this.workletNode?.disconnect();
    this.sourceNode?.disconnect();

    if (this.workletNode) {
      this.workletNode.port.onmessage = null;
    }

    this.workletNode = null;
    this.sourceNode = null;

    if (this.stream) {
      for (const track of this.stream.getTracks()) {
        track.stop();
      }
    }

    this.stream = null;

    if (this.audioContext) {
      void this.audioContext.close();
    }

    this.audioContext = null;

    if (this.workletUrl) {
      URL.revokeObjectURL(this.workletUrl);
      this.workletUrl = null;
    }
  }

  private clearListeners(): void {
    this.onRecordListener = null;
    this.onSpeechStartListener = null;
    this.onSpeechEndListener = null;
    this.onReadyListener = null;
    this.onErrorListener = null;
    this.onVolumeChangeListener = null;
    this.onSpeechProbabilityListener = null;
  }

  private emitError(error: Error): void {
    this.onErrorListener?.(error);
  }

  private assertNotDestroyed(): void {
    if (this.destroyed) {
      throw new Error("VadRecorder instance has been destroyed.");
    }
  }
}

function createWorkletUrl(frameSize: number): string {
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

function computeDecibels(frame: Float32Array): number {
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

function concatFrames(frames: Float32Array[], expectedSamples: number): Float32Array {
  const output = new Float32Array(expectedSamples);
  let offset = 0;

  for (const frame of frames) {
    output.set(frame, offset);
    offset += frame.length;
  }

  return output;
}

function encodeWav(samples: Float32Array, sampleRate: number, _mimeType: string): Blob {
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

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function normalizeError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }

  return new Error(typeof error === "string" ? error : "Unknown error");
}
