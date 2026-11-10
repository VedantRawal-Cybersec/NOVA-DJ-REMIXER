import pg from 'pg';

const { Pool } = pg;

let pgPool = null;
let schemaReadyPromise = null;
let tursoSchemaPromise = null;

function isPostgresUrl(val) {
  return typeof val === 'string' && /^postgres(?:ql)?:\/\//i.test(val.trim());
}

function findMatchingEnv(suffixes) {
  const entries = Object.entries(process.env);
  for (const suffix of suffixes) {
    if (process.env[suffix]) return { key: suffix, val: process.env[suffix] };
  }
  for (const [k, v] of entries) {
    if (!v) continue;
    for (const suffix of suffixes) {
      if (k.toUpperCase().endsWith(`_${suffix}`)) {
        return { key: k, val: v };
      }
    }
  }
  return null;
}

function detectConfig() {
  // 1. Direct & Marketplace Postgres (Vercel Postgres, Neon, Supabase Postgres, Prisma Postgres direct, AWS Aurora, Nile)
  const preferredPgKeys = [
    'DATABASE_URL_POOLED',
    'POSTGRES_URL_POOLED',
    'POSTGRES_URL',
    'DATABASE_URL',
    'NEON_DATABASE_URL',
    'POSTGRES_PRISMA_URL',
    'STORAGE_URL',
    'POSTGRES_URL_NON_POOLING',
    'DATABASE_URL_UNPOOLED',
    'POSTGRES_URL_NO_SSL',
    'PRISMA_DATABASE_URL',
    'DIRECT_URL',
  ];

  for (const k of preferredPgKeys) {
    const val = process.env[k]?.trim();
    if (isPostgresUrl(val)) {
      return { provider: 'postgres', pgUrl: val, envKey: k };
    }
  }

  // Dynamic scan for custom Vercel integration prefixes (e.g. NOVA_POSTGRES_URL, APP_DATABASE_URL, etc.)
  const dynamicPg = Object.entries(process.env)
    .filter(([k, v]) => isPostgresUrl(v) && !/ACCELERATE/i.test(k))
    .sort(([a], [b]) => {
      const score = (n) => (/POOLED/i.test(n) ? 0 : /DATABASE_URL|POSTGRES_URL/i.test(n) ? 1 : /UNPOOLED|DIRECT/i.test(n) ? 3 : 2);
      return score(a) - score(b);
    });

  if (dynamicPg.length) {
    return { provider: 'postgres', pgUrl: dynamicPg[0][1].trim(), envKey: dynamicPg[0][0] };
  }

  if (process.env.PGHOST && process.env.PGDATABASE && process.env.PGUSER) {
    const port = process.env.PGPORT || '5432';
    const pass = process.env.PGPASSWORD ? `:${encodeURIComponent(process.env.PGPASSWORD)}` : '';
    const pgUrl = `postgresql://${encodeURIComponent(process.env.PGUSER)}${pass}@${process.env.PGHOST}:${port}/${process.env.PGDATABASE}`;
    return { provider: 'postgres', pgUrl, envKey: 'PGHOST' };
  }

  // 2. Supabase REST (direct or custom Marketplace prefix)
  const sbUrlMatch = findMatchingEnv(['SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_URL']);
  const sbKeyMatch = findMatchingEnv(['SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_ANON_KEY', 'NEXT_PUBLIC_SUPABASE_ANON_KEY']);
  if (sbUrlMatch?.val && sbKeyMatch?.val) {
    return {
      provider: 'supabase',
      supabaseUrl: sbUrlMatch.val.trim().replace(/\/+$/, ''),
      supabaseKey: sbKeyMatch.val.trim(),
      envKey: sbUrlMatch.key,
    };
  }

  // 3. Upstash Redis / Vercel KV REST (direct or custom prefix)
  const kvUrlMatch = findMatchingEnv(['KV_REST_API_URL', 'UPSTASH_REDIS_REST_URL', 'REDIS_REST_URL']);
  const kvTokenMatch = findMatchingEnv(['KV_REST_API_TOKEN', 'UPSTASH_REDIS_REST_TOKEN', 'REDIS_REST_TOKEN']);
  if (kvUrlMatch?.val && kvTokenMatch?.val) {
    return {
      provider: 'kv',
      kvUrl: kvUrlMatch.val.trim().replace(/\/+$/, ''),
      kvToken: kvTokenMatch.val.trim(),
      envKey: kvUrlMatch.key,
    };
  }

  // 4. Turso / libSQL HTTP API (zero extra deps)
  const tursoUrlMatch = findMatchingEnv(['TURSO_DATABASE_URL', 'LIBSQL_URL', 'LIBSQL_DATABASE_URL']);
  const tursoTokenMatch = findMatchingEnv(['TURSO_AUTH_TOKEN', 'LIBSQL_AUTH_TOKEN']);
  if (tursoUrlMatch?.val) {
    const httpUrl = tursoUrlMatch.val.trim().replace(/^libsql:\/\//i, 'https://').replace(/\/+$/, '');
    if (/^https?:\/\//i.test(httpUrl)) {
      return {
        provider: 'turso',
        tursoUrl: httpUrl,
        tursoToken: tursoTokenMatch?.val?.trim() || '',
        envKey: tursoUrlMatch.key,
      };
    }
  }

  // Detect unsupported raw vars cleanly (key names only, zero secret values)
  const candidateKey = Object.keys(process.env).find((k) =>
    /^(?:.*_)?(?:MONGODB_URI|REDIS_URL|KV_URL|CONVEX_DEPLOYMENT)$/i.test(k) && process.env[k]
  );

  return { provider: 'none', unmappedEnvKey: candidateKey || null };
}

function getPool(pgUrl) {
  if (!pgPool) {
    const needsSsl = !/localhost|127\.0\.0\.1/i.test(pgUrl);
    pgPool = new Pool({
      connectionString: pgUrl,
      max: 4,
      idleTimeoutMillis: 15000,
      connectionTimeoutMillis: 6000,
      ssl: needsSsl ? { rejectUnauthorized: false } : false,
    });
  }
  return pgPool;
}

async function ensurePgSchema(pool) {
  if (!schemaReadyPromise) {
    schemaReadyPromise = (async () => {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS nova_tracks (
          track_id TEXT PRIMARY KEY,
          source TEXT NOT NULL,
          youtube_id TEXT,
          title TEXT NOT NULL,
          artist TEXT NOT NULL,
          artwork TEXT,
          stream_url TEXT,
          duration_sec DOUBLE PRECISION DEFAULT 0,
          bpm DOUBLE PRECISION,
          musical_key TEXT,
          camelot TEXT,
          energy DOUBLE PRECISION DEFAULT 6,
          lufs DOUBLE PRECISION,
          entry_sec DOUBLE PRECISION DEFAULT 0,
          exit_sec DOUBLE PRECISION,
          play_full BOOLEAN DEFAULT FALSE,
          heat_json JSONB,
          sections_json JSONB,
          cue_votes INTEGER DEFAULT 0,
          cue_confidence TEXT DEFAULT 'auto',
          updated_at TIMESTAMPTZ DEFAULT NOW()
        );
      `);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS nova_playlists (
          playlist_id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          channel TEXT,
          artwork TEXT,
          item_count INTEGER DEFAULT 0,
          items_json JSONB NOT NULL,
          updated_at TIMESTAMPTZ DEFAULT NOW()
        );
      `);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS nova_sets (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          name TEXT NOT NULL,
          vibe_json JSONB,
          tracks_json JSONB NOT NULL,
          created_at TIMESTAMPTZ DEFAULT NOW()
        );
      `);
      await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_nova_sets_session ON nova_sets(session_id, created_at DESC);
      `);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS nova_cue_feedback (
          id BIGSERIAL PRIMARY KEY,
          track_id TEXT NOT NULL,
          session_id TEXT NOT NULL,
          action TEXT NOT NULL,
          from_sec DOUBLE PRECISION,
          to_sec DOUBLE PRECISION,
          rating TEXT,
          created_at TIMESTAMPTZ DEFAULT NOW()
        );
      `);
    })().catch((err) => {
      schemaReadyPromise = null;
      throw err;
    });
  }
  return schemaReadyPromise;
}

function toTursoArg(v) {
  if (v === null || v === undefined) return { type: 'null', value: null };
  if (typeof v === 'boolean') return { type: 'integer', value: v ? '1' : '0' };
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return { type: 'null', value: null };
    return Number.isInteger(v) ? { type: 'integer', value: String(v) } : { type: 'float', value: v };
  }
  return { type: 'text', value: String(v) };
}

function fromTursoVal(cell) {
  if (!cell || cell.type === 'null') return null;
  if (cell.type === 'integer') return Number(cell.value);
  if (cell.type === 'float') return Number(cell.value);
  return cell.value;
}

async function tursoPipeline(cfg, statements) {
  const requests = statements.map((s) => ({
    type: 'execute',
    stmt: {
      sql: s.sql,
      args: (s.args || []).map(toTursoArg),
    },
  }));
  requests.push({ type: 'close' });

  const headers = { 'Content-Type': 'application/json' };
  if (cfg.tursoToken) headers.Authorization = `Bearer ${cfg.tursoToken}`;

  const res = await fetch(`${cfg.tursoUrl}/v2/pipeline`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ requests }),
  });
  if (!res.ok) throw new Error(`Turso HTTP ${res.status}`);
  const data = await res.json();
  return (data.results || []).map((r) => {
    if (r.type === 'error') throw new Error(r.error?.message || 'Turso SQL error');
    const result = r.response?.result;
    if (!result) return [];
    const cols = (result.cols || []).map((c) => c.name);
    return (result.rows || []).map((row) => {
      const obj = {};
      cols.forEach((col, i) => { obj[col] = fromTursoVal(row[i]); });
      return obj;
    });
  });
}

async function ensureTursoSchema(cfg) {
  if (!tursoSchemaPromise) {
    tursoSchemaPromise = tursoPipeline(cfg, [
      {
        sql: `CREATE TABLE IF NOT EXISTS nova_tracks (
          track_id TEXT PRIMARY KEY, source TEXT NOT NULL, youtube_id TEXT,
          title TEXT NOT NULL, artist TEXT NOT NULL, artwork TEXT, stream_url TEXT,
          duration_sec REAL DEFAULT 0, bpm REAL, musical_key TEXT, camelot TEXT,
          energy REAL DEFAULT 6, lufs REAL, entry_sec REAL DEFAULT 0, exit_sec REAL,
          play_full INTEGER DEFAULT 0, heat_json TEXT, sections_json TEXT,
          cue_votes INTEGER DEFAULT 0, cue_confidence TEXT DEFAULT 'auto',
          updated_at TEXT DEFAULT CURRENT_TIMESTAMP
        )`,
      },
      {
        sql: `CREATE TABLE IF NOT EXISTS nova_playlists (
          playlist_id TEXT PRIMARY KEY, title TEXT NOT NULL, channel TEXT,
          artwork TEXT, item_count INTEGER DEFAULT 0, items_json TEXT NOT NULL,
          updated_at TEXT DEFAULT CURRENT_TIMESTAMP
        )`,
      },
      {
        sql: `CREATE TABLE IF NOT EXISTS nova_sets (
          id TEXT PRIMARY KEY, session_id TEXT NOT NULL, name TEXT NOT NULL,
          vibe_json TEXT, tracks_json TEXT NOT NULL,
          created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )`,
      },
      {
        sql: `CREATE TABLE IF NOT EXISTS nova_cue_feedback (
          id INTEGER PRIMARY KEY AUTOINCREMENT, track_id TEXT NOT NULL,
          session_id TEXT NOT NULL, action TEXT NOT NULL,
          from_sec REAL, to_sec REAL, rating TEXT,
          created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )`,
      },
    ]).catch((err) => {
      tursoSchemaPromise = null;
      throw err;
    });
  }
  return tursoSchemaPromise;
}

async function kvCmd(cfg, command) {
  const res = await fetch(cfg.kvUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${cfg.kvToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(command),
  });
  if (!res.ok) throw new Error(`KV error ${res.status}`);
  const data = await res.json();
  return data.result;
}

async function supabaseReq(cfg, path, options = {}) {
  const res = await fetch(`${cfg.supabaseUrl}/rest/v1/${path}`, {
    ...options,
    headers: {
      apikey: cfg.supabaseKey,
      Authorization: `Bearer ${cfg.supabaseKey}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  if (!res.ok) {
    const msg = await res.text().catch(() => '');
    throw new Error(`Supabase REST ${res.status}: ${msg.slice(0, 160)}`);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

function safeParseJson(v, fallback = null) {
  if (!v) return fallback;
  if (typeof v === 'object') return v;
  try { return JSON.parse(v); } catch { return fallback; }
}

export async function getDbHealth() {
  const cfg = detectConfig();
  if (cfg.provider === 'none') {
    return {
      connected: false,
      provider: 'none',
      mode: 'browser-fallback',
      ...(cfg.unmappedEnvKey ? { unmappedEnvKey: cfg.unmappedEnvKey } : {}),
    };
  }
  try {
    if (cfg.provider === 'postgres') {
      const pool = getPool(cfg.pgUrl);
      await ensurePgSchema(pool);
      await pool.query('SELECT 1');
      return { connected: true, provider: 'postgres', mode: 'persistent', envKey: cfg.envKey };
    }
    if (cfg.provider === 'turso') {
      await ensureTursoSchema(cfg);
      await tursoPipeline(cfg, [{ sql: 'SELECT 1' }]);
      return { connected: true, provider: 'turso', mode: 'persistent', envKey: cfg.envKey };
    }
    if (cfg.provider === 'supabase') {
      await supabaseReq(cfg, 'nova_tracks?select=track_id&limit=1');
      return { connected: true, provider: 'supabase', mode: 'persistent', envKey: cfg.envKey };
    }
    if (cfg.provider === 'kv') {
      await kvCmd(cfg, ['PING']);
      return { connected: true, provider: 'kv', mode: 'persistent', envKey: cfg.envKey };
    }
  } catch (err) {
    return {
      connected: false,
      provider: cfg.provider,
      envKey: cfg.envKey,
      mode: 'browser-fallback',
      error: err?.message || 'Database check failed',
    };
  }
  return { connected: false, provider: 'none', mode: 'browser-fallback' };
}

export async function upsertTracks(tracks) {
  if (!Array.isArray(tracks) || !tracks.length) return { persisted: false };
  const cfg = detectConfig();
  if (cfg.provider === 'none') return { persisted: false };

  try {
    if (cfg.provider === 'postgres') {
      const pool = getPool(cfg.pgUrl);
      await ensurePgSchema(pool);
      for (const t of tracks.slice(0, 150)) {
        if (!t || !t.id) continue;
        await pool.query(
          `INSERT INTO nova_tracks (
            track_id, source, youtube_id, title, artist, artwork, stream_url,
            duration_sec, bpm, musical_key, camelot, energy, lufs,
            entry_sec, exit_sec, play_full, heat_json, sections_json, cue_confidence, updated_at
          ) VALUES (
            $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,NOW()
          )
          ON CONFLICT (track_id) DO UPDATE SET
            title = COALESCE(NULLIF(EXCLUDED.title, ''), nova_tracks.title),
            artist = COALESCE(NULLIF(EXCLUDED.artist, ''), nova_tracks.artist),
            artwork = COALESCE(NULLIF(EXCLUDED.artwork, ''), nova_tracks.artwork),
            stream_url = COALESCE(NULLIF(EXCLUDED.stream_url, ''), nova_tracks.stream_url),
            duration_sec = GREATEST(nova_tracks.duration_sec, EXCLUDED.duration_sec),
            bpm = COALESCE(EXCLUDED.bpm, nova_tracks.bpm),
            musical_key = COALESCE(EXCLUDED.musical_key, nova_tracks.musical_key),
            camelot = COALESCE(EXCLUDED.camelot, nova_tracks.camelot),
            energy = COALESCE(EXCLUDED.energy, nova_tracks.energy),
            lufs = COALESCE(EXCLUDED.lufs, nova_tracks.lufs),
            entry_sec = CASE WHEN nova_tracks.cue_votes > 0 AND EXCLUDED.cue_confidence <> 'user' THEN nova_tracks.entry_sec ELSE COALESCE(EXCLUDED.entry_sec, nova_tracks.entry_sec) END,
            exit_sec = CASE WHEN nova_tracks.cue_votes > 0 AND EXCLUDED.cue_confidence <> 'user' THEN nova_tracks.exit_sec ELSE COALESCE(EXCLUDED.exit_sec, nova_tracks.exit_sec) END,
            heat_json = COALESCE(EXCLUDED.heat_json, nova_tracks.heat_json),
            sections_json = COALESCE(EXCLUDED.sections_json, nova_tracks.sections_json),
            updated_at = NOW()`,
          [
            String(t.id),
            String(t.source || 'youtube'),
            t.videoId || null,
            String(t.title || 'Untitled'),
            String(t.artist || 'Unknown artist'),
            t.artwork || null,
            t.streamUrl || null,
            Number(t.durationSec) || 0,
            Number.isFinite(Number(t.bpm)) ? Number(t.bpm) : null,
            t.key || null,
            t.camelot || null,
            Number.isFinite(Number(t.energy)) ? Number(t.energy) : 6,
            Number.isFinite(Number(t.lufs)) ? Number(t.lufs) : null,
            Number.isFinite(Number(t.entrySec)) ? Number(t.entrySec) : 0,
            Number.isFinite(Number(t.exitSec)) ? Number(t.exitSec) : null,
            Boolean(t.playFull),
            t.heat ? JSON.stringify(t.heat) : null,
            t.sections ? JSON.stringify(t.sections) : null,
            String(t.cueConfidence || 'auto'),
          ]
        );
      }
      return { persisted: true, provider: 'postgres' };
    }

    if (cfg.provider === 'turso') {
      await ensureTursoSchema(cfg);
      const stmts = tracks.slice(0, 100).filter((t) => t && t.id).map((t) => ({
        sql: `INSERT INTO nova_tracks (
          track_id, source, youtube_id, title, artist, artwork, stream_url,
          duration_sec, bpm, musical_key, camelot, energy, lufs,
          entry_sec, exit_sec, play_full, heat_json, sections_json, cue_confidence
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(track_id) DO UPDATE SET
          title = COALESCE(NULLIF(excluded.title, ''), nova_tracks.title),
          artist = COALESCE(NULLIF(excluded.artist, ''), nova_tracks.artist),
          duration_sec = MAX(nova_tracks.duration_sec, excluded.duration_sec),
          bpm = COALESCE(excluded.bpm, nova_tracks.bpm),
          musical_key = COALESCE(excluded.musical_key, nova_tracks.musical_key),
          camelot = COALESCE(excluded.camelot, nova_tracks.camelot),
          entry_sec = CASE WHEN nova_tracks.cue_votes > 0 AND excluded.cue_confidence <> 'user' THEN nova_tracks.entry_sec ELSE COALESCE(excluded.entry_sec, nova_tracks.entry_sec) END,
          exit_sec = CASE WHEN nova_tracks.cue_votes > 0 AND excluded.cue_confidence <> 'user' THEN nova_tracks.exit_sec ELSE COALESCE(excluded.exit_sec, nova_tracks.exit_sec) END,
          heat_json = COALESCE(excluded.heat_json, nova_tracks.heat_json),
          updated_at = CURRENT_TIMESTAMP`,
        args: [
          String(t.id),
          String(t.source || 'youtube'),
          t.videoId || null,
          String(t.title || 'Untitled'),
          String(t.artist || 'Unknown artist'),
          t.artwork || null,
          t.streamUrl || null,
          Number(t.durationSec) || 0,
          Number.isFinite(Number(t.bpm)) ? Number(t.bpm) : null,
          t.key || null,
          t.camelot || null,
          Number.isFinite(Number(t.energy)) ? Number(t.energy) : 6,
          Number.isFinite(Number(t.lufs)) ? Number(t.lufs) : null,
          Number.isFinite(Number(t.entrySec)) ? Number(t.entrySec) : 0,
          Number.isFinite(Number(t.exitSec)) ? Number(t.exitSec) : null,
          Boolean(t.playFull),
          t.heat ? JSON.stringify(t.heat) : null,
          t.sections ? JSON.stringify(t.sections) : null,
          String(t.cueConfidence || 'auto'),
        ],
      }));
      if (stmts.length) await tursoPipeline(cfg, stmts);
      return { persisted: true, provider: 'turso' };
    }

    if (cfg.provider === 'kv') {
      const pipeline = tracks.slice(0, 100).filter(Boolean).map((t) =>
        kvCmd(cfg, ['SET', `nova:track:${t.id}`, JSON.stringify(t), 'EX', 60 * 60 * 24 * 30])
      );
      await Promise.all(pipeline);
      return { persisted: true, provider: 'kv' };
    }

    if (cfg.provider === 'supabase') {
      const rows = tracks.slice(0, 100).filter((t) => t && t.id).map((t) => ({
        track_id: String(t.id),
        source: String(t.source || 'youtube'),
        youtube_id: t.videoId || null,
        title: String(t.title || 'Untitled'),
        artist: String(t.artist || 'Unknown artist'),
        artwork: t.artwork || null,
        stream_url: t.streamUrl || null,
        duration_sec: Number(t.durationSec) || 0,
        bpm: Number.isFinite(Number(t.bpm)) ? Number(t.bpm) : null,
        musical_key: t.key || null,
        camelot: t.camelot || null,
        energy: Number.isFinite(Number(t.energy)) ? Number(t.energy) : 6,
        entry_sec: Number.isFinite(Number(t.entrySec)) ? Number(t.entrySec) : 0,
        exit_sec: Number.isFinite(Number(t.exitSec)) ? Number(t.exitSec) : null,
        play_full: Boolean(t.playFull),
        heat_json: t.heat || null,
        sections_json: t.sections || null,
        cue_confidence: String(t.cueConfidence || 'auto'),
      }));
      await supabaseReq(cfg, 'nova_tracks?on_conflict=track_id', {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify(rows),
      });
      return { persisted: true, provider: 'supabase' };
    }
  } catch (err) {
    console.warn('upsertTracks skipped:', err?.message);
  }
  return { persisted: false };
}

function mapTrackRow(r) {
  return {
    id: r.track_id,
    source: r.source,
    videoId: r.youtube_id,
    title: r.title,
    artist: r.artist,
    artwork: r.artwork,
    streamUrl: r.stream_url,
    durationSec: r.duration_sec,
    bpm: r.bpm,
    key: r.musical_key,
    camelot: r.camelot,
    energy: r.energy,
    lufs: r.lufs,
    entrySec: r.entry_sec,
    exitSec: r.exit_sec,
    playFull: Boolean(r.play_full),
    heat: safeParseJson(r.heat_json),
    sections: safeParseJson(r.sections_json),
    cueVotes: r.cue_votes || 0,
    cueConfidence: r.cue_confidence,
  };
}

export async function getTracksByIds(ids) {
  if (!Array.isArray(ids) || !ids.length) return {};
  const cleanIds = ids.map(String).slice(0, 150);
  const cfg = detectConfig();
  if (cfg.provider === 'none') return {};

  try {
    if (cfg.provider === 'postgres') {
      const pool = getPool(cfg.pgUrl);
      await ensurePgSchema(pool);
      const { rows } = await pool.query('SELECT * FROM nova_tracks WHERE track_id = ANY($1)', [cleanIds]);
      const map = {};
      for (const r of rows) map[r.track_id] = mapTrackRow(r);
      return map;
    }

    if (cfg.provider === 'turso') {
      await ensureTursoSchema(cfg);
      const placeholders = cleanIds.map(() => '?').join(',');
      const [rows] = await tursoPipeline(cfg, [
        { sql: `SELECT * FROM nova_tracks WHERE track_id IN (${placeholders})`, args: cleanIds },
      ]);
      const map = {};
      for (const r of rows || []) map[r.track_id] = mapTrackRow(r);
      return map;
    }

    if (cfg.provider === 'kv') {
      const values = await kvCmd(cfg, ['MGET', ...cleanIds.map((id) => `nova:track:${id}`)]);
      const map = {};
      if (Array.isArray(values)) {
        values.forEach((raw, idx) => {
          if (raw) {
            try { map[cleanIds[idx]] = JSON.parse(raw); } catch {}
          }
        });
      }
      return map;
    }

    if (cfg.provider === 'supabase') {
      const inList = cleanIds.map((id) => encodeURIComponent(id)).join(',');
      const rows = await supabaseReq(cfg, `nova_tracks?track_id=in.(${inList})`);
      const map = {};
      for (const r of rows || []) map[r.track_id] = mapTrackRow(r);
      return map;
    }
  } catch (err) {
    console.warn('getTracksByIds skipped:', err?.message);
  }
  return {};
}

export async function searchCachedTracks(query, limit = 12) {
  const cfg = detectConfig();
  if (cfg.provider !== 'postgres' && cfg.provider !== 'turso') return [];
  try {
    const pattern = `%${query}%`;
    let rows = [];
    if (cfg.provider === 'postgres') {
      const pool = getPool(cfg.pgUrl);
      await ensurePgSchema(pool);
      const res = await pool.query(
        `SELECT * FROM nova_tracks
         WHERE title ILIKE $1 OR artist ILIKE $1
         ORDER BY cue_votes DESC, updated_at DESC
         LIMIT $2`,
        [pattern, limit]
      );
      rows = res.rows;
    } else {
      await ensureTursoSchema(cfg);
      [rows] = await tursoPipeline(cfg, [
        {
          sql: `SELECT * FROM nova_tracks WHERE title LIKE ? OR artist LIKE ? ORDER BY cue_votes DESC, updated_at DESC LIMIT ?`,
          args: [pattern, pattern, limit],
        },
      ]);
    }
    return rows.map((r) => ({
      ...mapTrackRow(r),
      mixReady: Boolean(r.stream_url) || r.source === 'youtube',
      dspReady: Boolean(r.stream_url),
      provider: r.source === 'youtube' ? 'YouTube (Cached)' : r.source,
    }));
  } catch (err) {
    console.warn('searchCachedTracks skipped:', err?.message);
    return [];
  }
}

export async function getCachedPlaylist(playlistId, maxAgeHours = 24) {
  const cfg = detectConfig();
  if (cfg.provider === 'none') return null;
  try {
    if (cfg.provider === 'postgres') {
      const pool = getPool(cfg.pgUrl);
      await ensurePgSchema(pool);
      const { rows } = await pool.query(
        `SELECT * FROM nova_playlists
         WHERE playlist_id = $1 AND updated_at > NOW() - ($2 || ' hours')::INTERVAL`,
        [playlistId, String(maxAgeHours)]
      );
      if (!rows.length) return null;
      const r = rows[0];
      return {
        playlistId: r.playlist_id,
        title: r.title,
        channel: r.channel,
        artwork: r.artwork,
        count: r.item_count,
        results: r.items_json,
        cached: true,
      };
    }
    if (cfg.provider === 'turso') {
      await ensureTursoSchema(cfg);
      const [rows] = await tursoPipeline(cfg, [
        { sql: `SELECT * FROM nova_playlists WHERE playlist_id = ? LIMIT 1`, args: [playlistId] },
      ]);
      if (!rows.length) return null;
      const r = rows[0];
      return {
        playlistId: r.playlist_id,
        title: r.title,
        channel: r.channel,
        artwork: r.artwork,
        count: r.item_count,
        results: safeParseJson(r.items_json, []),
        cached: true,
      };
    }
    if (cfg.provider === 'kv') {
      const raw = await kvCmd(cfg, ['GET', `nova:playlist:${playlistId}`]);
      return raw ? { ...JSON.parse(raw), cached: true } : null;
    }
  } catch (err) {
    console.warn('getCachedPlaylist skipped:', err?.message);
  }
  return null;
}

export async function saveCachedPlaylist(playlist) {
  const cfg = detectConfig();
  if (cfg.provider === 'none' || !playlist?.playlistId) return false;
  try {
    if (cfg.provider === 'postgres') {
      const pool = getPool(cfg.pgUrl);
      await ensurePgSchema(pool);
      await pool.query(
        `INSERT INTO nova_playlists (playlist_id, title, channel, artwork, item_count, items_json, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, NOW())
         ON CONFLICT (playlist_id) DO UPDATE SET
           title = EXCLUDED.title,
           channel = EXCLUDED.channel,
           artwork = EXCLUDED.artwork,
           item_count = EXCLUDED.item_count,
           items_json = EXCLUDED.items_json,
           updated_at = NOW()`,
        [
          playlist.playlistId,
          playlist.title || 'YouTube Playlist',
          playlist.channel || 'YouTube',
          playlist.artwork || '',
          playlist.results?.length || 0,
          JSON.stringify(playlist.results || []),
        ]
      );
      return true;
    }
    if (cfg.provider === 'turso') {
      await ensureTursoSchema(cfg);
      await tursoPipeline(cfg, [
        {
          sql: `INSERT INTO nova_playlists (playlist_id, title, channel, artwork, item_count, items_json)
                VALUES (?,?,?,?,?,?)
                ON CONFLICT(playlist_id) DO UPDATE SET
                  title=excluded.title, channel=excluded.channel, artwork=excluded.artwork,
                  item_count=excluded.item_count, items_json=excluded.items_json, updated_at=CURRENT_TIMESTAMP`,
          args: [
            playlist.playlistId,
            playlist.title || 'YouTube Playlist',
            playlist.channel || 'YouTube',
            playlist.artwork || '',
            playlist.results?.length || 0,
            JSON.stringify(playlist.results || []),
          ],
        },
      ]);
      return true;
    }
    if (cfg.provider === 'kv') {
      await kvCmd(cfg, ['SET', `nova:playlist:${playlist.playlistId}`, JSON.stringify(playlist), 'EX', 60 * 60 * 24]);
      return true;
    }
  } catch (err) {
    console.warn('saveCachedPlaylist skipped:', err?.message);
  }
  return false;
}

export async function updateTrackCue(payload) {
  const cfg = detectConfig();
  if (cfg.provider === 'none' || !payload?.trackId) return { persisted: false };
  try {
    if (cfg.provider === 'postgres') {
      const pool = getPool(cfg.pgUrl);
      await ensurePgSchema(pool);
      await pool.query(
        `INSERT INTO nova_cue_feedback (track_id, session_id, action, from_sec, to_sec, rating)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          String(payload.trackId),
          String(payload.sessionId || 'anon'),
          String(payload.action || 'cue'),
          Number.isFinite(Number(payload.fromSec)) ? Number(payload.fromSec) : null,
          Number.isFinite(Number(payload.toSec)) ? Number(payload.toSec) : null,
          payload.rating ? String(payload.rating) : null,
        ]
      );
      if (Number.isFinite(Number(payload.entrySec)) || Number.isFinite(Number(payload.exitSec))) {
        await pool.query(
          `UPDATE nova_tracks
           SET entry_sec = COALESCE($2, entry_sec),
               exit_sec = COALESCE($3, exit_sec),
               bpm = COALESCE($4, bpm),
               musical_key = COALESCE($5, musical_key),
               camelot = COALESCE($6, camelot),
               heat_json = COALESCE($7, heat_json),
               cue_votes = cue_votes + 1,
               cue_confidence = 'user',
               updated_at = NOW()
           WHERE track_id = $1`,
          [
            String(payload.trackId),
            Number.isFinite(Number(payload.entrySec)) ? Number(payload.entrySec) : null,
            Number.isFinite(Number(payload.exitSec)) ? Number(payload.exitSec) : null,
            Number.isFinite(Number(payload.bpm)) ? Number(payload.bpm) : null,
            payload.key || null,
            payload.camelot || null,
            payload.heat ? JSON.stringify(payload.heat) : null,
          ]
        );
      }
      return { persisted: true, provider: 'postgres' };
    }
    if (cfg.provider === 'turso') {
      await ensureTursoSchema(cfg);
      const stmts = [
        {
          sql: `INSERT INTO nova_cue_feedback (track_id, session_id, action, from_sec, to_sec, rating) VALUES (?,?,?,?,?,?)`,
          args: [
            String(payload.trackId),
            String(payload.sessionId || 'anon'),
            String(payload.action || 'cue'),
            Number.isFinite(Number(payload.fromSec)) ? Number(payload.fromSec) : null,
            Number.isFinite(Number(payload.toSec)) ? Number(payload.toSec) : null,
            payload.rating ? String(payload.rating) : null,
          ],
        },
      ];
      if (Number.isFinite(Number(payload.entrySec)) || Number.isFinite(Number(payload.exitSec))) {
        stmts.push({
          sql: `UPDATE nova_tracks
                SET entry_sec = COALESCE(?, entry_sec), exit_sec = COALESCE(?, exit_sec),
                    bpm = COALESCE(?, bpm), musical_key = COALESCE(?, musical_key),
                    camelot = COALESCE(?, camelot), heat_json = COALESCE(?, heat_json),
                    cue_votes = cue_votes + 1, cue_confidence = 'user', updated_at = CURRENT_TIMESTAMP
                WHERE track_id = ?`,
          args: [
            Number.isFinite(Number(payload.entrySec)) ? Number(payload.entrySec) : null,
            Number.isFinite(Number(payload.exitSec)) ? Number(payload.exitSec) : null,
            Number.isFinite(Number(payload.bpm)) ? Number(payload.bpm) : null,
            payload.key || null,
            payload.camelot || null,
            payload.heat ? JSON.stringify(payload.heat) : null,
            String(payload.trackId),
          ],
        });
      }
      await tursoPipeline(cfg, stmts);
      return { persisted: true, provider: 'turso' };
    }
    if (cfg.provider === 'kv') {
      const existingRaw = await kvCmd(cfg, ['GET', `nova:track:${payload.trackId}`]);
      if (existingRaw) {
        const track = JSON.parse(existingRaw);
        if (Number.isFinite(Number(payload.entrySec))) track.entrySec = Number(payload.entrySec);
        if (Number.isFinite(Number(payload.exitSec))) track.exitSec = Number(payload.exitSec);
        if (Number.isFinite(Number(payload.bpm))) track.bpm = Number(payload.bpm);
        if (payload.key) track.key = payload.key;
        if (payload.camelot) track.camelot = payload.camelot;
        track.cueConfidence = 'user';
        await kvCmd(cfg, ['SET', `nova:track:${payload.trackId}`, JSON.stringify(track)]);
      }
      return { persisted: true, provider: 'kv' };
    }
  } catch (err) {
    console.warn('updateTrackCue skipped:', err?.message);
  }
  return { persisted: false };
}

export async function listSavedSets(sessionId) {
  const cfg = detectConfig();
  if (cfg.provider === 'none') return { sets: [], persisted: false };
  try {
    if (cfg.provider === 'postgres') {
      const pool = getPool(cfg.pgUrl);
      await ensurePgSchema(pool);
      const { rows } = await pool.query(
        `SELECT id, session_id, name, vibe_json, tracks_json, created_at
         FROM nova_sets
         WHERE session_id = $1 OR session_id = 'public'
         ORDER BY created_at DESC
         LIMIT 30`,
        [String(sessionId || 'anon')]
      );
      return {
        persisted: true,
        sets: rows.map((r) => ({
          id: r.id,
          name: r.name,
          vibe: r.vibe_json,
          tracks: r.tracks_json,
          createdAt: r.created_at,
        })),
      };
    }
    if (cfg.provider === 'turso') {
      await ensureTursoSchema(cfg);
      const [rows] = await tursoPipeline(cfg, [
        {
          sql: `SELECT id, session_id, name, vibe_json, tracks_json, created_at FROM nova_sets
                WHERE session_id = ? OR session_id = 'public' ORDER BY created_at DESC LIMIT 30`,
          args: [String(sessionId || 'anon')],
        },
      ]);
      return {
        persisted: true,
        sets: rows.map((r) => ({
          id: r.id,
          name: r.name,
          vibe: safeParseJson(r.vibe_json, {}),
          tracks: safeParseJson(r.tracks_json, []),
          createdAt: r.created_at,
        })),
      };
    }
    if (cfg.provider === 'kv') {
      const raw = await kvCmd(cfg, ['GET', `nova:sets:${sessionId || 'anon'}`]);
      return { persisted: true, sets: raw ? JSON.parse(raw) : [] };
    }
  } catch (err) {
    console.warn('listSavedSets skipped:', err?.message);
  }
  return { sets: [], persisted: false };
}

export async function saveSetRecord(setObj) {
  const cfg = detectConfig();
  if (cfg.provider === 'none') return { persisted: false, set: setObj };
  try {
    if (cfg.provider === 'postgres') {
      const pool = getPool(cfg.pgUrl);
      await ensurePgSchema(pool);
      await pool.query(
        `INSERT INTO nova_sets (id, session_id, name, vibe_json, tracks_json, created_at)
         VALUES ($1, $2, $3, $4, $5, NOW())
         ON CONFLICT (id) DO UPDATE SET
           name = EXCLUDED.name,
           vibe_json = EXCLUDED.vibe_json,
           tracks_json = EXCLUDED.tracks_json`,
        [
          String(setObj.id),
          String(setObj.sessionId || 'anon'),
          String(setObj.name || 'NOVA Set'),
          JSON.stringify(setObj.vibe || {}),
          JSON.stringify(setObj.tracks || []),
        ]
      );
      return { persisted: true, set: setObj };
    }
    if (cfg.provider === 'turso') {
      await ensureTursoSchema(cfg);
      await tursoPipeline(cfg, [
        {
          sql: `INSERT INTO nova_sets (id, session_id, name, vibe_json, tracks_json) VALUES (?,?,?,?,?)
                ON CONFLICT(id) DO UPDATE SET name=excluded.name, vibe_json=excluded.vibe_json, tracks_json=excluded.tracks_json`,
          args: [
            String(setObj.id),
            String(setObj.sessionId || 'anon'),
            String(setObj.name || 'NOVA Set'),
            JSON.stringify(setObj.vibe || {}),
            JSON.stringify(setObj.tracks || []),
          ],
        },
      ]);
      return { persisted: true, set: setObj };
    }
    if (cfg.provider === 'kv') {
      const key = `nova:sets:${setObj.sessionId || 'anon'}`;
      const raw = await kvCmd(cfg, ['GET', key]);
      const list = raw ? JSON.parse(raw) : [];
      const next = [setObj, ...list.filter((s) => s.id !== setObj.id)].slice(0, 30);
      await kvCmd(cfg, ['SET', key, JSON.stringify(next)]);
      return { persisted: true, set: setObj };
    }
  } catch (err) {
    console.warn('saveSetRecord skipped:', err?.message);
  }
  return { persisted: false, set: setObj };
}

export async function deleteSetRecord(id, sessionId) {
  const cfg = detectConfig();
  if (cfg.provider === 'none') return { deleted: false };
  try {
    if (cfg.provider === 'postgres') {
      const pool = getPool(cfg.pgUrl);
      await ensurePgSchema(pool);
      await pool.query('DELETE FROM nova_sets WHERE id = $1 AND session_id = $2', [
        String(id),
        String(sessionId || 'anon'),
      ]);
      return { deleted: true };
    }
    if (cfg.provider === 'turso') {
      await ensureTursoSchema(cfg);
      await tursoPipeline(cfg, [
        {
          sql: `DELETE FROM nova_sets WHERE id = ? AND session_id = ?`,
          args: [String(id), String(sessionId || 'anon')],
        },
      ]);
      return { deleted: true };
    }
    if (cfg.provider === 'kv') {
      const key = `nova:sets:${sessionId || 'anon'}`;
      const raw = await kvCmd(cfg, ['GET', key]);
      const list = raw ? JSON.parse(raw) : [];
      const next = list.filter((s) => s.id !== id);
      await kvCmd(cfg, ['SET', key, JSON.stringify(next)]);
      return { deleted: true };
    }
  } catch (err) {
    console.warn('deleteSetRecord skipped:', err?.message);
  }
  return { deleted: false };
}
