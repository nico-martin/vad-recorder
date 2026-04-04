import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { VadRecorder } from "./index";
import type {
  ProgressEvent,
  VadRecorderInfo,
  VadRecorderOptions,
} from "./types";

export type UseVadRecorderResult = {
  status: string;
  progress: number;
  volumeDb: number | null;
  speechProbability: number | null;
  recordings: Blob[];
  error: Error | null;
  recorder: VadRecorder | null;
  initialize: () => Promise<void>;
  start: () => Promise<void>;
  stop: () => void;
  pause: () => void;
  resume: () => void;
  destroy: () => Promise<void>;
  clearRecordings: () => void;
  info: () => Promise<VadRecorderInfo>;
};

export function useVadRecorder(
  options: VadRecorderOptions = {},
): UseVadRecorderResult {
  const [status, setStatus] = useState("idle");
  const [progress, setProgress] = useState(0);
  const [volumeDb, setVolumeDb] = useState<number | null>(null);
  const [speechProbability, setSpeechProbability] = useState<number | null>(
    null,
  );
  const [recordings, setRecordings] = useState<Blob[]>([]);
  const [error, setError] = useState<Error | null>(null);
  const [recorder, setRecorder] = useState<VadRecorder | null>(null);

  const recorderRef = useRef<VadRecorder | null>(null);
  const optionsKey = useMemo(() => JSON.stringify(options), [options]);

  useEffect(() => {
    const parsedOptions = JSON.parse(optionsKey) as VadRecorderOptions;
    const instance = new VadRecorder(parsedOptions);

    instance.onReady(() => {
      setStatus("ready");
    });
    instance.onRecord((blob) => {
      setRecordings((prev: Blob[]) => [blob, ...prev]);
    });
    instance.onError((nextError) => {
      setError(nextError);
      setStatus("error");
    });
    instance.onVolumeChange((db) => {
      setVolumeDb(db);
    });
    instance.onSpeechProbability((probability) => {
      setSpeechProbability(probability);
    });
    instance.onSpeechStart(() => {
      setStatus("speech");
    });
    instance.onSpeechEnd(() => {
      setStatus("silence");
    });

    recorderRef.current = instance;
    setRecorder(instance);
    setError(null);

    return () => {
      recorderRef.current = null;
      setRecorder(null);
      void instance.destroy();
    };
  }, [optionsKey]);

  const ensureRecorder = (): VadRecorder => {
    if (!recorderRef.current) {
      throw new Error("Recorder is not ready yet");
    }

    return recorderRef.current;
  };

  const initialize = useCallback(async (): Promise<void> => {
    const instance = ensureRecorder();
    setStatus("initializing");
    setProgress(0);

    await instance.initialize((event: ProgressEvent) => {
      if (event.status === "ready") {
        setProgress(1);
        setStatus("initialized");
        return;
      }

      setStatus(event.status);
      setProgress(event.progress);
    });
  }, []);

  const start = useCallback(async (): Promise<void> => {
    const instance = ensureRecorder();
    setStatus("starting");
    await instance.start();
  }, []);

  const stop = useCallback((): void => {
    ensureRecorder().stop();
    setStatus("stopped");
  }, []);

  const pause = useCallback((): void => {
    ensureRecorder().pause();
    setStatus("paused");
  }, []);

  const resume = useCallback((): void => {
    ensureRecorder().resume();
    setStatus("resumed");
  }, []);

  const destroy = useCallback(async (): Promise<void> => {
    const instance = ensureRecorder();
    await instance.destroy();
    setStatus("destroyed");
  }, []);

  const clearRecordings = useCallback((): void => {
    setRecordings([]);
  }, []);

  const info = useCallback(async (): Promise<VadRecorderInfo> => {
    return VadRecorder.info();
  }, []);

  return {
    status,
    progress,
    volumeDb,
    speechProbability,
    recordings,
    error,
    recorder,
    initialize,
    start,
    stop,
    pause,
    resume,
    destroy,
    clearRecordings,
    info,
  };
}
