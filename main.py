"""Echo — Seus documentos ganham voz.

Upload de PDFs → extração de texto → TTS com Microsoft Edge (AntonioNeural).

SEGURANÇA — toda rota de documento exige sessão e filtra pelo dono.
Documento de outra pessoa responde 404 (e não 403) de propósito: 403 confirma
que aquele id existe, o que já é vazamento de informação.
"""

import os
import re
import glob
import uuid
import shutil
import asyncio
import logging
from pathlib import Path

from fastapi import FastAPI, UploadFile, File, HTTPException, Query, Request, Response
from fastapi.responses import FileResponse, StreamingResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.gzip import GZipMiddleware
from pydantic import BaseModel

from src.database import init_db, create_document, list_documents, get_document_for_user, delete_document
from src.database import count_documents_with_filename, get_chunk_owner
from src.database import save_chunk, get_chunks, get_chunk, update_chunk_audio, update_progress, get_progress
from src.database import create_user, create_or_update_user, authenticate_user, create_session, get_user_by_session, delete_session, reset_user_password, list_users
from src.database import get_user_voice, set_user_voice
from src.pdf_parser import extract_text_from_pdf, chunk_pages, get_pdf_info, extract_cover, render_page, get_toc, get_word_positions_on_page

# Logging
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(name)s] %(levelname)s: %(message)s")
logger = logging.getLogger("echo")

PAGES_DIR = os.environ.get("PAGES_DIR", "/app/data/pages")

COVERS_DIR = os.environ.get("COVERS_DIR", "/app/data/covers")
from src.tts_service import generate_audio, generate_audio_stream, list_voices, voz_valida, NOMES_VALIDOS

UPLOAD_DIR = os.environ.get("UPLOAD_DIR", "/app/data/uploads")
AUDIO_DIR = os.environ.get("AUDIO_DIR", "/app/data/audio")

app = FastAPI(title="Echo", version="1.0.0", docs_url="/api/docs")
app.add_middleware(GZipMiddleware, minimum_size=500)

# Servir arquivos estáticos (fontes, JS, CSS)
app.mount("/static", StaticFiles(directory="static"), name="static")


@app.on_event("startup")
async def startup():
    os.makedirs(UPLOAD_DIR, exist_ok=True)
    os.makedirs(AUDIO_DIR, exist_ok=True)
    os.makedirs(COVERS_DIR, exist_ok=True)
    os.makedirs(PAGES_DIR, exist_ok=True)
    init_db()


# --- Helpers ---

def _extract_token(request: Request) -> tuple[str | None, str]:
    """Extrai token de Authorization header ou cookie. Retorna (token, source)."""
    auth = request.headers.get("authorization", "")
    if auth.startswith("Bearer "):
        return auth[7:].strip(), "header"
    cookie = request.cookies.get("echo_session")
    if cookie:
        return cookie, "cookie"
    return None, "none"


def get_current_user(request: Request) -> dict | None:
    """Resolve sessão via Bearer token (prioridade) ou cookie (fallback)."""
    token, source = _extract_token(request)
    if not token:
        return None
    user = get_user_by_session(token)
    if not user:
        logger.warning("AUTH %s — token inválido via %s (token=%s...)",
                        request.url.path, source, token[:8])
        return None
    return user


def require_auth(request: Request) -> dict:
    user = get_current_user(request)
    if not user:
        raise HTTPException(401, "Não autenticado")
    return user


def voz_do_usuario(user: dict, pedida: str = "") -> str:
    """Voz a usar: a pedida na chamada, senão a salva na conta, senão a padrão.

    Um lugar só decide isso — se cada rota resolvesse por conta própria, uma
    delas acabaria gerando áudio na voz errada, e o cache guardaria o engano.
    """
    if pedida:
        return voz_valida(pedida)
    return voz_valida(user.get("voice"))


def require_doc(request: Request, doc_id: str) -> tuple[dict, dict]:
    """Exige sessão E propriedade do documento. Retorna (usuário, documento).

    Documento inexistente e documento de outro dono devolvem a MESMA resposta
    (404): se o de outro dono devolvesse 403, dava para varrer ids e descobrir
    quais existem.
    """
    user = require_auth(request)
    doc = get_document_for_user(doc_id, user["id"])
    if not doc:
        raise HTTPException(404, "Documento não encontrado")
    return user, doc


# --- Páginas (sem redirects server-side — JS controla auth) ---
# Headers anti-cache para Cloudflare não cachear HTML dinâmico
_NO_CACHE = {"Cache-Control": "no-cache, no-store, must-revalidate", "Pragma": "no-cache"}

# Mídia autenticada (capa, página PNG, MP3, PDF) — a resposta agora depende de
# QUEM pediu, então nenhuma camada intermediária pode guardar e reentregar.
# Sem isto a Cloudflare cachearia /api/covers/*.png e /pages/*.png pela extensão
# e serviria a capa de um usuário para outro, com a rota já protegida.
_MEDIA_PRIVADA = {"Cache-Control": "private, no-store, max-age=0", "Pragma": "no-cache"}


@app.get("/", response_class=HTMLResponse)
async def landing():
    return FileResponse("static/landing.html", headers=_NO_CACHE)


@app.get("/app", response_class=HTMLResponse)
async def app_page():
    return FileResponse("static/index.html", headers=_NO_CACHE)


@app.get("/login", response_class=HTMLResponse)
async def login_page():
    return FileResponse("static/login.html", headers=_NO_CACHE)


@app.get("/register", response_class=HTMLResponse)
async def register_page():
    return FileResponse("static/register.html", headers=_NO_CACHE)


# --- Health ---

@app.get("/api/health")
async def health():
    return {"status": "ok", "service": "echo", "voice": os.environ.get("TTS_VOICE", "pt-BR-AntonioNeural")}


# =========================================================================
# COMO A MÍDIA SE AUTENTICA  (decisão de projeto — ler antes de mexer)
#
# <img>, <audio> e o PDF.js NÃO conseguem mandar header Authorization: quem
# faz a requisição é o próprio navegador, e src de mídia não aceita header.
# Exigir Bearer nestas rotas quebraria capa, páginas, áudio e PDF de uma vez.
#
# Caminho escolhido: o COOKIE httponly echo_session, que o login já emite.
# Requisição de mesma origem carrega o cookie sozinha — inclusive de dentro de
# <img>/<audio>/PDF.js — então a web funciona sem mudar uma linha de markup, e
# get_current_user já aceita cookie como fonte de sessão.
#
# Por que não URL assinada com expiração: seria um segundo tipo de credencial
# para emitir, expirar e revogar, e ainda assim colocaria um token de acesso
# dentro da URL — que vaza em log de acesso, histórico do navegador, Referer e
# chave de cache de CDN. O cookie httponly não é legível por JS (nem num XSS)
# e não aparece em lugar nenhum disso.
#
# No app mobile não há cookie: lá o Bearer vai por header, porque expo-image e
# react-native-track-player aceitam headers no source/track (ver mobile/src/lib/api.ts).
# =========================================================================


# --- Servir PDF original (para PDF.js client-side) ---

@app.get("/api/documents/{doc_id}/pdf")
async def serve_pdf(doc_id: str, request: Request):
    """Serve o PDF original para renderizacao client-side via PDF.js."""
    _, doc = require_doc(request, doc_id)
    pdf_path = os.path.join(UPLOAD_DIR, doc["filename"])
    if not os.path.exists(pdf_path):
        raise HTTPException(404, "PDF não encontrado")
    return FileResponse(pdf_path, media_type="application/pdf", headers=_MEDIA_PRIVADA)


# --- Busca dentro do documento ---

@app.get("/api/documents/{doc_id}/search")
async def search_document(doc_id: str, request: Request, q: str = Query(..., min_length=2)):
    """Busca texto em todos os chunks do documento."""
    require_doc(request, doc_id)
    chunks = get_chunks(doc_id)
    query = q.lower()
    results = []
    for c in chunks:
        text = c["text_content"]
        lower_text = text.lower()
        idx = lower_text.find(query)
        if idx >= 0:
            # Extrair contexto ao redor
            start = max(0, idx - 40)
            end = min(len(text), idx + len(query) + 40)
            snippet = text[start:end].strip()
            if start > 0:
                snippet = "..." + snippet
            if end < len(text):
                snippet = snippet + "..."
            results.append({
                "chunk_index": c["chunk_index"],
                "page": c["page_number"],
                "snippet": snippet,
                "position": idx,
            })
    return {"results": results, "total": len(results), "query": q}


# --- Covers ---

@app.get("/api/covers/{doc_id}.png")
async def serve_cover(doc_id: str, request: Request):
    require_doc(request, doc_id)
    filepath = os.path.join(COVERS_DIR, f"{doc_id}.png")
    if not os.path.exists(filepath):
        raise HTTPException(404, "Capa não encontrada")
    return FileResponse(filepath, media_type="image/png", headers=_MEDIA_PRIVADA)


@app.get("/api/documents/{doc_id}/pages/{page_num}.png")
async def serve_page(doc_id: str, page_num: int, request: Request):
    """Renderiza e serve uma página do PDF como PNG (com cache)."""
    _, doc = require_doc(request, doc_id)

    # Cache por doc_id + page
    page_dir = os.path.join(PAGES_DIR, doc_id)
    os.makedirs(page_dir, exist_ok=True)
    page_path = os.path.join(page_dir, f"{page_num}.png")

    if not os.path.exists(page_path):
        pdf_path = os.path.join(UPLOAD_DIR, doc["filename"])
        if not os.path.exists(pdf_path):
            raise HTTPException(404, "PDF não encontrado")
        ok = render_page(pdf_path, page_num, page_path)
        if not ok:
            raise HTTPException(404, "Página inválida")

    return FileResponse(page_path, media_type="image/png", headers=_MEDIA_PRIVADA)


# --- TOC ---

@app.get("/api/documents/{doc_id}/toc")
async def get_document_toc(doc_id: str, request: Request):
    """Retorna Table of Contents do PDF."""
    _, doc = require_doc(request, doc_id)
    pdf_path = os.path.join(UPLOAD_DIR, doc["filename"])
    if not os.path.exists(pdf_path):
        return {"toc": []}
    toc = get_toc(pdf_path)
    return {"toc": toc, "total_pages": doc["total_pages"]}


# --- Word positions (para highlight no PDF) ---

@app.get("/api/documents/{doc_id}/pages/{page_num}/words")
async def get_page_words(doc_id: str, page_num: int, request: Request):
    """Retorna todas as palavras da página com posições relativas (0-1)."""
    _, doc = require_doc(request, doc_id)
    pdf_path = os.path.join(UPLOAD_DIR, doc["filename"])
    if not os.path.exists(pdf_path):
        return {"words": []}
    words = get_word_positions_on_page(pdf_path, page_num)
    return {"words": words, "page": page_num}


# --- Auth ---

class RegisterRequest(BaseModel):
    name: str
    email: str
    password: str


class LoginRequest(BaseModel):
    email: str
    password: str


def _set_session_cookie(request: Request, response: Response, token: str):
    """Cookie de sessão — é ele que autentica <img>, <audio> e o PDF.js.

    Secure só quando a requisição chegou por https: em desenvolvimento (http)
    um cookie Secure simplesmente não seria guardado pelo navegador.
    """
    response.set_cookie(
        "echo_session", token,
        httponly=True, samesite="lax", path="/",
        secure=request.url.scheme == "https",
        max_age=30 * 24 * 3600,
    )


@app.post("/api/auth/register")
async def register(body: RegisterRequest, request: Request, response: Response):
    if len(body.password) < 6:
        raise HTTPException(400, "Senha deve ter pelo menos 6 caracteres")
    if not body.name.strip():
        raise HTTPException(400, "Nome é obrigatório")

    # Cadastro NÃO sobrescreve conta existente. Antes chamava
    # create_or_update_user: quem soubesse o e-mail de alguém "se cadastrava"
    # de novo, trocava a senha da vítima e entrava na conta dela — o que
    # anularia qualquer separação por dono feita aqui.
    user_id = create_user(body.name.strip(), body.email, body.password)
    if not user_id:
        raise HTTPException(409, "Este email já tem conta. Faça login.")
    token = create_session(user_id)
    _set_session_cookie(request, response, token)
    logger.info("REGISTER %s user=%s token=%s...", body.email, user_id, token[:8])
    return {"ok": True, "name": body.name.strip(), "new_user": True, "token": token}


@app.post("/api/auth/login")
async def login(body: LoginRequest, request: Request, response: Response):
    logger.info("LOGIN %s", body.email)
    user = authenticate_user(body.email, body.password)
    if not user:
        raise HTTPException(401, "Email ou senha incorretos")

    token = create_session(user["id"])
    _set_session_cookie(request, response, token)
    logger.info("LOGIN OK %s token=%s...", body.email, token[:8])
    return {"ok": True, "name": user["name"], "token": token}


@app.post("/api/auth/session-cookie")
async def refresh_session_cookie(request: Request, response: Response):
    """Reemite o cookie da sessão que o Bearer já provou ser válida.

    Quem logou antes desta correção tem o token no localStorage mas pode estar
    sem o cookie (expirado ou nunca gravado). Como agora é o cookie que
    autentica a mídia, o app chama isto no boot e a capa/áudio voltam a
    carregar sem obrigar ninguém a deslogar.
    """
    user = require_auth(request)
    token, _ = _extract_token(request)
    _set_session_cookie(request, response, token)
    return {"ok": True, "name": user["name"]}


@app.get("/api/auth/me")
async def me(request: Request):
    user = get_current_user(request)
    if not user:
        raise HTTPException(401, "Não autenticado")
    return {"id": user["id"], "name": user["name"], "email": user["email"],
            "voice": voz_do_usuario(user)}


@app.post("/api/auth/logout")
async def logout(request: Request, response: Response):
    token, source = _extract_token(request)
    if token:
        delete_session(token)
    response.delete_cookie("echo_session", path="/")
    logger.info("LOGOUT via %s", source)
    return {"ok": True}


class AdminRequest(BaseModel):
    admin_key: str
    action: str = "status"  # status | reset_password | list_users
    email: str = ""
    new_password: str = ""


@app.post("/api/admin")
async def admin_endpoint(body: AdminRequest):
    """Endpoint admin para debug e manutenção.

    A chave sai da env ECHO_ADMIN_KEY. Sem a env o endpoint fica desligado —
    antes havia uma chave fixa no código-fonte, e quem lesse o repositório
    trocava a senha de qualquer usuário.
    """
    admin_key = os.environ.get("ECHO_ADMIN_KEY", "")
    if not admin_key:
        logger.warning("ADMIN chamado com ECHO_ADMIN_KEY ausente — endpoint desligado")
        raise HTTPException(404, "Não encontrado")
    if not secrets_compare(body.admin_key, admin_key):
        raise HTTPException(403, "Acesso negado")

    if body.action == "list_users":
        users = list_users()
        logger.info("Admin: list_users — %d usuários", len(users))
        return {"users": users, "total": len(users)}

    if body.action == "reset_password":
        if not body.email or len(body.new_password) < 6:
            raise HTTPException(400, "Email e senha (min 6 chars) obrigatórios")
        ok = reset_user_password(body.email, body.new_password)
        if not ok:
            raise HTTPException(404, "Usuário não encontrado")
        logger.info("Admin: senha resetada para %s", body.email)
        return {"ok": True, "message": "Senha atualizada"}

    # Default: status
    from src.database import DB_PATH
    db_exists = os.path.exists(DB_PATH)
    db_size = os.path.getsize(DB_PATH) if db_exists else 0
    users = list_users()
    return {
        "status": "ok",
        "db_path": DB_PATH,
        "db_exists": db_exists,
        "db_size_kb": round(db_size / 1024, 1),
        "total_users": len(users),
        "users": [{"id": u["id"], "email": u["email"]} for u in users],
    }


def secrets_compare(a: str, b: str) -> bool:
    """Comparação em tempo constante (não vaza o prefixo certo pelo tempo)."""
    import hmac
    return hmac.compare_digest(a or "", b or "")


# --- Upload PDF ---

def _nome_seguro_em_disco(nome_original: str) -> str:
    """Nome de arquivo gerado pelo servidor, nunca o enviado pelo cliente.

    Dois motivos: (1) o nome vinha do multipart e ia direto para os.path.join —
    um "../../algo.pdf" escreveria fora de UPLOAD_DIR; (2) duas pessoas
    subindo "livro.pdf" gravavam por cima uma da outra, e apagar o documento
    de uma apagava o PDF da outra.
    """
    sufixo = Path(nome_original or "").suffix.lower()
    if sufixo != ".pdf":
        sufixo = ".pdf"
    return f"{uuid.uuid4().hex}{sufixo}"


@app.post("/api/documents")
async def upload_document(request: Request, file: UploadFile = File(...)):
    user = require_auth(request)

    if not file.filename or not file.filename.lower().endswith(".pdf"):
        raise HTTPException(400, "Apenas arquivos PDF são aceitos")

    if file.size and file.size > 100 * 1024 * 1024:
        raise HTTPException(400, "Arquivo muito grande (máx. 100MB)")

    # Salvar PDF com nome gerado pelo servidor
    os.makedirs(UPLOAD_DIR, exist_ok=True)
    stored_name = _nome_seguro_em_disco(file.filename)
    file_path = os.path.join(UPLOAD_DIR, stored_name)
    with open(file_path, "wb") as f:
        content = await file.read()
        f.write(content)

    # Extrair metadados e texto
    try:
        info = get_pdf_info(file_path)
        pages = extract_text_from_pdf(file_path)
        chunks = chunk_pages(pages)
    except Exception as e:
        os.remove(file_path)
        raise HTTPException(400, f"Erro ao processar PDF: {str(e)}")

    if not chunks:
        os.remove(file_path)
        raise HTTPException(400, "PDF não contém texto extraível")

    # Título continua vindo do nome enviado (só como texto, nunca como caminho)
    nome_exibicao = Path(file.filename).name
    title = info["title"] if info["title"] else Path(nome_exibicao).stem.replace("_", " ").replace("-", " ").title()
    doc_id = create_document(
        user_id=user["id"],
        title=title,
        filename=stored_name,
        total_pages=info["total_pages"],
        total_chunks=len(chunks),
        file_size=len(content),
    )

    for c in chunks:
        save_chunk(doc_id, c["chunk_index"], c["page_number"], c["text"])

    # Extrair capa (primeira página como PNG)
    cover_path = os.path.join(COVERS_DIR, f"{doc_id}.png")
    has_cover = extract_cover(file_path, cover_path)
    logger.info("UPLOAD %s — user=%s cover=%s path=%s", doc_id, user["id"], has_cover, cover_path)

    # Pré-gerar áudio de TODOS os chunks em background, na voz do dono
    asyncio.create_task(_pregenerate_all_audio(doc_id, voz_do_usuario(user)))

    return {
        "id": doc_id,
        "title": title,
        "total_pages": info["total_pages"],
        "total_chunks": len(chunks),
        "file_size": len(content),
        "has_cover": has_cover,
    }


async def _pregenerate_all_audio(doc_id: str, voice: str = ""):
    """Pré-gera áudio de todos os chunks em background, na voz escolhida."""
    chunks = get_chunks(doc_id)
    for chunk in chunks:
        try:
            await generate_audio(chunk["text_content"], chunk["id"], voice=voice or None)
        except Exception:
            pass  # Continuar mesmo se um falhar


# --- Listar documentos ---

@app.get("/api/documents")
async def get_documents(request: Request):
    user = require_auth(request)
    docs = list_documents(user["id"])
    return {"documents": docs}


# --- Detalhes do documento ---

@app.get("/api/documents/{doc_id}")
async def get_document_detail(doc_id: str, request: Request):
    user, doc = require_doc(request, doc_id)

    chunks = get_chunks(doc_id)
    progress = get_progress(user["id"], doc_id)

    # Contar chunks com áudio pronto
    ready = sum(1 for c in chunks if c["audio_path"])

    # Se nenhum chunk tem áudio, disparar pré-geração
    if ready == 0:
        asyncio.create_task(_pregenerate_all_audio(doc_id, voz_do_usuario(user)))

    return {
        "document": doc,
        "chunks": [
            {
                "index": c["chunk_index"],
                "page": c["page_number"],
                "text": c["text_content"][:200] + "...",
                "has_audio": bool(c["audio_path"]),
                "duration_ms": c.get("duration_ms") or 0,
            }
            for c in chunks
        ],
        "progress": progress,
        "audio_ready": ready,
        "audio_total": len(chunks),
    }


# --- Deletar documento ---

@app.delete("/api/documents/{doc_id}")
async def remove_document(doc_id: str, request: Request):
    user, doc = require_doc(request, doc_id)

    # Remover o áudio de TODAS as vozes já geradas para este documento.
    # chunks.audio_path guarda só o último gerado; como o nome do arquivo é
    # {chunk_id}_{hash-que-inclui-a-voz}, apagar só o registrado deixaria os
    # MP3 das outras vozes órfãos no disco para sempre.
    chunks = get_chunks(doc_id)
    for c in chunks:
        for arquivo in glob.glob(os.path.join(AUDIO_DIR, f"{c['id']}_*")):
            try:
                os.remove(arquivo)
            except OSError:
                pass
        if c["audio_path"] and os.path.exists(c["audio_path"]):
            os.remove(c["audio_path"])

    # Remover PDF — só se nenhum outro documento apontar para o mesmo arquivo
    # (uploads antigos usavam o nome original e podiam colidir entre pessoas)
    pdf_path = os.path.join(UPLOAD_DIR, doc["filename"])
    if os.path.exists(pdf_path):
        if count_documents_with_filename(doc["filename"], doc_id) == 0:
            os.remove(pdf_path)
        else:
            logger.warning("DELETE %s — PDF %s preservado: outro documento usa o mesmo arquivo",
                           doc_id, doc["filename"])

    # Remover cover
    cover_path = os.path.join(COVERS_DIR, f"{doc_id}.png")
    if os.path.exists(cover_path):
        os.remove(cover_path)

    # Remover pages renderizadas
    page_dir = os.path.join(PAGES_DIR, doc_id)
    if os.path.exists(page_dir):
        shutil.rmtree(page_dir, ignore_errors=True)

    delete_document(doc_id)
    logger.info("DELETE %s por user=%s", doc_id, user["id"])
    return {"ok": True}


# --- Gerar áudio de um chunk ---

@app.post("/api/documents/{doc_id}/chunks/{chunk_index}/audio")
async def generate_chunk_audio(
    doc_id: str,
    chunk_index: int,
    request: Request,
    rate: str = Query(default="+0%", description="Velocidade: -50% a +100%"),
    pitch: str = Query(default="+0Hz", description="Tom: -50Hz a +50Hz"),
    voice: str = Query(default="", description="Voz (ex: pt-BR-AntonioNeural)"),
):
    user, _ = require_doc(request, doc_id)
    chunk = get_chunk(doc_id, chunk_index)
    if not chunk:
        raise HTTPException(404, "Chunk não encontrado")

    usada = voz_do_usuario(user, voice)
    result = await generate_audio(chunk["text_content"], chunk["id"], rate=rate, pitch=pitch, voice=usada)

    if not result["cached"]:
        # Estimar duração (~150 palavras/min para pt-BR)
        word_count = len(chunk["text_content"].split())
        duration_ms = int((word_count / 150) * 60 * 1000)
        update_chunk_audio(chunk["id"], result["path"], duration_ms)

    # Carregar boundaries inline (evita request extra)
    import json as _json
    boundaries = []
    boundaries_path = os.path.join(AUDIO_DIR, result["boundaries_file"])
    if os.path.exists(boundaries_path):
        with open(boundaries_path, "r", encoding="utf-8") as f:
            boundaries = _json.load(f)

    return {
        "audio_url": f"/api/audio/{result['filename']}",
        "boundaries": boundaries,
        "text": chunk["text_content"],
        "cached": result["cached"],
        "chunk_index": chunk_index,
        "page": chunk["page_number"],
        "voice": usada,
    }


# --- Stream áudio (gerar e enviar em tempo real) ---

@app.get("/api/documents/{doc_id}/chunks/{chunk_index}/stream")
async def stream_chunk_audio(
    doc_id: str,
    chunk_index: int,
    request: Request,
    rate: str = Query(default="+0%"),
    pitch: str = Query(default="+0Hz"),
):
    user, _ = require_doc(request, doc_id)
    chunk = get_chunk(doc_id, chunk_index)
    if not chunk:
        raise HTTPException(404, "Chunk não encontrado")

    return StreamingResponse(
        generate_audio_stream(chunk["text_content"], rate=rate, pitch=pitch,
                              voice=voz_do_usuario(user)),
        media_type="audio/mpeg",
        headers={
            "Content-Disposition": f"inline; filename=chunk_{chunk_index}.mp3",
            **_MEDIA_PRIVADA,
        },
    )


# --- Servir arquivo de áudio ---

_NOME_AUDIO = re.compile(r"^([0-9a-f]{8})_[0-9a-f]{12}\.(mp3|json)$")


@app.get("/api/audio/{filename}")
async def serve_audio(filename: str, request: Request):
    """Serve o MP3/boundaries de um chunk — só para o dono do documento.

    O arquivo se chama {chunk_id}_{hash}.mp3, então o chunk_id no nome é o que
    liga o arquivo ao documento e ao dono. Sem essa checagem qualquer pessoa
    logada leria o áudio do livro de qualquer outra, mesmo com as demais rotas
    fechadas — e o nome do arquivo vem da URL, o que também abriria caminho
    para sair do diretório de áudio.
    """
    user = require_auth(request)

    m = _NOME_AUDIO.match(filename)
    if not m:
        raise HTTPException(404, "Arquivo não encontrado")

    dono = get_chunk_owner(m.group(1))
    if dono != user["id"]:
        raise HTTPException(404, "Arquivo não encontrado")

    filepath = os.path.join(AUDIO_DIR, filename)
    if not os.path.exists(filepath):
        raise HTTPException(404, "Arquivo não encontrado")
    media = "application/json" if filename.endswith(".json") else "audio/mpeg"
    return FileResponse(filepath, media_type=media, headers=_MEDIA_PRIVADA)


# --- Obter texto de um chunk (para highlight) ---

@app.get("/api/documents/{doc_id}/chunks/{chunk_index}/text")
async def get_chunk_text(doc_id: str, chunk_index: int, request: Request):
    require_doc(request, doc_id)
    chunk = get_chunk(doc_id, chunk_index)
    if not chunk:
        raise HTTPException(404, "Chunk não encontrado")
    return {"text": chunk["text_content"], "page": chunk["page_number"]}


# --- Atualizar progresso ---

@app.put("/api/documents/{doc_id}/progress")
async def save_progress(doc_id: str, request: Request,
                        current_chunk: int = Query(...), position_ms: int = Query(default=0)):
    user, _ = require_doc(request, doc_id)
    update_progress(user["id"], doc_id, current_chunk, position_ms)
    return {"ok": True}


# --- Listar vozes disponíveis ---

class VozRequest(BaseModel):
    voice: str


@app.get("/api/voices")
async def get_voices(request: Request, language: str = Query(default="pt-BR")):
    """As três vozes pt-BR e a que está escolhida nesta conta."""
    user = require_auth(request)
    voices = await list_voices(language)
    return {"voices": voices, "selected": voz_do_usuario(user)}


@app.put("/api/voices/selected")
async def set_voice(body: VozRequest, request: Request):
    """Troca a voz da CONTA — vale na web e no app, e sobrevive ao logout.

    Não apaga áudio nenhum: o MP3 de cada voz tem nome próprio, então voltar
    para a voz anterior reaproveita o que já existe em vez de gerar de novo.
    """
    user = require_auth(request)
    if body.voice not in NOMES_VALIDOS:
        raise HTTPException(400, "Voz não disponível")
    set_user_voice(user["id"], body.voice)
    return {"ok": True, "voice": body.voice}
