"""Prova que documento tem dono e que ninguém enxerga o do outro.

Até 08/2026 a tabela documents não tinha coluna de dono e as rotas não pediam
sessão: um curl sem token listava e apagava a biblioteca inteira. Cada teste
aqui trava um pedaço desse buraco.
"""

import sqlite3

import pytest


# --- 1. Sem sessão não se faz nada -----------------------------------------

ROTAS_SEM_TOKEN = [
    ("get", "/api/documents"),
    ("get", "/api/documents/qualquer"),
    ("delete", "/api/documents/qualquer"),
    ("get", "/api/documents/qualquer/toc"),
    ("get", "/api/documents/qualquer/search?q=teste"),
    ("get", "/api/documents/qualquer/pdf"),
    ("get", "/api/documents/qualquer/pages/1.png"),
    ("get", "/api/documents/qualquer/pages/1/words"),
    ("get", "/api/documents/qualquer/chunks/0/text"),
    ("post", "/api/documents/qualquer/chunks/0/audio"),
    ("get", "/api/documents/qualquer/chunks/0/stream"),
    ("get", "/api/covers/qualquer.png"),
    ("get", "/api/audio/aaaaaaaa_bbbbbbbbbbbb.mp3"),
    ("put", "/api/documents/qualquer/progress?current_chunk=1"),
]


@pytest.mark.parametrize("metodo,rota", ROTAS_SEM_TOKEN)
def test_rota_sem_token_devolve_401(client, metodo, rota):
    client.cookies.clear()
    r = getattr(client, metodo)(rota)
    assert r.status_code == 401, f"{metodo.upper()} {rota} devolveu {r.status_code}"


def test_upload_sem_token_devolve_401(client, tmp_raiz):
    from conftest import pdf_de_teste

    client.cookies.clear()
    caminho = pdf_de_teste(tmp_raiz / "anonimo.pdf")
    with open(caminho, "rb") as f:
        r = client.post("/api/documents", files={"file": ("anonimo.pdf", f, "application/pdf")})
    assert r.status_code == 401


def test_listagem_publica_nao_vaza_documento(client, cria_usuario, sobe_documento):
    """O bug original: GET /api/documents sem token listava tudo de todo mundo."""
    headers, _ = cria_usuario("Dono", "dono-vazamento@echo.test")
    sobe_documento(headers)

    client.cookies.clear()
    r = client.get("/api/documents")
    assert r.status_code == 401
    assert "documents" not in r.text


# --- 2. A não enxerga nem apaga o de B -------------------------------------

@pytest.fixture()
def dois_usuarios(cria_usuario, sobe_documento):
    a, _ = cria_usuario("Alice", "alice@echo.test")
    b, _ = cria_usuario("Bruno", "bruno@echo.test")
    doc_a = sobe_documento(a, "alice.pdf")
    doc_b = sobe_documento(b, "bruno.pdf")
    return {"a": a, "b": b, "doc_a": doc_a, "doc_b": doc_b}


def test_a_ve_apenas_o_proprio_documento(client, dois_usuarios):
    r = client.get("/api/documents", headers=dois_usuarios["a"])
    assert r.status_code == 200
    ids = [d["id"] for d in r.json()["documents"]]
    assert ids == [dois_usuarios["doc_a"]]


def test_b_ve_apenas_o_proprio_documento(client, dois_usuarios):
    r = client.get("/api/documents", headers=dois_usuarios["b"])
    ids = [d["id"] for d in r.json()["documents"]]
    assert ids == [dois_usuarios["doc_b"]]


def test_documento_do_outro_devolve_404_e_nao_403(client, dois_usuarios):
    """404 de propósito: 403 confirmaria que aquele id existe."""
    doc_b = dois_usuarios["doc_b"]
    for metodo, rota in [
        ("get", f"/api/documents/{doc_b}"),
        ("get", f"/api/documents/{doc_b}/toc"),
        ("get", f"/api/documents/{doc_b}/search?q=echo"),
        ("get", f"/api/documents/{doc_b}/pdf"),
        ("get", f"/api/documents/{doc_b}/pages/1.png"),
        ("get", f"/api/documents/{doc_b}/pages/1/words"),
        ("get", f"/api/documents/{doc_b}/chunks/0/text"),
        ("post", f"/api/documents/{doc_b}/chunks/0/audio"),
        ("get", f"/api/covers/{doc_b}.png"),
        ("put", f"/api/documents/{doc_b}/progress?current_chunk=3"),
    ]:
        r = getattr(client, metodo)(rota, headers=dois_usuarios["a"])
        assert r.status_code == 404, f"{metodo.upper()} {rota} devolveu {r.status_code}"


def test_a_nao_apaga_documento_de_b(client, dois_usuarios):
    doc_b = dois_usuarios["doc_b"]
    r = client.delete(f"/api/documents/{doc_b}", headers=dois_usuarios["a"])
    assert r.status_code == 404

    # e o documento de B continua inteiro
    r = client.get(f"/api/documents/{doc_b}", headers=dois_usuarios["b"])
    assert r.status_code == 200
    assert r.json()["document"]["id"] == doc_b


def test_a_apaga_o_proprio_documento(client, dois_usuarios):
    doc_a = dois_usuarios["doc_a"]
    r = client.delete(f"/api/documents/{doc_a}", headers=dois_usuarios["a"])
    assert r.status_code == 200
    r = client.get(f"/api/documents/{doc_a}", headers=dois_usuarios["a"])
    assert r.status_code == 404


# --- 3. Progresso é por pessoa ---------------------------------------------

def test_progresso_de_a_nao_vaza_para_b(client, cria_usuario, sobe_documento):
    a, _ = cria_usuario("Ana", "ana@echo.test")
    b, _ = cria_usuario("Beto", "beto@echo.test")
    doc_a = sobe_documento(a, "ana.pdf")
    doc_b = sobe_documento(b, "beto.pdf")

    assert client.put(f"/api/documents/{doc_a}/progress?current_chunk=7", headers=a).status_code == 200
    assert client.put(f"/api/documents/{doc_b}/progress?current_chunk=2", headers=b).status_code == 200

    assert client.get(f"/api/documents/{doc_a}", headers=a).json()["progress"]["current_chunk"] == 7
    assert client.get(f"/api/documents/{doc_b}", headers=b).json()["progress"]["current_chunk"] == 2

    # B não consegue mexer no progresso do documento de A
    assert client.put(f"/api/documents/{doc_a}/progress?current_chunk=99", headers=b).status_code == 404
    assert client.get(f"/api/documents/{doc_a}", headers=a).json()["progress"]["current_chunk"] == 7


# --- 4. Áudio (o arquivo servido por nome) ---------------------------------

def test_audio_de_outro_dono_devolve_404(client, cria_usuario, sobe_documento):
    from src.database import get_chunks

    a, _ = cria_usuario("Aud A", "auda@echo.test")
    b, _ = cria_usuario("Aud B", "audb@echo.test")
    doc_a = sobe_documento(a, "audio-a.pdf")

    chunk_id = get_chunks(doc_a)[0]["id"]
    nome = f"{chunk_id}_0123456789ab.mp3"

    # B sabe o nome do arquivo e mesmo assim não recebe
    assert client.get(f"/api/audio/{nome}", headers=b).status_code == 404
    # sem sessão nenhuma, também não
    client.cookies.clear()
    assert client.get(f"/api/audio/{nome}").status_code == 401


def test_audio_com_nome_fora_do_padrao_nao_sai_do_diretorio(client, cria_usuario):
    a, _ = cria_usuario("Trav", "trav@echo.test")
    for nome in ["..", "echo.db", "aaaaaaaa_bbbbbbbbbbbb.txt", "....mp3"]:
        r = client.get(f"/api/audio/{nome}", headers=a)
        assert r.status_code == 404, f"{nome} devolveu {r.status_code}"


# --- 5. Cookie autentica a mídia (é o caminho da web) ----------------------

def test_cookie_autentica_capa_e_pdf(client, cria_usuario, sobe_documento):
    """<img>/<audio>/PDF.js não mandam header — quem os autentica é o cookie."""
    headers, dados = cria_usuario("Cookie", "cookie@echo.test")
    doc = sobe_documento(headers, "cookie.pdf")

    # sessão só por cookie (sem Authorization), como o navegador faz
    client.cookies.clear()
    r = client.post("/api/auth/login", json={"email": dados["email"], "password": "senha123"})
    assert r.status_code == 200
    assert "echo_session" in r.cookies or "echo_session" in client.cookies

    r = client.get(f"/api/documents/{doc}/pdf")
    assert r.status_code == 200
    assert r.headers["cache-control"].startswith("private")

    r = client.get(f"/api/covers/{doc}.png")
    assert r.status_code in (200, 404)  # 404 só se o PDF não gerou capa
    assert r.status_code != 401

    r = client.get(f"/api/documents/{doc}/pages/1.png")
    assert r.status_code == 200
    assert "private" in r.headers["cache-control"]


def test_session_cookie_reemite_a_partir_do_bearer(client, cria_usuario):
    headers, _ = cria_usuario("Recookie", "recookie@echo.test")
    client.cookies.clear()
    r = client.post("/api/auth/session-cookie", headers=headers)
    assert r.status_code == 200
    assert client.cookies.get("echo_session")

    client.cookies.clear()
    assert client.post("/api/auth/session-cookie").status_code == 401


# --- 6. Upload não escreve fora da pasta -----------------------------------

def test_upload_com_nome_malicioso_fica_na_pasta(client, cria_usuario, tmp_raiz):
    from conftest import pdf_de_teste
    from src.database import get_document_for_user

    headers, dados = cria_usuario("Path", "path@echo.test")
    caminho = pdf_de_teste(tmp_raiz / "malicioso.pdf")
    with open(caminho, "rb") as f:
        r = client.post(
            "/api/documents",
            headers=headers,
            files={"file": ("../../../../tmp/invasao.pdf", f, "application/pdf")},
        )
    assert r.status_code == 200
    doc_id = r.json()["id"]

    import os
    from src.database import get_db

    conn = get_db()
    dono = conn.execute("SELECT user_id FROM documents WHERE id = ?", (doc_id,)).fetchone()[0]
    filename = conn.execute("SELECT filename FROM documents WHERE id = ?", (doc_id,)).fetchone()[0]
    conn.close()

    assert dono  # documento nasce com dono
    assert "/" not in filename and "\\" not in filename and ".." not in filename
    assert os.path.exists(os.path.join(os.environ["UPLOAD_DIR"], filename))


# --- 7. Migração do banco antigo -------------------------------------------

def test_migracao_adota_orfaos_e_preserva_progresso(tmp_path, monkeypatch):
    """Reproduz o banco de produção (sem user_id) e roda init_db em cima."""
    import importlib

    banco = tmp_path / "antigo.db"
    conn = sqlite3.connect(banco)
    conn.executescript("""
        CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')));
        CREATE TABLE sessions (token TEXT PRIMARY KEY, user_id TEXT NOT NULL,
            created_at TEXT DEFAULT (datetime('now')));
        CREATE TABLE documents (id TEXT PRIMARY KEY, title TEXT NOT NULL, filename TEXT NOT NULL,
            total_pages INTEGER DEFAULT 0, total_chunks INTEGER DEFAULT 0, file_size INTEGER DEFAULT 0,
            cover_color TEXT DEFAULT '#003083', created_at TEXT DEFAULT (datetime('now')),
            updated_at TEXT DEFAULT (datetime('now')));
        CREATE TABLE chunks (id TEXT PRIMARY KEY, document_id TEXT NOT NULL, chunk_index INTEGER NOT NULL,
            page_number INTEGER DEFAULT 0, text_content TEXT NOT NULL, audio_path TEXT,
            duration_ms INTEGER DEFAULT 0);
        CREATE TABLE reading_progress (document_id TEXT PRIMARY KEY, current_chunk INTEGER DEFAULT 0,
            position_ms INTEGER DEFAULT 0, last_read_at TEXT DEFAULT (datetime('now')));

        INSERT INTO users (id,name,email,password_hash,created_at)
            VALUES ('e66f18a3','Marcelo','marcelo@echo.test','x:y','2026-04-15 14:50:39');
        INSERT INTO users (id,name,email,password_hash,created_at)
            VALUES ('zz999999','Depois','depois@echo.test','x:y','2026-08-01 10:00:00');
        INSERT INTO documents (id,title,filename) VALUES ('90600c57','Essencialismo','ess.pdf');
        INSERT INTO documents (id,title,filename) VALUES ('83271e2a','Como Fazer Amigos','amigos.pdf');
        INSERT INTO reading_progress (document_id,current_chunk,position_ms) VALUES ('90600c57',24,0);
        INSERT INTO reading_progress (document_id,current_chunk,position_ms) VALUES ('83271e2a',34,0);
    """)
    conn.commit()
    conn.close()

    monkeypatch.setenv("DB_PATH", str(banco))
    import src.database as db

    importlib.reload(db)
    db.init_db()
    db.init_db()  # idempotente: rodar duas vezes não pode quebrar nem duplicar

    conn = sqlite3.connect(banco)
    conn.row_factory = sqlite3.Row
    docs = {r["id"]: r["user_id"] for r in conn.execute("SELECT id, user_id FROM documents")}
    prog = {(r["user_id"], r["document_id"]): r["current_chunk"]
            for r in conn.execute("SELECT * FROM reading_progress")}
    conn.close()

    # órfãos vão para o usuário mais antigo — não somem nem são apagados
    assert docs == {"90600c57": "e66f18a3", "83271e2a": "e66f18a3"}
    # progresso preservado, agora com dono
    assert prog == {("e66f18a3", "90600c57"): 24, ("e66f18a3", "83271e2a"): 34}

    importlib.reload(db)  # devolve o módulo ao banco dos outros testes


def test_admin_desligado_sem_env(client):
    """A chave fixa saiu do código: sem ECHO_ADMIN_KEY o endpoint não existe."""
    r = client.post("/api/admin", json={"admin_key": "echo-admin-2026", "action": "list_users"})
    assert r.status_code == 404


# --- 8. Cadastro não é porta dos fundos ------------------------------------

def test_cadastro_com_email_existente_nao_toma_a_conta(client, cria_usuario, sobe_documento):
    """Registrar de novo com o e-mail de alguém trocava a senha e entrava na conta."""
    headers, dados = cria_usuario("Vitima", "vitima@echo.test")
    doc = sobe_documento(headers, "vitima.pdf")

    client.cookies.clear()
    r = client.post("/api/auth/register", json={
        "name": "Invasor", "email": dados["email"], "password": "outrasenha123",
    })
    assert r.status_code == 409
    assert "token" not in r.json()

    # a senha original continua valendo
    assert client.post("/api/auth/login", json={
        "email": dados["email"], "password": "senha123",
    }).status_code == 200
    # e a senha do invasor não vale
    client.cookies.clear()
    assert client.post("/api/auth/login", json={
        "email": dados["email"], "password": "outrasenha123",
    }).status_code == 401
    # documento segue com a vítima
    assert client.get(f"/api/documents/{doc}", headers=headers).status_code == 200
