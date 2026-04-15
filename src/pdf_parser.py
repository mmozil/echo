"""Extração de texto de PDFs usando PyMuPDF."""

import fitz  # PyMuPDF
import re


def extract_text_from_pdf(file_path: str) -> list[dict]:
    """Extrai texto do PDF página por página.

    Retorna lista de {page: int, text: str}
    """
    doc = fitz.open(file_path)
    pages = []

    for page_num in range(len(doc)):
        page = doc[page_num]
        text = page.get_text("text")
        text = _clean_text(text)
        if text.strip():
            pages.append({"page": page_num + 1, "text": text})

    doc.close()
    return pages


def chunk_pages(pages: list[dict], max_chars: int = 3000) -> list[dict]:
    """Divide páginas em chunks de tamanho adequado para TTS.

    Cada chunk tem ~3000 chars (aprox. 2-3 min de áudio).
    Respeita limites de parágrafo quando possível.
    """
    chunks = []
    chunk_index = 0

    for page_data in pages:
        page_num = page_data["page"]
        text = page_data["text"]
        paragraphs = text.split("\n\n")

        current_chunk = ""

        for para in paragraphs:
            para = para.strip()
            if not para:
                continue

            if len(current_chunk) + len(para) + 2 > max_chars and current_chunk:
                chunks.append({
                    "chunk_index": chunk_index,
                    "page_number": page_num,
                    "text": current_chunk.strip(),
                })
                chunk_index += 1
                current_chunk = ""

            current_chunk += para + "\n\n"

        if current_chunk.strip():
            chunks.append({
                "chunk_index": chunk_index,
                "page_number": page_num,
                "text": current_chunk.strip(),
            })
            chunk_index += 1

    return chunks


def get_pdf_info(file_path: str) -> dict:
    """Retorna metadados do PDF."""
    doc = fitz.open(file_path)
    info = {
        "total_pages": len(doc),
        "title": doc.metadata.get("title", "") or "",
        "author": doc.metadata.get("author", "") or "",
    }
    doc.close()
    return info


def _clean_text(text: str) -> str:
    """Limpa texto extraído de PDF."""
    # Remove hífens de quebra de linha
    text = re.sub(r"(\w)-\n(\w)", r"\1\2", text)
    # Junta linhas dentro do mesmo parágrafo
    text = re.sub(r"(?<!\n)\n(?!\n)", " ", text)
    # Remove espaços múltiplos
    text = re.sub(r" {2,}", " ", text)
    # Remove cabeçalhos/rodapés numéricos comuns
    text = re.sub(r"^\d+\s*$", "", text, flags=re.MULTILINE)
    return text.strip()
