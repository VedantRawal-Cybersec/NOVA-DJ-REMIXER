"""
NOVA AI DJ — Phase 1 Analysis Service (Demucs + Multi-Tracker Beatgrid + Keys + WhisperX Lyrics).
Caches complete analysis JSON & separated stems on disk per SHA-256 content hash.
Gracefully supports full GPU (Demucs + WhisperX + beat_this/madmom) or lightweight librosa CPU mode.
"""

from __future__ import annotations
import hashlib
import json
import os
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import numpy as np
import soundfile as sf

CACHE_ROOT = Path(os.environ.get("NOVA_CACHE_DIR", Path(__file__).parent / "cache"))
CACHE_ROOT.mkdir(parents=True, exist_ok=True)

KEY_TO_CAMELOT = {
    ("C", "minor"): "5A", ("C", "major"): "8B",
    ("C#", "minor"): "12A", ("C#", "major"): "3B",
    ("D", "minor"): "7A", ("D", "major"): "10B",
    ("D#", "minor"): "2A", ("D#", "major"): "5B",
    ("E", "minor"): "9A", ("E", "major"): "12B",
    ("F", "minor"): "4A", ("F", "major"): "7B",
    ("F#", "minor"): "11A", ("F#", "major"): "2B",
    ("G", "minor"): "6A", ("G", "major"): "9B",
    ("G#", "minor"): "1A", ("G#", "major"): "4B",
    ("A", "minor"): "8A", ("A", "major"): "11B",
    ("A#", "minor"): "3A", ("A#", "major"): "6B",
    ("B", "minor"): "10A", ("B", "major"): "1B",
}
PITCH_CLASSES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _detect_key_camelot(y: np.ndarray, sr: int) -> Tuple[str, str, float]:
    """Krumhansl-Schmuckler chroma key detection (Essentia used first if available)."""
    try:
        import essentia.standard as es  # type: ignore
        audio_44k = y.astype(np.float32)
        key, scale, strength = es.KeyExtractor()(audio_44k)
        cam = KEY_TO_CAMELOT.get((key, scale), "8A")
        label = f"{key}{'m' if scale == 'minor' else ''}"
        return label, cam, round(float(strength), 3)
    except Exception:
        pass

    try:
        import librosa
        chroma = librosa.feature.chroma_cqt(y=y, sr=sr).mean(axis=1)
        maj_prof = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
        min_prof = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])
        best_corr, best_key = -1.0, ("C", "minor")
        for i, name in enumerate(PITCH_CLASSES):
            c_maj = np.corrcoef(chroma, np.roll(maj_prof, i))[0, 1]
            c_min = np.corrcoef(chroma, np.roll(min_prof, i))[0, 1]
            if c_maj > best_corr:
                best_corr, best_key = c_maj, (name, "major")
            if c_min > best_corr:
                best_corr, best_key = c_min, (name, "minor")
        label = f"{best_key[0]}{'m' if best_key[1] == 'minor' else ''}"
        return label, KEY_TO_CAMELOT[best_key], round(max(0.0, min(1.0, float(best_corr))), 3)
    except Exception:
        return "Am", "8A", 0.5


def _track_beats_and_downbeats(y: np.ndarray, sr: int, duration: float) -> Tuple[float, float, List[float], List[float], Dict[str, Any]]:
    """Dual-method beat/downbeat tracking: compares beat_this/madmom/librosa_dp vs tempogram PLP and resolves octaves."""
    candidates: List[Dict[str, Any]] = []

    # Method A (neural): beat_this or madmom if available
    try:
        from beat_this.inference import Audio2Beats  # type: ignore
        a2b = Audio2Beats()
        b_times, db_times = a2b(y, sr)
        if len(b_times) >= 8:
            b_list = [round(float(t), 3) for t in b_times]
            ibis = np.diff(b_list)
            ibis = ibis[(ibis > 0.25) & (ibis < 1.35)]
            b_bpm = float(60.0 / np.median(ibis)) if len(ibis) else 120.0
            candidates.append({
                "name": "beat_this",
                "bpm": b_bpm,
                "conf": 0.9,
                "beats": b_list,
                "downbeats": [round(float(t), 3) for t in db_times if t is not None],
            })
    except Exception:
        pass

    if not candidates:
        try:
            import madmom  # type: ignore
            proc = madmom.features.downbeats.DBNDownBeatTrackingProcessor(beats_per_bar=[4], fps=100)
            act = madmom.features.downbeats.RNNDownBeatProcessor()(y)
            res = proc(act)
            if len(res) >= 8:
                b_list = [round(float(r[0]), 3) for r in res]
                ibis = np.diff(b_list)
                ibis = ibis[(ibis > 0.25) & (ibis < 1.35)]
                b_bpm = float(60.0 / np.median(ibis)) if len(ibis) else 120.0
                candidates.append({
                    "name": "madmom",
                    "bpm": b_bpm,
                    "conf": 0.88,
                    "beats": b_list,
                    "downbeats": [round(float(r[0]), 3) for r in res if int(r[1]) == 1],
                })
        except Exception:
            pass

    # Method B: Librosa DP beat_track
    import librosa
    onset_low = librosa.onset.onset_strength(y=y, sr=sr, fmax=180)
    onset_full = librosa.onset.onset_strength(y=y, sr=sr)
    tempo, beat_frames = librosa.beat.beat_track(y=y, sr=sr, onset_envelope=onset_full, trim=False)
    bpm_lib = float(np.atleast_1d(tempo)[0])
    beats_lib = [round(float(t), 3) for t in librosa.frames_to_time(beat_frames, sr=sr)]
    phase_scores = [0.0, 0.0, 0.0, 0.0]
    for idx, bf in enumerate(beat_frames):
        if 0 <= bf < len(onset_low):
            phase_scores[idx % 4] += float(onset_low[bf])
    phase = int(np.argmax(phase_scores))
    downbeats_lib = [beats_lib[i] for i in range(phase, len(beats_lib), 4)]
    candidates.append({
        "name": "librosa_beat_track",
        "bpm": bpm_lib,
        "conf": 0.78 if len(beats_lib) >= 12 else 0.3,
        "beats": beats_lib,
        "downbeats": downbeats_lib,
    })

    # Method C: Librosa Predominant Local Pulse (PLP) second independent tracker when < 2 candidates
    if len(candidates) < 2:
        try:
            pulse = librosa.beat.plp(onset_envelope=onset_full, sr=sr, tempo_min=60, tempo_max=190)
            plp_frames = librosa.util.peak_pick(pulse, pre_max=4, post_max=4, pre_avg=5, post_avg=5, delta=0.08, wait=6)
            beats_plp = [round(float(t), 3) for t in librosa.frames_to_time(plp_frames, sr=sr)]
            ibis_p = np.diff(beats_plp)
            ibis_p = ibis_p[(ibis_p > 0.25) & (ibis_p < 1.35)]
            bpm_plp = float(60.0 / np.median(ibis_p)) if len(ibis_p) else bpm_lib
            candidates.append({
                "name": "librosa_plp",
                "bpm": bpm_plp,
                "conf": 0.74 if len(beats_plp) >= 12 else 0.3,
                "beats": beats_plp,
                "downbeats": beats_plp[::4],
            })
        except Exception:
            pass

    primary = candidates[0]
    secondary = candidates[1] if len(candidates) > 1 else candidates[0]
    bpm = primary["bpm"]
    conf = primary["conf"]
    beats = primary["beats"]
    downbeats = primary["downbeats"]
    tracker = primary["name"]

    if len(beats) >= 4:
        ibis = np.diff(beats)
        ibis = ibis[(ibis > 0.24) & (ibis < 1.35)]
        if len(ibis):
            bpm = round(float(60.0 / np.median(ibis)), 2)

    if not downbeats and beats:
        downbeats = beats[::4]

    # Compare primary vs secondary across octave ratios (1x, 2x, 0.5x)
    min_err = min(abs(bpm * k - secondary["bpm"]) / max(55.0, bpm * k, secondary["bpm"]) for k in (1.0, 2.0, 0.5))
    octave_resolved = min_err <= 0.05 and abs(bpm - secondary["bpm"]) / max(55.0, bpm) > 0.05

    drift_pct = 0.0
    ibi_cv = 0.0
    if len(beats) >= 12:
        ibis = np.diff(beats)
        ibis = ibis[(ibis > 0.24) & (ibis < 1.35)]
        if len(ibis) >= 8:
            q1 = float(np.mean(ibis[: len(ibis) // 3]))
            q3 = float(np.mean(ibis[-len(ibis) // 3 :]))
            drift_pct = round(abs(q3 - q1) / max(0.2, q1) * 100.0, 2)
            ibi_cv = round(float(np.std(ibis) / max(0.2, np.mean(ibis))), 4)

    low_confidence = min_err > 0.07 or conf < 0.45 or drift_pct > 5.0 or ibi_cv > 0.11
    return bpm, conf, beats, downbeats, {
        "tracker": tracker,
        "drift_pct": drift_pct,
        "ibi_cv": ibi_cv,
        "is_variable": drift_pct > 3.5,
        "low_confidence": low_confidence,
        "comparison": {
            "method_a": {"name": primary["name"], "bpm": round(primary["bpm"], 1), "conf": primary["conf"]},
            "method_b": {"name": secondary["name"], "bpm": round(secondary["bpm"], 1), "conf": secondary["conf"]},
            "chosen": tracker,
            "bpm_delta_pct": round(min_err * 100.0, 1),
            "octave_resolved": octave_resolved,
        },
    }


def _separate_stems_demucs(audio_path: Path, out_dir: Path) -> Optional[Dict[str, Path]]:
    """Runs Demucs htdemucs 4-stem separation if Demucs/PyTorch is installed."""
    stem_names = ("vocals", "drums", "bass", "other")
    if all((out_dir / f"{s}.wav").exists() for s in stem_names):
        return {s: out_dir / f"{s}.wav" for s in stem_names}

    try:
        import subprocess
        cmd = ["python", "-m", "demucs", "--two-stems" if False else "-n", "htdemucs", "-o", str(out_dir / "demucs_tmp"), str(audio_path)]
        res = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
        if res.returncode == 0:
            found = list((out_dir / "demucs_tmp").glob("htdemucs/*/vocals.wav"))
            if found:
                src_folder = found[0].parent
                out = {}
                for s in stem_names:
                    dst = out_dir / f"{s}.wav"
                    (src_folder / f"{s}.wav").replace(dst)
                    out[s] = dst
                return out
    except Exception:
        pass
    return None


def _transcribe_lyrics(vocal_path: Path) -> Tuple[List[Dict[str, Any]], str]:
    """Runs WhisperX or faster-whisper on the clean vocal stem for multilingual lyrics."""
    try:
        from faster_whisper import WhisperModel  # type: ignore
        model = WhisperModel("small", device="cpu", compute_type="int8")
        segments, info = model.transcribe(str(vocal_path), beam_size=1)
        lines = []
        for seg in segments:
            text = seg.text.strip()
            if text:
                lines.append({
                    "start_sec": round(float(seg.start), 2),
                    "end_sec": round(float(seg.end), 2),
                    "text": text,
                })
        return lines, str(getattr(info, "language", "unknown"))
    except Exception:
        return [], "unknown"


def analyze_audio_file(audio_bytes: bytes, filename: str = "track.wav", song_id: Optional[str] = None) -> Dict[str, Any]:
    """Complete Phase 1 analysis pipeline with SHA-256 disk caching."""
    h = sha256_bytes(audio_bytes)[:24]
    song_dir = CACHE_ROOT / h
    song_dir.mkdir(parents=True, exist_ok=True)
    json_path = song_dir / "analysis.json"
    if json_path.exists():
        cached = json.loads(json_path.read_text(encoding="utf-8"))
        cached["cached"] = True
        return cached

    raw_path = song_dir / f"source{Path(filename).suffix or '.wav'}"
    raw_path.write_bytes(audio_bytes)

    import librosa
    y, sr = librosa.load(str(raw_path), sr=44100, mono=True)
    duration = float(len(y) / sr)

    # Measure integrated loudness (approx LUFS) and produce a normalized working copy for balanced stem/energy stats
    rms_total = float(np.sqrt(np.mean(y ** 2) + 1e-9))
    measured_lufs = round(max(-40.0, min(-4.0, 20.0 * np.log10(max(1e-5, rms_total)) - 0.691)), 2)
    gain_lin = float(10 ** (max(-6.0, min(6.0, -14.0 - measured_lufs)) / 20.0))
    y_norm = np.clip(y * gain_lin, -0.99, 0.99)
    norm_path = song_dir / "normalized.wav"
    sf.write(str(norm_path), y_norm.astype(np.float32), sr)

    bpm, bpm_conf, beats, downbeats, stab = _track_beats_and_downbeats(y_norm, sr, duration)
    key_label, camelot, key_conf = _detect_key_camelot(y_norm, sr)

    tempo_changes: List[Dict[str, Any]] = []
    if len(beats) >= 16:
        ibis = np.diff(beats)
        prev_wbpm = None
        for idx in range(0, len(ibis) - 11, 12):
            avg_d = float(np.mean(ibis[idx : idx + 12]))
            if avg_d > 0.2:
                wbpm = round(60.0 / avg_d, 1)
                if prev_wbpm and abs(wbpm - prev_wbpm) / max(55.0, prev_wbpm) >= 0.045:
                    tempo_changes.append({"at_sec": round(float(beats[idx]), 2), "from_bpm": prev_wbpm, "to_bpm": wbpm})
                prev_wbpm = wbpm
    stab["tempo_changes"] = tempo_changes

    bar_dur = (60.0 / max(55.0, bpm)) * 4.0
    bar_starts = downbeats if len(downbeats) >= 2 else [round(t, 3) for t in np.arange(0, duration, bar_dur)]
    bars = []
    for i, s in enumerate(bar_starts):
        e = min(duration, bar_starts[i + 1] if i + 1 < len(bar_starts) else s + bar_dur)
        if e - s >= 0.35:
            bars.append({"bar": len(bars), "start_sec": round(float(s), 3), "end_sec": round(float(e), 3)})
    bar_count = len(bars)

    stems_map = _separate_stems_demucs(raw_path, song_dir)
    lyrics, language = ([], "unknown")
    if stems_map and "vocals" in stems_map:
        lyrics, language = _transcribe_lyrics(stems_map["vocals"])

    stem_activity: Dict[str, List[float]] = {"vocals": [], "drums": [], "bass": [], "other": []}
    energy_per_bar: List[float] = []

    if stems_map:
        stem_arrays = {k: sf.read(str(p), always_2d=False)[0] for k, p in stems_map.items()}
        for k in stem_activity:
            arr = stem_arrays[k]
            if arr.ndim > 1:
                arr = arr.mean(axis=1)
            vals = [float(np.sqrt(np.mean(arr[int(b["start_sec"] * sr):int(b["end_sec"] * sr)] ** 2) + 1e-9)) for b in bars]
            p95 = float(np.percentile(vals, 95)) if vals else 1.0
            stem_activity[k] = [round(min(1.0, v / max(p95, 1e-6)), 3) for v in vals]

    for b in bars:
        seg = y[int(b["start_sec"] * sr):int(b["end_sec"] * sr)]
        rms = float(np.sqrt(np.mean(seg ** 2) + 1e-9)) if len(seg) else 0.0
        energy_per_bar.append(rms)
        if not stems_map:
            spec = np.abs(np.fft.rfft(seg)) if len(seg) else np.zeros(1)
            freqs = np.fft.rfftfreq(len(seg), 1.0 / sr) if len(seg) else np.zeros(1)
            lo = float(np.mean(spec[(freqs >= 30) & (freqs < 150)])) if np.any((freqs >= 30) & (freqs < 150)) else 0.0
            dr = float(np.mean(spec[(freqs >= 150) & (freqs < 400)])) if np.any((freqs >= 150) & (freqs < 400)) else 0.0
            vo = float(np.mean(spec[(freqs >= 400) & (freqs < 3800)])) if np.any((freqs >= 400) & (freqs < 3800)) else 0.0
            hi = float(np.mean(spec[freqs >= 3800])) if np.any(freqs >= 3800) else 0.0
            stem_activity["bass"].append(lo)
            stem_activity["drums"].append(dr)
            stem_activity["vocals"].append(vo)
            stem_activity["other"].append(hi)

    def _norm(v_list: List[float]) -> List[float]:
        if not v_list:
            return []
        p95 = float(np.percentile(v_list, 95)) or 1e-6
        return [round(min(1.0, x / max(p95, 1e-6)), 3) for x in v_list]

    energy_per_bar = _norm(energy_per_bar)
    if not stems_map:
        for k in stem_activity:
            stem_activity[k] = _norm(stem_activity[k])
    stem_activity["drum_density"] = stem_activity["drums"]
    stem_activity["bass_presence"] = stem_activity["bass"]

    # Sections & phrase boundaries
    phrase_boundaries = [{"bar": b["bar"], "sec": b["start_sec"], "multiple": 32 if b["bar"] % 32 == 0 else (16 if b["bar"] % 16 == 0 else 8)} for b in bars if b["bar"] % 8 == 0]
    sections = []
    for i, b in enumerate(bars):
        e = energy_per_bar[i] if i < len(energy_per_bar) else 0.5
        st = "intro" if i < min(8, bar_count // 6) and e < 0.6 else ("outro" if i >= max(bar_count - 8, int(bar_count * 0.85)) and e < 0.65 else ("chorus" if e >= 0.75 else "verse"))
        if sections and sections[-1]["type"] == st:
            sections[-1]["end_bar"] = i + 1
            sections[-1]["end_sec"] = b["end_sec"]
        else:
            sections.append({"type": st, "start_bar": i, "end_bar": i + 1, "start_sec": b["start_sec"], "end_sec": b["end_sec"], "energy": e})

    instrumental_gaps = []
    g_start = None
    for i in range(bar_count + 1):
        quiet = i < bar_count and stem_activity["vocals"][i] < 0.38
        if quiet and g_start is None:
            g_start = i
        elif not quiet and g_start is not None:
            if i - g_start >= 2:
                instrumental_gaps.append({
                    "start_bar": g_start,
                    "end_bar": i,
                    "start_sec": bars[g_start]["start_sec"],
                    "end_sec": bars[i - 1]["end_sec"],
                    "duration_sec": round(bars[i - 1]["end_sec"] - bars[g_start]["start_sec"], 2),
                })
            g_start = None

    warnings: List[str] = []
    if bpm_conf < 0.35 or len(beats) < 8:
        warnings.append("no_clear_beat")
    if stab["is_variable"]:
        warnings.append("variable_tempo")
    if stab.get("low_confidence"):
        warnings.append("low_confidence")
    safe_only = bool(stab.get("low_confidence") or "no_clear_beat" in warnings)

    result = {
        "song_id": song_id or h,
        "hash": h,
        "content_hash": h,
        "title": Path(filename).stem,
        "duration_sec": round(duration, 2),
        "lufs": measured_lufs,
        "bpm": bpm,
        "bpm_confidence": bpm_conf,
        "beat_times": beats,
        "downbeat_times": downbeats,
        "tracker_comparison": stab.get("comparison"),
        "low_confidence": safe_only,
        "safe_transitions_only": safe_only,
        "stems_available": bool(stems_map),
        "stem_mode": "demucs-4stem" if stems_map else "eq-midside-off",
        "bar_count": bar_count,
        "bars": bars,
        "phrase_boundaries": phrase_boundaries,
        "sections": sections,
        "key": key_label,
        "key_camelot": camelot,
        "key_confidence": key_conf,
        "energy_per_bar": energy_per_bar,
        "stem_activity": stem_activity,
        "instrumental_gaps": instrumental_gaps,
        "lyrics": lyrics,
        "language": language,
        "tempo_stability": stab,
        "warnings": warnings,
        "stems": {k: f"/stems/{h}/{k}.wav" for k in stems_map} if stems_map else None,
        "cached": False,
    }
    json_path.write_text(json.dumps(result), encoding="utf-8")
    return result
