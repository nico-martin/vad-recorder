import { AutoModel, ModelRegistry, Tensor } from "@huggingface/transformers";
import type {
  ErrorListener,
  ModelProgressCallback,
  NumberListener,
  ProgressEvent,
  RecordListener,
  VadModel,
  VadRecorderInfo,
  VadRecorderOptions,
  VoidListener,
} from "./types";
import { computeDecibels, concatFrames, encodeWav } from "./utils/audio";
import { isModelCachedInAppCache } from "./utils/cache";
import { normalizeError } from "./utils/errors";
import { clamp } from "./utils/math";
import { createWorkletUrl } from "./utils/worklet";

export type {
  ProgressEvent,
  VadRecorderInfo,
  VadRecorderOptions,
} from "./types";

const MODEL_ID = "onnx-community/silero-vad";
const MODEL_NAME = "silero-vad";
const FRAME_SIZE = 512;
const SAMPLE_RATE = 16000;
const MODEL_OPTIONS = { dtype: "fp32" } as const;

const DEFAULT_OPTIONS: Required<VadRecorderOptions> = {
  threshold: 0.5,
  minSpeechDuration: 250,
  minSilenceDuration: 1000,
  prependSilence: 200,
  appendSilence: 300,
};

/**
 * Voice Activity Detection (VAD) recorder for browser microphone input.
 *
 * Captures live audio, detects speech with Silero VAD, and emits speech
 * segments as WAV blobs through `onRecord`.
 */
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

  /**
   * Create a new recorder instance.
   *
   * Supported options:
   * - `threshold` (`0..1`): speech probability cutoff.
   * - `minSpeechDuration` (ms): minimum continuous speech needed to start a segment.
   * - `minSilenceDuration` (ms): silence needed before ending a segment.
   * - `prependSilence` (ms): buffered lead-in audio prepended to a segment.
   * - `appendSilence` (ms): trailing audio kept after speech end.
   */
  constructor(options: VadRecorderOptions = {}) {
    this.options = {
      ...DEFAULT_OPTIONS,
      ...options,
      threshold: clamp(options.threshold ?? DEFAULT_OPTIONS.threshold, 0, 1),
      minSpeechDuration: Math.max(
        0,
        options.minSpeechDuration ?? DEFAULT_OPTIONS.minSpeechDuration,
      ),
      minSilenceDuration: Math.max(
        0,
        options.minSilenceDuration ?? DEFAULT_OPTIONS.minSilenceDuration,
      ),
      prependSilence: Math.max(
        0,
        options.prependSilence ?? DEFAULT_OPTIONS.prependSilence,
      ),
      appendSilence: Math.max(
        0,
        options.appendSilence ?? DEFAULT_OPTIONS.appendSilence,
      ),
    };
  }

  /**
   * Get model metadata used by this recorder.
   *
   * - `isCached`: whether the ONNX model is present in the browser cache.
   * - `downloadSize`: remote size in bytes for `onnx/model.onnx`.
   */
  static async info(): Promise<VadRecorderInfo> {
    const file = "onnx/model.onnx";
    const [isCached, meta] = await Promise.all([
      isModelCachedInAppCache(MODEL_ID),
      ModelRegistry.get_file_metadata(MODEL_ID, file),
    ]);
    const downloadSize = meta.size ?? 0;

    return { isCached, downloadSize };
  }

  /**
   * Load and initialize the VAD model.
   *
   * Safe to call multiple times; repeated calls reuse the same loaded model.
   * The optional callback receives download progress and a final `ready` event.
   */
  async initialize(
    onProgress?: (progress: ProgressEvent) => void,
  ): Promise<void> {
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

  /**
   * Start microphone capture and VAD processing.
   *
   * Requires `initialize()` to be called first.
   */
  async start(): Promise<void> {
    this.assertNotDestroyed();

    if (!this.model) {
      throw new Error(
        "VadRecorder.start() requires initialize() to be called first.",
      );
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
          channelCount: 1,
          sampleRate: SAMPLE_RATE,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });

      this.stream = stream;
      this.audioContext = new AudioContext({ sampleRate: SAMPLE_RATE });
      this.srTensor = new Tensor(
        "int64",
        [BigInt(this.audioContext.sampleRate)],
        [],
      );

      this.sourceNode = this.audioContext.createMediaStreamSource(stream);
      this.workletUrl = createWorkletUrl(FRAME_SIZE);
      await this.audioContext.audioWorklet.addModule(this.workletUrl);

      this.workletNode = new AudioWorkletNode(
        this.audioContext,
        "vad-recorder-worklet",
      );
      this.workletNode.port.onmessage = (
        event: MessageEvent<{ buffer: Float32Array }>,
      ) => {
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

  /**
   * Stop microphone capture and processing.
   * Keeps the model loaded so recording can be started again quickly.
   */
  stop(): void {
    if (!this.started) {
      return;
    }

    this.teardownAudio();
    this.resetSegmentState();
    this.started = false;
    this.paused = false;
  }

  /** Pause VAD processing while keeping the stream active. */
  pause(): void {
    this.assertNotDestroyed();
    if (!this.started) {
      return;
    }
    this.paused = true;
  }

  /** Resume processing after `pause()`. */
  resume(): void {
    this.assertNotDestroyed();
    if (!this.started) {
      return;
    }
    this.paused = false;
  }

  /**
   * Fully dispose this instance.
   *
   * Stops capture, disposes model resources, and removes listeners.
   * After calling this method, the instance cannot be reused.
   */
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

  /** Register callback fired when a speech segment blob is ready. */
  onRecord(listener: (blob: Blob) => void): void {
    this.onRecordListener = listener;
  }

  /** Register callback fired when speech is detected. */
  onSpeechStart(listener: () => void): void {
    this.onSpeechStartListener = listener;
  }

  /** Register callback fired when speech end is detected. */
  onSpeechEnd(listener: () => void): void {
    this.onSpeechEndListener = listener;
  }

  /** Register callback fired when recorder is actively listening. */
  onReady(listener: () => void): void {
    this.onReadyListener = listener;
  }

  /** Register callback fired on runtime errors. */
  onError(listener: (error: Error) => void): void {
    this.onErrorListener = listener;
  }

  /** Register callback fired with current input volume in dB. */
  onVolumeChange(listener: (db: number) => void): void {
    this.onVolumeChangeListener = listener;
  }

  /** Register callback fired with current VAD speech probability (`0..1`). */
  onSpeechProbability(listener: (probability: number) => void): void {
    this.onSpeechProbabilityListener = listener;
  }

  private async loadModel(
    onProgress?: (progress: ProgressEvent) => void,
  ): Promise<void> {
    let lastProgress = -1;

    const progressCallback: ModelProgressCallback = (info): void => {
      if (!onProgress) {
        return;
      }

      if (info.status === "progress_total") {
        const progress =
          Math.round(clamp(info.progress / 100, 0, 1) * 100) / 100;
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
    this.vadState = new Tensor(
      "float32",
      new Float32Array(2 * 1 * 128),
      [2, 1, 128],
    );
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

        if (
          this.destroyed ||
          !this.started ||
          this.paused ||
          !this.model ||
          !this.srTensor ||
          !this.vadState
        ) {
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

        if (
          this.appendCountdownMs <= 0 &&
          this.consecutiveSilenceMs >= this.options.minSilenceDuration
        ) {
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
    this.segmentSamples = this.segmentFrames.reduce(
      (sum, frame) => sum + frame.length,
      0,
    );
    this.segmentSpeechMs = 0;
    this.consecutiveSilenceMs = 0;
    this.appendCountdownMs = 0;
    this.onSpeechStartListener?.();
  }

  private appendFrameToSegment(
    frame: Float32Array,
    containsSpeech: boolean,
  ): void {
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
    const totalSamples = this.segmentSamples;

    this.resetSegmentState();

    if (totalSpeechMs < this.options.minSpeechDuration) {
      return;
    }

    const pcm = concatFrames(frames, totalSamples);
    const blob = encodeWav(pcm, this.audioContext?.sampleRate ?? SAMPLE_RATE);
    this.onRecordListener?.(blob);
  }

  private frameDurationMs(samples: number): number {
    const sampleRate = this.audioContext?.sampleRate ?? SAMPLE_RATE;
    return (samples / sampleRate) * 1000;
  }

  private pushPrependFrame(frame: Float32Array): void {
    if (
      this.options.prependSilence <= 0 &&
      this.options.minSpeechDuration <= 0
    ) {
      return;
    }

    const sampleRate = this.audioContext?.sampleRate ?? SAMPLE_RATE;
    const requiredMs =
      this.options.prependSilence + this.options.minSpeechDuration;
    const maxPrependSamples = Math.floor((requiredMs / 1000) * sampleRate);

    this.prependFrames.push(frame.slice());
    this.prependSamples += frame.length;

    while (
      this.prependSamples > maxPrependSamples &&
      this.prependFrames.length > 0
    ) {
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
      this.srTensor = new Tensor(
        "int64",
        [BigInt(this.audioContext.sampleRate)],
        [],
      );
    }
    this.vadState = new Tensor(
      "float32",
      new Float32Array(2 * 1 * 128),
      [2, 1, 128],
    );
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
