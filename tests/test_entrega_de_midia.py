"""Como a mídia sai do servidor — o que sustenta tocar com a tela apagada.

Os dois defeitos que deram origem a estes testes:

1. O GZipMiddleware era global e comprimia o MP3. Medido num MP3 de 40.004
   bytes: saía com `content-encoding: gzip` e **40.037** — crescia, porque MP3
   já é comprimido. E a resposta 206 de um pedido `Range` vinha gzipada, sendo
   que é de Range que o `<audio>` depende para retomar o buffer quando a aba
   volta do segundo plano ou o celular destrava.

2. O MP3 saía com `no-store`, que proíbe até o cache do PRÓPRIO navegador:
   voltar dez segundos ou rebuscar dado depois de o sistema suspender a aba
   virava ida nova ao servidor, e se a rede oscilasse justo aí a leitura parava.
"""

import os

import pytest

import main


@pytest.fixture()
def audio_do_dono(client, cria_usuario, sobe_documento, tmp_raiz):
    """Cria um MP3 de verdade no cache, com o nome que a rota exige."""
    headers, _ = cria_usuario("Dona do Livro", "midia@echo.test")
    doc_id = sobe_documento(headers, "livro-midia.pdf")

    r = client.get(f"/api/documents/{doc_id}", headers=headers)
    assert r.status_code == 200, r.text
    from src.database import get_chunks
    chunk_id = get_chunks(doc_id)[0]["id"]

    os.makedirs(main.AUDIO_DIR, exist_ok=True)
    nome = f"{chunk_id}_{'a' * 12}.mp3"
    with open(os.path.join(main.AUDIO_DIR, nome), "wb") as f:
        f.write(b"\xff\xfb\x90\x64" + os.urandom(40000))
    return headers, nome


def test_mp3_nao_sai_comprimido(client, audio_do_dono):
    headers, nome = audio_do_dono
    r = client.get(f"/api/audio/{nome}",
                   headers={**headers, "Accept-Encoding": "gzip, deflate, br"})
    assert r.status_code == 200, r.text
    # 🚨 gzip em MP3 não encolhe nada e quebra Range
    assert "gzip" not in r.headers.get("content-encoding", "")
    assert r.headers.get("content-length") is not None, "sem Content-Length o <audio> não sabe a duração"


def test_mp3_aceita_pedido_de_faixa(client, audio_do_dono):
    """Range é o que o <audio> usa para retomar o buffer ao voltar do fundo."""
    headers, nome = audio_do_dono
    r = client.get(f"/api/audio/{nome}",
                   headers={**headers, "Accept-Encoding": "gzip", "Range": "bytes=0-1023"})
    assert r.status_code == 206, r.text
    assert "gzip" not in r.headers.get("content-encoding", "")
    assert len(r.content) == 1024


def test_mp3_pode_ficar_no_cache_do_proprio_navegador(client, audio_do_dono):
    headers, nome = audio_do_dono
    r = client.get(f"/api/audio/{nome}", headers=headers)
    cache = r.headers.get("cache-control", "")
    assert "private" in cache, "nunca em cache compartilhado — a Cloudflare serviria o áudio de um para outro"
    assert "no-store" not in cache, "no-store proíbe até o cache do próprio aparelho"


def test_capa_continua_sem_cache_nenhum(client, cria_usuario, sobe_documento):
    """A imagem NÃO afrouxa: o risco de a CDN servir a capa de um para outro."""
    headers, _ = cria_usuario("Dona da Capa", "capa@echo.test")
    doc_id = sobe_documento(headers, "livro-capa.pdf")
    r = client.get(f"/api/covers/{doc_id}.png", headers=headers)
    if r.status_code == 404:
        pytest.skip("PDF de teste não gerou capa neste ambiente")
    assert "no-store" in r.headers.get("cache-control", "")


def test_json_continua_comprimido(client, cria_usuario):
    """A exclusão do gzip é só para mídia — o resto tem de seguir comprimido."""
    headers, _ = cria_usuario("Quem Lista", "json@echo.test")
    r = client.get("/api/documents", headers={**headers, "Accept-Encoding": "gzip"})
    assert r.status_code == 200
    # respostas curtas ficam abaixo do minimum_size; o que importa é a ROTA
    # não estar na lista de exclusão
    assert not main._ROTA_DE_MIDIA.match("/api/documents")


@pytest.mark.parametrize("caminho,e_midia", [
    ("/api/audio/abcd1234_aaaaaaaaaaaa.mp3", True),
    ("/api/covers/abc123.png", True),
    ("/api/documents/abc123/pdf", True),
    ("/api/documents/abc123/pages/5.png", True),
    ("/api/documents/abc123/pages/5/words", True),
    ("/api/documents", False),
    ("/api/documents/abc123", False),
    ("/api/documents/abc123/toc", False),
    ("/app", False),
])
def test_quais_rotas_escapam_do_gzip(caminho, e_midia):
    assert bool(main._ROTA_DE_MIDIA.match(caminho)) is e_midia
