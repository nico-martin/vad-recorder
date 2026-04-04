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
  - Speech probability cutoff (`0-1`).
  - Higher = stricter detection (fewer false positives, can miss quiet speech).
  - Lower = more sensitive (captures quiet speech, can trigger on noise).
- `minSpeechDuration` ms (default `250`)
  - Minimum continuous speech before a segment officially starts.
  - Helps filter clicks, breaths, and very short noises.
- `minSilenceDuration` ms (default `1000`)
  - Required silence before a segment is considered finished.
  - Increase to avoid splitting natural pauses mid-sentence.
- `prependSilence` ms (default `100`)
  - Audio prepended before detected speech to avoid clipping first phonemes.
  - Internally combined with `minSpeechDuration` in the rolling pre-buffer.
- `appendSilence` ms (default `300`)
  - Extra audio kept after speech end is detected.
  - Helps avoid cutting off trailing words/syllables.

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
- Sample rate is fixed at `16000` (Silero VAD requirement).
- Channel count is fixed at mono (`1`).
- Current recording output is WAV blobs (`audio/wav`) for deterministic PCM assembly.
