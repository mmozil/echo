"""Database SQLite para Echo — biblioteca de documentos e progresso de leitura."""

import sqlite3
import os
import uuid
import hashlib
import secrets
from datetime import datetime

DB_PATH = os.environ.get("DB_PATH", "/app/data/echo.db")


def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def init_db():
    conn = get_db()
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS users (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            email TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            created_at TEXT DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS sessions (
            token TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            created_at TEXT DEFAULT (datetime('now')),
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS documents (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            filename TEXT NOT NULL,
            total_pages INTEGER DEFAULT 0,
            total_chunks INTEGER DEFAULT 0,
            file_size INTEGER DEFAULT 0,
            cover_color TEXT DEFAULT '#003083',
            created_at TEXT DEFAULT (datetime('now')),
            updated_at TEXT DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS chunks (
            id TEXT PRIMARY KEY,
            document_id TEXT NOT NULL,
            chunk_index INTEGER NOT NULL,
            page_number INTEGER DEFAULT 0,
            text_content TEXT NOT NULL,
            audio_path TEXT,
            duration_ms INTEGER DEFAULT 0,
            FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS reading_progress (
            document_id TEXT PRIMARY KEY,
            current_chunk INTEGER DEFAULT 0,
            position_ms INTEGER DEFAULT 0,
            last_read_at TEXT DEFAULT (datetime('now')),
            FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_chunks_doc ON chunks(document_id, chunk_index);
    """)
    conn.commit()
    conn.close()


# --- Auth ---

def _hash_password(password: str) -> str:
    salt = secrets.token_hex(16)
    hashed = hashlib.sha256((salt + password).encode()).hexdigest()
    return f"{salt}:{hashed}"


def _verify_password(password: str, password_hash: str) -> bool:
    salt, hashed = password_hash.split(":")
    return hashlib.sha256((salt + password).encode()).hexdigest() == hashed


def create_user(name: str, email: str, password: str) -> str | None:
    user_id = str(uuid.uuid4())[:8]
    conn = get_db()
    try:
        conn.execute(
            "INSERT INTO users (id, name, email, password_hash) VALUES (?, ?, ?, ?)",
            (user_id, name, email.lower().strip(), _hash_password(password)),
        )
        conn.commit()
    except sqlite3.IntegrityError:
        conn.close()
        return None
    conn.close()
    return user_id


def authenticate_user(email: str, password: str) -> dict | None:
    conn = get_db()
    row = conn.execute("SELECT * FROM users WHERE email = ?", (email.lower().strip(),)).fetchone()
    conn.close()
    if not row or not _verify_password(password, row["password_hash"]):
        return None
    return dict(row)


def create_session(user_id: str) -> str:
    token = secrets.token_urlsafe(32)
    conn = get_db()
    conn.execute("INSERT INTO sessions (token, user_id) VALUES (?, ?)", (token, user_id))
    conn.commit()
    conn.close()
    return token


def get_user_by_session(token: str) -> dict | None:
    conn = get_db()
    row = conn.execute("""
        SELECT u.id, u.name, u.email FROM users u
        JOIN sessions s ON u.id = s.user_id
        WHERE s.token = ?
    """, (token,)).fetchone()
    conn.close()
    return dict(row) if row else None


def delete_session(token: str):
    conn = get_db()
    conn.execute("DELETE FROM sessions WHERE token = ?", (token,))
    conn.commit()
    conn.close()


# --- Documents ---

def create_document(title: str, filename: str, total_pages: int, total_chunks: int, file_size: int) -> str:
    doc_id = str(uuid.uuid4())[:8]
    colors = ["#1A1A1A", "#2D2D2D", "#404040", "#525252", "#374151", "#1F2937", "#111827"]
    color = colors[hash(title) % len(colors)]
    conn = get_db()
    conn.execute(
        "INSERT INTO documents (id, title, filename, total_pages, total_chunks, file_size, cover_color) VALUES (?, ?, ?, ?, ?, ?, ?)",
        (doc_id, title, filename, total_pages, total_chunks, file_size, color),
    )
    conn.execute(
        "INSERT INTO reading_progress (document_id, current_chunk, position_ms) VALUES (?, 0, 0)",
        (doc_id,),
    )
    conn.commit()
    conn.close()
    return doc_id


def list_documents() -> list[dict]:
    conn = get_db()
    rows = conn.execute("""
        SELECT d.*, rp.current_chunk, rp.last_read_at
        FROM documents d
        LEFT JOIN reading_progress rp ON d.id = rp.document_id
        ORDER BY rp.last_read_at DESC, d.created_at DESC
    """).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def get_document(doc_id: str) -> dict | None:
    conn = get_db()
    row = conn.execute("SELECT * FROM documents WHERE id = ?", (doc_id,)).fetchone()
    conn.close()
    return dict(row) if row else None


def delete_document(doc_id: str):
    conn = get_db()
    conn.execute("DELETE FROM documents WHERE id = ?", (doc_id,))
    conn.commit()
    conn.close()


# --- Chunks ---

def save_chunk(document_id: str, chunk_index: int, page_number: int, text_content: str) -> str:
    chunk_id = str(uuid.uuid4())[:8]
    conn = get_db()
    conn.execute(
        "INSERT INTO chunks (id, document_id, chunk_index, page_number, text_content) VALUES (?, ?, ?, ?, ?)",
        (chunk_id, document_id, chunk_index, page_number, text_content),
    )
    conn.commit()
    conn.close()
    return chunk_id


def get_chunks(document_id: str) -> list[dict]:
    conn = get_db()
    rows = conn.execute(
        "SELECT * FROM chunks WHERE document_id = ? ORDER BY chunk_index",
        (document_id,),
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def get_chunk(document_id: str, chunk_index: int) -> dict | None:
    conn = get_db()
    row = conn.execute(
        "SELECT * FROM chunks WHERE document_id = ? AND chunk_index = ?",
        (document_id, chunk_index),
    ).fetchone()
    conn.close()
    return dict(row) if row else None


def update_chunk_audio(chunk_id: str, audio_path: str, duration_ms: int):
    conn = get_db()
    conn.execute(
        "UPDATE chunks SET audio_path = ?, duration_ms = ? WHERE id = ?",
        (audio_path, duration_ms, chunk_id),
    )
    conn.commit()
    conn.close()


# --- Progress ---

def update_progress(document_id: str, current_chunk: int, position_ms: int = 0):
    conn = get_db()
    conn.execute(
        "UPDATE reading_progress SET current_chunk = ?, position_ms = ?, last_read_at = ? WHERE document_id = ?",
        (current_chunk, position_ms, datetime.now().isoformat(), document_id),
    )
    conn.commit()
    conn.close()


def get_progress(document_id: str) -> dict | None:
    conn = get_db()
    row = conn.execute(
        "SELECT * FROM reading_progress WHERE document_id = ?",
        (document_id,),
    ).fetchone()
    conn.close()
    return dict(row) if row else None
