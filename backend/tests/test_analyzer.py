import io
import numpy as np
import soundfile as sf

from analyzer import analyze_audio_file


def _make_click_wav(bpm: float = 124.0, duration_sec: float = 16.0, sr: int = 44100) -> bytes:
    t = np.linspace(0, duration_sec, int(sr * duration_sec), endpoint=False)
    y = 0.08 * np.sin(2 * np.pi * 220 * t)
    beat_sec = 60.0 / bpm
    for idx, bt in enumerate(np.arange(0, duration_sec - 0.1, beat_sec)):
        i0 = int(bt * sr)
        n = min(int(0.08 * sr), len(y) - i0)
        amp = 0.65 if idx % 4 == 0 else 0.35
        env = np.exp(-np.linspace(0, 6, n))
        y[i0 : i0 + n] += amp * env * np.sin(2 * np.pi * (80 if idx % 4 == 0 else 180) * np.linspace(0, 0.08, n))
    buf = io.BytesIO()
    sf.write(buf, y.astype(np.float32), sr, format="WAV")
    return buf.getvalue()


def test_phase1_schema_and_beats():
    wav_bytes = _make_click_wav(124.0, 16.0)
    res = analyze_audio_file(wav_bytes, filename="test_124_click.wav", song_id="test-124")
    assert res["song_id"] == "test-124"
    assert abs(res["bpm"] - 124.0) < 4.0
    assert len(res["beat_times"]) >= 20
    assert len(res["downbeat_times"]) >= 4
    assert res["bar_count"] >= 4
    assert len(res["energy_per_bar"]) == res["bar_count"]
    assert all(k in res["stem_activity"] for k in ("vocals", "drums", "bass", "other"))
    assert res["key_camelot"].endswith(("A", "B"))
