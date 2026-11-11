# NOVA AI DJ v3.1 (Supernova Multi-Provider Edition)

NOVA is a full-stack autonomous AI DJ, beatmatching engine, stem mashup studio, and YouTube playlist mixer styled around high-contrast performance clarity (`Obsidian #060608` + `Supernova Vermilion #FF4D00` + `Solar Amber #FFB800`).

## Architecture (Phases 1–9)

1. **Phase 1 — Measurement, Stem & Lyric Understanding (`public/js/engine/analysis-worker.js`, `backend/`, `api/ai.js`)**
   - **Browser Essentia.js WASM + Mid-Side Spectral Engine**: Computes LUFS loudness, BPM, `beat_times`, `downbeat_times`, `bar_count`, `bars`, `phrase_boundaries` (8/16/32), `sections` (`intro`, `verse`, `pre_chorus`, `build`, `chorus`, `bridge`, `breakdown`, `outro`), `key_camelot`, `energy_per_bar`, `stem_activity` (`vocals`, `drums`, `bass`, `other`, `drum_density`, `bass_presence`), `instrumental_gaps`, `tempo_changes`, `tags`, and mixability `warnings`.
   - **Multilingual Transcription & Protected Lyric Ranges (`/api/ai`)**: `TRANSCRIBER` + `LYRIC_UNDERSTANDER` extract timestamped Hindi, Punjabi, Tamil, Telugu, Hinglish, and English lines, Romanised text, English translations, themes, hook timestamps, explicit flags, and `do_not_cut_ranges`, cached by song ID.
   - **Optional Python FastAPI GPU Backend (`backend/`)**: SHA-256 cached LUFS normalization, Demucs (`htdemucs`) 4-stem separation, multi-tracker beat/downbeat detection (`beat_this`, `madmom`, `librosa`), and `faster-whisper`/`WhisperX` lyrics via `AUDIO_WORKER_URL`.

2. **Phase 2–4 — Multi-Provider AI Router, 3-Idea Creativity Engine & Strict Validator (`api/_lib/llm-router.js`, `api/plan.js`, `public/js/engine/dj-brain.js`)**
   - **Provider-Agnostic AI Roles**: Assigns `PLANNER`, `LYRIC_UNDERSTANDER`, `AUDIO_LISTENER`, `CRITIC`, and `TRANSCRIBER` across **Gemini**, **Anthropic Claude Opus**, and **OpenAI** with automatic failover (`503`/`429` retry + fallback).
   - **Compatibility + Creativity Engine**: Scores pairs with `S = 0.25*T + 0.20*K + 0.15*E + 0.15*P + 0.15*V + 0.10*G - R`, generates **3 scored creative concepts** per transition, and enforces **19 transition templates**.
   - **Deterministic Rule Validator**: Rejects bar overruns, `>8.5%` tempo stretch violations, `>+-2` semitone shifts, double basslines, overlapping lead vocals, Camelot `>1` melodic clashes, clipping gain sums, and cuts inside protected `do_not_cut_ranges`.

3. **Phase 5–6 — Render, Listen & Critique Loop + Lookahead Playback Engine (`public/js/engine/offline-exporter.js`, `pro-mixer-engine.js`, `orchestrator.js`)**
   - Renders isolated 10–15s transition clips via `OfflineAudioContext`, measures 6 objective acoustic metrics (`bass_overlap_pct`, `vocal_overlap_pct`, `beat_drift_ms`, `lufs_jump_db`, `spectral_mud_pct`, `clipping_samples`), sends WAV audio directly to **Gemini Audio Listener**, and loops with **Critic** up to 3 iterations.
   - Lookahead scheduling on `AudioContext.currentTime`, Mid-Side Stem Matrix + 4-band stem isolator, `SignalsmithStretch` beatmatching, per-bar drift monitor + micro-correction, 2-ahead track pre-warming, live **Click Track**, and full-set `.WAV` export.
   - Dual-Deck YouTube engine (`youtube-deck-engine.js`) with public playlist pagination (`api/_lib/youtube.js`) and 4 blend choreographies.

4. **Phase 7–9 — Beat Grid Studio, Live Energy Slider, Learning Loop & Cost Estimator (`public/js/ui/debug-studio.js`, `app.js`)**
   - Interactive SVG beat-grid/section/gap/protected-phrase visualizer, 3-idea switcher, `🎧 AI LISTENER CHECK`, `8s` preview, live Energy Arc slider, 👍/👎 + skip learning loop, pre-run cost/time estimate, and unit tests (`scripts/test-v2-engine.mjs`).

## Commands

```bash
npm install
npm run build   # Syncs Essentia.js & Signalsmith Stretch WASM bundles to public/vendor/
npm run check   # Runs syntax checks + Phase 2-4 deterministic unit tests
npm run dev     # Starts local dev server on http://127.0.0.1:4173 (loads .env)
```

## Server / Vercel Environment Variables (Never Commit Secrets)
Copy `.env.example` to `.env` locally (gitignored) and add your keys in Vercel -> Project Settings -> Environment Variables:
- `GEMINI_API_KEY` — Gemini API key for multimodal Audio Listening (`gemini-2.5-flash`), AI Planning, and multilingual lyrics.
- `OPENAI_API_KEY` — OpenAI key for Critic (`gpt-4.1-mini`) & Whisper (`whisper-1`), with automatic failover if quota is unavailable.
- `ANTHROPIC_API_KEY` — Optional Claude Opus key for Planner / Critic roles.
- `YOUTUBE_API_KEY` — Optional YouTube Data API v3 key (public extractor works automatically).
- `AUDIO_WORKER_URL` — Optional URL to deployed `backend/` FastAPI Demucs/WhisperX service.
- `POSTGRES_URL` / `DATABASE_URL` / `SUPABASE_URL` / `KV_REST_API_URL` / `TURSO_DATABASE_URL` — Cloud DB persistence (`localStorage` fallback built in).
