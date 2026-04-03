import type { ProgressInfo, Tensor } from "@huggingface/transformers";

export type ProgressEvent =
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
  channelCount?: number;
  prependSilence?: number;
  appendSilence?: number;
};

export type VadModelOutput = {
  stateN: Tensor;
  output: Tensor;
};

export type VadModel = {
  (inputs: { input: Tensor; sr: Tensor; state: Tensor }): Promise<VadModelOutput>;
  dispose?: () => Promise<unknown>;
};

export type VoidListener = (() => void) | null;
export type ErrorListener = ((error: Error) => void) | null;
export type RecordListener = ((blob: Blob) => void) | null;
export type NumberListener = ((value: number) => void) | null;

export type ModelProgressCallback = (info: ProgressInfo) => void;
