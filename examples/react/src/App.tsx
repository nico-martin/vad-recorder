import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useForm } from "react-hook-form";
import { VadRecorder, type VadRecorderOptions } from "../../../src/index";

type Recording = {
  id: string;
  url: string;
  size: number;
};

const DEFAULT_OPTIONS: VadRecorderOptions = {
  threshold: 0.55,
  minSpeechDuration: 250,
  minSilenceDuration: 900,
  prependSilence: 200,
  appendSilence: 300,
};

export default function App() {
  const recorderRef = useRef<VadRecorder | null>(null);
  const [status, setStatus] = useState("idle");
  const [volume, setVolume] = useState("-");
  const [probability, setProbability] = useState("-");
  const [progress, setProgress] = useState(0);
  const [modelInfo, setModelInfo] = useState("unknown");
  const [logs, setLogs] = useState<string[]>([]);
  const [recordings, setRecordings] = useState<Recording[]>([]);

  const {
    register,
    handleSubmit,
    formState: { isSubmitting },
  } = useForm<VadRecorderOptions>({
    defaultValues: DEFAULT_OPTIONS,
  });

  const recordingCount = useMemo(() => recordings.length, [recordings.length]);

  useEffect(() => {
    void createRecorder(DEFAULT_OPTIONS);
    return () => {
      void cleanupRecorder();
      setRecordings((prev) => {
        for (const recording of prev) {
          URL.revokeObjectURL(recording.url);
        }
        return [];
      });
    };
  }, []);

  async function createRecorder(options: VadRecorderOptions): Promise<void> {
    await cleanupRecorder();

    const recorder = new VadRecorder(options);

    recorder.onReady(() => {
      setStatus("ready/listening");
      addLog("onReady");
    });
    recorder.onSpeechStart(() => {
      setStatus("speech detected");
      addLog("onSpeechStart");
    });
    recorder.onSpeechEnd(() => {
      setStatus("speech ended");
      addLog("onSpeechEnd");
    });
    recorder.onVolumeChange((db) => {
      setVolume(`${db.toFixed(1)} dB`);
    });
    recorder.onSpeechProbability((value) => {
      setProbability(value.toFixed(3));
    });
    recorder.onError((error) => {
      setStatus("error");
      addLog(`onError: ${error.message}`);
    });
    recorder.onRecord((blob) => {
      const url = URL.createObjectURL(blob);
      setRecordings((prev) => [
        { id: crypto.randomUUID(), url, size: blob.size },
        ...prev,
      ]);
      addLog(`onRecord (${blob.size} bytes)`);
    });

    recorderRef.current = recorder;
    setStatus("recorder created");
    addLog("new recorder created with current options");
  }

  async function cleanupRecorder(): Promise<void> {
    if (!recorderRef.current) {
      return;
    }

    const recorder = recorderRef.current;
    recorderRef.current = null;
    await recorder.destroy();
  }

  function addLog(message: string): void {
    const stamp = new Date().toLocaleTimeString();
    setLogs((prev) => [`[${stamp}] ${message}`, ...prev].slice(0, 200));
  }

  function getRecorder(): VadRecorder {
    if (!recorderRef.current) {
      throw new Error("Recorder not initialized yet. Submit options first.");
    }
    return recorderRef.current;
  }

  const onApplyOptions = handleSubmit(async (values) => {
    await createRecorder(values);
  });

  const onInfo = async () => {
    const info = await VadRecorder.info();
    setModelInfo(`cached=${info.isCached} size=${info.downloadSize} bytes`);
    addLog(`info: cached=${info.isCached} size=${info.downloadSize}`);
  };

  const onInitialize = async () => {
    const recorder = getRecorder();
    setStatus("initializing");
    setProgress(0);

    await recorder.initialize((event) => {
      if (event.status === "ready") {
        setProgress(1);
        setStatus("initialized");
        addLog("initialize: ready");
        return;
      }

      setProgress(event.progress);
      setStatus(`${event.status} ${Math.round(event.progress * 100)}%`);
    });
  };

  const onStart = async () => {
    await getRecorder().start();
    setStatus("starting");
    addLog("start");
  };

  const onPause = () => {
    getRecorder().pause();
    setStatus("paused");
    addLog("pause");
  };

  const onResume = () => {
    getRecorder().resume();
    setStatus("resumed");
    addLog("resume");
  };

  const onStop = () => {
    getRecorder().stop();
    setStatus("stopped");
    addLog("stop");
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <div className="mx-auto max-w-6xl px-4 py-8">
        <h1 className="text-3xl font-semibold tracking-tight">
          vad-recorder React playground
        </h1>
        <p className="mt-2 text-slate-300">
          Configure options with react-hook-form, then initialize and test the
          VAD flow.
        </p>

        <div className="mt-6 grid gap-6 lg:grid-cols-[380px_minmax(0,1fr)]">
          <form
            onSubmit={onApplyOptions}
            className="space-y-4 rounded-xl border border-slate-800 bg-slate-900/70 p-4"
          >
            <h2 className="text-lg font-medium">Options</h2>

            <Label title="threshold">
              <input
                type="number"
                step="0.01"
                min={0}
                max={1}
                className="field"
                {...register("threshold", { valueAsNumber: true })}
              />
            </Label>

            <Label title="minSpeechDuration (ms)">
              <input
                type="number"
                min={0}
                className="field"
                {...register("minSpeechDuration", { valueAsNumber: true })}
              />
            </Label>

            <Label title="minSilenceDuration (ms)">
              <input
                type="number"
                min={0}
                className="field"
                {...register("minSilenceDuration", { valueAsNumber: true })}
              />
            </Label>

            <Label title="prependSilence (ms)">
              <input
                type="number"
                min={0}
                className="field"
                {...register("prependSilence", { valueAsNumber: true })}
              />
            </Label>

            <Label title="appendSilence (ms)">
              <input
                type="number"
                min={0}
                className="field"
                {...register("appendSilence", { valueAsNumber: true })}
              />
            </Label>

            <button
              type="submit"
              disabled={isSubmitting}
              className="w-full rounded-md bg-cyan-500 px-3 py-2 font-medium text-slate-950 transition hover:bg-cyan-400 disabled:opacity-50"
            >
              {isSubmitting ? "Applying..." : "Apply options (new recorder)"}
            </button>
          </form>

          <div className="space-y-4">
            <div className="rounded-xl border border-slate-800 bg-slate-900/70 p-4">
              <h2 className="text-lg font-medium">Controls</h2>
              <div className="mt-3 flex flex-wrap gap-2">
                <Button onClick={onInfo}>Info</Button>
                <Button onClick={onInitialize}>Initialize</Button>
                <Button onClick={onStart}>Start</Button>
                <Button onClick={onPause}>Pause</Button>
                <Button onClick={onResume}>Resume</Button>
                <Button onClick={onStop}>Stop</Button>
              </div>

              <div className="mt-4 space-y-1 text-sm text-slate-300">
                <p>Status: {status}</p>
                <p>Model: {modelInfo}</p>
                <p>Volume: {volume}</p>
                <p>Speech probability: {probability}</p>
                <p>Recordings: {recordingCount}</p>
              </div>

              <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-slate-800">
                <div
                  className="h-full bg-cyan-400 transition-all"
                  style={{ width: `${progress * 100}%` }}
                />
              </div>
            </div>

            <div className="rounded-xl border border-slate-800 bg-slate-900/70 p-4">
              <h2 className="text-lg font-medium">Event log</h2>
              <div className="mt-2 max-h-48 overflow-auto rounded-md bg-slate-950 p-3 text-xs text-slate-300">
                {logs.length === 0 ? (
                  <p>No events yet.</p>
                ) : (
                  logs.map((line, index) => (
                    <p key={`${line}-${index}`}>{line}</p>
                  ))
                )}
              </div>
            </div>

            <div className="rounded-xl border border-slate-800 bg-slate-900/70 p-4">
              <h2 className="text-lg font-medium">Recordings</h2>
              <div className="mt-2 space-y-3">
                {recordings.length === 0 ? (
                  <p className="text-sm text-slate-400">No recordings yet.</p>
                ) : (
                  recordings.map((recording) => (
                    <div
                      key={recording.id}
                      className="rounded-md border border-slate-800 bg-slate-950 p-2"
                    >
                      <p className="mb-2 text-xs text-slate-400">
                        {recording.size} bytes
                      </p>
                      <audio className="w-full" controls src={recording.url} />
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function Label(props: { title: string; children: ReactNode }) {
  return (
    <label className="block text-sm text-slate-300">
      <span className="mb-1 block">{props.title}</span>
      {props.children}
    </label>
  );
}

function Button(props: {
  onClick: () => void | Promise<void>;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={() => void props.onClick()}
      className="rounded-md border border-slate-700 bg-slate-800 px-3 py-1.5 text-sm text-slate-100 transition hover:bg-slate-700"
    >
      {props.children}
    </button>
  );
}
