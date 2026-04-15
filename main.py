"""Echo — Seus documentos ganham voz.

Upload de PDFs → extração de texto → TTS com Microsoft Edge (AntonioNeural).
"""

import os
import shutil
import asyncio
from pathlib import Path

from fastapi import FastAPI, UploadFile, File, HTTPException, Query, Request, Response, Cookie
from fastapi.responses import FileResponse, StreamingResponse, HTMLResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from src.database import init_db, create_document, list_documents, get_document, delete_document
from src.database import save_chunk, get_chunks, get_chunk, update_chunk_audio, update_progress, get_progress
from src.database import create_user, authenticate_user, create_session, get_user_by_session, delete_session
from src.pdf_parser import extract_text_from_pdf, chunk_pages, get_pdf_info, extract_cover, render_page, get_toc, get_word_positions_on_page

PAGES_DIR = os.environ.get("PAGES_DIR", "/app/data/pages")

COVERS_DIR = os.environ.get("COVERS_DIR", "/app/data/covers")
from src.tts_service import generate_audio, generate_audio_stream, list_voices

UPLOAD_DIR = os.environ.get("UPLOAD_DIR", "/app/data/uploads")
AUDIO_DIR = os.environ.get("AUDIO_DIR", "/app/data/audio")

app = FastAPI(title="Echo", version="1.0.0", docs_url="/api/docs")

# Servir arquivos estáticos
app.mount("/static", StaticFiles(directory="static"), name="static")


@app.on_event("startup")
async def startup():
    os.makedirs(UPLOAD_DIR, exist_ok=True)
    os.makedirs(AUDIO_DIR, exist_ok=True)
    os.makedirs(COVERS_DIR, exist_ok=True)
    os.makedirs(PAGES_DIR, exist_ok=True)
    init_db()


# --- Helpers ---

def get_current_user(request: Request) -> dict | None:
    token = request.cookies.get("echo_session")
    if not token:
        return None
    return get_user_by_session(token)


def require_auth(request: Request) -> dict:
    user = get_current_user(request)
    if not user:
        raise HTTPException(401, "Não autenticado")
    return user


# --- Páginas ---

@app.get("/", response_class=HTMLResponse)
async def landing():
    return FileResponse("static/landing.html")


@app.get("/app", response_class=HTMLResponse)
async def app_page(request: Request):
    user = get_current_user(request)
    if not user:
        return RedirectResponse("/login", status_code=302)
    return FileResponse("static/index.html")


@app.get("/login", response_class=HTMLResponse)
async def login_page(request: Request):
    user = get_current_user(request)
    if user:
        return RedirectResponse("/app", status_code=302)
    return FileResponse("static/login.html")


@app.get("/register", response_class=HTMLResponse)
async def register_page(request: Request):
    user = get_current_user(request)
    if user:
        return RedirectResponse("/app", status_code=302)
    return FileResponse("static/register.html")


# --- Health ---

@app.get("/api/health")
async def health():
    return {"status": "ok", "service": "echo", "voice": os.environ.get("TTS_VOICE", "pt-BR-AntonioNeural")}


# --- Covers ---

@app.get("/api/covers/{doc_id}.png")
async def serve_cover(doc_id: str):
    filepath = os.path.join(COVERS_DIR, f"{doc_id}.png")
    if not os.path.exists(filepath):
        raise HTTPException(404, "Capa não encontrada")
    return FileResponse(filepath, media_type="image/png")


@app.get("/api/documents/{doc_id}/pages/{page_num}.png")
async def serve_page(doc_id: str, page_num: int):
    """Renderiza e serve uma página do PDF como PNG (com cache)."""
    doc = get_document(doc_id)
    if not doc:
        raise HTTPException(404, "Documento não encontrado")

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

    return FileResponse(page_path, media_type="image/png")


# --- TOC ---

@app.get("/api/documents/{doc_id}/toc")
async def get_document_toc(doc_id: str):
    """Retorna Table of Contents do PDF."""
    doc = get_document(doc_id)
    if not doc:
        raise HTTPException(404, "Documento não encontrado")
    pdf_path = os.path.join(UPLOAD_DIR, doc["filename"])
    if not os.path.exists(pdf_path):
        return {"toc": []}
    toc = get_toc(pdf_path)
    return {"toc": toc, "total_pages": doc["total_pages"]}


# --- Word positions (para highlight no PDF) ---

@app.get("/api/documents/{doc_id}/pages/{page_num}/words")
async def get_page_words(doc_id: str, page_num: int):
    """Retorna todas as palavras da página com posições relativas (0-1)."""
    doc = get_document(doc_id)
    if not doc:
        raise HTTPException(404, "Documento não encontrado")
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


@app.post("/api/auth/register")
async def register(body: RegisterRequest, response: Response):
    if len(body.password) < 6:
        raise HTTPException(400, "Senha deve ter pelo menos 6 caracteres")
    if not body.name.strip():
        raise HTTPException(400, "Nome é obrigatório")

    user_id = create_user(body.name.strip(), body.email, body.password)
    if not user_id:
        raise HTTPException(409, "Email já cadastrado")

    token = create_session(user_id)
    response.set_cookie("echo_session", token, httponly=True, samesite="lax", max_age=30 * 24 * 3600)
    return {"ok": True, "name": body.name.strip()}


@app.post("/api/auth/login")
async def login(body: LoginRequest, response: Response):
    user = authenticate_user(body.email, body.password)
    if not user:
        raise HTTPException(401, "Email ou senha incorretos")

    token = create_session(user["id"])
    response.set_cookie("echo_session", token, httponly=True, samesite="lax", max_age=30 * 24 * 3600)
    return {"ok": True, "name": user["name"]}


@app.get("/api/auth/me")
async def me(request: Request):
    user = get_current_user(request)
    if not user:
        raise HTTPException(401, "Não autenticado")
    return {"id": user["id"], "name": user["name"], "email": user["email"]}


@app.post("/api/auth/logout")
async def logout(request: Request, response: Response):
    token = request.cookies.get("echo_session")
    if token:
        delete_session(token)
    response.delete_cookie("echo_session")
    return {"ok": True}


# --- Upload PDF ---

@app.post("/api/documents")
async def upload_document(file: UploadFile = File(...)):
    if not file.filename.lower().endswith(".pdf"):
        raise HTTPException(400, "Apenas arquivos PDF são aceitos")

    if file.size and file.size > 100 * 1024 * 1024:
        raise HTTPException(400, "Arquivo muito grande (máx. 100MB)")

    # Salvar PDF
    os.makedirs(UPLOAD_DIR, exist_ok=True)
    file_path = os.path.join(UPLOAD_DIR, file.filename)
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

    # Salvar no banco
    title = info["title"] if info["title"] else Path(file.filename).stem.replace("_", " ").replace("-", " ").title()
    doc_id = create_document(
        title=title,
        filename=file.filename,
        total_pages=info["total_pages"],
        total_chunks=len(chunks),
        file_size=len(content),
    )

    for c in chunks:
        save_chunk(doc_id, c["chunk_index"], c["page_number"], c["text"])

    # Extrair capa (primeira página como PNG)
    cover_path = os.path.join(COVERS_DIR, f"{doc_id}.png")
    has_cover = extract_cover(file_path, cover_path)

    # Pré-gerar áudio de TODOS os chunks em background
    asyncio.create_task(_pregenerate_all_audio(doc_id))

    return {
        "id": doc_id,
        "title": title,
        "total_pages": info["total_pages"],
        "total_chunks": len(chunks),
        "file_size": len(content),
        "has_cover": has_cover,
    }


async def _pregenerate_all_audio(doc_id: str):
    """Pré-gera áudio de todos os chunks em background."""
    chunks = get_chunks(doc_id)
    for chunk in chunks:
        try:
            await generate_audio(chunk["text_content"], chunk["id"])
        except Exception:
            pass  # Continuar mesmo se um falhar


# --- Listar documentos ---

@app.get("/api/documents")
async def get_documents():
    docs = list_documents()
    return {"documents": docs}


# --- Detalhes do documento ---

@app.get("/api/documents/{doc_id}")
async def get_document_detail(doc_id: str):
    doc = get_document(doc_id)
    if not doc:
        raise HTTPException(404, "Documento não encontrado")

    chunks = get_chunks(doc_id)
    progress = get_progress(doc_id)

    # Contar chunks com áudio pronto
    ready = sum(1 for c in chunks if c["audio_path"])

    # Se nenhum chunk tem áudio, disparar pré-geração
    if ready == 0:
        asyncio.create_task(_pregenerate_all_audio(doc_id))

    return {
        "document": doc,
        "chunks": [{"index": c["chunk_index"], "page": c["page_number"], "text": c["text_content"][:200] + "...", "has_audio": bool(c["audio_path"])} for c in chunks],
        "progress": progress,
        "audio_ready": ready,
        "audio_total": len(chunks),
    }


# --- Deletar documento ---

@app.delete("/api/documents/{doc_id}")
async def remove_document(doc_id: str):
    doc = get_document(doc_id)
    if not doc:
        raise HTTPException(404, "Documento não encontrado")

    # Remover arquivos de áudio
    chunks = get_chunks(doc_id)
    for c in chunks:
        if c["audio_path"] and os.path.exists(c["audio_path"]):
            os.remove(c["audio_path"])

    # Remover PDF
    pdf_path = os.path.join(UPLOAD_DIR, doc["filename"])
    if os.path.exists(pdf_path):
        os.remove(pdf_path)

    delete_document(doc_id)
    return {"ok": True}


# --- Gerar áudio de um chunk ---

@app.post("/api/documents/{doc_id}/chunks/{chunk_index}/audio")
async def generate_chunk_audio(
    doc_id: str,
    chunk_index: int,
    rate: str = Query(default="+0%", description="Velocidade: -50% a +100%"),
    pitch: str = Query(default="+0Hz", description="Tom: -50Hz a +50Hz"),
    voice: str = Query(default="", description="Voz (ex: pt-BR-AntonioNeural)"),
):
    chunk = get_chunk(doc_id, chunk_index)
    if not chunk:
        raise HTTPException(404, "Chunk não encontrado")

    result = await generate_audio(chunk["text_content"], chunk["id"], rate=rate, pitch=pitch, voice=voice or None)

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
    }


# --- Stream áudio (gerar e enviar em tempo real) ---

@app.get("/api/documents/{doc_id}/chunks/{chunk_index}/stream")
async def stream_chunk_audio(
    doc_id: str,
    chunk_index: int,
    rate: str = Query(default="+0%"),
    pitch: str = Query(default="+0Hz"),
):
    chunk = get_chunk(doc_id, chunk_index)
    if not chunk:
        raise HTTPException(404, "Chunk não encontrado")

    return StreamingResponse(
        generate_audio_stream(chunk["text_content"], rate=rate, pitch=pitch),
        media_type="audio/mpeg",
        headers={"Content-Disposition": f"inline; filename=chunk_{chunk_index}.mp3"},
    )


# --- Servir arquivo de áudio ---

@app.get("/api/audio/{filename}")
async def serve_audio(filename: str):
    filepath = os.path.join(AUDIO_DIR, filename)
    if not os.path.exists(filepath):
        raise HTTPException(404, "Arquivo não encontrado")
    media = "application/json" if filename.endswith(".json") else "audio/mpeg"
    return FileResponse(filepath, media_type=media)


# --- Obter texto de um chunk (para highlight) ---

@app.get("/api/documents/{doc_id}/chunks/{chunk_index}/text")
async def get_chunk_text(doc_id: str, chunk_index: int):
    chunk = get_chunk(doc_id, chunk_index)
    if not chunk:
        raise HTTPException(404, "Chunk não encontrado")
    return {"text": chunk["text_content"], "page": chunk["page_number"]}


# --- Atualizar progresso ---

@app.put("/api/documents/{doc_id}/progress")
async def save_progress(doc_id: str, current_chunk: int = Query(...), position_ms: int = Query(default=0)):
    doc = get_document(doc_id)
    if not doc:
        raise HTTPException(404, "Documento não encontrado")
    update_progress(doc_id, current_chunk, position_ms)
    return {"ok": True}


# --- Listar vozes disponíveis ---

@app.get("/api/voices")
async def get_voices(language: str = Query(default="pt-BR")):
    voices = await list_voices(language)
    return {"voices": voices}
