# NOVA AI DJ v3 (Supernova Edition)

NOVA is a full-stack autonomous AI DJ, beatmatching engine, stem mashup studio, and YouTube playlist mixer styled around high-contrast performance clarity (`Obsidian #060608` + `Supernova Vermilion #FF4D00` + `Solar Amber #FFB800`).

## Architecture (Phases 1–7)

1. **Phase 1 — Measurement & Analysis Layer**
   - **Browser Essentia.js WASM + Mid-Side Spectral Engine (`public/js/engine/analysis-worker.js`)**: Computes BPM, `beat_times`, `downbeat_times`, `bar_count`, `bars`, `phrase_boundaries` (8/16/32), `sections` (`intro`, `verse`, `build`, `chorus`, `bridge`, `outro`), `key_camelot`, `energy_per_bar`, `stem_activity` (`vocals`, `drums`, `bass`, `other`), `instrumental_gaps`, `tags`, and `warnings` (`no_clear_beat`, `free_time_intro`, `variable_tempo`, `low_confidence`).
   - **Optional Python FastAPI GPU Backend (`backend/`)**: SHA-256 cached Demucs (`htdemucs`) 4-stem separation, multi-tracker beat/downbeat detection (`beat_this`, `madmom`, `librosa`), multilingual vocal-stem lyrics (`WhisperX` / `faster-whisper`), and Vercel proxy (`api/analyze.js` via `AUDIO_WORKER_URL`).
2. **Phase 2 & 3 — Compatibility Scorer, AI Brain & Deterministic Validator (`public/js/engine/dj-brain.js`, `api/plan.js`)**
   - Scores every candidate pair and 5 mix-point options via:
     `S = 0.25*T + 0.20*K + 0.15*E + 0.15*P + 0.15*V + 0.10*G - R`
   - Calls Anthropic **Claude Opus** (`ANTHROPIC_API_KEY` or session-only Studio key) with top 5 candidates, genre playbooks (Punjabi/Bhangra, Bollywood, Tamil/Telugu, Hip-Hop/Trap, House/Techno, Pop, R&B), and past user transition ratings — falling back seamlessly to deterministic TSP planning if no key is configured.
   - Strict deterministic rule validator enforces bar bounds, `<= 8%` stretch (or half/double-time), `+-2` semitone cap, no overlapping lead vocals, no double basslines, Camelot distance `<= 1` on layered melodic stems, and safe transitions for warned tracks (with automatic retry + fallback).
3. **Phase 4 & 5 — Web Audio Lookahead Engine & 14 Club Transitions (`public/js/engine/pro-mixer-engine.js`, `stems-isolator.js`, `offline-exporter.js`)**
   - Bit-transparent Mid-Side matrix (`Mid = (L+R)/2`, `Side = (L-R)/2`) + 4-band stem isolator + 3-band kill EQ + color filter + tempo-synced ping-pong echo + reverb + master limiter.
   - `SignalsmithStretch` WASM `AudioWorklet` for pitch-preserving beatmatching & 4-bar loops/loop-rolls/spinbacks.
   - All 14 transition templates (`bass_swap_blend`, `long_blend`, `filter_sweep`, `echo_out`, `reverb_wash`, `drum_loop_bridge`, `loop_roll_drop`, `build_up_drop`, `vocal_mashup`, `acapella_in`, `instrumental_in`, `half_time_switch`, `impact_cut`, `spinback`) + synthesized Dhol/House/Trap drum bridges.
   - Live beat-grid **Click Track** overlay + **OfflineAudioContext `.WAV` Mix Exporter** (`offline-exporter.js`).
   - Dual-Deck YouTube engine (`youtube-deck-engine.js`) with public playlist continuation pagination (`api/_lib/youtube.js`) and 4 YouTube blend modes.
4. **Phase 6 & 7 — Recipe Debug Studio & Quality Feedback Loop (`public/js/ui/debug-studio.js`)**
   - Interactive beat-grid/section/gap SVG visualizer, 8s transition previewer, recipe regenerator, 👍/👎 transition ratings, set quality scorecard, and Postgres/Supabase/KV/Turso persistence (`api/_lib/db.js`).

## Commands

```bash
npm install
npm run build   # Syncs Essentia.js & Signalsmith Stretch WASM bundles to public/vendor/
npm run check   # Runs Node syntax validation across api/, scripts/, and public/js/
npm run dev     # Starts local dev server on http://127.0.0.1:4173
```

## Optional Vercel Environment Variables
- `YOUTUBE_API_KEY` — YouTube Data API v3 key (public extractor works as fallback).
- `ANTHROPIC_API_KEY` — Enables Claude Opus recipe generation in `/api/plan`.
- `AUDIO_WORKER_URL` — URL to deployed `backend/` FastAPI Demucs/WhisperX service.
- `POSTGRES_URL` / `DATABASE_URL` / `SUPABASE_URL` / `KV_REST_API_URL` / `TURSO_DATABASE_URL` — Cloud DB persistence (browser `localStorage` works offline).
