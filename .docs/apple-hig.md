# Apple HIG — o que vale hoje, tirado da fonte

> **Baixado de `developer.apple.com/design/human-interface-guidelines` em 25/09/2026**,
> lendo as páginas no navegador (elas são montadas por JavaScript — buscador de texto
> volta vazio). Páginas lidas: `typography`, `layout`, `buttons`, `materials`, `sheets`,
> `color`, `accessibility`, `sf-symbols`.
>
> 🚨 **Isto substitui a `skill-mobile-design` como fonte.** Aquela skill é um resumo nosso
> de 290 linhas do HIG **clássico**: tem **zero** menção a Liquid Glass, iOS 26 ou
> SF Symbols. Serve para o que não mudou (grade de 8, alvo de 44pt); não serve para o
> visual atual.

---

## 1 · Tipografia — a escala do iOS, literal

**A Apple não publica UMA escala: publica 22 tabelas**, uma para cada tamanho do
Dynamic Type (`xSmall` → `AX5`), mais macOS e watchOS. A do iPhone em ajuste de fábrica
é **`Large (default)`**:

| Estilo | Peso | Tamanho | Entrelinha | Peso enfatizado |
|---|---|---|---|---|
| Large Title | Regular | **34** | **41** | Bold |
| Title 1 | Regular | 28 | 34 | Bold |
| Title 2 | Regular | 22 | 28 | Bold |
| Title 3 | Regular | 20 | 25 | Semibold |
| Headline | **Semibold** | 17 | 22 | Semibold |
| Body | Regular | **17** | **22** | Semibold |
| Callout | Regular | 16 | 21 | Semibold |
| Subhead | Regular | 15 | 20 | Semibold |
| Footnote | Regular | 13 | 18 | Semibold |
| Caption 1 | Regular | 12 | 16 | Semibold |
| Caption 2 | Regular | 11 | 13 | Semibold |

🚨 **Corpo é 17pt e mínimo é 11pt** (tabela «Platform / Default size / Minimum size»:
iOS 17pt padrão, 11pt mínimo). Abaixo de 11 não existe.

🚨 **O `Headline` é o MESMO 17pt do corpo, mudando só o peso.** A hierarquia da Apple é
por **peso**, não por tamanho — é por isso que app com oito tamanhos numa tela parece
amador: ele tenta fazer com tamanho o que se faz com peso.

**Regras textuais, verbatim:**
- *"Use font sizes that most people can read easily."*
- *"In general, avoid light font weights."*
- *"Adjust font weight, size, and color as needed to emphasize important information."*
- *"Minimize the number of typefaces you use, even in a highly customized interface."*
- *"Make sure your app's layout adapts to all font sizes."*
- *"Keep text truncation to a minimum as font size increases."*
- *"Maintain a consistent information hierarchy regardless of the current font size."*
- *"Maximize the contrast between text and the background of its container."*

---

## 2 · Liquid Glass — o material atual, e onde ele NÃO vai

> *"Apple platforms feature two types of materials: **Liquid Glass**, and standard
> materials. Liquid Glass is a dynamic material that unifies the design language across
> Apple platforms, allowing you to present controls and navigation without obscuring
> underlying content."*

> *"Liquid Glass forms a distinct **functional layer** for controls and navigation
> elements — like tab bars and sidebars — that **floats above the content layer**."*

🚨 **As três regras que mais pegam:**
- *"**Don't use Liquid Glass in the content layer.**"*
- *"**Use Liquid Glass effects sparingly.**"*
- *"**Only use clear Liquid Glass for components that appear over visually rich backgrounds.**"*

Ou seja: são **duas variantes** (regular e *clear*), e a *clear* só entra sobre fundo
visualmente rico. Mais:
- *"Help ensure legibility by using vibrant colors on top of materials."*
- *"Apply color sparingly to the Liquid Glass material, and to symbols or text on the material."*
- *"Use color sparingly, especially on glass."*
- *"Prefer translucency to opaque colors in windows."*

---

## 3 · Folhas (sheets)

- *"**Include a grabber in a resizable sheet.**"*
- *"**Support swiping to dismiss a sheet.**"*
- *"**In an iPhone app, consider supporting the medium detent** to allow progressive
  disclosure of the sheet's content."*
- *"Display only one sheet at a time from the main interface."*
- *"Present a sheet in a reasonable default size."*
- *"Keep sheet interactions brief and occasional."*
- *"Provide an alternative to the Done button."*

---

## 4 · Botões e alvo de toque

- *"**Make buttons easy for people to use.**"*
- *"**Always include a press state for a custom button.**"*
- *"In general, prefer circular or capsule-shape buttons."*
- *"Prefer buttons that have a discernible background shape and fill."*
- *"Provide enough space around a button to make it easy for people to look at it."*
- *"Ensure that each button clearly communicates its purpose."*
- *"Prefer buttons that span the width of the screen for primary actions in your app."*
- *"Avoid creating a custom button that uses a white background fill and black text or icons."*
- Da acessibilidade: *"**Offer sufficiently sized controls.**"* e
  *"**Consider spacing between controls as important as size.**"*

---

## 5 · Layout

- *"**Adhere to the screen's safe area.**"*
- *"**Use consistent spacing.**"*
- *"**Include enough space around controls for them to be easy to interact with.**"*
- *"**Avoid placing more than two or três controls side by side in your interface.**"*
  🚨 A pílula do player tinha **sete**.
- *"Avoid placing controls or critical information at the bottom of a window."*
- *"Order content by relative importance."*
- *"Group related items to clearly express related information or functions."*
- *"Use progressive disclosure to make layouts cleaner and easier to interact with."*
- *"**Differentiate controls from content.**"*
- *"Be prepared for text-size changes."*

---

## 6 · Cor

- *"**Avoid using the same color to mean different things.**"*
- *"**Avoid relying solely on color** to differentiate between objects, indicate
  interactivity, or communicate essential information."*
- *"**Avoid hard-coding system color values in your app.**"*
- *"Make sure all your app's colors work well in light, dark, and increased contrast contexts."*
- *"Prefer using color in bold text and large areas."*
- *"Consider choosing a limited color palette that coordinates with your app logo."*

---

## 7 · Acessibilidade — o que o app ignora hoje

- *"**Support larger text sizes.**"* 🚨 Tudo no Echo é tamanho fixo. O Dynamic Type
  **não** chega. É a lacuna documentada mais grave, e a razão das 22 tabelas existirem.
- *"Strive to meet color contrast minimum standards."*
- *"Convey information with more than color alone."*
- *"Describe your app's interface and content for VoiceOver."*
- *"Use haptics in addition to audio cues."*
- *"Offer alternatives to gestures."* 🚨 O player novo tem gesto de puxar; precisa de
  caminho por toque para a mesma ação — e tem (tocar na capa abre o player grande).

---

## Como atualizar esta nota

As páginas são montadas por JavaScript; `curl` e buscador de texto voltam vazios.
Abrir no navegador, esperar ~3 s, e extrair: a Apple marca **cada diretriz em
`<strong>`**, e as tabelas de escala estão em `<table>`.

🚨 **A tabela certa não é a primeira.** Das 22 com «Large Title», a do iPhone é a
**quarta** (`xSmall`, `Small`, `Medium`, **`Large (default)`**). Peguei a primeira na
primeira tentativa e vinha **watchOS** — corpo de 14pt. Aplicar aquilo teria deixado o
app **menor**, o oposto do pedido. Conferir sempre por um valor âncora: **Body = 17**.
