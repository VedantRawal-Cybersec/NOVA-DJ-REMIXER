/**
 * SHA-256 Content-Hash Analysis Cache (IndexedDB primary + localStorage fallback).
 * Ensures every song is analyzed once per audio content hash across reloads and duplicates.
 */

const DB_NAME = 'nova-analysis-cache';
const DB_VERSION = 1;
const STORE_NAME = 'songs';
const LS_FALLBACK_KEY = 'nova.analysis.hashcache.v1';

let dbPromise = null;

function openCacheDb() {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  if (!dbPromise) {
    dbPromise = new Promise((resolve) => {
      try {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains(STORE_NAME)) {
            db.createObjectStore(STORE_NAME, { keyPath: 'hash' });
          }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
  }
  return dbPromise;
}

function readLsMap() {
  try {
    return JSON.parse(localStorage.getItem(LS_FALLBACK_KEY) || '{}');
  } catch {
    return {};
  }
}

function writeLsEntry(hash, analysis) {
  try {
    const map = readLsMap();
    // Keep lightweight summary in localStorage fallback to avoid 5MB quota errors
    const lite = { ...analysis };
    if (Array.isArray(lite.beat_times) && lite.beat_times.length > 800) {
      lite.beat_times = lite.beat_times.slice(0, 800);
      lite.beats = lite.beat_times;
    }
    map[hash] = { hash, savedAt: Date.now(), analysis: lite };
    const keys = Object.keys(map);
    if (keys.length > 20) {
      keys.sort((a, b) => (map[a].savedAt || 0) - (map[b].savedAt || 0));
      for (const old of keys.slice(0, keys.length - 20)) delete map[old];
    }
    localStorage.setItem(LS_FALLBACK_KEY, JSON.stringify(map));
  } catch {}
}

/**
 * Computes a deterministic 24-hex SHA-256 content hash for an ArrayBuffer or Uint8Array.
 */
export async function computeAudioContentHash(bytesLike) {
  const bytes = bytesLike instanceof Uint8Array
    ? bytesLike
    : bytesLike instanceof ArrayBuffer
      ? new Uint8Array(bytesLike)
      : new Uint8Array(bytesLike?.buffer || 0);

  if (typeof crypto !== 'undefined' && crypto.subtle?.digest) {
    try {
      const digest = await crypto.subtle.digest('SHA-256', bytes);
      return Array.from(new Uint8Array(digest))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('')
        .slice(0, 24);
    } catch {}
  }

  // Deterministic non-crypto fallback for insecure non-localhost origins
  let h1 = 0x811c9dc5;
  let h2 = 0x9e3779b9;
  const step = Math.max(1, Math.floor(bytes.length / 8192));
  for (let i = 0; i < bytes.length; i += step) {
    h1 = Math.imul(h1 ^ bytes[i], 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ bytes[bytes.length - 1 - i], 0x85ebca6b) >>> 0;
  }
  return `${h1.toString(16).padStart(8, '0')}${h2.toString(16).padStart(8, '0')}${bytes.length.toString(16).padStart(8, '0')}`.slice(0, 24);
}

/**
 * Hashes a decoded AudioBuffer's PCM channels + sampleRate + duration so streams
 * or pre-separated stem sums resolve to the same content hash even across sessions.
 */
export async function computeAudioBufferHash(buffer) {
  const sr = Math.round(buffer.sampleRate || 44100);
  const len = buffer.length || 0;
  const ch0 = buffer.getChannelData(0);
  const sampleCount = 4096;
  const out = new Uint8Array(sampleCount * 2 + 8);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, sr, true);
  dv.setUint32(4, len, true);
  const stride = Math.max(1, Math.floor(ch0.length / sampleCount));
  for (let i = 0; i < sampleCount; i++) {
    const v = ch0[Math.min(ch0.length - 1, i * stride)] || 0;
    dv.setInt16(8 + i * 2, Math.max(-32767, Math.min(32767, Math.round(v * 32767))), true);
  }
  return computeAudioContentHash(out);
}

export async function getCachedAnalysisByHash(hash) {
  if (!hash) return null;
  const db = await openCacheDb();
  if (db) {
    const hit = await new Promise((resolve) => {
      try {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const req = tx.objectStore(STORE_NAME).get(hash);
        req.onsuccess = () => resolve(req.result?.analysis || null);
        req.onerror = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
    if (hit) return { ...hit, cached: true, content_hash: hash };
  }
  const ls = readLsMap()[hash]?.analysis;
  return ls ? { ...ls, cached: true, content_hash: hash } : null;
}

export async function saveCachedAnalysisByHash(hash, analysis) {
  if (!hash || !analysis) return;
  const payload = { ...analysis, content_hash: hash };
  const db = await openCacheDb();
  if (db) {
    await new Promise((resolve) => {
      try {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).put({ hash, savedAt: Date.now(), analysis: payload });
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
      } catch {
        resolve();
      }
    });
  }
  writeLsEntry(hash, payload);
}
