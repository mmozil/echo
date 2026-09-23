#!/usr/bin/env python3
"""Reextrai o texto de documentos que já estão na biblioteca.

Por que existe: a correção do texto soletrado, do cabeçalho corrente e do
número de página vive em `src/pdf_parser.py`, e ela só roda no UPLOAD. Quem já
tinha o livro na estante continuaria ouvindo a versão soletrada para sempre —
a menos que apagasse e subisse de novo, perdendo o progresso de leitura.

O que faz:
  1. reextrai o PDF com o parser atual;
  2. quando o fatiamento mantém o mesmo formato (mesmo número de trechos, mesma
     página em cada um), atualiza o TEXTO NO LUGAR. O `chunks.id` não muda, e
     por isso o progresso de leitura continua apontando para o trecho certo;
  3. apaga o MP3 dos trechos cujo texto mudou — é o áudio errado, soletrado.
     O próximo play gera o certo. (A chave do cache é md5 do texto+voz, então
     o arquivo novo nasce com outro nome de qualquer forma; o que se apaga aqui
     é o lixo que ficaria para trás.)

  🚨 Se o formato do fatiamento mudar, o script NÃO mexe sozinho: recriar os
  trechos muda os ids e desloca o progresso. Nesse caso ele avisa e só age com
  --recriar, dito na mão.

Uso (dentro do container):
    python scripts/reprocessar_documento.py                 # prévia de todos
    python scripts/reprocessar_documento.py --aplicar
    python scripts/reprocessar_documento.py --doc 506a0c61 --aplicar
    python scripts/reprocessar_documento.py --doc X --aplicar --recriar
"""

import argparse
import glob
import os
import sqlite3
import sys
import uuid

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from src.pdf_parser import extract_text_from_pdf, chunk_pages  # noqa: E402

DB_PATH = os.environ.get("DB_PATH", "/app/data/echo.db")
UPLOAD_DIR = os.environ.get("UPLOAD_DIR", "/app/data/uploads")
AUDIO_DIR = os.environ.get("AUDIO_DIR", "/app/data/audio")


def conectar():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    return conn


def apagar_audio(chunk_id: str) -> int:
    apagados = 0
    for arquivo in glob.glob(os.path.join(AUDIO_DIR, f"{chunk_id}_*")):
        try:
            os.remove(arquivo)
            apagados += 1
        except OSError:
            pass
    return apagados


def reprocessar(conn, doc, aplicar: bool, recriar: bool) -> dict:
    caminho = os.path.join(UPLOAD_DIR, doc["filename"])
    if not os.path.exists(caminho):
        return {"erro": f"PDF ausente: {doc['filename']}"}

    novos = chunk_pages(extract_text_from_pdf(caminho))
    atuais = conn.execute(
        "SELECT id, chunk_index, page_number, text_content FROM chunks "
        "WHERE document_id = ? ORDER BY chunk_index",
        (doc["id"],),
    ).fetchall()

    mesmo_formato = len(novos) == len(atuais) and all(
        n["page_number"] == a["page_number"] for n, a in zip(novos, atuais)
    )

    res = {
        "titulo": doc["title"],
        "trechos_antes": len(atuais),
        "trechos_depois": len(novos),
        "mesmo_formato": mesmo_formato,
        "mudaram": 0,
        "chars_antes": sum(len(a["text_content"]) for a in atuais),
        "chars_depois": sum(len(n["text"]) for n in novos),
        "audio_apagado": 0,
        "acao": "nada",
    }

    if mesmo_formato:
        alterados = [
            (a["id"], n["text"])
            for a, n in zip(atuais, novos)
            if a["text_content"] != n["text"]
        ]
        res["mudaram"] = len(alterados)
        res["acao"] = "atualizar-no-lugar"
        if aplicar and alterados:
            for chunk_id, texto in alterados:
                conn.execute(
                    "UPDATE chunks SET text_content = ?, audio_path = NULL, duration_ms = 0 WHERE id = ?",
                    (texto, chunk_id),
                )
                res["audio_apagado"] += apagar_audio(chunk_id)
            conn.commit()
        return res

    # Formato diferente: só com --recriar, e avisando o que custa.
    res["acao"] = "recriar" if recriar else "BLOQUEADO (use --recriar)"
    if aplicar and recriar:
        for a in atuais:
            res["audio_apagado"] += apagar_audio(a["id"])
        conn.execute("DELETE FROM chunks WHERE document_id = ?", (doc["id"],))
        for n in novos:
            conn.execute(
                "INSERT INTO chunks (id, document_id, chunk_index, page_number, text_content) "
                "VALUES (?, ?, ?, ?, ?)",
                (str(uuid.uuid4())[:8], doc["id"], n["chunk_index"], n["page_number"], n["text"]),
            )
        conn.execute(
            "UPDATE documents SET total_chunks = ?, updated_at = datetime('now') WHERE id = ?",
            (len(novos), doc["id"]),
        )
        # O progresso pode ter ficado fora da faixa nova.
        conn.execute(
            "UPDATE reading_progress SET current_chunk = MIN(current_chunk, ?) WHERE document_id = ?",
            (max(0, len(novos) - 1), doc["id"]),
        )
        conn.commit()
        res["mudaram"] = len(novos)
    return res


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--doc", default="", help="id do documento (vazio = todos)")
    p.add_argument("--aplicar", action="store_true", help="sem isto é só prévia")
    p.add_argument("--recriar", action="store_true", help="permite recriar trechos quando o formato muda")
    args = p.parse_args()

    conn = conectar()
    if args.doc:
        docs = conn.execute("SELECT * FROM documents WHERE id = ?", (args.doc,)).fetchall()
    else:
        docs = conn.execute("SELECT * FROM documents ORDER BY rowid").fetchall()

    if not docs:
        print("nenhum documento encontrado")
        return

    print("PRÉVIA (nada gravado)" if not args.aplicar else "APLICANDO")
    print("-" * 74)
    for doc in docs:
        r = reprocessar(conn, doc, args.aplicar, args.recriar)
        if "erro" in r:
            print(f"{doc['id']}  {r['erro']}")
            continue
        delta = r["chars_depois"] - r["chars_antes"]
        pct = delta * 100.0 / max(r["chars_antes"], 1)
        print(
            f"{doc['id']}  {r['titulo'][:34]:<34} "
            f"trechos {r['trechos_antes']}->{r['trechos_depois']}  "
            f"texto {delta:+d} ({pct:+.1f}%)  "
            f"mudam {r['mudaram']}  audio-apagado {r['audio_apagado']}  [{r['acao']}]"
        )
    conn.close()


if __name__ == "__main__":
    main()
