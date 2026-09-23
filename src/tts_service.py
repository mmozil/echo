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

# =========================================================================
# DOIS MOTORES DE VOZ
#
# edge-tts (Microsoft, nuvem)  — rápido: ~4 s num trecho de 1.000 caracteres.
# Kokoro (nosso, self-hosted)  — 12 a 20 s no mesmo trecho, MAS devolve uma
#                                marcação POR PALAVRA, na grafia exata do
#                                texto (medido: 154 para 154 palavras).
#
# 🚨 A marcação do Kokoro é MELHOR que a do Edge para o destaque. O
# `WordBoundary` do Edge não casa 1 para 1 com o texto (89 marcações para
# ~100 palavras, 12 delas de um caractere), e por isso o front precisa casar
# por aproximação. Com o Kokoro o mapa é identidade.
#
# O preço é o tempo. No Echo isso pesa pouco: o áudio é pré-gerado em segundo
# plano e fica em cache. Dói só no trecho ainda não gerado.
#
# O container `kokoro-tts` já serve o Tier Agent (5 GB / 6 vCPU). Sem a env
# KOKORO_URL a voz simplesmente não é oferecida — é a degradação graciosa que
# o resto do projeto usa.
# =========================================================================

KOKORO_URL = os.environ.get("KOKORO_URL", "").rstrip("/")
KOKORO_TIMEOUT_S = int(os.environ.get("KOKORO_TIMEOUT_S", "180"))
PREFIXO_KOKORO = "kokoro:"

# As vozes pt-BR do Edge — e só elas. As de Portugal (pt-PT-DuarteNeural,
# pt-PT-RaquelNeural) ficam de fora de propósito: o sotaque europeu se ouve na
# hora e não é o que o leitor daqui espera.
VOZES_EDGE = [
    {"name": "pt-BR-FranciscaNeural", "label": "Francisca", "gender": "Feminina", "motor": "edge"},
    {"name": "pt-BR-AntonioNeural", "label": "Antônio", "gender": "Masculina", "motor": "edge"},
    {"name": "pt-BR-ThalitaMultilingualNeural", "label": "Thalita", "gender": "Feminina", "motor": "edge"},
]

# Kokoro tem três em português: pf_dora, pm_alex e pm_santa. A Dora é a que já
# fala pelo Tier Agent — mesma voz, mesma casa.
VOZES_KOKORO = [
    {"name": PREFIXO_KOKORO + "pf_dora", "label": "Dora", "gender": "Feminina", "motor": "kokoro"},
]

VOZES_PT_BR = VOZES_EDGE + (VOZES_KOKORO if KOKORO_URL else [])
NOMES_VALIDOS = {v["name"] for v in VOZES_PT_BR}
VOZ_PADRAO = VOICE if VOICE in NOMES_VALIDOS else "pt-BR-AntonioNeural"


def e_kokoro(nome: str | None) -> bool:
    return bool(nome) and nome.startswith(PREFIXO_KOKORO)


def voz_valida(nome: str | None) -> str:
    """Devolve a voz pedida se ela existir e estiver disponível; senão, a padrão.

    🚨 Com KOKORO_URL vazia, uma voz Kokoro salva na conta cai aqui e volta
    para a padrão — quem escolheu a Dora antes de o motor sair do ar continua
    ouvindo o livro, com outra voz, em vez de tomar erro.
    """
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

    if e_kokoro(use_voice):
        audio_data, boundaries = await _falar_kokoro_com_prazo(text, use_voice)
    else:
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


# --- Kokoro ---------------------------------------------------------------

async def _falar_kokoro_com_prazo(text: str, voice: str) -> tuple[bytes, list]:
    """Mesma disciplina do Edge: prazo, tentativas e limite de simultâneos.

    🚨 O limite de simultâneos importa MAIS aqui. O container do Kokoro é
    capado em 5 GB, e a experiência do Tier Agent foi clara: paralelizar
    derruba por falta de memória (a 2 GB ele caiu servindo 4 frases juntas).
    """
    if not KOKORO_URL:
        raise RuntimeError("Voz Kokoro pedida sem KOKORO_URL configurada")

    ultimo = None
    for tentativa in range(1, TTS_TENTATIVAS + 1):
        try:
            async with _vagas:
                return await asyncio.wait_for(_falar_kokoro(text, voice), timeout=KOKORO_TIMEOUT_S)
        except asyncio.TimeoutError as e:
            ultimo = e
            logger.warning("KOKORO tentativa %d/%d estourou %ds", tentativa, TTS_TENTATIVAS, KOKORO_TIMEOUT_S)
        except Exception as e:
            ultimo = e
            logger.warning("KOKORO tentativa %d/%d falhou: %s", tentativa, TTS_TENTATIVAS, e)
        if tentativa < TTS_TENTATIVAS:
            await asyncio.sleep(1.5 * tentativa)
    raise RuntimeError(f"Kokoro falhou após {TTS_TENTATIVAS} tentativas: {ultimo}")


async def _falar_kokoro(text: str, voice: str) -> tuple[bytes, list]:
    """Fala pelo Kokoro e traduz a marcação dele para o formato da casa.

    🚨 A resposta é NDJSON (uma linha por parte), não um JSON só: o áudio vem
    em base64, pedaço a pedaço, e as marcações vêm espalhadas pelas linhas.
    Ler com json.loads() no corpo inteiro estoura com "Extra data".
    """
    import base64
    import aiohttp

    corpo = {
        "model": "kokoro",
        "input": text,
        "voice": voice[len(PREFIXO_KOKORO):],
        "response_format": "mp3",
        "return_timestamps": True,
    }

    pedacos: list[bytes] = []
    marcas: list[dict] = []

    tempo = aiohttp.ClientTimeout(total=KOKORO_TIMEOUT_S)
    async with aiohttp.ClientSession(timeout=tempo) as sessao:
        async with sessao.post(f"{KOKORO_URL}/dev/captioned_speech", json=corpo) as resposta:
            if resposta.status != 200:
                detalhe = (await resposta.text())[:200]
                raise RuntimeError(f"Kokoro HTTP {resposta.status}: {detalhe}")
            bruto = await resposta.read()

    for linha in bruto.split(b"\n"):
        if not linha.strip():
            continue
        try:
            parte = json.loads(linha)
        except Exception:
            continue
        if parte.get("audio"):
            pedacos.append(base64.b64decode(parte["audio"]))
        for chave in ("timestamps", "word_timestamps", "words"):
            if parte.get(chave):
                marcas.extend(parte[chave])
                break

    audio = b"".join(pedacos)
    if not audio:
        raise RuntimeError("Kokoro devolveu áudio vazio")

    return audio, _marcas_para_boundaries(marcas)


def _marcas_para_boundaries(marcas: list) -> list[dict]:
    """Traduz {word, start_time, end_time} em segundos para o formato do Edge.

    O resto do app (mapa de destaque, clique, âncora) só entende
    `offset_ms`/`duration_ms`/`text` — então a diferença entre os dois motores
    morre aqui, e nada além deste arquivo precisa saber qual voz falou.
    """
    saida = []
    for m in marcas:
        try:
            inicio = float(m.get("start_time", 0))
            fim = float(m.get("end_time", inicio))
            texto = str(m.get("word", m.get("text", ""))).strip()
        except (TypeError, ValueError):
            continue
        if not texto:
            continue
        saida.append({
            "offset": int(inicio * 10_000_000),      # 100ns, como o Edge manda
            "duration": int(max(0.0, fim - inicio) * 10_000_000),
            "text": texto,
            "offset_ms": inicio * 1000,
            "duration_ms": max(0.0, fim - inicio) * 1000,
        })
    return saida


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

    Sai da constante, não da API do motor: a lista é fixa, e assim a tela de
    voz não depende de uma chamada de rede que pode falhar nem corre o risco
    de oferecer uma voz que o resto do código recusa.

    A Dora (Kokoro) só entra quando KOKORO_URL está configurada — e vem com um
    aviso, porque ela demora 3x mais para gerar e a pessoa merece saber antes
    de escolher, não depois de esperar.
    """
    return [
        dict(v, locale="pt-BR",
             aviso="gera mais devagar" if v.get("motor") == "kokoro" else "")
        for v in VOZES_PT_BR
    ]
