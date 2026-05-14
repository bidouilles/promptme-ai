/**
 * Transcription Worker — Whisper base (multilingual, French)
 *
 * Receives completed speech segments from the VAD worker (relayed via
 * main thread). Runs Whisper inference with a French language hint and
 * posts transcripts back to the main thread.
 *
 * Completely decoupled from VAD: Whisper's 500 ms–1.2 s inference never
 * delays speech boundary detection. Segments that arrive while a previous
 * inference is running are queued and processed in order.
 */

import {
  pipeline,
} from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1/dist/transformers.min.js';

// Language and task hints passed on every transcription call. Whisper is
// multilingual; without these it would language-detect each segment, which
// is slower and less reliable for short utterances.
const ASR_OPTIONS = { language: 'french', task: 'transcribe' };

// ── Device detection ─────────────────────────────────────────────────────────
async function supportsWebGPU() {
  if (!('gpu' in navigator)) return false;
  try { const a = await navigator.gpu.requestAdapter(); return a !== null; }
  catch { return false; }
}

const device = (await supportsWebGPU()) ? 'webgpu' : 'wasm';
self.postMessage({ type: 'info', message: `Device: ${device}` });
self.postMessage({ type: 'status', status: 'loading', message: 'Loading speech model…' });

const DTYPE_CONFIGS = {
  webgpu: { encoder_model: 'fp32', decoder_model_merged: 'q4' },
  wasm:   { encoder_model: 'fp32', decoder_model_merged: 'q8' },
};

// ── Load Whisper base (multilingual) ─────────────────────────────────────────
// Tiny was too weak for French — frequent homophone/word swaps even on clear
// audio. Base is ~2× the download and ~2× inference, but noticeably more
// accurate; the optimistic-creep layer in app.js hides most of the added
// latency so reading still feels real-time.
let transcriber;
try {
  transcriber = await pipeline(
    'automatic-speech-recognition',
    'onnx-community/whisper-base',
    {
      device, dtype: DTYPE_CONFIGS[device],
      progress_callback: (progress) => {
        if (progress.status === 'progress' && progress.total) {
          self.postMessage({ type: 'progress', percent: Math.round((progress.loaded / progress.total) * 100), file: progress.file });
        } else if (progress.status === 'done') {
          self.postMessage({ type: 'progress', percent: 100, file: progress.file });
        }
      },
    },
  );
} catch (err) {
  self.postMessage({ type: 'error', message: `Failed to load Whisper: ${err.message}` });
  throw err;
}

// Warm up — compile shaders / JIT with a silent buffer
await transcriber(new Float32Array(16000), ASR_OPTIONS);
self.postMessage({ type: 'status', status: 'ready', message: 'Ready' });

// ── Smart partial handling ────────────────────────────────────────────────────
// Partials arrive while VAD accumulates audio. If inference is slower than
// the partial interval, stale partials queue up. We keep only the LATEST
// partial buffer and skip any that were superseded before processing started.
// Finals always process.
let txChain = Promise.resolve();
let _latestPartial = null;   // newest partial buffer, replaces any pending one

async function transcribeAndEmit(buffer, isFinal, vadEmitTs, audioMs) {
  const txStartTs = performance.now();
  self.postMessage({ type: 'status', status: 'transcribing', message: 'Transcribing…' });
  const { text } = await transcriber(buffer, ASR_OPTIONS);
  const txEndTs = performance.now();
  const cleaned = text.trim();
  if (cleaned) self.postMessage({ type: 'transcript', text: cleaned, isFinal, vadEmitTs, audioMs, txStartTs, txEndTs, txDurMs: Math.round(txEndTs - txStartTs) });
  self.postMessage({ type: 'status', status: 'recording', message: 'Listening…' });
}

// ── Main message handler ──────────────────────────────────────────────────────
self.onmessage = ({ data }) => {
  const { type, buffer, isFinal, vadEmitTs, audioMs } = data;
  if (type !== 'segment' || !buffer) return;

  if (isFinal) {
    // Finals are never dropped — they contain the full utterance.
    txChain = txChain.then(() => transcribeAndEmit(buffer, true, vadEmitTs, audioMs).catch(
      err => console.error('[TX worker] Transcription error:', err)));
  } else {
    // For partials: store latest buffer. When the chain reaches this entry
    // it grabs the freshest one and skips any that were superseded.
    _latestPartial = { buffer, vadEmitTs, audioMs };
    txChain = txChain.then(() => {
      const p = _latestPartial;
      if (!p) return;           // already consumed by a newer chain entry
      _latestPartial = null;      // claim it
      return transcribeAndEmit(p.buffer, false, p.vadEmitTs, p.audioMs).catch(() => {});
    });
  }
};
