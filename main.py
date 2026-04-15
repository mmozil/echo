"""Echo — Seus documentos ganham voz.

Upload de PDFs → extração de texto → TTS com Microsoft Edge (AntonioNeural).
"""

import os
import shutil
from pathlib import Path

from fastapi import FastAPI, UploadFile, File, HTTPException, Query, Request, Response, Cookie
from fastapi.responses import FileResponse, StreamingResponse, HTMLResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from src.database import init_db, create_document, list_documents, get_document, delete_document
from src.database import save_chunk, get_chunks, get_chunk, update_chunk_audio, update_progress, get_progress
from src.database import create_user, authenticate_user, create_session, get_user_by_session, delete_session
from src.pdf_parser import extract_text_from_pdf, chunk_pages, get_pdf_info
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
async def index(request: Request):
    user = get_current_user(request)
    if not user:
        return RedirectResponse("/login", status_code=302)
    return FileResponse("static/index.html")


@app.get("/login", response_class=HTMLResponse)
async def login_page(request: Request):
    user = get_current_user(request)
    if user:
        return RedirectResponse("/", status_code=302)
    return FileResponse("static/login.html")


# --- Health ---

@app.get("/api/health")
async def health():
    return {"status": "ok", "service": "echo", "voice": os.environ.get("TTS_VOICE", "pt-BR-AntonioNeural")}


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

    return {
        "id": doc_id,
        "title": title,
        "total_pages": info["total_pages"],
        "total_chunks": len(chunks),
        "file_size": len(content),
    }


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

    return {
        "document": doc,
        "chunks": [{"index": c["chunk_index"], "page": c["page_number"], "text": c["text_content"][:200] + "...", "has_audio": bool(c["audio_path"])} for c in chunks],
        "progress": progress,
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
):
    chunk = get_chunk(doc_id, chunk_index)
    if not chunk:
        raise HTTPException(404, "Chunk não encontrado")

    result = await generate_audio(chunk["text_content"], chunk["id"], rate=rate, pitch=pitch)

    if not result["cached"]:
        # Estimar duração (~150 palavras/min para pt-BR)
        word_count = len(chunk["text_content"].split())
        duration_ms = int((word_count / 150) * 60 * 1000)
        update_chunk_audio(chunk["id"], result["path"], duration_ms)

    return {
        "audio_url": f"/api/audio/{result['filename']}",
        "cached": result["cached"],
        "chunk_index": chunk_index,
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
        raise HTTPException(404, "Áudio não encontrado")
    return FileResponse(filepath, media_type="audio/mpeg")


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
