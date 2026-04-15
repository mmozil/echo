"""Serviço TTS usando Microsoft Edge TTS — voz pt-BR-AntonioNeural (grátis)."""

import edge_tts
import os
import json
import hashlib

VOICE = os.environ.get("TTS_VOICE", "pt-BR-AntonioNeural")
AUDIO_DIR = os.environ.get("AUDIO_DIR", "/app/data/audio")


async def generate_audio(text: str, chunk_id: str, rate: str = "+0%", pitch: str = "+0Hz", voice: str = None) -> dict:
    """Gera áudio MP3 + word boundaries JSON.

    Retorna {path, filename, boundaries_file, cached}
    """
    use_voice = voice or VOICE
    cache_key = hashlib.md5(f"{text}:{use_voice}:{rate}:{pitch}".encode()).hexdigest()[:12]
    filename = f"{chunk_id}_{cache_key}.mp3"
    boundaries_filename = f"{chunk_id}_{cache_key}.json"
    filepath = os.path.join(AUDIO_DIR, filename)
    boundaries_path = os.path.join(AUDIO_DIR, boundaries_filename)

    if os.path.exists(filepath) and os.path.exists(boundaries_path):
        return {"path": filepath, "filename": filename, "boundaries_file": boundaries_filename, "cached": True}

    os.makedirs(AUDIO_DIR, exist_ok=True)

    communicate = edge_tts.Communicate(
        text=text,
        voice=use_voice,
        rate=rate,
        pitch=pitch,
        boundary="WordBoundary",
    )

    # Stream para capturar áudio + word boundaries
    boundaries = []
    audio_data = b""

    async for message in communicate.stream():
        if message["type"] == "audio":
            audio_data += message["data"]
        elif message["type"] == "WordBoundary":
            boundaries.append({
                "offset": message["offset"],           # microsegundos desde início
                "duration": message["duration"],       # duração em microsegundos
                "text": message["text"],               # palavra
                "offset_ms": message["offset"] / 10000,  # converter para ms
                "duration_ms": message["duration"] / 10000,
            })

    # Salvar áudio
    with open(filepath, "wb") as f:
        f.write(audio_data)

    # Salvar word boundaries
    with open(boundaries_path, "w", encoding="utf-8") as f:
        json.dump(boundaries, f, ensure_ascii=False)

    return {"path": filepath, "filename": filename, "boundaries_file": boundaries_filename, "cached": False}


async def generate_audio_stream(text: str, rate: str = "+0%", pitch: str = "+0Hz"):
    """Gera áudio como stream (para playback em tempo real)."""
    communicate = edge_tts.Communicate(
        text=text,
        voice=VOICE,
        rate=rate,
        pitch=pitch,
    )

    async for chunk in communicate.stream():
        if chunk["type"] == "audio":
            yield chunk["data"]


async def list_voices(language: str = "pt-BR") -> list[dict]:
    """Lista vozes disponíveis para o idioma."""
    voices = await edge_tts.list_voices()
    return [
        {"name": v["ShortName"], "gender": v["Gender"], "locale": v["Locale"]}
        for v in voices
        if v["Locale"].startswith(language)
    ]
