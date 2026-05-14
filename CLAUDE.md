# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Browser-based teleprompter that listens to your voice and tracks position in the script in real time. **No build step, no backend, no framework** — vanilla JS + CSS served as static files from `src/`.

## Running locally

The app needs cross-origin isolation (for `SharedArrayBuffer` used by Transformers.js). `src/coi-serviceworker.js` installs the required COOP/COEP headers, so any static server works:

```bash
cd src
python3 -m http.server 8080      # or: npx serve .
```

Open `http://localhost:8080`. The Whisper base model (~150 MB) is fetched on first run and cached; after that the app works offline. (Tiny was tried first and was too weak for French — recurring homophone/word swaps even on clean audio. Base is the smallest size that gave acceptable accuracy.)

**Language:** the app is configured for **French** speech. The language hint lives in `src/transcribe.worker.js` as `ASR_OPTIONS = { language: 'french', task: 'transcribe' }` and is passed on both warm-up and every transcription call. The matcher's homophone collapse tables (`ASR_OVERRIDES` and `stripVerbSuffix` in `src/app.js`) are also French-specific — see "Script-matching algorithm" below.

## Deployment

`.github/workflows/deploy.yml` publishes `./src` to GitHub Pages on push to `main`. There is no test/lint pipeline — the only CI is the Pages deploy.

## Architecture

Three-thread pipeline. Each piece exists for a specific latency reason; do not collapse them.

```
AudioWorklet (16 kHz PCM, 512 samples)
   → vad.worker.js     (Silero VAD — runs unblocked at frame rate)
   → transcribe.worker.js  (Whisper base multilingual ONNX, French — queues segments)
   → app.js main thread    (script matcher + scroll/highlight UI)
```

- **`src/app.js`** (~1700 lines, single file) — UI, audio capture, script tokenization/indexing, fuzzy matcher, scroll/highlight rendering, and the optimistic-creep ticker.
- **`src/vad.worker.js`** — Silero VAD only. Detects speech-segment boundaries and posts completed segments to the main thread.
- **`src/transcribe.worker.js`** — Whisper ASR only (`onnx-community/whisper-base`, multilingual, called with a French language hint). Receives segments relayed from the main thread; transcripts return as `{type:'transcript', text, isFinal}`.
- **`src/whisper.worker.js`** — **Legacy / unused.** The earlier single-worker design that combined VAD + the original Moonshine ASR. Kept for reference but not loaded by `app.js`. Decoupling VAD from ASR is the whole point of the current split — Whisper's 300–800 ms inference no longer delays speech-boundary detection.

The two workers and the main thread are wired in `app.js` around lines 1489–1506.

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
