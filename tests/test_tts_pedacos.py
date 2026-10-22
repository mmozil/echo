"""Trecho falado em pedaços paralelos (22/10/2026).

A Microsoft passou a servir cada conexão quase em tempo real: a Thalita levava
86 s num trecho de 1.989 caracteres e todo play estourava o prazo. O trecho é
dividido por frase, cada pedaço vai numa conexão, e o áudio é emendado.

O risco real não é o paralelismo — é a EMENDA: se o deslocamento das marcações
de palavra errar, o destaque anda fora da voz a partir do segundo pedaço.
"""

import asyncio

from src import tts_service


def test_texto_curto_vai_inteiro():
    assert tts_service._pedacos("Uma frase só.", tam=500) == ["Uma frase só."]


def test_corta_so_em_fim_de_frase_e_nao_perde_texto():
    frases = [f"Frase número {i} do capítulo, com algum recheio para ocupar espaço." for i in range(20)]
    texto = " ".join(frases)
    pedacos = tts_service._pedacos(texto, tam=200)
    assert len(pedacos) > 1
    assert all(len(p) <= 200 for p in pedacos)
    # cada pedaço termina em fim de frase, e juntos devolvem o texto inteiro
    assert all(p.endswith(".") for p in pedacos)
    assert " ".join(pedacos) == texto


def test_frase_maior_que_o_pedaco_vai_sozinha():
    longa = "palavra " * 100 + "fim."
    texto = f"Curta. {longa} Outra curta."
    pedacos = tts_service._pedacos(texto, tam=50)
    assert longa.strip() in pedacos


def test_emenda_desloca_as_marcacoes_pela_duracao_do_audio(monkeypatch):
    # 6.000 bytes = 1 s no MP3 de 48 kbps do Edge
    falas = {
        "A primeira.": (b"\x00" * 12_000, [{"offset": 1_000_000, "duration": 5, "text": "A"}]),
        "A segunda.": (b"\x01" * 6_000, [{"offset": 2_000_000, "duration": 5, "text": "segunda"}]),
        "A terceira.": (b"\x02" * 6_000, [{"offset": 0, "duration": 5, "text": "terceira"}]),
    }

    async def falso(texto, voice, rate, pitch):
        await asyncio.sleep(0.01 if texto == "A primeira." else 0)  # termina fora de ordem
        return falas[texto]

    monkeypatch.setattr(tts_service, "_falar_um", falso)
    texto = "A primeira. A segunda. A terceira."
    monkeypatch.setattr(tts_service, "_pedacos", lambda t: ["A primeira.", "A segunda.", "A terceira."])

    audio, marcas = asyncio.run(tts_service._falar(texto, "voz", "+0%", "+0Hz"))

    assert audio == b"\x00" * 12_000 + b"\x01" * 6_000 + b"\x02" * 6_000
    assert [m["text"] for m in marcas] == ["A", "segunda", "terceira"]
    # 2º pedaço começa em 2 s, 3º em 3 s (100 ns)
    assert [m["offset"] for m in marcas] == [1_000_000, 22_000_000, 30_000_000]
    assert [m["offset_ms"] for m in marcas] == [100.0, 2200.0, 3000.0]
