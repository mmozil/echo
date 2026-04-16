# CLAUDE.md — Echo

## Resumo

Echo é um leitor de documentos com voz AI. Upload de PDFs → extração de texto → TTS com Microsoft Edge (pt-BR-AntonioNeural). Speechify pessoal, gratuito.

**URL:** https://echo.hovio.com.br
**Repo:** github.com/mmozil/echo
**Stack:** Python 3.13, FastAPI, Edge TTS, PyMuPDF, PDF.js, SQLite

## Comandos

```bash
# Dev local
pip install -r requirements.txt
DB_PATH=./data/echo.db UPLOAD_DIR=./data/uploads AUDIO_DIR=./data/audio uvicorn main:app --reload --port 8095

# Docker (produção usa docker-compose)
docker compose up --build
```

## Arquitetura

```
Echo/
├── main.py              # FastAPI (rotas, upload, player, audio, auth)
├── docker-compose.yml   # Container + volume + Traefik labels
├── Dockerfile           # Python 3.13-slim, porta 8095
├── src/
│   ├── database.py      # SQLite (users, sessions, documents, chunks, progress)
│   ├── pdf_parser.py    # PyMuPDF — extração, chunking, cover, pages, TOC, words
│   └── tts_service.py   # Edge TTS (AntonioNeural, cache MP3, word boundaries)
├── static/
│   ├── index.html       # App (biblioteca + reader + player + settings)
│   ├── login.html       # Login (token-based)
│   ├── register.html    # Registro
│   └── landing.html     # Landing page
└── data/                # Volume persistente (/app/data)
    ├── echo.db          # SQLite (WAL mode)
    ├── uploads/         # PDFs originais
    ├── audio/           # MP3 cache + .json word boundaries
    ├── covers/          # PNG da capa (primeira página, 400px)
    └── pages/{doc_id}/  # PNGs renderizados por página (800px)
```

## Auth

- **Método primário:** Bearer token via `Authorization` header
- **Token armazenado em:** `localStorage('echo_token')` no browser
- **Fallback:** Cookie `echo_session` (httponly, samesite=lax)
- **Login:** `POST /api/auth/login` retorna `{ ok, name, token }` no body
- **Sem redirects server-side:** /app e /login sempre servem HTML, JS controla auth
- **Fetch interceptor:** index.html injeta `Authorization: Bearer` em todas chamadas `/api/`

## Deploy (Coolify)

- **Build pack:** `dockercompose` (docker-compose.yml)
- **Container name:** `echo-iws04g0kow8w44o40ocsw4s0-{timestamp}`
- **Coolify App UUID:** `iws04g0kow8w44o40ocsw4s0`
- **Porta:** 8095
- **Volume:** Docker named volume `iws04g0kow8w44o40ocsw4s0_echo-data` → `/app/data`
- **Rede:** `coolify` (Traefik roteia via labels no docker-compose.yml)
- **Env vars:** nenhuma obrigatória (Edge TTS é grátis)
- **Deploy:** Push to main → GitHub App webhook → Coolify auto-build
- **Deploy manual:** `curl -s "https://apps.cloudesneper.com.br/api/v1/deploy?uuid=iws04g0kow8w44o40ocsw4s0&force=true" -H "Authorization: Bearer 5|claude-deploy-token-2026"`

### Cuidados no deploy
- Coolify pode manter container antigo rodando (rolling deploy). Verificar com: `ssh root@46.224.220.223 "docker ps | grep iws04"`
- Se dois containers, matar o antigo: `docker stop {old_id} && docker rm {old_id}`
- O volume persiste entre deploys (Docker named volume)

## API

| Método | Rota | Auth | Descrição |
|--------|------|------|-----------|
| POST | `/api/auth/login` | - | Login → retorna token |
| POST | `/api/auth/register` | - | Registro → retorna token |
| GET | `/api/auth/me` | Bearer | Info do user logado |
| POST | `/api/auth/logout` | Bearer | Destroi sessão |
| POST | `/api/documents` | - | Upload PDF (multipart) |
| GET | `/api/documents` | - | Listar biblioteca |
| GET | `/api/documents/{id}` | - | Detalhes + chunks |
| DELETE | `/api/documents/{id}` | - | Remover (limpa files) |
| GET | `/api/documents/{id}/pdf` | Bearer | Serve PDF original |
| GET | `/api/documents/{id}/toc` | - | Table of contents |
| GET | `/api/documents/{id}/search?q=` | - | Busca full-text |
| POST | `/api/documents/{id}/chunks/{i}/audio` | - | Gerar áudio chunk |
| GET | `/api/documents/{id}/chunks/{i}/text` | - | Texto do chunk |
| GET | `/api/documents/{id}/pages/{p}.png` | - | Página renderizada |
| GET | `/api/documents/{id}/pages/{p}/words` | - | Posições das palavras |
| GET | `/api/covers/{id}.png` | - | Capa do documento |
| PUT | `/api/documents/{id}/progress` | - | Salvar progresso |
| GET | `/api/voices` | - | Listar vozes |
| GET | `/api/health` | - | Health check |
| POST | `/api/admin` | admin_key | Debug/manutenção |
