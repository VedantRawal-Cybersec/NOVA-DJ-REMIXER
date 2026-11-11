import { handlePreflight, readJsonBody, sendJson } from './_lib/http.js';
import { getAiHealth, invokeAiRole } from './_lib/llm-router.js';
import {
  GENRE_PLAYBOOKS,
  TRANSITION_TYPES,
  normalizeSongAnalysis,
  repairOrFallbackRecipe,
  validateTransitionRecipe,
} from '../public/js/engine/dj-brain.js';

function fallbackLyricUnderstanding({ title = '', artist = '', durationSec = 180, bpm = 120, lyrics = [] }) {
  const txt = `${title} ${artist}`.toLowerCase();
  const isPunjabi = /aujla|diljit|sidhu|ap dhillon|shubh|bhangra|punjabi/.test(txt);
  const isTamilTelugu = /anirudh|thaman|tamil|telugu|vijay|pushpa/.test(txt);
  const isHindi = /arijit|pritam|rahman|t-series|yrf|bollywood|hindi|neha|badshah/.test(txt);
  const language = isPunjabi ? 'pa' : isTamilTelugu ? 'ta' : isHindi ? 'hi' : 'en';
  const hookSec = Math.round(durationSec * 0.34);
  return {
    language,
    romanised: (lyrics || []).map((l) => l.text).join(' | '),
    translation: '',
    theme: isPunjabi ? 'bhangra party & swagger' : isHindi ? 'bollywood anthem / emotion' : 'club groove',
    mood: bpm >= 122 ? 'euphoric / peak' : 'rhythmic / moody',
    emotional_arc: 'intro build -> hook release',
    hook_line: lyrics?.[0]?.text || title,
    hook_sec: hookSec,
    repeated_phrases: [],
    call_and_response: '',
    spoken_intro: false,
    explicit_flag: /\b(explicit|uncensored|fuck|shit|bitch)\b/i.test(txt),
    do_not_cut_ranges: [],
  };
}

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return sendJson(res, 405, { ok: false, error: 'Method not allowed' });
  }

  let body;
  try {
    // Allow larger clip payloads up to 2.5 MB base64 for 16 kHz mono WAV inspection clips
    body = await readJsonBody(req, 2.5 * 1024 * 1024);
  } catch (err) {
    return sendJson(res, 400, { ok: false, error: err?.message || 'Invalid JSON body' });
  }

  const action = String(body?.action || '').trim();
  const health = getAiHealth(req);

  if (action === 'estimate_cost') {
    const dspCount = Number(body?.dspCount) || 0;
    const ytCount = Number(body?.ytCount) || 0;
    const total = dspCount + ytCount;
    const hasCloudAi = health.multiProviderConfigured;
    const estSeconds = Math.max(1, Math.round(dspCount * (hasCloudAi ? 3.5 : 1.2) + ytCount * 0.4 + 2));
    const estUsd = hasCloudAi ? Math.round((total * 0.0028 + Math.max(0, total - 1) * 0.002) * 1000) / 1000 : 0;
    return sendJson(res, 200, {
      ok: true,
      estimate: {
        tracks: total,
        dspTracks: dspCount,
        ytTracks: ytCount,
        estimatedSeconds: estSeconds,
        estimatedUsd: estUsd,
        providers: health.roles,
      },
    });
  }

  if (action === 'transcribe_and_understand') {
    const { title = 'Untitled', artist = 'Artist', durationSec = 180, bpm = 120, wavBase64 = '' } = body || {};
    let lyrics = [];
    let language = 'unknown';
    let trace = [];

    if (wavBase64 && wavBase64.length > 100) {
      // Single-hop Gemini multimodal transcription + deep lyric understanding (stays fast under Vercel limits)
      // If OpenAI Whisper is configured with billing credit, TRANSCRIBER runs Whisper first and fails over to Gemini automatically.
      const combinedPrompt = `You are NOVA's multilingual Lyrics Transcriber & Understander.
Track: "${title}" by "${artist}" (${Math.round(bpm)} BPM, ${Math.round(durationSec)}s).
Listen carefully to this audio clip (it may contain Hindi, Punjabi, Tamil, Telugu, Hinglish, English, or Spanish vocals, or instrumental sections).
Return STRICT VALID JSON ONLY matching:
{
  "language": "iso code e.g. en, hi, pa, ta, te, es, or mixed-hi-en",
  "lyrics": [{"start_sec": 0.0, "end_sec": 3.5, "text": "sung line", "confidence": 0.9}],
  "lyric_understanding": {
    "romanised": "latin script transliteration summary",
    "translation": "short natural english translation summary",
    "theme": "2-5 word core theme",
    "mood": "2-4 word mood",
    "emotional_arc": "e.g. tender verse into celebratory chorus",
    "hook_line": "main chorus or hook phrase if heard",
    "hook_sec": 12.0,
    "repeated_phrases": ["phrase1"],
    "call_and_response": "short DJ handoff suggestion",
    "spoken_intro": false,
    "explicit_flag": false,
    "do_not_cut_ranges": [{"start_sec": 8.0, "end_sec": 14.0, "reason": "main chorus phrase"}]
  }
}`;

      const transcribeRes = await invokeAiRole({
        role: 'TRANSCRIBER',
        req,
        audioBase64: wavBase64,
        audioMime: 'audio/wav',
        userPrompt: combinedPrompt,
        preferredProviders: ['openai', 'gemini'],
      });
      trace.push(...(transcribeRes.trace || []));

      if (transcribeRes.ok && transcribeRes.provider === 'gemini' && transcribeRes.data) {
        lyrics = Array.isArray(transcribeRes.data.lyrics) ? transcribeRes.data.lyrics : [];
        language = transcribeRes.data.language || 'unknown';
        const lu = transcribeRes.data.lyric_understanding || fallbackLyricUnderstanding({ title, artist, durationSec, bpm, lyrics });
        return sendJson(res, 200, {
          ok: true,
          provider: transcribeRes.provider,
          model: transcribeRes.model,
          language,
          lyrics,
          lyric_understanding: { ...lu, language },
          trace,
        });
      }

      if (transcribeRes.ok && transcribeRes.provider === 'openai' && transcribeRes.data) {
        lyrics = transcribeRes.data.lyrics || [];
        language = transcribeRes.data.language || 'unknown';
      }
    }

    // Second hop / Metadata understander when Whisper provided raw lines or audio wasn't decoded
    const understandRes = await invokeAiRole({
      role: 'LYRIC_UNDERSTANDER',
      req,
      userPrompt: `You are NOVA's Lyric Understander (expert in Hindi, Punjabi, Tamil, Telugu, Bollywood, Hip-Hop, EDM & Pop).
Track: "${title}" by "${artist}" (${Math.round(bpm)} BPM, ${Math.round(durationSec)}s).
Measured lines: ${JSON.stringify(lyrics.slice(0, 12))}
Output STRICT VALID JSON ONLY:
{
  "language": "${language !== 'unknown' ? language : 'en/hi/pa/ta/etc'}",
  "romanised": "short romanised summary",
  "translation": "short english meaning summary",
  "theme": "core theme",
  "mood": "mood",
  "emotional_arc": "arc description",
  "hook_line": "hook lyric or title hook",
  "hook_sec": ${Math.round(durationSec * 0.32)},
  "repeated_phrases": [],
  "call_and_response": "DJ cue idea",
  "spoken_intro": false,
  "explicit_flag": false,
  "do_not_cut_ranges": []
}`,
    });
    trace.push(...(understandRes.trace || []));

    const lu = understandRes.ok && understandRes.data
      ? understandRes.data
      : fallbackLyricUnderstanding({ title, artist, durationSec, bpm, lyrics });

    return sendJson(res, 200, {
      ok: true,
      provider: understandRes.ok ? understandRes.provider : 'heuristic-fallback',
      model: understandRes.model || null,
      language: lu.language || language,
      lyrics,
      lyric_understanding: lu,
      trace,
    });
  }

  if (action === 'understand_metadata') {
    const songs = Array.isArray(body?.songs) ? body.songs.slice(0, 20) : [];
    if (!songs.length) return sendJson(res, 400, { ok: false, error: 'songs array is required' });

    const ai = await invokeAiRole({
      role: 'LYRIC_UNDERSTANDER',
      req,
      userPrompt: `Analyze these tracks for DJ set curation (detect likely language, genreKey from [punjabi, bollywood, tamil_telugu, hiphop, pop, house, techno, chill], mood, theme, explicit_flag).
Tracks: ${JSON.stringify(songs.map((s) => ({ id: s.id, title: s.title, artist: s.artist, durationSec: s.durationSec })))}
Return STRICT VALID JSON: {"tracks": [{"id": "...", "language": "hi", "genreKey": "bollywood", "theme": "...", "mood": "...", "explicit_flag": false}]}`,
    });

    const outTracks = ai.ok && Array.isArray(ai.data?.tracks)
      ? ai.data.tracks
      : songs.map((s) => ({ id: s.id, ...fallbackLyricUnderstanding(s) }));

    return sendJson(res, 200, {
      ok: true,
      provider: ai.provider,
      model: ai.model || null,
      tracks: outTracks,
      trace: ai.trace,
    });
  }

  if (action === 'critique_transition') {
    const { wavBase64 = '', recipe, metrics = {}, songA: rawA, songB: rawB, iteration = 1 } = body || {};
    if (!recipe || !rawA || !rawB) {
      return sendJson(res, 400, { ok: false, error: 'recipe, songA, and songB are required' });
    }
    const a = normalizeSongAnalysis(rawA);
    const b = normalizeSongAnalysis(rawB);
    const trace = [];

    // Step 1: Audio Listener (Gemini listens directly to rendered WAV clip + objective acoustic metrics)
    let listener = null;
    if (wavBase64 && wavBase64.length > 100) {
      const listenRes = await invokeAiRole({
        role: 'AUDIO_LISTENER',
        req,
        preferredProviders: ['gemini'],
        audioBase64: wavBase64,
        audioMime: 'audio/wav',
        userPrompt: `You are NOVA's expert club-DJ Audio Listener checking transition "${recipe.type}" (${a.title} -> ${b.title}).
Objective DSP metrics already measured from this rendered transition clip:
${JSON.stringify(metrics)}
Listen to the audio clip carefully and output STRICT VALID JSON ONLY:
{
  "score_1_to_10": 8,
  "beat_clash": false,
  "vocal_clash": false,
  "bass_mud": false,
  "harsh_cut": false,
  "energy_dip": false,
  "issues": ["list concrete problems if score < 7, else []"],
  "notes": "1-2 sentence DJ booth ear assessment"
}`,
      });
      trace.push(...(listenRes.trace || []));
      if (listenRes.ok && listenRes.data) listener = listenRes.data;
    }

    // Objective acoustic fallback if Gemini audio listener unavailable
    if (!listener) {
      const mBass = Number(metrics.bass_overlap_pct) || 0;
      const mVoc = Number(metrics.vocal_overlap_pct) || 0;
      const mDrift = Number(metrics.beat_drift_ms) || 0;
      const mClip = Number(metrics.clipping_samples) || 0;
      const penalty = (mBass > 28 ? 2 : 0) + (mVoc > 35 ? 1.5 : 0) + (mDrift > 35 ? 2 : 0) + (mClip > 0 ? 2 : 0);
      const score = Math.max(3, Math.min(9.5, Math.round((8.6 - penalty) * 10) / 10));
      listener = {
        score_1_to_10: score,
        beat_clash: mDrift > 35,
        vocal_clash: mVoc > 35,
        bass_mud: mBass > 28,
        harsh_cut: Math.abs(Number(metrics.lufs_jump_db) || 0) > 6,
        energy_dip: false,
        issues: [
          ...(mBass > 28 ? [`High sub-bass overlap (${mBass}%)`] : []),
          ...(mDrift > 35 ? [`Beat drift ${mDrift}ms`] : []),
          ...(mClip > 0 ? [`Digital clipping (${mClip} samples)`] : []),
        ],
        notes: score >= 7
          ? 'Clean bass handover, tight beat alignment, and balanced headroom.'
          : 'Objective DSP metrics flagged overlap mud or drift requiring tighter EQ/cut.',
      };
    }

    const metricsBad = (Number(metrics.clipping_samples) || 0) > 0 || (Number(metrics.bass_overlap_pct) || 0) > 34 || (Number(metrics.beat_drift_ms) || 0) > 45;
    const score = Number(listener.score_1_to_10) || 7;
    const passed = score >= 7 && !metricsBad;

    // Step 2: Critic proposes revised recipe only when listener score < 7 or metrics fail
    let revisedRecipe = null;
    let criticProvider = null;
    if (!passed && iteration < 3) {
      const criticRes = await invokeAiRole({
        role: 'CRITIC',
        req,
        userPrompt: `You are NOVA's Mix Critic. The Audio Listener and DSP checker flagged issues in this transition recipe.
Current recipe: ${JSON.stringify(recipe)}
Metrics: ${JSON.stringify(metrics)}
Listener report: ${JSON.stringify(listener)}
Genre playbooks: ${JSON.stringify({ A: GENRE_PLAYBOOKS[a.genreKey], B: GENRE_PLAYBOOKS[b.genreKey] })}
Allowed types: ${TRANSITION_TYPES.join(', ')}

Return STRICT VALID JSON with ONE fixed recipe object matching the same fields ("from", "to", "mix_out_bar", "mix_in_bar", "length_bars", "type", "tempo_plan", "stem_layers", "eq_automation", "filter_automation", "fx", "added_drums", "why", "risk", "fallback").
Ensure only ONE bassline plays at a time (deck low <= -24dB during handover), zero simultaneous lead vocals, and clean mix_out_bar/mix_in_bar inside song bounds.`,
      });
      trace.push(...(criticRes.trace || []));
      if (criticRes.ok && criticRes.data && (criticRes.data.type || criticRes.data.recipe?.type)) {
        const candRec = {
          ...(criticRes.data.recipe || criticRes.data),
          from: a.song_id,
          to: b.song_id,
        };
        const check = validateTransitionRecipe(candRec, a, b);
        if (check.valid) {
          candRec.validation = check;
          revisedRecipe = candRec;
          criticProvider = criticRes.provider;
        }
      }
      if (!revisedRecipe) {
        // Deterministic critic repair if model suggestion didn't validate
        revisedRecipe = repairOrFallbackRecipe(a, b);
        if ((Number(metrics.clipping_samples) || 0) > 0 && Array.isArray(revisedRecipe.stem_layers)) {
          revisedRecipe.stem_layers = revisedRecipe.stem_layers.map((sl) => ({
            ...sl,
            gain_curve: (sl.gain_curve || []).map(([bar, g]) => [bar, Math.round(g * 0.82 * 100) / 100]),
          }));
        }
        revisedRecipe.why = `Auto-repaired after critique (${(listener.issues || []).join('; ') || 'tighter bass/vocal separation & -1.5dB headroom'}).`;
        criticProvider = 'deterministic-critic';
      }
    }

    return sendJson(res, 200, {
      ok: true,
      iteration,
      passed,
      listener,
      criticUsed: Boolean(revisedRecipe),
      criticProvider,
      revisedRecipe,
      trace,
    });
  }

  return sendJson(res, 400, { ok: false, error: `Unknown AI action "${action}"` });
}
