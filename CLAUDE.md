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
npx expo start --dev-client   # 🚨 NÃO Expo Go — ver abaixo
```

## Mobile (`mobile/`)

App nativo React Native + Expo SDK 54, mesmo backend. Compartilha login/progresso com a versão web automaticamente via JWT em SecureStore + `PUT /api/documents/{id}/progress`.

- **Estrutura:** Expo Router (file-based) — `app/_layout.tsx`, `app/login.tsx`, `app/index.tsx` (library), `app/reader/[id].tsx`
- **Áudio:** **`react-native-track-player` v4** (background + controles na tela de bloqueio). `expo-av` continua no `package.json` como sobra da fase anterior, **sem um único import** — não é o motor.
- 🚨 **Expo Go NÃO serve.** O `TrackPlayerModule` é código nativo e não existe lá: no Expo Go o app abre e simplesmente não sai som, e o diagnóstico natural (errado) é "o áudio do mobile quebrou". Usar dev-client ou build nativo.
- 🚨 **`react-native-track-player` NÃO entra em `plugins` do `app.json`.** A versão 4.1.2 não traz `app.plugin.js`, e listá-la ali fazia `npx expo config`/`prebuild`/`eas build` **abortar** antes de gerar o projeto nativo (*"Verify that react-native-track-player includes a config plugin"*) — nenhum binário podia ser produzido. O pacote não precisa de plugin: o `AndroidManifest.xml` dele já declara o `MusicService` com `foregroundServiceType="mediaPlayback"`, e as permissões estão em `android.permissions`.
- 🚨 **O avanço de trecho mora em `service.ts`, fora da árvore do React.** Ele vivia num `useTrackPlayerEvents` dentro de `reader/[id].tsx`: sair da tela de leitura desmontava o componente, o React limpava a inscrição, e a voz parava no fim do trecho corrente. Hoje a tela só **registra** como avançar (`definirAvanco` em `src/lib/player.ts`) e o playback service chama. **Não pôr cleanup no desmonte** — seria devolver o defeito.
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

### Vozes (4 pt-BR, escolha por conta)

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

#### Dora — a 4ª voz, pelo Kokoro (09/2026)

Dois motores convivem. `kokoro:pf_dora` é servida pelo container **`kokoro-tts`
que já roda para o Tier Agent** (5 GB / 6 vCPU, rede `coolify`) — RAM extra
zero, custo zero, sem chave.

| | edge-tts | Kokoro (Dora) |
|---|---|---|
| trecho de ~1.000 caracteres | **~4 s** | 12–20 s |
| marcação de palavra | aproximada | **1 para 1, exata** |

- 🚨 **A marcação do Kokoro é MELHOR.** `/dev/captioned_speech` devolve uma
  marcação por palavra, na grafia exata do texto: medido 177 para 177, e o
  `boundaryToWordMap` sai **identidade**. O `WordBoundary` do Edge não casa
  1 para 1 (89 para ~100 palavras, 12 delas de um caractere) e obriga o front
  a casar por aproximação com janela de 15.
- 🚨 **A resposta é NDJSON**, não um JSON só: áudio em base64 pedaço a pedaço,
  marcações espalhadas pelas linhas. `json.loads()` no corpo inteiro estoura
  com «Extra data». O concatenado toca: 63,5 s de áudio com a última marcação
  em 62,6 s.
- 🚨 **Sem `KOKORO_URL` a voz não é oferecida E não é aceita** — quem escolheu
  a Dora antes de o motor sair do ar volta para a padrão e continua ouvindo,
  em vez de tomar erro a cada trecho.
- 🚨 **O container capado morre por OOM ao paralelizar** (no Tier Agent, a
  2 GB, caiu servindo 4 frases juntas). Por isso o mesmo semáforo de
  simultâneos do Edge vale aqui, e pesa mais.
- O preço é o tempo, e ele **aparece na tela**: a voz vem com o aviso «gera
  mais devagar», dito antes de escolher. Livro de 148 trechos leva ~30 min de
  pré-geração contra ~10 min do Edge — mas é em segundo plano.
- Env no Coolify: `KOKORO_URL=http://kokoro-tts:8880` (criada nas duas faces,
  produção e preview — o Coolify limpa o `.env` a cada deploy).
- Medição completa: [memory/reference_kokoro_para_o_echo_20260923.md].

### Precisão da leitura — o narrador soletrava (09/2026)

O PyMuPDF devolve título com **letter-spacing** como letras soltas, e a folga
guarda a informação: **um espaço separa LETRA, dois ou mais separam PALAVRA**.

```
'T E X T O  B Í B L I C O  P A R A  M E D I T A Ç Ã O'
 ^ letra     ^^ fronteira de palavra
```

O `re.sub(r" {2,}", " ", ...)` que vinha logo depois colapsava os dois em um e
apagava a fronteira. O edge-tts recebia letras e soletrava — **medido no
narrador**: 25 unidades faladas (`['T','E','X','T','O','B',...]`) contra 4
depois da correção (`['TEXTO','BÍBLICO','PARA','MEDITAÇÃO']`), com áudio 57%
mais curto.

- **119 das 148 páginas** de "Buscando os Dons Espirituais" tinham trecho
  soletrado (618 trechos). Nos outros dois livros da biblioteca, **zero** — é
  característica do PDF, não do leitor, e por isso eles servem de controle: com
  a correção saem byte a byte idênticos.
- 🚨 **A de-soletração roda POR LINHA e ANTES de colapsar espaço.** Depois não
  dá: a fronteira já se perdeu. Mesma razão para o corte de número de página —
  a regra antiga rodava depois da junção de linhas e **nunca casava com nada**.
- 🚨 **O freio contra falso positivo é a CAIXA ALTA.** Em português "o", "a" e
  "e" são palavras; três seguidas casariam com o padrão. Só dispara em caixa
  alta ou com 5+ sinais.
- 🚨 **Cabeçalho corrente sai pela POSIÇÃO, não pela repetição** (301 leituras
  repetidas em 144 páginas). O Essencialismo repete trecho de corpo legítimo
  ('Sent', 'Acha que'): deduplicar por igualdade apagaria texto de verdade.
  Cabeçalho vive na margem (y<0,12 ou y>0,88), texto vive no miolo.
- 🚨 **`get_word_positions_on_page` junta as letras também.** O destaque no PDF
  casa aquela lista com o texto do trecho; se o texto diz "TEXTO" e a lista traz
  'T','E','X','T','O', o realce anda sozinho e erra a linha.
- ⚠️ **Limite conhecido:** a correção depende de o PDF ter deixado a folga dupla
  entre palavras. Num PDF que espaça tudo por igual, a informação não existe e
  o resultado sairia colado ("TEXTOBÍBLICO"). Não foi o caso de nenhum dos três
  livros da biblioteca. O conserto definitivo seria geométrico (`rawdict`).
- **Livro já subido** não é alcançado pela correção (o texto está em
  `chunks.text_content`): `python scripts/reprocessar_documento.py --aplicar`
  reextrai e **atualiza no lugar**, preservando `chunks.id` e, com ele, o
  progresso de leitura. Sem `--aplicar` é prévia.

### Sumário — quando o índice do PDF não é um índice (09/2026)

Editor gráfico costuma virar **cada caixa de texto** em marcador. Medido:

| livro | entradas | páginas | por página |
|---|---|---|---|
| Essencialismo | 32 | 215 | 0,15 |
| Carnegie | 43 | 294 | 0,15 |
| Dons Espirituais | **565** | 148 | **3,82** |

São 25× de separação — por isso o corte em **1,0 entrada por página** não é
chute. Reprovado o outline, o sumário é **derivado da tipografia**: 15 entradas
no lugar de 565, e os 12 capítulos batem com o sumário impresso do próprio
livro (páginas 4 e 5), que serve de conferência independente.

- Corpo de texto é medido **só nas linhas longas (40+ caracteres)** — essas são
  corpo por definição. Tomar a moda de tudo aponta para o tamanho errado em
  livro com muita legenda e infográfico.
- Título de display quebra em várias linhas ('Um Dom' / 'Para Quê?'): linhas
  seguidas, mesma página, mesmo corpo de letra e coladas na vertical são o
  **mesmo** título.
- 🚨 **`get_toc` é CACHEADO.** Derivar custa **1.702 ms** num livro de 148
  páginas contra 3 ms quando o outline serve, e a rota é `async`: sem cache,
  cada abertura do leitor travava o servidor inteiro por quase dois segundos.
- Na tela: `.toc-item.active` existia no CSS e **nunca era aplicada** — regra
  morta. Hoje o item aceso segue a leitura e a lista rola sozinha, mas **recua
  por 5s quando a mão está nela**.

### Tocar com a tela apagada (09/2026)

Quatro causas independentes do mesmo sintoma ("saí da tela e parou de falar"):

1. 🚨 **`await requestAnimationFrame` no caminho do áudio.** A especificação
   manda o navegador **não servir quadro** para documento escondido: a promessa
   ficava pendurada para sempre e o `audio.src` do trecho seguinte nunca era
   atribuído. **A ordem agora é SOM PRIMEIRO, ENFEITE DEPOIS** — nada que só
   desenhe fica entre ter a URL e mandar tocar. Eram **três** ocorrências no
   arquivo; a terceira só apareceu conferindo o que subiu.
2. **Sem `navigator.mediaSession`** o sistema não reconhece a aba como
   reprodutor: nada na tela de bloqueio e menos prioridade para não ser suspensa.
3. **Um 401 em prefetch de fundo** fazia `window.location.href='/login'`: a
   página era descarregada e o `<audio>` morria junto, com o telefone no bolso.
   Hoje o aviso fica guardado e só leva ao login quando a tela volta.
4. **No mobile**, o avanço de trecho morava num hook do React — ver a seção
   Mobile acima.

## Deploy (Coolify)

- **Build pack:** `dockercompose` (docker-compose.yml)
- **Container name:** `echo-iws04g0kow8w44o40ocsw4s0-{timestamp}`
- **Coolify App UUID:** `iws04g0kow8w44o40ocsw4s0`
- **Porta:** 8095
- **Volume:** Docker named volume `iws04g0kow8w44o40ocsw4s0_echo-data` → `/app/data`
- **Rede:** `coolify` (Traefik roteia via labels no docker-compose.yml)
- **Env vars:** nenhuma obrigatória (Edge TTS é grátis)
- **Deploy:** Push to main → GitHub App webhook → Coolify auto-build
- 🚨 **O webhook nem sempre dispara** (conferido em 22/09/2026: push entrou, `docker logs coolify` não registrou `ApplicationDeploymentJob`). Depois de dar push, confirmar que o container foi recriado; se não, chamar o deploy na mão.
- **Deploy manual:** `curl -X POST -s "https://coolify.tier.finance/api/v1/deploy?uuid=iws04g0kow8w44o40ocsw4s0&force=true" -H "Authorization: Bearer 5|claude-deploy-token-2026"`
  (a URL antiga `apps.cloudesneper.com.br` **não resolve mais** — o `APP_URL` do Coolify é `https://coolify.tier.finance`. Acompanhar com `GET /api/v1/deployments/{deployment_uuid}`.)

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
