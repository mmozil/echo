"""Ambiente isolado para os testes: banco e pastas temporárias, TTS desligado.

As variáveis de ambiente têm de ser definidas ANTES de importar src.database e
main — DB_PATH e as pastas são lidas na importação do módulo.
"""

import os
import sys
import tempfile
import uuid
from pathlib import Path

import pytest

RAIZ = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(RAIZ))

_TMP = Path(tempfile.mkdtemp(prefix="echo-teste-"))
os.environ["DB_PATH"] = str(_TMP / "echo.db")
os.environ["UPLOAD_DIR"] = str(_TMP / "uploads")
os.environ["AUDIO_DIR"] = str(_TMP / "audio")
os.environ["COVERS_DIR"] = str(_TMP / "covers")
os.environ["PAGES_DIR"] = str(_TMP / "pages")
os.environ.pop("ECHO_ADMIN_KEY", None)

import fitz  # noqa: E402  (PyMuPDF)
from fastapi.testclient import TestClient  # noqa: E402

import main  # noqa: E402


@pytest.fixture(scope="session")
def tmp_raiz() -> Path:
    return _TMP


@pytest.fixture(scope="session", autouse=True)
def _sem_tts():
    """Não gerar áudio de verdade nos testes (Edge TTS bate na rede)."""
    async def _nada(doc_id: str):
        return None

    main._pregenerate_all_audio = _nada


@pytest.fixture()
def client():
    with TestClient(main.app) as c:
        yield c


def pdf_de_teste(caminho: Path, texto: str = "Echo teste de propriedade de documento.") -> Path:
    doc = fitz.open()
    for i in range(2):
        page = doc.new_page()
        page.insert_text((72, 100), f"{texto} Pagina {i + 1}.", fontsize=14)
    doc.save(str(caminho))
    doc.close()
    return caminho


@pytest.fixture()
def cria_usuario(client):
    """Registra um usuário NOVO e devolve (headers_bearer, dados).

    O e-mail leva um sufixo único: cadastro não sobrescreve conta existente,
    e cada teste precisa de uma biblioteca limpa.
    """
    def _cria(nome: str, email: str, senha: str = "senha123"):
        email = f"{uuid.uuid4().hex[:8]}-{email}"
        r = client.post("/api/auth/register", json={"name": nome, "email": email, "password": senha})
        assert r.status_code == 200, r.text
        token = r.json()["token"]
        dados = dict(r.json(), email=email)
        # TestClient guarda o cookie sozinho; para isolar os usuários, cada um
        # usa o próprio Bearer e o cookie é limpo entre eles.
        client.cookies.clear()
        return {"Authorization": f"Bearer {token}"}, dados

    return _cria


@pytest.fixture()
def sobe_documento(client, tmp_raiz):
    def _sobe(headers: dict, nome_arquivo: str = "livro.pdf") -> str:
        caminho = tmp_raiz / nome_arquivo
        pdf_de_teste(caminho)
        with open(caminho, "rb") as f:
            r = client.post(
                "/api/documents",
                headers=headers,
                files={"file": (nome_arquivo, f, "application/pdf")},
            )
        assert r.status_code == 200, r.text
        return r.json()["id"]

    return _sobe
