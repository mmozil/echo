# CLAUDE.md — Echo

## Resumo

Echo é um leitor de documentos com voz AI. Upload de PDFs → extração de texto → TTS com Microsoft Edge (pt-BR-AntonioNeural). Speechify pessoal, gratuito.

**URLs:**
- Web: https://echo.hovio.com.br
- API: https://echo.hovio.com.br (mesma origem)
- Mobile: app nativo iOS + Android em `mobile/` (Expo SDK 54)

**Repo:** github.com/mmozil/echo
**Stack:** Python 3.13, FastAPI, Edge TTS, PyMuPDF, PDF.js (web), React Native (mobile), SQLite

## Comandos

```bash
# Backend dev
pip install -r requirements.txt
DB_PATH=./data/echo.db UPLOAD_DIR=./data/uploads AUDIO_DIR=./data/audio uvicorn main:app --reload --port 8095

# Docker (produção usa docker-compose)
docker compose up --build

# Mobile (Expo)
cd mobile
npm install
npx expo start --lan       # Expo Go scanea QR
```

## Mobile (`mobile/`)

App nativo React Native + Expo SDK 54, mesmo backend. Compartilha login/progresso com a versão web automaticamente via JWT em SecureStore + `PUT /api/documents/{id}/progress`.

- **Estrutura:** Expo Router (file-based) — `app/_layout.tsx`, `app/login.tsx`, `app/index.tsx` (library), `app/reader/[id].tsx`
- **Áudio:** `expo-av` baseline; roadmap: `react-native-track-player` (background + lockscreen controls)
- **Highlights:** `react-native-svg` com mesma técnica de path do web (1 path com sub-paths round-rect por linha da frase)
- **PDF rendering:** PNG do servidor (`/api/documents/{id}/pages/{p}.png`) — sem PDF.js no mobile, mesma estratégia do fallback web
- **Sync:** progresso salva em cada chunk transition; web detecta no foco da aba via `GET /api/documents/{id}`

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

### Propriedade dos documentos (corrigido em 08/2026)

Até 08/2026 a tabela `documents` **não tinha coluna de dono** e as rotas de
documento não pediam sessão: um `curl` sem token listava e apagava a biblioteca
de todo mundo. Hoje:

- `documents.user_id` e `reading_progress(user_id, document_id)` — migração
  idempotente em `src/database.py` (`ALTER TABLE` guardado por `PRAGMA
  table_info`; `reading_progress` foi recriada porque SQLite não troca PK).
- Documentos legados (sem dono) são adotados pelo **usuário mais antigo** no
  primeiro boot. Órfão nunca é apagado nem escondido.
- 🚨 **Mídia se autentica pelo COOKIE, não pelo Bearer.** `<img>`, `<audio>` e o
  PDF.js não conseguem mandar header `Authorization` — quem carrega capa,
  página PNG, MP3 e PDF é o navegador, e ele leva sozinho o cookie httponly
  `echo_session` por ser mesma origem. Exigir Bearer nessas rotas quebra o app
  inteiro. URL assinada foi descartada: seria um segundo tipo de credencial e
  colocaria token dentro da URL (log, histórico, Referer, cache de CDN).
- No **mobile não há cookie**: lá vai o mesmo Bearer por header — `expo-image`
  aceita `headers` no `source` e o `react-native-track-player` na track
  (`authHeaders()` em `mobile/src/lib/api.ts`).
- Toda resposta de mídia sai com `Cache-Control: private, no-store` — sem isso a
  Cloudflare cachearia os `.png` pela extensão e entregaria a capa de um
  usuário para outro, com a rota já protegida.
- `POST /api/auth/register` **não sobrescreve conta existente** (devolve 409).
  Antes chamava `create_or_update_user`: quem soubesse o e-mail de alguém
  trocava a senha da vítima e entrava na conta dela.
- Testes: `pytest tests/ -q` (deps em `requirements-dev.txt`).

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
| POST | `/api/auth/session-cookie` | Bearer | Reemite o cookie de sessão (mídia) |
| POST | `/api/documents` | dono | Upload PDF (multipart) |
| GET | `/api/documents` | dono | Listar biblioteca (só a do usuário) |
| GET | `/api/documents/{id}` | dono | Detalhes + chunks |
| DELETE | `/api/documents/{id}` | dono | Remover (limpa files) |
| GET | `/api/documents/{id}/pdf` | dono | Serve PDF original |
| GET | `/api/documents/{id}/toc` | dono | Table of contents |
| GET | `/api/documents/{id}/search?q=` | dono | Busca full-text |
| POST | `/api/documents/{id}/chunks/{i}/audio` | dono | Gerar áudio chunk |
| GET | `/api/documents/{id}/chunks/{i}/text` | dono | Texto do chunk |
| GET | `/api/documents/{id}/pages/{p}.png` | dono | Página renderizada |
| GET | `/api/documents/{id}/pages/{p}/words` | dono | Posições das palavras |
| GET | `/api/covers/{id}.png` | dono | Capa do documento |
| PUT | `/api/documents/{id}/progress` | dono | Salvar progresso (por usuário) |
| GET | `/api/voices` | Bearer/cookie | Listar vozes |
| GET | `/api/health` | - | Health check |
| POST | `/api/admin` | `ECHO_ADMIN_KEY` | Debug/manutenção (desligado sem a env) |

**dono** = exige sessão *e* ser o dono do documento. Documento de outra pessoa
responde **404**, nunca 403 — 403 confirmaria que aquele id existe.
