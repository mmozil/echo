# CLAUDE.md — Echo

## Resumo

Echo é um leitor de documentos com voz AI. Upload de PDFs → extração de texto → TTS com Microsoft Edge (pt-BR-AntonioNeural). Speechify pessoal, gratuito.

**URL:** https://echo.hovio.com.br
**Repo:** github.com/mmozil/echo
**Stack:** Python 3.13, FastAPI, Edge TTS, PyMuPDF, SQLite

## Comandos

```bash
# Dev local
pip install -r requirements.txt
DB_PATH=./data/echo.db UPLOAD_DIR=./data/uploads AUDIO_DIR=./data/audio uvicorn main:app --reload --port 8095

# Docker
docker build -t hovio-echo .
docker run -p 8095:8095 -v echo-data:/app/data hovio-echo
```

## Arquitetura

```
Echo/
├── main.py              # FastAPI (rotas, upload, player, audio)
├── src/
│   ├── database.py      # SQLite (documents, chunks, progress)
│   ├── pdf_parser.py    # PyMuPDF — extração + chunking
│   └── tts_service.py   # Edge TTS (AntonioNeural, cache MP3)
├── static/
│   └── index.html       # Frontend single-file (biblioteca + player)
├── data/
│   ├── echo.db          # SQLite
│   ├── uploads/         # PDFs originais
│   └── audio/           # MP3 cache (chunk_id + hash)
└── Dockerfile           # Python 3.13-slim, porta 8095
```

## TTS

- **Provider:** Microsoft Edge TTS (grátis, sem API key)
- **Biblioteca:** `edge-tts` (Python)
- **Voz:** `pt-BR-AntonioNeural` (mesma do Vivaldi)
- **Cache:** MP3 cacheado por hash(texto + voz + rate + pitch)
- **Formato:** audio-24khz-48kbitrate-mono-mp3

## Fluxo

1. Upload PDF → PyMuPDF extrai texto página por página
2. Texto dividido em chunks (~3000 chars, respeita parágrafos)
3. Play → Edge TTS gera MP3 do chunk → cache local
4. Auto-advance: ao terminar chunk, toca o próximo
5. Progresso salvo no SQLite (chunk atual + posição)

## API

| Método | Rota | Descrição |
|--------|------|-----------|
| POST | `/api/documents` | Upload PDF (multipart) |
| GET | `/api/documents` | Listar biblioteca |
| GET | `/api/documents/{id}` | Detalhes + chunks |
| DELETE | `/api/documents/{id}` | Remover documento |
| POST | `/api/documents/{id}/chunks/{i}/audio` | Gerar áudio do chunk |
| GET | `/api/documents/{id}/chunks/{i}/stream` | Stream áudio real-time |
| GET | `/api/documents/{id}/chunks/{i}/text` | Texto do chunk |
| PUT | `/api/documents/{id}/progress` | Salvar progresso |
| GET | `/api/voices` | Listar vozes disponíveis |
| GET | `/api/health` | Health check |

## Deploy (Coolify)

- **Porta:** 8095
- **Volume:** `/app/data` (SQLite + uploads + audio)
- **Env vars:** nenhuma obrigatória (Edge TTS é grátis)
- **Opcional:** `TTS_VOICE=pt-BR-AntonioNeural`
