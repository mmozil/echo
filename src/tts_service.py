"""Serviço TTS usando Microsoft Edge TTS — voz pt-BR-AntonioNeural (grátis)."""

import edge_tts
import os
import hashlib

VOICE = os.environ.get("TTS_VOICE", "pt-BR-AntonioNeural")
AUDIO_DIR = os.environ.get("AUDIO_DIR", "/app/data/audio")
OUTPUT_FORMAT = "audio-24khz-48kbitrate-mono-mp3"


async def generate_audio(text: str, chunk_id: str, rate: str = "+0%", pitch: str = "+0Hz") -> dict:
    """Gera áudio MP3 a partir de texto usando Edge TTS.

    Retorna {path: str, filename: str, cached: bool}
    """
    # Cache por hash do texto + configurações
    cache_key = hashlib.md5(f"{text}:{VOICE}:{rate}:{pitch}".encode()).hexdigest()[:12]
    filename = f"{chunk_id}_{cache_key}.mp3"
    filepath = os.path.join(AUDIO_DIR, filename)

    # Se já existe, retorna cache
    if os.path.exists(filepath):
        return {"path": filepath, "filename": filename, "cached": True}

    os.makedirs(AUDIO_DIR, exist_ok=True)

    communicate = edge_tts.Communicate(
        text=text,
        voice=VOICE,
        rate=rate,
        pitch=pitch,
    )

    await communicate.save(filepath)

    return {"path": filepath, "filename": filename, "cached": False}


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
