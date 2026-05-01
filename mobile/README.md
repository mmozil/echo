# Echo Mobile

App nativo (iOS + Android) do Echo. Compartilha o backend com a versão web — **mesmo login, mesmo progresso, sincroniza automaticamente**.

## Stack

- Expo SDK 54 + React Native 0.81
- Expo Router (file-based)
- expo-av (áudio com background)
- react-native-svg (highlights — mesma técnica path do web)
- TanStack Query (cache + refetch)
- expo-secure-store (token JWT)

## Rodar localmente

```bash
cd D:/Project/Hovio/Echo/mobile
npm install
npx expo start --lan
```

Escaneia o QR no Expo Go (Android) ou Camera (iOS).

## Build standalone (TestFlight / Play Store)

```bash
npm install -g eas-cli
eas login
eas build --profile preview --platform android   # APK
eas build --profile production --platform ios    # IPA → TestFlight
```

## Sync com web

- Login: mesmo email/senha do `echo.hovio.com.br`
- Token JWT salvo em `SecureStore` (encrypted keychain iOS / EncryptedSharedPreferences Android)
- Cada play/pause/seek/chunk salva via `PUT /api/documents/{id}/progress`
- Web faz `GET /api/documents/{id}` no foco da aba e pula para o último ponto

## Próximos passos (roadmap)

- [x] Auth + Library + Reader baseline
- [x] SVG highlight no PDF
- [x] Player com cover, tempos globais, controles
- [ ] **Background audio** (`react-native-track-player` — controles na lockscreen)
- [ ] Offline cache (downloads de áudio + PNGs por documento)
- [ ] Sync inverso: web detecta mudança do mobile e pula
- [ ] Dark/light theme toggle
- [ ] Upload de PDF do mobile (usar expo-document-picker)
- [ ] Splash + ícone customizado
