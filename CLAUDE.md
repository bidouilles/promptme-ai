# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Browser-based **French-language** teleprompter that listens to your voice and tracks position in the script in real time. Fork of `larsbaunwall/promptme-ai` adapted for French presentations — model, matcher, sample script, and UI all localised. **No build step, no backend, no framework** — vanilla JS + CSS served as static files from `src/`.

Live deploy: `https://bidouilles.github.io/promptme-ai/` (Pages on push to `main`).

## Running locally

The app needs cross-origin isolation (for `SharedArrayBuffer` used by Transformers.js when the Whisper engine is active). `src/coi-serviceworker.js` installs the required COOP/COEP headers, so any static server works:

```bash
cd src
python3 -m http.server 8080      # or: npx serve .
```

Open `http://localhost:8080`. On Safari/Chromium the page boots without any model download (Web Speech engine — see below). On Firefox or after the user flips the offline toggle, the Whisper base model (~150 MB) is fetched on first run and cached; after that Whisper also works offline.

**HTTPS / mic access:** `getUserMedia` and Web Speech only work from a secure context (`https://`, `localhost`, or `127.0.0.1`). On iPad accessed over a LAN IP (`http://192.168.x.y:8080/`), Safari does not expose `navigator.mediaDevices` at all — the app detects this and surfaces a French message explaining the cause rather than the raw "undefined is not an object". For iPad testing use mkcert + an HTTPS dev server, ngrok, or the GitHub Pages URL.

## Deployment

`.github/workflows/deploy.yml` publishes `./src` to GitHub Pages on push to `main`. There is no test/lint pipeline — the only CI is the Pages deploy.

## Architecture

There are **two interchangeable speech engines**. They share the same downstream code path (matcher + scroll/highlight), differing only in how transcripts are produced. Active engine lives in `state.engine` ∈ `{'web-speech', 'whisper'}`, persisted to `localStorage` under `promptme.engine`. The user-facing toggle is **"Reconnaissance hors ligne"** in the Controls panel — only rendered when Web Speech is available on the browser.

### Engine 1 — Web Speech (default on Safari/iPad/Chromium)

```
SpeechRecognition (lang='fr-FR', continuous, interimResults)
   → app.js: onresult handler concatenates new entries since resultIndex
   → appendTranscript() + processTranscript()  (same matcher path as Whisper)
```

- No model download, no Workers, no AudioWorklet. The browser handles capture + ASR natively; on iOS this is Apple's Speech framework.
- iOS auto-stops the recognizer after ~60 s of silence; the `onend` handler restarts as long as `state._wsRestart` is true. Don't touch this without testing on a real iPad.
- Audio may transit Apple/Google servers depending on browser + OS version — the engine indicator surfaces this in French.
- Implemented in `app.js`: `initWebSpeech()`, `startWebSpeech()`, `stopWebSpeech()`.

### Engine 2 — Whisper (fallback + offline mode)

Three-thread pipeline. Each piece exists for a specific latency reason; do not collapse them.

```
AudioWorklet (16 kHz PCM, 512 samples)
   → vad.worker.js     (Silero VAD — runs unblocked at frame rate)
   → transcribe.worker.js  (Whisper base multilingual ONNX, French — queues segments)
   → app.js main thread    (script matcher + scroll/highlight UI)
```

- **`src/vad.worker.js`** — Silero VAD only. Detects speech-segment boundaries and posts completed segments to the main thread. Emits partials every **1800 ms** (max **2** per utterance) — relaxed from the original 1000 ms × 4 because each partial re-transcribes the whole accumulated buffer, so frequent partials saturate the worker on WASM.
- **`src/transcribe.worker.js`** — Whisper ASR only (`onnx-community/whisper-base`, multilingual, called with a French language hint). The call options also pass `no_repeat_ngram_size: 3`, `temperature: 0`, `condition_on_prev_tokens: false` — without these, Whisper's greedy decoder loops on French function-word sequences (a single `"vous parlez"` decoded as `"vous par les par les par les..."`). Treat all three flags as load-bearing.
- **`src/whisper.worker.js`** — **Legacy / unused.** Earlier single-worker design that combined VAD + the original Moonshine ASR. Kept for reference but not loaded by `app.js`.

### Common
- **`src/app.js`** (~1900 lines, single file) — UI, audio capture, script tokenization/indexing, fuzzy matcher, scroll/highlight rendering, optimistic-creep ticker, and the two engine implementations.
- Whisper workers are **not** pre-loaded at boot when Web Speech is the active engine — saves the 150 MB download on iPad. They lazy-init the first time the user flips the offline toggle (`setEngine('whisper')` → `initWorker()`).
- Whisper status handlers in the message-passing layer are gated on `if (state.engine === 'whisper')` — without this guard, a background worker can overwrite the Apple Speech engine label after the user has switched.

## Script-matching algorithm

The hard problem is mapping noisy ~600 ms ASR batches back to a script position. Implemented in `app.js`; the design hinges on these layered ideas — touch them carefully:

1. **Phonetic normalisation at parse time.** Every script and spoken token is run through Double Metaphone (`double-metaphone` from CDN). DM is English-tuned but produces a stable code for any input — script-side and ASR-side encodings stay consistent. On top of DM, **French-specific layers** handle the cases DM cannot resolve:
   - `ASR_OVERRIDES` is a manual table mapping each French homophone group to a shared key: `[sɛ]` (c'est/ces/ses/s'est/sait/sais), `[ɛ]` (et/est/ait/aie/aient), `[a]` (a/à/as), articles (le/les/la, un/une, du/de/des), possessives, peu/peut/peux, quel/quelle/quels/quelles, etc. ASR routinely swaps these and DM does not collapse them.
   - `stripVerbSuffix` collapses regular-verb `[e]/[ɛ]` endings before DM: `parler / parlé / parlais / parlait / parlaient / parlez` all hash to the same root. The regex is deliberately narrow — it does **not** strip plural `-s` or bare `-e`, which would cause too many short-word collisions. Minimum 4 letters must remain after the cut.
2. **Inverted token index** (`token → [positions]`) built once at script load. Candidate windows come from O(1) hash lookups, not full-script scans.
3. **Banded Levenshtein** over token windows: only the diagonal band of width `MAX_EDITS` is computed (`O(n·k)`), with early-exit when the running minimum exceeds the edit budget. DP rows are pre-allocated `Int16Array` buffers reused across calls.
4. **Locality penalty.** Score is halved every ~20 words of offset from the last confirmed position, so the matcher does not jump to a higher-scoring repeat earlier/later in the script.
5. **Optimistic word creep.** Between ASR batches, the highlight is advanced at ~85% of the measured WPM (capped at 3 words ahead). On the next confirmed transcript, it snaps back. This is what makes tracking feel real-time despite the 600 ms batch latency. See `creepTick` (recently tweaked with punctuation-aware deceleration — commit fe1de13).

## Conventions

- ES modules loaded directly from CDN (`https://cdn.jsdelivr.net/npm/...`). No bundler, no `node_modules`, no `package.json`. When adding a dep, import it from a CDN ESM URL the same way.
- Workers are also ES modules (`new Worker(url, { type: 'module' })`) and import Transformers.js from the same CDN.
- The Transformers.js version is pinned in URL strings (currently `@huggingface/transformers@3.8.1`) — bump it in **all three** worker files together.
- Inference backend auto-detects: WebGPU if `navigator.gpu.requestAdapter()` succeeds, otherwise WASM. `DTYPE_CONFIGS` in `transcribe.worker.js` differs by backend (q4 for WebGPU, q8 for WASM) — keep both paths working when changing the model.
- **All user-visible strings are in French** — including engine indicator, status badge, error messages, button labels, ARIA labels, the `<title>`, and `<html lang="fr">`. Console logs and `_mlog()` metric keys stay English (developer-facing). When adding new UI strings, follow suit; when adding new status/error states, remember they may be forwarded from a worker via `{ type: 'status', message: '…' }` and are displayed verbatim.
- WPM is displayed in the UI as **MPM** (mots par minute). Internal variable names (`wpm`, `WPM_DEFAULT`, etc.) stayed English.
