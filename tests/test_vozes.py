"""Escolha de voz: as três pt-BR, preferência na conta, cache por voz.

O risco real aqui não é a tela — é o CACHE. O MP3 de cada trecho é
reaproveitado, e se a chave não incluísse a voz, trocar de voz continuaria
tocando a voz antiga e pareceria que a troca não funciona.
"""

import hashlib
import os

import pytest

import main
from src import tts_service


VOZES = ["pt-BR-FranciscaNeural", "pt-BR-AntonioNeural", "pt-BR-ThalitaMultilingualNeural"]


# --- 1. A lista oferecida ---------------------------------------------------

def test_voices_exige_sessao(client):
    client.cookies.clear()
    assert client.get("/api/voices").status_code == 401
    assert client.put("/api/voices/selected", json={"voice": VOZES[0]}).status_code == 401


def test_lista_tem_exatamente_as_tres_pt_br(client, cria_usuario):
    headers, _ = cria_usuario("Voz", "voz-lista@echo.test")
    r = client.get("/api/voices", headers=headers)
    assert r.status_code == 200
    nomes = [v["name"] for v in r.json()["voices"]]
    assert nomes == VOZES, nomes
    assert all(v["locale"] == "pt-BR" for v in r.json()["voices"])
    # nada de Portugal: o sotaque se ouve na hora
    assert not any("pt-PT" in n for n in nomes)
    assert [v["label"] for v in r.json()["voices"]] == ["Francisca", "Antônio", "Thalita"]


def test_voz_de_portugal_e_recusada(client, cria_usuario):
    headers, _ = cria_usuario("PT", "voz-pt@echo.test")
    r = client.put("/api/voices/selected", json={"voice": "pt-PT-DuarteNeural"}, headers=headers)
    assert r.status_code == 400
    r = client.put("/api/voices/selected", json={"voice": "en-US-JennyNeural"}, headers=headers)
    assert r.status_code == 400


# --- 2. A preferência mora na conta ----------------------------------------

def test_preferencia_sobrevive_a_logout_e_login(client, cria_usuario):
    headers, dados = cria_usuario("Persist", "voz-persist@echo.test")

    assert client.get("/api/voices", headers=headers).json()["selected"] == "pt-BR-AntonioNeural"
    assert client.put("/api/voices/selected",
                      json={"voice": "pt-BR-ThalitaMultilingualNeural"},
                      headers=headers).status_code == 200

    # sai da sessão e entra de novo: sessão nova, token novo
    client.post("/api/auth/logout", headers=headers)
    client.cookies.clear()
    r = client.post("/api/auth/login", json={"email": dados["email"], "password": "senha123"})
    novo = {"Authorization": f"Bearer {r.json()['token']}"}

    assert client.get("/api/voices", headers=novo).json()["selected"] == "pt-BR-ThalitaMultilingualNeural"
    # /api/auth/me também devolve — é por aí que o app mobile lê no boot
    assert client.get("/api/auth/me", headers=novo).json()["voice"] == "pt-BR-ThalitaMultilingualNeural"


def test_voz_de_um_nao_muda_a_do_outro(client, cria_usuario):
    a, _ = cria_usuario("VozA", "voza@echo.test")
    b, _ = cria_usuario("VozB", "vozb@echo.test")

    client.put("/api/voices/selected", json={"voice": "pt-BR-FranciscaNeural"}, headers=a)
    assert client.get("/api/voices", headers=a).json()["selected"] == "pt-BR-FranciscaNeural"
    assert client.get("/api/voices", headers=b).json()["selected"] == "pt-BR-AntonioNeural"


# --- 3. 🚨 O cache é por voz ------------------------------------------------

@pytest.fixture()
def tts_falso(monkeypatch):
    """Edge TTS sem rede: o áudio gerado carrega a voz no conteúdo.

    Assim dá para provar, byte a byte, que dois arquivos de vozes diferentes
    não são o mesmo — sem depender da internet no teste.
    """
    class ComunicaFalso:
        def __init__(self, text, voice, rate="+0%", pitch="+0Hz", boundary=None):
            self.text, self.voice = text, voice

        async def stream(self):
            yield {"type": "audio", "data": f"AUDIO[{self.voice}]{self.text[:20]}".encode()}
            yield {"type": "WordBoundary", "offset": 0, "duration": 5_000_000, "text": "palavra"}

    monkeypatch.setattr(tts_service.edge_tts, "Communicate", ComunicaFalso)


def _md5(caminho):
    return hashlib.md5(open(caminho, "rb").read()).hexdigest()


def test_trocar_de_voz_gera_outro_arquivo_e_voltar_reaproveita(
    client, cria_usuario, sobe_documento, tts_falso
):
    headers, _ = cria_usuario("Cache", "voz-cache@echo.test")
    doc = sobe_documento(headers, "voz-cache.pdf")
    audio_dir = os.environ["AUDIO_DIR"]

    def gera(voz):
        r = client.post(f"/api/documents/{doc}/chunks/0/audio?voice={voz}", headers=headers)
        assert r.status_code == 200, r.text
        d = r.json()
        arquivo = os.path.join(audio_dir, d["audio_url"].rsplit("/", 1)[-1])
        return d, arquivo

    antonio, arq_antonio = gera("pt-BR-AntonioNeural")
    thalita, arq_thalita = gera("pt-BR-ThalitaMultilingualNeural")

    # 1) arquivos diferentes, conteúdos diferentes
    assert antonio["audio_url"] != thalita["audio_url"]
    assert _md5(arq_antonio) != _md5(arq_thalita)
    assert antonio["voice"] == "pt-BR-AntonioNeural"
    assert thalita["voice"] == "pt-BR-ThalitaMultilingualNeural"
    assert antonio["cached"] is False and thalita["cached"] is False

    # 2) trocar de voz NÃO apagou o áudio da voz anterior
    assert os.path.exists(arq_antonio) and os.path.exists(arq_thalita)

    # 3) voltar para a voz anterior reaproveita — não regera
    mtime_antes = os.path.getmtime(arq_antonio)
    de_volta, arq_de_volta = gera("pt-BR-AntonioNeural")
    assert de_volta["cached"] is True
    assert arq_de_volta == arq_antonio
    assert os.path.getmtime(arq_antonio) == mtime_antes

    # 4) o .json de boundaries acompanha a voz (muda junto com o áudio)
    assert os.path.exists(arq_antonio.replace(".mp3", ".json"))
    assert os.path.exists(arq_thalita.replace(".mp3", ".json"))

    # 5) e o MP3 de cada voz continua servido pela rota, para o dono
    for url in (antonio["audio_url"], thalita["audio_url"]):
        assert client.get(url, headers=headers).status_code == 200


def test_audio_sem_voz_na_chamada_usa_a_da_conta(client, cria_usuario, sobe_documento, tts_falso):
    headers, _ = cria_usuario("Padrao", "voz-padrao@echo.test")
    doc = sobe_documento(headers, "voz-padrao.pdf")
    client.put("/api/voices/selected", json={"voice": "pt-BR-FranciscaNeural"}, headers=headers)

    r = client.post(f"/api/documents/{doc}/chunks/0/audio", headers=headers)
    assert r.json()["voice"] == "pt-BR-FranciscaNeural"


def test_apagar_documento_leva_o_audio_de_todas_as_vozes(
    client, cria_usuario, sobe_documento, tts_falso
):
    headers, _ = cria_usuario("Limpa", "voz-limpa@echo.test")
    doc = sobe_documento(headers, "voz-limpa.pdf")
    audio_dir = os.environ["AUDIO_DIR"]

    arquivos = []
    for voz in ("pt-BR-AntonioNeural", "pt-BR-ThalitaMultilingualNeural"):
        d = client.post(f"/api/documents/{doc}/chunks/0/audio?voice={voz}", headers=headers).json()
        arquivos.append(os.path.join(audio_dir, d["audio_url"].rsplit("/", 1)[-1]))

    assert all(os.path.exists(a) for a in arquivos)
    assert client.delete(f"/api/documents/{doc}", headers=headers).status_code == 200
    # nenhum MP3 órfão fica no disco (o registro no banco só apontava para um deles)
    assert not any(os.path.exists(a) for a in arquivos)


def test_voz_invalida_no_query_cai_na_padrao(client, cria_usuario, sobe_documento, tts_falso):
    headers, _ = cria_usuario("Invalida", "voz-invalida@echo.test")
    doc = sobe_documento(headers, "voz-invalida.pdf")
    r = client.post(f"/api/documents/{doc}/chunks/0/audio?voice=pt-PT-DuarteNeural", headers=headers)
    assert r.status_code == 200
    assert r.json()["voice"] == "pt-BR-AntonioNeural"
