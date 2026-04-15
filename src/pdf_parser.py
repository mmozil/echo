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


def chunk_pages(pages: list[dict], max_chars: int = 1200) -> list[dict]:
    """Divide páginas em chunks de tamanho adequado para TTS.

    Cada chunk tem ~1200 chars (aprox. 40-60s de áudio) — rápido para gerar.
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


def extract_cover(file_path: str, output_path: str, width: int = 400) -> bool:
    """Extrai a primeira página do PDF como imagem PNG para usar como capa."""
    try:
        doc = fitz.open(file_path)
        if len(doc) == 0:
            doc.close()
            return False

        page = doc[0]
        zoom = width / page.rect.width
        mat = fitz.Matrix(zoom, zoom)
        pix = page.get_pixmap(matrix=mat)
        pix.save(output_path)
        doc.close()
        return True
    except Exception:
        return False


def render_page(file_path: str, page_num: int, output_path: str, width: int = 800) -> bool:
    """Renderiza uma página específica do PDF como imagem PNG."""
    try:
        doc = fitz.open(file_path)
        if page_num < 1 or page_num > len(doc):
            doc.close()
            return False

        page = doc[page_num - 1]
        zoom = width / page.rect.width
        mat = fitz.Matrix(zoom, zoom)
        pix = page.get_pixmap(matrix=mat)
        pix.save(output_path)
        doc.close()
        return True
    except Exception:
        return False


def get_toc(file_path: str) -> list[dict]:
    """Extrai Table of Contents do PDF."""
    doc = fitz.open(file_path)
    toc = doc.get_toc()
    doc.close()
    return [{"level": item[0], "title": item[1], "page": item[2]} for item in toc]


def search_words_on_page(file_path: str, page_num: int, words: list[str]) -> dict:
    """Busca palavras numa página e retorna suas posições relativas (0-1).

    Retorna {page_width, page_height, results: [{word, rects: [{x0,y0,x1,y1}]}]}
    """
    doc = fitz.open(file_path)
    if page_num < 1 or page_num > len(doc):
        doc.close()
        return {"page_width": 0, "page_height": 0, "results": []}

    page = doc[page_num - 1]
    pw = page.rect.width
    ph = page.rect.height

    results = []
    for word in words:
        rects = page.search_for(word)
        results.append({
            "word": word,
            "rects": [
                {
                    "x0": round(r.x0 / pw, 4),
                    "y0": round(r.y0 / ph, 4),
                    "x1": round(r.x1 / pw, 4),
                    "y1": round(r.y1 / ph, 4),
                }
                for r in rects[:3]  # máx 3 ocorrências por palavra
            ],
        })

    doc.close()
    return {"page_width": pw, "page_height": ph, "results": results}


def get_word_positions_on_page(file_path: str, page_num: int) -> list[dict]:
    """Retorna TODAS as palavras da página com suas posições relativas.

    Retorna [{word, x0, y0, x1, y1}] em coordenadas relativas (0-1).
    """
    doc = fitz.open(file_path)
    if page_num < 1 or page_num > len(doc):
        doc.close()
        return []

    page = doc[page_num - 1]
    pw = page.rect.width
    ph = page.rect.height

    # get_text("words") retorna (x0, y0, x1, y1, word, block_no, line_no, word_no)
    raw = page.get_text("words")
    words = [
        {
            "word": w[4],
            "x0": round(w[0] / pw, 4),
            "y0": round(w[1] / ph, 4),
            "x1": round(w[2] / pw, 4),
            "y1": round(w[3] / ph, 4),
            "block": w[5],
            "line": w[6],
        }
        for w in raw
    ]

    doc.close()
    return words


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
