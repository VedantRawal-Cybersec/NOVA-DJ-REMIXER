from pathlib import Path
from typing import Optional
import urllib.request

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel

from analyzer import CACHE_ROOT, analyze_audio_file

app = FastAPI(title="NOVA AI DJ Audio Analysis Service", version="3.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


import base64


class AnalyzeUrlBody(BaseModel):
    url: str
    song_id: Optional[str] = None
    filename: Optional[str] = "stream.mp3"


class AnalyzeB64Body(BaseModel):
    audioBase64: str
    song_id: Optional[str] = None
    filename: Optional[str] = "upload.wav"


@app.get("/health")
def health():
    has_demucs = False
    has_whisper = False
    try:
        import demucs  # noqa: F401
        has_demucs = True
    except Exception:
        pass
    try:
        import faster_whisper  # noqa: F401
        has_whisper = True
    except Exception:
        pass
    return {"ok": True, "service": "NOVA Python Audio Analyzer", "demucs": has_demucs, "whisper": has_whisper}


@app.post("/analyze")
async def analyze_upload(file: UploadFile = File(...), song_id: Optional[str] = Form(None)):
    raw = await file.read()
    if len(raw) < 1024:
        raise HTTPException(status_code=400, detail="Audio file too small")
    return analyze_audio_file(raw, file.filename or "upload.wav", song_id=song_id)


@app.post("/analyze-url")
def analyze_url(body: AnalyzeUrlBody):
    req = urllib.request.Request(body.url, headers={"User-Agent": "NOVA-AI-DJ/3.0"})
    with urllib.request.urlopen(req, timeout=20) as resp:
        raw = resp.read()
    return analyze_audio_file(raw, body.filename or "stream.mp3", song_id=body.song_id)


@app.post("/analyze-b64")
def analyze_b64(body: AnalyzeB64Body):
    try:
        raw = base64.b64decode(body.audioBase64)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid base64 audio payload")
    if len(raw) < 1024:
        raise HTTPException(status_code=400, detail="Audio file too small")
    return analyze_audio_file(raw, body.filename or "upload.wav", song_id=body.song_id)


@app.get("/stems/{song_hash}/{stem_name}")
def get_stem(song_hash: str, stem_name: str):
    clean = stem_name.replace(".wav", "")
    if clean not in ("vocals", "drums", "bass", "other"):
        raise HTTPException(status_code=400, detail="Invalid stem")
    path = CACHE_ROOT / song_hash / f"{clean}.wav"
    if not path.exists():
        raise HTTPException(status_code=404, detail="Stem not found")
    return FileResponse(path, media_type="audio/wav")
