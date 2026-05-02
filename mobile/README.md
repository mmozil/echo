# Echo Mobile

App nativo (iOS + Android) do Echo. Compartilha backend com a versão web — **mesmo login, mesmo progresso, sincroniza automaticamente**.

## Stack

- Expo SDK 54 + React Native 0.81
- Expo Router (file-based)
- **react-native-track-player** (background audio + lockscreen controls + controles do fone)
- react-native-svg (highlights — mesma técnica path do web)
- expo-image (cache memory+disk)
- TanStack Query (cache + refetch)
- expo-secure-store (token JWT)

## ⚠️ Requer Dev Client

`react-native-track-player` é um módulo nativo. **Não roda no Expo Go**. Você precisa criar um dev client uma vez:

### Opção A — Build local (Android, mais rápido)

Precisa do **Android Studio** instalado.

```bash
cd D:/Project/Hovio/Echo/mobile
npx expo prebuild --clean       # gera ios/ e android/
npx expo run:android             # buildando + instala no dispositivo USB ou emulador
```

Depois disso, `npx expo start --lan --dev-client` e abre no app que ficou instalado.

### Opção B — EAS Build cloud (sem Mac/Android Studio local)

```bash
npm install -g eas-cli
eas login
eas build --profile development --platform android   # Android APK (~10min)
eas build --profile development --platform ios       # iOS ad-hoc (precisa Apple Developer)
```

Recebe link de download por email, instala no celular, roda `npx expo start --dev-client`.

### Opção C — Continuar testando audio basic em Expo Go (pré track-player)

Reverte commit `[hash]` antes do track-player. Não recomendado — perde lockscreen.

## Comandos

```bash
npm install --legacy-peer-deps
npx expo start --dev-client       # após build do dev client
```

## Sync com web

- Login: mesmo email/senha do `echo.hovio.com.br`
- Token JWT salvo em `SecureStore` (encrypted keychain iOS / EncryptedSharedPreferences Android)
- Cada play/pause/seek/chunk salva via `PUT /api/documents/{id}/progress`
- Web faz `GET /api/documents/{id}` no foco da aba e pula para o último ponto

## Roadmap

- [x] Auth + Library + Reader baseline
- [x] SVG highlight no PDF (mesma técnica do web)
- [x] Player Apple Books style com cover, tempos globais, controles
- [x] TOC sheet (capítulos com páginas)
- [x] Speed sheet (modal de velocidade)
- [x] Click palavra → seek exato (mapa pré-construído alignment-style)
- [x] **Background audio + lockscreen controls** (react-native-track-player)
- [ ] Offline cache (downloads de áudio + PNGs por documento)
- [ ] Highlights/notas → Obsidian sync
- [ ] AI chat sobre o livro (via AgentOptimus)
- [ ] EPUB + DOCX support
- [ ] Voz clonada via ElevenLabs
- [ ] Apple Watch / CarPlay
