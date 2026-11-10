# NOVA AI DJ v2 (Supernova Edition)

NOVA is an autonomous browser & dual-deck AI DJ mixing studio styled around brutalist high-contrast performance clarity (`Anton` + `Inter`, Obsidian `#060608` + Supernova Vermilion `#FF4D00` + Solar Amber `#FFB800`).

## Architecture

### Dual-Path Hybrid Mixing Engine
1. **Pro Web Audio DSP Engine (`public/js/engine/pro-mixer-engine.js`)** — runs on local audio uploads (`MP3`, `WAV`, `FLAC`, `M4A`, `OGG`) and full CORS-enabled streams (**Audius**, **Openverse**):
   - **Essentia.js WASM Web Worker (`analysis-worker.js`)**: `RhythmExtractor2013` + `KeyExtractor` at `44.1 kHz`, sub-beat downbeat phase finder, 64-window section & drop segmentation, LUFS loudness measurement, and 88-bar waveform heat.
   - **Signalsmith Stretch WASM `AudioWorklet`**: Pitch-preserving tempo stretch (*Master Tempo*) + automatic `±1` semitone Camelot harmonic key-lock (`camelot.js`) + quantized 4-bar looping.
   - **Studio-Transparent 4-Band Isolator (`stems-isolator.js`)**: Zero-latency real-time stem controls (`Vocals`, `Drums`, `Bass`, `Air`) + sweepable HPF/LPF color filter, tempo-synced ping-pong echo, algorithmic reverb, synthesized percussion bridge, and live `.webm` mix recording.
   - **8 Club Transition Choreographies**: `BASS_SWAP_16BAR`, `STEM_VOCAL_PASS`, `DROP_SWAP`, `TENSION_ROLL_DROP`, `ECHO_OUT_BRAKE`, `HARMONIC_BLEND`, `BREAKDOWN_BRIDGE`, `PERCUSSION_BRIDGE`.
2. **Dual-Deck YouTube Engine (`public/js/engine/youtube-deck-engine.js`)** — runs on YouTube search results, single links, and imported playlists:
   - Imports full YouTube playlists (`youtube/v3/playlistItems` paginated up to 150 tracks) and searches embeddable music videos via `YOUTUBE_API_KEY`.
   - Dual pre-cued YouTube IFrame decks (`yt-deck-A` / `yt-deck-B`) with equal-power `sin/cos` crossfade, optional PIP video preview, and interactive drag-to-seek cue learning.

### Database Persistence (`api/_lib/db.js`)
Auto-detects connected Vercel database integrations without extra setup:
- **Postgres** (`POSTGRES_URL`, `DATABASE_URL`, `NEON_DATABASE_URL`, `POSTGRES_PRISMA_URL`) with auto-created tables (`nova_tracks`, `nova_playlists`, `nova_sets`, `nova_cue_feedback`)
- **Supabase REST** (`SUPABASE_URL` + key)
- **Vercel KV / Upstash Redis** (`KV_REST_API_URL` + token)
- Falls back gracefully to browser `localStorage` when running offline.

## Commands

```bash
npm install
npm run build   # Copies Essentia.js & Signalsmith Stretch WASM bundles to public/vendor/
npm run check   # Runs Node syntax validation across api/, scripts/, and public/js/
npm run dev     # Starts local static + serverless API dev server on http://127.0.0.1:4173
```

## Vercel Environment Variables
- `YOUTUBE_API_KEY` — YouTube Data API v3 key for search & playlist import.
- Database env vars (`POSTGRES_URL` / `DATABASE_URL` / `SUPABASE_URL` / `KV_REST_API_URL`) — auto-detected by `api/_lib/db.js`.
