# NOVA AI DJ

NOVA's current deployed experience is preserved behind a same-origin proxy to the archived original deployment. The YouTube layer is additive: it adds YouTube discovery, official embedded playback, and a local queue without routing YouTube audio into the DJ remix engine.

## YouTube integration

- Official YouTube embedded player
- Search through YouTube Data API v3
- Search-result thumbnails, video titles, creator channels, and durations
- Paste a YouTube video URL and play it inside NOVA
- Local queue with add, play-next, remove, and clear controls
- Search fallback link to YouTube
- API key kept server-side in Vercel

## Required Vercel environment variable

Set `YOUTUBE_API_KEY` in the Production environment. Create an API key in Google Cloud after enabling YouTube Data API v3, then restrict that key to YouTube Data API v3. Never place the key in browser JavaScript or commit it to Git.

The embedded player and pasted-link playback do not need the Data API key. In-app search does.

## Rights and playback boundaries

YouTube is used as a discovery and embedded playback source. The app does not extract, download, hide, or re-host YouTube audio. YouTube tracks are not passed into NOVA's audio mixing, EQ, beatmatching, or crossfade engine. Use only separately licensed or user-authorized audio files for DJ transformations.

## Preserved original site

The proxy currently forwards the original UI and API routes to the immutable original production deployment:

https://nova-ai-pgesffzzq-rawalvedant455-7308s-projects.vercel.app/

The Vercel project keeps preview deployments protected. This original production snapshot remains the stable upstream until the complete original source project has been restored into this repository.