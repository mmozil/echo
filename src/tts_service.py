"""Serviço TTS usando Microsoft Edge TTS — voz pt-BR-AntonioNeural (grátis)."""

import edge_tts
import os
import json
import hashlib

VOICE = os.environ.get("TTS_VOICE", "pt-BR-AntonioNeural")
AUDIO_DIR = os.environ.get("AUDIO_DIR", "/app/data/audio")

# As três vozes pt-BR do Edge — e só elas. As de Portugal
# (pt-PT-DuarteNeural, pt-PT-RaquelNeural) ficam de fora de propósito: o
# sotaque europeu se ouve na hora e não é o que o leitor daqui espera.
VOZES_PT_BR = [
    {"name": "pt-BR-FranciscaNeural", "label": "Francisca", "gender": "Feminina"},
    {"name": "pt-BR-AntonioNeural", "label": "Antônio", "gender": "Masculina"},
    {"name": "pt-BR-ThalitaMultilingualNeural", "label": "Thalita", "gender": "Feminina"},
]
NOMES_VALIDOS = {v["name"] for v in VOZES_PT_BR}
VOZ_PADRAO = VOICE if VOICE in NOMES_VALIDOS else "pt-BR-AntonioNeural"


def voz_valida(nome: str | None) -> str:
    """Devolve a voz pedida se for uma das três; senão, a padrão."""
    return nome if nome in NOMES_VALIDOS else VOZ_PADRAO


async def generate_audio(text: str, chunk_id: str, rate: str = "+0%", pitch: str = "+0Hz", voice: str = None) -> dict:
    """Gera áudio MP3 + word boundaries JSON.

    Retorna {path, filename, boundaries_file, cached}
    """
    # 🚨 A VOZ ENTRA NA CHAVE DO CACHE. Sem isso, trocar de voz continuaria
    # tocando o MP3 antigo e pareceria que a troca não funciona — quando o que
    # está errado é o cache servindo arquivo de outra voz. O .json de word
    # boundaries usa a mesma chave, porque ele também muda com a voz.
    use_voice = voz_valida(voice)
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


async def generate_audio_stream(text: str, rate: str = "+0%", pitch: str = "+0Hz", voice: str = None):
    """Gera áudio como stream (para playback em tempo real)."""
    communicate = edge_tts.Communicate(
        text=text,
        voice=voz_valida(voice),
        rate=rate,
        pitch=pitch,
    )

    async for chunk in communicate.stream():
        if chunk["type"] == "audio":
            yield chunk["data"]


async def list_voices(language: str = "pt-BR") -> list[dict]:
    """Lista as vozes oferecidas ao leitor.

    Sai da constante, não da API do Edge: a lista é fixa (três vozes pt-BR),
    e assim a tela de voz não depende de uma chamada de rede que pode falhar
    nem corre o risco de oferecer uma voz que o resto do código recusa.
    """
    return [dict(v, locale="pt-BR") for v in VOZES_PT_BR]
