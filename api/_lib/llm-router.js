import { extractRequestKeys, loadServerEnv } from './env.js';

export function getConfiguredPlannerChain() {
  loadServerEnv();
  const def = String(process.env.AI_PLANNER_PROVIDER || 'anthropic').trim().toLowerCase();
  const base = ['anthropic', 'gemini', 'openai'];
  return base.includes(def) ? [def, ...base.filter((p) => p !== def)] : base;
}

export const AI_ROLE_CHAINS = {
  PLANNER: ['anthropic', 'gemini', 'openai'],
  LYRIC_UNDERSTANDER: ['gemini', 'anthropic', 'openai'],
  AUDIO_LISTENER: ['gemini'],
  CRITIC: ['openai', 'anthropic', 'gemini'],
  TRANSCRIBER: ['openai', 'gemini'],
};

const TIMEOUT_MS = process.env.VERCEL ? 7800 : 16000;

export function getAiHealth(req = null) {
  const keys = req ? extractRequestKeys(req) : (() => {
    loadServerEnv();
    return {
      gemini: String(process.env.GEMINI_API_KEY || '').trim(),
      openai: String(process.env.OPENAI_API_KEY || '').trim(),
      anthropic: String(process.env.ANTHROPIC_API_KEY || '').trim(),
    };
  })();

  return {
    providers: {
      gemini: { configured: Boolean(keys.gemini), model: process.env.GEMINI_PLANNER_MODEL || 'gemini-2.5-flash' },
      openai: { configured: Boolean(keys.openai), model: process.env.OPENAI_PLANNER_MODEL || 'gpt-4.1-mini' },
      anthropic: { configured: Boolean(keys.anthropic), model: process.env.ANTHROPIC_MODEL || 'claude-opus-4-1-20250805' },
    },
    roles: {
      PLANNER: keys.anthropic ? 'claude-opus' : keys.gemini ? 'gemini-2.5' : keys.openai ? 'openai' : 'deterministic-tsp',
      LYRIC_UNDERSTANDER: keys.gemini ? 'gemini-2.5' : keys.openai ? 'openai' : keys.anthropic ? 'claude' : 'heuristic',
      AUDIO_LISTENER: keys.gemini ? 'gemini-2.5-multimodal' : 'acoustic-dsp-metrics',
      CRITIC: keys.openai ? 'openai-with-gemini-fallback' : keys.gemini ? 'gemini-2.5' : keys.anthropic ? 'claude' : 'validator-only',
      TRANSCRIBER: keys.openai ? 'openai-whisper-with-gemini-fallback' : keys.gemini ? 'gemini-2.5-audio' : 'worker-whisperx',
    },
    multiProviderConfigured: Boolean(keys.gemini || keys.openai || keys.anthropic),
  };
}

export function extractJsonFromText(raw) {
  const txt = String(raw || '').trim();
  const fenced = txt.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1].trim() : txt;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) {
    throw new Error('Model response did not contain valid JSON object.');
  }
  return JSON.parse(body.slice(start, end + 1));
}

async function fetchWithTimeout(url, init, ms = TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function callGeminiSingle({ apiKey, model, systemPrompt, userPrompt, audioBase64 = null, audioMime = 'audio/wav', jsonMode = true, disableThinking = true, attemptTimeoutMs = 6000, temperature = 0.25 }) {
  const cleanModel = String(model || 'gemini-2.5-flash').replace(/^models\//, '');
  const parts = [];
  if (audioBase64) {
    parts.push({ inlineData: { mimeType: audioMime, data: audioBase64 } });
  }
  parts.push({ text: userPrompt });

  const generationConfig = {
    temperature: Number.isFinite(temperature) ? temperature : 0.25,
    maxOutputTokens: 3200,
    ...(jsonMode ? { responseMimeType: 'application/json' } : {}),
    ...(disableThinking && /2\.5-flash/.test(cleanModel) ? { thinkingConfig: { thinkingBudget: 0 } } : {}),
  };

  const body = {
    contents: [{ role: 'user', parts }],
    generationConfig,
  };
  if (systemPrompt) {
    body.systemInstruction = { parts: [{ text: systemPrompt }] };
  }

  const res = await fetchWithTimeout(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(cleanModel)}:generateContent`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey,
      },
      body: JSON.stringify(body),
    },
    attemptTimeoutMs
  );
  if (!res.ok) {
    const errTxt = await res.text().catch(() => '');
    throw new Error(`Gemini HTTP ${res.status}: ${errTxt.slice(0, 180)}`);
  }
  const json = await res.json();
  const text = (json.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('\n');
  return { model: cleanModel, text };
}

async function callGemini(opts) {
  const primary = String(opts.model || 'gemini-2.5-flash').replace(/^models\//, '');
  const fallbacks = [...new Set([primary, 'gemini-2.5-flash-lite', 'gemini-flash-latest'])];
  const perMs = process.env.VERCEL ? 4400 : 7500;
  let lastErr;
  for (const m of fallbacks) {
    try {
      return await callGeminiSingle({ ...opts, model: m, attemptTimeoutMs: perMs });
    } catch (err) {
      lastErr = err;
      const msg = String(err?.message || '');
      if (msg.includes('thinking') && opts.disableThinking !== false) {
        try {
          return await callGeminiSingle({ ...opts, model: m, disableThinking: false, attemptTimeoutMs: perMs });
        } catch (err2) {
          lastErr = err2;
        }
      }
      if (!/503|429|UNAVAILABLE|RESOURCE_EXHAUSTED|abort/i.test(msg)) {
        continue;
      }
    }
  }
  throw lastErr || new Error('Gemini models unavailable');
}

async function callOpenAI({ apiKey, model, systemPrompt, userPrompt, jsonMode = true, temperature = 0.25 }) {
  const cleanModel = model || 'gpt-4.1-mini';
  const res = await fetchWithTimeout('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: cleanModel,
      temperature: Number.isFinite(temperature) ? temperature : 0.25,
      max_tokens: 3200,
      ...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
      messages: [
        ...(systemPrompt ? [{ role: 'system', content: systemPrompt }] : []),
        { role: 'user', content: userPrompt },
      ],
    }),
  });
  if (!res.ok) {
    const errTxt = await res.text().catch(() => '');
    throw new Error(`OpenAI HTTP ${res.status}: ${errTxt.slice(0, 180)}`);
  }
  const json = await res.json();
  const text = json.choices?.[0]?.message?.content || '';
  return { model: cleanModel, text };
}

async function callOpenAIWhisper({ apiKey, audioBase64, filename = 'clip.wav', model = 'whisper-1' }) {
  const buf = Buffer.from(audioBase64, 'base64');
  const form = new FormData();
  form.append('file', new Blob([buf], { type: 'audio/wav' }), filename);
  form.append('model', model);
  form.append('response_format', 'verbose_json');
  form.append('timestamp_granularities[]', 'segment');

  const res = await fetchWithTimeout('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });
  if (!res.ok) {
    const errTxt = await res.text().catch(() => '');
    throw new Error(`OpenAI Whisper HTTP ${res.status}: ${errTxt.slice(0, 180)}`);
  }
  return res.json();
}

async function callAnthropic({ apiKey, model, systemPrompt, userPrompt, temperature = 0.25 }) {
  const cleanModel = model || 'claude-opus-4-1-20250805';
  const res = await fetchWithTimeout('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: cleanModel,
      max_tokens: 3200,
      temperature: Number.isFinite(temperature) ? temperature : 0.25,
      ...(systemPrompt ? { system: systemPrompt } : {}),
      messages: [{ role: 'user', content: userPrompt }],
    }),
  });
  if (!res.ok) {
    const errTxt = await res.text().catch(() => '');
    throw new Error(`Anthropic HTTP ${res.status}: ${errTxt.slice(0, 180)}`);
  }
  const json = await res.json();
  const text = (json.content || []).map((c) => c.text || '').join('\n');
  return { model: cleanModel, text };
}

/**
 * Role-based multi-provider AI call with automatic retry & failover (Gemini / OpenAI / Anthropic).
 * Keys never leave the server; optional session keys arrive only via TLS headers when testing.
 */
export async function invokeAiRole({
  role = 'PLANNER',
  req = null,
  systemPrompt = '',
  userPrompt = '',
  audioBase64 = null,
  audioMime = 'audio/wav',
  preferredProviders = null,
  expectJson = true,
  temperature = 0.25,
}) {
  const keys = extractRequestKeys(req);
  const roleChain = role === 'PLANNER' ? getConfiguredPlannerChain() : (AI_ROLE_CHAINS[role] || ['gemini', 'openai', 'anthropic']);
  const chain = (preferredProviders || roleChain).filter((p) => {
    if (audioBase64 && p !== 'gemini' && role !== 'TRANSCRIBER') return false;
    return Boolean(keys[p]);
  });

  const trace = [];
  for (const provider of chain) {
    const t0 = Date.now();
    try {
      let out;
      if (role === 'TRANSCRIBER' && audioBase64 && provider === 'openai') {
        const w = await callOpenAIWhisper({
          apiKey: keys.openai,
          audioBase64,
          model: process.env.OPENAI_TRANSCRIBE_MODEL || 'whisper-1',
        });
        const lines = (w.segments || []).map((s) => ({
          start_sec: Math.round((s.start || 0) * 100) / 100,
          end_sec: Math.round((s.end || 0) * 100) / 100,
          text: String(s.text || '').trim(),
          confidence: 0.9,
        })).filter((s) => s.text);
        const data = { language: w.language || 'unknown', lyrics: lines, raw_text: w.text || '' };
        trace.push({ provider: 'openai', model: 'whisper-1', ok: true, ms: Date.now() - t0 });
        return { ok: true, provider: 'openai', model: 'whisper-1', data, trace };
      }

      if (provider === 'gemini') {
        const defaultGemModel =
          role === 'PLANNER'
            ? (process.env.GEMINI_PLANNER_MODEL || 'gemini-2.5-flash')
            : (process.env.GEMINI_LISTENER_MODEL || 'gemini-2.5-flash');
        out = await callGemini({
          apiKey: keys.gemini,
          model: defaultGemModel,
          systemPrompt,
          userPrompt,
          audioBase64,
          audioMime,
          jsonMode: expectJson,
          temperature,
        });
      } else if (provider === 'openai') {
        out = await callOpenAI({
          apiKey: keys.openai,
          model: process.env.OPENAI_PLANNER_MODEL || 'gpt-4.1-mini',
          systemPrompt,
          userPrompt,
          jsonMode: expectJson,
          temperature,
        });
      } else if (provider === 'anthropic') {
        out = await callAnthropic({
          apiKey: keys.anthropic,
          model: process.env.ANTHROPIC_MODEL || 'claude-opus-4-1-20250805',
          systemPrompt,
          userPrompt,
          temperature,
        });
      }

      const data = expectJson ? extractJsonFromText(out.text) : out.text;
      trace.push({ provider, model: out.model, ok: true, ms: Date.now() - t0 });
      return { ok: true, provider, model: out.model, data, rawText: out.text, trace };
    } catch (err) {
      trace.push({ provider, ok: false, ms: Date.now() - t0, error: err?.message || 'Failed' });
    }
  }

  return { ok: false, provider: 'deterministic-fallback', model: null, data: null, trace };
}
