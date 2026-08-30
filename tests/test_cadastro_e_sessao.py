"""Portão do cadastro e prazo da sessão.

Dois riscos que o dono mandou fechar: qualquer pessoa abria conta (e gastava
disco e CPU com upload e TTS), e sessão nenhuma vencia — token vazado valia
para sempre.
"""

from src.database import get_db


# --- 1. Cadastro por variável de ambiente --------------------------------

def _cadastrar(client, email, codigo=None):
    corpo = {"name": "Fulano", "email": email, "password": "senha123"}
    if codigo is not None:
        corpo["codigo"] = codigo
    client.cookies.clear()
    return client.post("/api/auth/register", json=corpo)


def test_sem_env_o_cadastro_esta_fechado(client, monkeypatch):
    """Sem ECHO_CADASTRO definida, produção recusa conta nova."""
    monkeypatch.delenv("ECHO_CADASTRO", raising=False)
    r = _cadastrar(client, "intruso-1@echo.test")
    assert r.status_code == 403
    assert "fechado" in r.json()["detail"].lower()
    assert "token" not in r.json()


def test_modo_fechado_explicito(client, monkeypatch):
    monkeypatch.setenv("ECHO_CADASTRO", "fechado")
    assert _cadastrar(client, "intruso-2@echo.test").status_code == 403


def test_modo_aberto_deixa_criar(client, monkeypatch):
    monkeypatch.setenv("ECHO_CADASTRO", "aberto")
    r = _cadastrar(client, "convidada-aberta@echo.test")
    assert r.status_code == 200 and r.json()["token"]


def test_modo_convite_exige_o_codigo(client, monkeypatch):
    monkeypatch.setenv("ECHO_CADASTRO", "convite")
    monkeypatch.setenv("ECHO_CONVITE_CODIGO", "abre-te-sesamo")

    assert _cadastrar(client, "sem-codigo@echo.test").status_code == 403
    assert _cadastrar(client, "codigo-errado@echo.test", codigo="chute").status_code == 403

    r = _cadastrar(client, "com-codigo@echo.test", codigo="abre-te-sesamo")
    assert r.status_code == 200 and r.json()["token"]


def test_modo_convite_sem_codigo_configurado_nao_libera(client, monkeypatch):
    """Modo convite com a env do código vazia não pode virar cadastro aberto."""
    monkeypatch.setenv("ECHO_CADASTRO", "convite")
    monkeypatch.delenv("ECHO_CONVITE_CODIGO", raising=False)
    assert _cadastrar(client, "sem-config@echo.test", codigo="").status_code == 403


def test_valor_desconhecido_cai_no_fechado(client, monkeypatch):
    monkeypatch.setenv("ECHO_CADASTRO", "talvez")
    assert _cadastrar(client, "valor-torto@echo.test").status_code == 403


def test_status_do_cadastro_e_publico_e_diz_o_modo(client, monkeypatch):
    monkeypatch.setenv("ECHO_CADASTRO", "fechado")
    client.cookies.clear()
    d = client.get("/api/auth/cadastro-status").json()
    assert d["modo"] == "fechado" and d["aberto"] is False and d["mensagem"]

    monkeypatch.setenv("ECHO_CADASTRO", "convite")
    d = client.get("/api/auth/cadastro-status").json()
    assert d["exige_codigo"] is True and d["aberto"] is True


def test_quem_ja_tem_conta_continua_entrando_com_cadastro_fechado(client, cria_usuario, monkeypatch):
    """🚨 Fechar o cadastro não pode trancar ninguém para fora."""
    monkeypatch.setenv("ECHO_CADASTRO", "aberto")
    _, dados = cria_usuario("Dona da casa", "dona@echo.test")

    monkeypatch.setenv("ECHO_CADASTRO", "fechado")
    client.cookies.clear()
    r = client.post("/api/auth/login", json={"email": dados["email"], "password": "senha123"})
    assert r.status_code == 200 and r.json()["token"]


# --- 2. Sessão com prazo -------------------------------------------------

def _expira_em(token):
    conn = get_db()
    row = conn.execute("SELECT expires_at FROM sessions WHERE token = ?", (token,)).fetchone()
    conn.close()
    return row["expires_at"] if row else None


def _forcar_prazo(token, expressao):
    conn = get_db()
    conn.execute(
        "UPDATE sessions SET expires_at = datetime('now', ?) WHERE token = ?",
        (expressao, token),
    )
    conn.commit()
    conn.close()


def test_sessao_nasce_com_prazo(client, cria_usuario):
    headers, _ = cria_usuario("Prazo", "prazo@echo.test")
    token = headers["Authorization"].split()[1]
    assert _expira_em(token) is not None


def test_sessao_vencida_devolve_401_e_apaga_o_cookie(client, cria_usuario, sobe_documento):
    headers, _ = cria_usuario("Vencida", "vencida@echo.test")
    token = headers["Authorization"].split()[1]
    doc = sobe_documento(headers, "vencida.pdf")

    _forcar_prazo(token, "-1 second")

    r = client.get("/api/documents", headers=headers)
    assert r.status_code == 401
    # 🚨 O cookie tem de morrer junto, senão o navegador segue mandando uma
    # credencial que o servidor recusa e a tela não sabe explicar.
    assert "echo_session=;" in r.headers.get("set-cookie", "")
    assert client.get(f"/api/documents/{doc}", headers=headers).status_code == 401
    # e a linha morta sai do banco
    assert _expira_em(token) is None


def test_uso_renova_o_prazo(client, cria_usuario):
    headers, _ = cria_usuario("Renova", "renova@echo.test")
    token = headers["Authorization"].split()[1]

    _forcar_prazo(token, "+2 days")          # como se faltassem 2 dias
    antes = _expira_em(token)

    assert client.get("/api/auth/me", headers=headers).status_code == 200

    depois = _expira_em(token)
    assert depois > antes, f"prazo nao deslizou: {antes} -> {depois}"


def test_sessao_recente_nao_reescreve_toda_hora(client, cria_usuario):
    """Renovar é barato, mas não a cada request: no máximo uma escrita por dia."""
    headers, _ = cria_usuario("Barato", "barato@echo.test")
    token = headers["Authorization"].split()[1]
    antes = _expira_em(token)
    client.get("/api/auth/me", headers=headers)
    assert _expira_em(token) == antes


def test_logout_continua_matando_a_sessao(client, cria_usuario):
    headers, _ = cria_usuario("Saida", "saida@echo.test")
    token = headers["Authorization"].split()[1]
    assert client.post("/api/auth/logout", headers=headers).status_code == 200
    assert _expira_em(token) is None
    client.cookies.clear()
    assert client.get("/api/documents", headers=headers).status_code == 401


def test_migracao_da_prazo_as_sessoes_antigas_a_partir_de_agora(tmp_path, monkeypatch):
    """Reproduz o banco de produção: sessões velhas, sem coluna de prazo."""
    import importlib
    import sqlite3

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
        INSERT INTO sessions (token,user_id,created_at) VALUES ('token-velho','e66f18a3','2026-04-15 15:00:00');
        INSERT INTO sessions (token,user_id,created_at) VALUES ('token-velho-2','e66f18a3','2026-05-01 03:00:00');
    """)
    conn.commit()
    conn.close()

    monkeypatch.setenv("DB_PATH", str(banco))
    import src.database as db
    importlib.reload(db)
    db.init_db()
    db.init_db()  # idempotente

    conn = sqlite3.connect(banco)
    conn.row_factory = sqlite3.Row
    linhas = conn.execute("SELECT token, expires_at > datetime('now') AS viva FROM sessions").fetchall()
    conn.close()

    # As duas sobreviveram: prazo contado de AGORA. Ninguém é deslogado no
    # deploy — se contasse do created_at, estas de abril/maio morreriam na hora.
    assert len(linhas) == 2
    assert all(linha["viva"] == 1 for linha in linhas)

    importlib.reload(db)  # devolve o módulo ao banco dos outros testes
