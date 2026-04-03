import "./style.css";
import { VadRecorder } from "../../../src/index";

const infoButton = getEl<HTMLButtonElement>("info");
const initButton = getEl<HTMLButtonElement>("init");
const startButton = getEl<HTMLButtonElement>("start");
const pauseButton = getEl<HTMLButtonElement>("pause");
const resumeButton = getEl<HTMLButtonElement>("resume");
const stopButton = getEl<HTMLButtonElement>("stop");

const statusEl = getEl<HTMLParagraphElement>("status");
const modelEl = getEl<HTMLParagraphElement>("model");
const volumeEl = getEl<HTMLParagraphElement>("volume");
const speechProbEl = getEl<HTMLParagraphElement>("speech-prob");
const progressEl = getEl<HTMLProgressElement>("progress");
const logEl = getEl<HTMLPreElement>("log");
const recordingsEl = getEl<HTMLDivElement>("recordings");

const recorder = new VadRecorder({
  threshold: 0.55,
  minSpeechDuration: 250,
  minSilenceDuration: 900,
  prependSilence: 120,
  appendSilence: 300,
});

recorder.onReady(() => {
  setStatus("ready/listening");
  writeLog("onReady");
});

recorder.onSpeechStart(() => {
  setStatus("speech detected");
  writeLog("onSpeechStart");
});

recorder.onSpeechEnd(() => {
  setStatus("speech ended");
  writeLog("onSpeechEnd");
});

recorder.onRecord((blob) => {
  setStatus("segment recorded");
  writeLog(`onRecord (${blob.size} bytes)`);

  const url = URL.createObjectURL(blob);
  const audio = document.createElement("audio");
  audio.controls = true;
  audio.src = url;
  recordingsEl.prepend(audio);
});

recorder.onVolumeChange((db) => {
  volumeEl.textContent = `Volume: ${db.toFixed(1)} dB`;
});

recorder.onSpeechProbability((p) => {
  speechProbEl.textContent = `Speech probability: ${p.toFixed(3)}`;
});

recorder.onError((error) => {
  setStatus("error");
  writeLog(`onError: ${error.message}`);
});

infoButton.addEventListener("click", async () => {
  const info = await VadRecorder.info();
  modelEl.textContent = `Model: cached=${info.isCached} downloadSize=${info.downloadSize} bytes`;
  writeLog(`info: cached=${info.isCached}, size=${info.downloadSize}`);
});

initButton.addEventListener("click", async () => {
  setStatus("initializing");
  progressEl.value = 0;

  await recorder.initialize((event) => {
    if (event.status === "ready") {
      progressEl.value = 1;
      setStatus("initialized");
      writeLog("initialize: ready");
      return;
    }

    progressEl.value = event.progress;
    setStatus(`${event.status} (${Math.round(event.progress * 100)}%)`);
  });
});

startButton.addEventListener("click", async () => {
  await recorder.start();
  setStatus("starting...");
});

pauseButton.addEventListener("click", () => {
  recorder.pause();
  setStatus("paused");
  writeLog("pause");
});

resumeButton.addEventListener("click", () => {
  recorder.resume();
  setStatus("resumed");
  writeLog("resume");
});

stopButton.addEventListener("click", () => {
  recorder.stop();
  setStatus("stopped");
  writeLog("stop");
});

function setStatus(value: string): void {
  statusEl.textContent = `Status: ${value}`;
}

function writeLog(line: string): void {
  const stamp = new Date().toLocaleTimeString();
  logEl.textContent = `[${stamp}] ${line}\n${logEl.textContent}`;
}

function getEl<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`Missing #${id}`);
  }
  return element as T;
}
