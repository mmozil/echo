# Publicar o Echo no TestFlight

> 🚨 **O EAS empacota a raiz do REPOSITORIO, nao a pasta do app.** Por isso o
> build sai de `D:\echo-app`, fora do git, com `EAS_NO_VCS=1`.

## Uma vez so'

1. **Registro do app** em [App Store Connect](https://appstoreconnect.apple.com)
   → Apps → **+** → Novo app. A API **nao** cria (`403 apps does not allow CREATE`).
   - Nome: `Echo` (se duplicado, `Echo Leitor`) · Idioma: Portugues (Brasil)
   - ID do pacote: **`com.hovio.echo`** · SKU: `ECHO001`
2. Pegar o **ID do app** (numero na URL) e por em `eas.json` → `submit.production.ios.ascAppId`.

## A cada versao

```bash
D=/d/echo-app && rm -rf "$D" && mkdir -p "$D"
cd mobile && tar --exclude=node_modules --exclude=.expo --exclude=ios \
    --exclude=android --exclude="*.bak" -cf - . | (cd "$D" && tar -xf -)
mkdir -p "$D/credenciais" && cp /c/cf-cred/echo/* "$D/credenciais/"
cd "$D" && npm ci
EAS_NO_VCS=1 npx eas build  --platform ios --profile production --non-interactive
EAS_NO_VCS=1 npx eas submit --platform ios --latest --non-interactive
```

O `credentials.json` vive **so' em `D:\echo-app`**, nunca no git. Aponta para
`credenciais/perfil.mobileprovision` e `credenciais/dist.p12`; a senha do `.p12`
esta no **Obsidian → Cofre-Segredos**, secao Central Fleet.

## Conta e credenciais

- Apple: **CENTRAL FLEET CONSULTORIA EMPRESARIAL LTDA** — a unica ativa.
  Numa publicacao publica o vendedor sai como «Central Fleet».
- Certificado de distribuicao `34QDQ6B7YT`, valido ate **27/08/2027**,
  compartilhado com o Central Fleet. 🚨 A Apple permite so' **dois** por conta —
  reaproveitar, nunca criar um terceiro.
- Bundle `com.hovio.echo` = `7H9AP9SW28` · Perfil «Echo App Store» = `8684728JYZ`.
- Recriar o perfil sem 2FA: `C:\cf-cred\criar.py` (trocar `BUNDLE` e `NOME`).

## Armadilhas ja' pagas

- **`ITSAppUsesNonExemptEncryption: false`** — sem ela o TestFlight trava em
  *Missing Compliance*.
- **Icone sem canal alfa** — a Apple recusa PNG com alfa. Gerar em RGB.
- **`npx expo install`, nunca `npm install`** para pacote do Expo: o `npm` pega
  a ultima versao publicada e ela costuma ser da SDK seguinte.
- **`react-dom` fixado na versao do `react`** — o `expo-router` o pede como par
  e o npm pegava a ultima, que exige react mais novo; quebrava o `npm ci`, que
  e' o comando que a nuvem roda.
- **Nada de `channel` nem `runtimeVersion` no `eas.json`** enquanto nao houver
  `expo-updates` instalado.
