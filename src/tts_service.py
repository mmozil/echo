"""Serviço TTS usando Microsoft Edge TTS — voz pt-BR-AntonioNeural (grátis)."""

import edge_tts
import asyncio
import logging
import os
import json
import hashlib

logger = logging.getLogger("echo.tts")

VOICE = os.environ.get("TTS_VOICE", "pt-BR-AntonioNeural")
AUDIO_DIR = os.environ.get("AUDIO_DIR", "/app/data/audio")

# 🚨 O edge-tts fala com um servidor da Microsoft e NÃO tinha prazo nem
# segunda tentativa. Se aquele socket pendurasse, o `await` não voltava: a
# requisição do trecho ficava aberta para sempre, o front esperava o JSON que
# nunca vinha, e o player simplesmente parava no fim do trecho anterior — sem
# mensagem, sem nova tentativa. Da cadeira do leitor, é "ele parou de falar".
TTS_TIMEOUT_S = int(os.environ.get("TTS_TIMEOUT_S", "45"))
TTS_TENTATIVAS = int(os.environ.get("TTS_TENTATIVAS", "3"))

# Dois livros grandes subindo ao mesmo tempo abririam dezenas de conexões
# simultâneas com a Microsoft. Três por vez já satura a banda útil.
_vagas = asyncio.Semaphore(int(os.environ.get("TTS_SIMULTANEOS", "3")))

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

    audio_data, boundaries = await _falar_com_prazo(text, use_voice, rate, pitch)

    # 🚨 GRAVAÇÃO ATÔMICA, e o MP3 só depois do JSON. O par tem de aparecer
    # inteiro ou não aparecer: um arquivo truncado (queda no meio da escrita)
    # ficaria no cache para sempre, porque a checagem lá em cima só olha se o
    # arquivo EXISTE — e todo play daquele trecho voltaria quebrado.
    _gravar_atomico(boundaries_path, json.dumps(boundaries, ensure_ascii=False).encode("utf-8"))
    _gravar_atomico(filepath, audio_data)

    return {"path": filepath, "filename": filename, "boundaries_file": boundaries_filename, "cached": False}


def _gravar_atomico(destino: str, dados: bytes):
    parcial = destino + ".parcial"
    with open(parcial, "wb") as f:
        f.write(dados)
        f.flush()
        os.fsync(f.fileno())
    os.replace(parcial, destino)


async def _falar_com_prazo(text: str, voice: str, rate: str, pitch: str) -> tuple[bytes, list]:
    """Chama o edge-tts com prazo e segunda chance."""
    ultimo_erro = None
    for tentativa in range(1, TTS_TENTATIVAS + 1):
        try:
            async with _vagas:
                return await asyncio.wait_for(
                    _falar(text, voice, rate, pitch), timeout=TTS_TIMEOUT_S
                )
        except asyncio.TimeoutError as e:
            ultimo_erro = e
            logger.warning("TTS tentativa %d/%d estourou %ds", tentativa, TTS_TENTATIVAS, TTS_TIMEOUT_S)
        except Exception as e:
            ultimo_erro = e
            logger.warning("TTS tentativa %d/%d falhou: %s", tentativa, TTS_TENTATIVAS, e)
        if tentativa < TTS_TENTATIVAS:
            await asyncio.sleep(1.5 * tentativa)   # espera crescente
    raise RuntimeError(f"TTS falhou após {TTS_TENTATIVAS} tentativas: {ultimo_erro}")


async def _falar(text: str, voice: str, rate: str, pitch: str) -> tuple[bytes, list]:
    communicate = edge_tts.Communicate(
        text=text,
        voice=voice,
        rate=rate,
        pitch=pitch,
        boundary="WordBoundary",
    )

    # Stream para capturar áudio + word boundaries
    boundaries = []
    pedacos = []

    async for message in communicate.stream():
        if message["type"] == "audio":
            pedacos.append(message["data"])
        elif message["type"] == "WordBoundary":
            boundaries.append({
                "offset": message["offset"],           # microsegundos desde início
                "duration": message["duration"],       # duração em microsegundos
                "text": message["text"],               # palavra
                "offset_ms": message["offset"] / 10000,  # converter para ms
                "duration_ms": message["duration"] / 10000,
            })

    audio = b"".join(pedacos)
    if not audio:
        raise RuntimeError("TTS devolveu áudio vazio")
    return audio, boundaries


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
