# NOVA AI DJ

NOVA is a browser-based DJ mixing workspace with a track catalogue, local audio uploads, a prompt/voice-driven set brief, and a Web Audio mixing engine.

## Restore and build

The complete homepage and standalone engine source are stored in `source/chunks/` as independent Brotli-compressed source parts. The repository build restores them into ordinary, readable files.

```bash
npm run build
```

The build creates:

- `public/index.html` — the complete NOVA website, including the current UI and inline browser application code.
- `src/nova-audio-engine.js` — the standalone, readable audio-engine source.

The build uses Node.js built-in modules only. No third-party npm dependencies are required. Vercel is configured to run this build and publish `public/`.

## Current application features

- Track catalogue discovery using supported public metadata and preview providers.
- Local audio-file loading and decoding into browser `AudioBuffer` objects.
- BPM estimation, onset/beat-grid analysis, downbeat confidence, energy curve and heuristic section estimation.
- Mix-in and mix-out cue selection, including longer phrase-aware outgoing windows.
- Playback-rate tempo matching between decks.
- Web Audio scheduling against the audio context clock.
- Automated transition planning with bass handover, three-band EQ, filters and echo.
- Optional generated kick/snare/hat percussion layer.
- Mix recording through the browser audio graph.
- Prompt-driven and voice-input DJ set briefs where browser speech recognition is available.

## API routes

- `/api/health` — health/status response.
- `/api/catalogue` — catalogue search and supported provider aggregation.
- `/api/proxy` — existing same-origin proxy retained from the original project.
- `/api/youtube-search` — YouTube Data API search endpoint.
- `youtube-integration.js` — existing YouTube embed/queue integration source.

### YouTube configuration

Set `YOUTUBE_API_KEY` in the Vercel Production environment after enabling YouTube Data API v3 in Google Cloud. Keep the key in Vercel environment variables; never place it in browser-side source code.

YouTube playback remains through the official embedded player. It is not extracted or passed into the DJ audio transformation engine.

## Technical boundaries

- Beat grids, downbeats, sections, cue points and key indicators are browser-side estimates, not guaranteed ground truth.
- When downbeat confidence is low, the engine falls back to beat-grid cues.
- The current implementation does not include vocal/instrumental source separation, true stem extraction, lyric transcription, or a trained music-understanding model.
- Browser decoding depends on the source being fetchable and CORS-permitted, or on the user uploading a local audio file.
- Catalogue availability and preview length depend on provider APIs and licensing. This project does not grant rights to download, remix, distribute, or publicly perform third-party recordings.

## Development

Requirements: Node.js 20 or newer.

```bash
npm run build
node --check src/nova-audio-engine.js
```

The Vercel build command is `npm run build`; the static output directory is `public`. Existing API and YouTube source files are retained in the repository.
