# vad-recorder

`vad-recorder` is a browser-focused TypeScript library that combines voice activity detection (VAD) with automatic audio segment recording.

It uses Silero VAD via `@huggingface/transformers` under the hood.

## Install

```bash
npm install vad-recorder
```

## Quick start

```ts
import { VadRecorder } from "vad-recorder";

const info = await VadRecorder.info();
console.log(info.isCached, info.downloadSize);

const recorder = new VadRecorder({
  threshold: 0.55,
  minSpeechDuration: 250,
  minSilenceDuration: 900,
  prependSilence: 120,
  appendSilence: 300,
});

recorder.onReady(() => console.log("Listening..."));
recorder.onSpeechStart(() => console.log("Speech start"));
recorder.onSpeechEnd(() => console.log("Speech end"));
recorder.onRecord((blob) => console.log("Recorded blob", blob));
recorder.onError((err) => console.error(err));

await recorder.initialize((event) => {
  if (event.status === "downloading") {
    console.log(`Model download: ${Math.round(event.progress * 100)}%`);
  }
});

await recorder.start();
```

## API

### `VadRecorder.info(): Promise<{ isCached: boolean; downloadSize: number }>`

Returns model cache/download metadata.

- `isCached`: whether required model files are cached.
- `downloadSize`: sum of all model file sizes (bytes).

### `new VadRecorder(options?)`

All options are optional:

- `threshold` (default `0.5`)
- `minSpeechDuration` ms (default `250`)
- `minSilenceDuration` ms (default `1000`)
- `sampleRate` (default `16000`)
- `channelCount` (default `1`)
- `mimeType` (default `audio/webm`)
- `prependSilence` ms (default `100`)
- `appendSilence` ms (default `300`)

### Lifecycle

- `initialize(onProgress?)`: loads VAD model, safe to call multiple times.
- `start()`: requests mic and starts frame processing.
- `pause()`: pauses VAD processing.
- `resume()`: resumes VAD processing.
- `stop()`: stops mic + processing, keeps model loaded.
- `destroy()`: full cleanup (mic + model + listeners).

### Events (single-listener setters)

- `onRecord((blob) => void)`
- `onSpeechStart(() => void)`
- `onSpeechEnd(() => void)`
- `onReady(() => void)`
- `onError((error) => void)`
- `onVolumeChange((db) => void)`
- `onSpeechProbability((p) => void)`

## Progress callback

`initialize(onProgress)` currently emits download progress from `progress_total` events only.

- Rounded to 2 decimals (`0.00` to `1.00`)
- Emitted only when the rounded value changes

## Development

```bash
npm install
npm run dev
```

Build for publish:

```bash
npm run build
```

Type-check:

```bash
npm run typecheck
```

## Example app

A minimal Vite demo is included at `examples/simple`.

```bash
cd examples/simple
npm install
npm run dev
```

## Notes

- Designed for browser environments.
- Current recording output is WAV blobs (`audio/wav`) for deterministic PCM assembly.
