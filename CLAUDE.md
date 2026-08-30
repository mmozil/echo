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

### Cadastro fechado por padrão (08/2026)

Qualquer pessoa criava conta em `echo.hovio.com.br` e gastava disco e CPU com
upload e TTS. Agora quem manda é a env **`ECHO_CADASTRO`**, e **sem ela o
cadastro fica FECHADO** — em produção ela não está definida, então ninguém abre
conta nova. **Login não é afetado: quem já tem conta entra normalmente.**

| `ECHO_CADASTRO` | O que acontece |
|---|---|
| ausente / `fechado` | `POST /api/auth/register` devolve **403** com frase explicando |
| `convite` | exige `codigo` igual a **`ECHO_CONVITE_CODIGO`** (env vazia = ninguém entra) |
| `aberto` | como era antes |

`GET /api/auth/cadastro-status` é público e diz o modo — o `register.html`
pergunta antes de desenhar o formulário: com o cadastro fechado ele **esconde o
formulário e mostra a frase**, em vez de deixar a pessoa digitar tudo para levar
um 403 seco; no modo convite ele mostra o campo do código.

**🔑 Como criar uma conta depois (dois caminhos, sem trancar ninguém para fora):**

1. **Sem redeploy** — direto no container, o mais rápido:
   ```bash
   ssh root@46.224.220.223
   C=$(docker ps --filter name=iws04 --format '{{.Names}}' | head -1)
   docker exec -i $C python -c "from src.database import create_user; print(create_user('Nome da Pessoa','email@dominio','senhaSegura'))"
   ```
   Imprime o `user_id`. Se o e-mail já existir, imprime `None` (não sobrescreve).
2. **Por convite, pelo Coolify** — adicionar `ECHO_CADASTRO=convite` e
   `ECHO_CONVITE_CODIGO=<código>` nas env vars do app `iws04g0kow8w44o40ocsw4s0`,
   redeploy, mandar o código para a pessoa, e depois voltar `ECHO_CADASTRO`
   para `fechado` (ou remover a env) e redeployar.

### Sessão com prazo (08/2026)

Antes nenhuma sessão vencia — eram 49 tokens vivos, e um token vazado valia para
sempre. Agora: **30 dias com janela deslizante** (`ECHO_SESSAO_DIAS` muda o
prazo). O uso renova, então quem lê todo dia nunca é deslogado.

- A validação acontece na **leitura** da sessão (`get_user_by_session`), não só
  na criação: é o único ponto por onde toda requisição autenticada passa.
- Renovação com no máximo **uma escrita por dia** por sessão.
- Sessão vencida sai do banco na hora, e o **401 devolve `Set-Cookie` apagando o
  `echo_session`** — senão o navegador segue mandando credencial que o servidor
  recusa, e a tela não sabe explicar (o limbo clássico de sessão expirada).
- Web e mobile mandam para o **login** ao receber 401 (interceptor de `fetch` no
  `index.html`, interceptor do axios em `mobile/src/lib/api.ts`).
- 🚨 **As sessões que já existiam ganharam prazo a partir da migração, não do
  `created_at`.** Contar do `created_at` deslogaria o dono da web e do app no
  segundo do deploy — quase todas passavam de 30 dias. Contando de agora, o
  risco antigo morre igual, só que sem derrubar ninguém no meio da leitura.

### Vozes (3 pt-BR, escolha por conta)

`VOZES_PT_BR` em `src/tts_service.py` — **Francisca**, **Antônio**, **Thalita**.
As de Portugal (`pt-PT-*`) ficam de fora: sotaque europeu se ouve na hora. A
lista sai da constante, não da API do Edge, para a tela não depender de rede
nem oferecer voz que o resto do código recusa (`voz_valida()`).

- A escolha vive em **`users.voice`** (migração idempotente), não em
  `localStorage` — o dono quer a mesma voz na web e no app, e quer que ela
  sobreviva ao logout.
- Trocável **durante a leitura**: botão ao lado da velocidade, no player
  (web: `cycleVoice()`; mobile: folha de seleção igual à de velocidade).
- 🚨 **A voz entra na chave do cache de áudio.** O arquivo é
  `{chunk_id}_{md5(texto:voz:rate:pitch)}.mp3` (+ o `.json` de word boundaries,
  que muda junto). Sem a voz na chave, trocar de voz continuaria tocando o MP3
  antigo e pareceria que a troca não funciona — quando o errado é o cache.
- 🚨 **Trocar de voz não apaga nada**: voltar para a voz anterior reaproveita o
  MP3 que já existia (`cached: true`). Quem apaga tudo é só o DELETE do
  documento, e ele varre `{chunk_id}_*` para não deixar MP3 órfão de outra voz.
- 🚨 Ao trocar de voz o front **limpa o prefetch**: os próximos trechos já
  tinham sido baixados na voz antiga.

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
| GET | `/api/auth/cadastro-status` | - | Diz se o cadastro está aberto/convite/fechado |
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
| GET | `/api/voices` | Bearer/cookie | As 3 vozes pt-BR + a escolhida na conta |
| PUT | `/api/voices/selected` | Bearer/cookie | Troca a voz da conta |
| GET | `/api/health` | - | Health check |
| POST | `/api/admin` | `ECHO_ADMIN_KEY` | Debug/manutenção (desligado sem a env) |

**dono** = exige sessão *e* ser o dono do documento. Documento de outra pessoa
responde **404**, nunca 403 — 403 confirmaria que aquele id existe.
