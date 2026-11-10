# Source layout

The site and audio engine are stored as independent Brotli-compressed source chunks so the full app can be transported without truncation. Run `npm run build` from the repository root to restore the original files.

- `source/chunks/site/` -> `public/index.html`
- `source/chunks/engine/` -> `src/nova-audio-engine.js`
- `source-manifest.json` declares chunk order and output paths.
