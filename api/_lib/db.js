import pg from 'pg';

const { Pool } = pg;

let pgPool = null;
let schemaReadyPromise = null;

function detectConfig() {
  const pgUrl =
    process.env.POSTGRES_URL ||
    process.env.DATABASE_URL ||
    process.env.POSTGRES_PRISMA_URL ||
    process.env.NEON_DATABASE_URL ||
    process.env.POSTGRES_URL_NON_POOLING ||
    '';

  if (pgUrl) {
    return { provider: 'postgres', pgUrl };
  }

  const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
  const supabaseKey =
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_ANON_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
    '';

  if (supabaseUrl && supabaseKey) {
    return {
      provider: 'supabase',
      supabaseUrl: supabaseUrl.replace(/\/+$/, ''),
      supabaseKey,
    };
  }

  const kvUrl = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || '';
  const kvToken = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '';
  if (kvUrl && kvToken) {
    return {
      provider: 'kv',
      kvUrl: kvUrl.replace(/\/+$/, ''),
      kvToken,
    };
  }

  return { provider: 'none' };
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

export async function getDbHealth() {
  const cfg = detectConfig();
  if (cfg.provider === 'none') {
    return { connected: false, provider: 'none', mode: 'browser-fallback' };
  }
  try {
    if (cfg.provider === 'postgres') {
      const pool = getPool(cfg.pgUrl);
      await ensurePgSchema(pool);
      await pool.query('SELECT 1');
      return { connected: true, provider: 'postgres', mode: 'persistent' };
    }
    if (cfg.provider === 'supabase') {
      await supabaseReq(cfg, 'nova_tracks?select=track_id&limit=1');
      return { connected: true, provider: 'supabase', mode: 'persistent' };
    }
    if (cfg.provider === 'kv') {
      await kvCmd(cfg, ['PING']);
      return { connected: true, provider: 'kv', mode: 'persistent' };
    }
  } catch (err) {
    return {
      connected: false,
      provider: cfg.provider,
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

export async function getTracksByIds(ids) {
  if (!Array.isArray(ids) || !ids.length) return {};
  const cleanIds = ids.map(String).slice(0, 150);
  const cfg = detectConfig();
  if (cfg.provider === 'none') return {};

  try {
    if (cfg.provider === 'postgres') {
      const pool = getPool(cfg.pgUrl);
      await ensurePgSchema(pool);
      const { rows } = await pool.query(
        'SELECT * FROM nova_tracks WHERE track_id = ANY($1)',
        [cleanIds]
      );
      const map = {};
      for (const r of rows) {
        map[r.track_id] = {
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
          playFull: r.play_full,
          heat: r.heat_json,
          sections: r.sections_json,
          cueVotes: r.cue_votes,
          cueConfidence: r.cue_confidence,
        };
      }
      return map;
    }

    if (cfg.provider === 'kv') {
      const values = await kvCmd(cfg, ['MGET', ...cleanIds.map((id) => `nova:track:${id}`)]);
      const map = {};
      if (Array.isArray(values)) {
        values.forEach((raw, idx) => {
          if (raw) {
            try {
              map[cleanIds[idx]] = JSON.parse(raw);
            } catch {}
          }
        });
      }
      return map;
    }

    if (cfg.provider === 'supabase') {
      const inList = cleanIds.map((id) => encodeURIComponent(id)).join(',');
      const rows = await supabaseReq(cfg, `nova_tracks?track_id=in.(${inList})`);
      const map = {};
      for (const r of rows || []) {
        map[r.track_id] = {
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
          entrySec: r.entry_sec,
          exitSec: r.exit_sec,
          playFull: r.play_full,
          heat: r.heat_json,
          sections: r.sections_json,
          cueVotes: r.cue_votes || 0,
          cueConfidence: r.cue_confidence,
        };
      }
      return map;
    }
  } catch (err) {
    console.warn('getTracksByIds skipped:', err?.message);
  }
  return {};
}

export async function searchCachedTracks(query, limit = 12) {
  const cfg = detectConfig();
  if (cfg.provider !== 'postgres') return [];
  try {
    const pool = getPool(cfg.pgUrl);
    await ensurePgSchema(pool);
    const pattern = `%${query}%`;
    const { rows } = await pool.query(
      `SELECT * FROM nova_tracks
       WHERE title ILIKE $1 OR artist ILIKE $1
       ORDER BY cue_votes DESC, updated_at DESC
       LIMIT $2`,
      [pattern, limit]
    );
    return rows.map((r) => ({
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
      entrySec: r.entry_sec,
      exitSec: r.exit_sec,
      playFull: r.play_full,
      heat: r.heat_json,
      sections: r.sections_json,
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
    if (cfg.provider === 'kv') {
      await kvCmd(cfg, [
        'SET',
        `nova:playlist:${playlist.playlistId}`,
        JSON.stringify(playlist),
        'EX',
        60 * 60 * 24,
      ]);
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
