# vad-recorder — Implementation Spec

## Overview

`vad-recorder` is a JavaScript library that combines Voice Activity Detection (VAD) with audio recording. When activated, it listens on the microphone, automatically starts recording when speech is detected, and fires an event with the recorded audio blob when the speaker stops.

It uses [Transformers.js](https://huggingface.co/docs/transformers.js) internally for VAD inference. The VAD model is fixed — consumers cannot swap it out.

---

## Package

```
vad-recorder/
├── src/
│   └── index.js         # main entry point
├── package.json
└── README.md
```

**package.json** essentials:
```json
{
  "name": "vad-recorder",
  "type": "module",
  "main": "./src/index.js",
  "exports": {
    ".": "./src/index.js"
  }
}
```

---

## Model

- **Fixed model**: Silero VAD via Transformers.js
- **Not configurable** by the consumer
- Model is loaded once and cached in the browser's Cache Storage
- Runs on WASM (default) — no WebGPU requirement

---

## API

### Static method: `VadRecorder.info()`

Returns metadata about the VAD model. Can be called before instantiation.

```js
const { isCached, downloadSize } = await VadRecorder.info();
```

**Returns:**
```ts
{
  isCached: boolean,      // true if model is already in Cache Storage
  downloadSize: number    // size in bytes
}
```

- `isCached` is determined by checking the browser's Cache Storage for the model URL
- `downloadSize` is determined by a HEAD request to the model URL (reads `Content-Length` header)
- Both checks should be done in parallel (`Promise.all`)

---

### Constructor: `new VadRecorder(options?)`

```js
const recorder = new VadRecorder({
  // VAD sensitivity
  threshold: 0.5,           // speech probability threshold (0–1), default: 0.5
  minSpeechDuration: 250,   // ms of speech before recording starts, default: 250
  minSilenceDuration: 1000, // ms of silence before speech end is triggered, default: 1000

  // Audio input
  sampleRate: 16000,        // default: 16000 (required by Silero VAD)
  channelCount: 1,          // default: 1 (mono)

  // Output
  mimeType: 'audio/webm',   // default: 'audio/webm'
  prependSilence: 100,      // ms of audio to include before speech start, default: 100
  appendSilence: 300,       // ms of audio to include after silence detected, default: 300
});
```

All options are optional. Defaults are applied for any omitted value.

---

### Instance method: `recorder.initialize(onProgress?)`

Loads the VAD model and prepares the audio pipeline. Does **not** request microphone access.

```js
await recorder.initialize(progress => {
  console.log(progress);
  // { status: 'downloading', name: 'silero-vad', progress: 0.43 }
  // { status: 'loading',     name: 'silero-vad', progress: 1.0  }
  // { status: 'ready' }
});
```

- `onProgress` callback is optional
- `progress` values: `0.0` – `1.0` as a float
- Resolves when model is ready
- Safe to call multiple times — subsequent calls resolve immediately if already initialized
- Must be called before `start()`

---

### Instance method: `recorder.start()`

Requests microphone access and begins VAD processing.

```js
await recorder.start();
```

- Triggers the browser's microphone permission prompt
- Throws if mic access is denied
- Throws if `initialize()` has not been called
- Emits `onReady` when listening begins

---

### Instance method: `recorder.stop()`

Stops listening and releases the microphone.

```js
recorder.stop();
```

- Stops audio stream and VAD processing
- Does not unload the model (call `destroy()` for that)

---

### Instance method: `recorder.pause()`

Pauses VAD processing without releasing the microphone.

```js
recorder.pause();
```

---

### Instance method: `recorder.resume()`

Resumes VAD processing after a pause.

```js
recorder.resume();
```

---

### Instance method: `recorder.destroy()`

Releases the microphone, unloads the model, and cleans up all resources.

```js
recorder.destroy();
```

- Instance is no longer usable after this call

---

## Events

All events are registered via instance methods that accept a callback.

```js
// Core
recorder.onRecord(blob => {})          // Fired with final audio Blob when speech segment ends
recorder.onSpeechStart(() => {})       // Speech detected, recording has begun
recorder.onSpeechEnd(() => {})         // Silence detected — fires just before onRecord

// Lifecycle
recorder.onReady(() => {})             // Mic is open, VAD is running — fired after start()
recorder.onError(err => {})            // Error (mic denied, model failure, etc.)

// Advanced / optional
recorder.onVolumeChange(db => {})      // Raw volume in dB — useful for UI visualisations
recorder.onSpeechProbability(p => {})  // Raw VAD score per frame (0–1), for custom logic
```

Each method registers exactly one listener. Calling the same method twice replaces the previous listener.

---

## Event firing order

For a single speech segment:

```
[user speaks]
  → onSpeechStart()
  → onVolumeChange() / onSpeechProbability()  (continuous, per frame)
[user stops speaking]
  → onSpeechEnd()
  → onRecord(blob)
[listening resumes automatically]
```

---

## Full usage example

```js
import { VadRecorder } from 'vad-recorder';

// Check model status before constructing
const { isCached, downloadSize } = await VadRecorder.info();

if (!isCached) {
  showBanner(`First use requires a ${formatBytes(downloadSize)} download`);
}

const recorder = new VadRecorder({
  threshold: 0.6,
  minSilenceDuration: 800,
  prependSilence: 150,
});

// Register events
recorder.onReady(() => updateUI('Listening...'));
recorder.onSpeechStart(() => updateUI('Recording...'));
recorder.onSpeechEnd(() => updateUI('Processing...'));
recorder.onRecord(blob => transcribe(blob));
recorder.onError(err => console.error(err));

// Initialize model (show progress if not cached)
await recorder.initialize(({ status, progress }) => {
  if (status === 'downloading') updateProgressBar(progress);
});

// Start on user interaction (to satisfy browser autoplay policy)
document.querySelector('#start-btn').addEventListener('click', async () => {
  await recorder.start();
});
```

---

## Implementation notes

- Audio frames are processed at the model's native frame size (Silero VAD: 512 samples at 16kHz)
- `prependSilence`: maintain a small ring buffer of audio frames before speech onset; prepend to the recording to avoid clipping the first phoneme
- `appendSilence`: after silence is detected, wait `appendSilence` ms before finalising the blob, to avoid clipping trailing audio
- `minSpeechDuration`: discard a speech segment if its duration is shorter than this threshold (filters breath sounds, clicks)
- `minSilenceDuration`: only trigger speech end when silence has lasted at least this long (avoids splitting on natural pauses mid-sentence)
- Use `MediaRecorder` for audio capture and blob assembly
- Use `AudioContext` + `ScriptProcessorNode` or `AudioWorkletNode` for frame-level access to PCM data
- VAD inference runs on each audio frame using the loaded Transformers.js pipeline