# -*- coding: utf-8 -*-
"""Validacao de FLUXO no codigo: telas, botoes e navegacao.

Percorre a arvore JSX e responde, elemento a elemento: **isto faz alguma
coisa? isto se toca? leva a algum lugar? da' para voltar? da' para sair?**

    python scripts/validar_fluxo.py        # sai 1 se houver ERRO

🚨 Nasceu de um defeito que passou por `tsc`, por `eas build` e por sete
   envios ao TestFlight: o `Toque` impunha `height: '100%'` a todo filho, e num
   pai `flex: 1` (os cartoes da biblioteca) isso vira altura indefinida —
   cartao sem altura NAO SE TOCA. O app «so' tocava audio», porque so' o player
   tem pais de tamanho fixo. Nenhuma ferramenta de tipo pega isso: e'
   geometria, nao tipo.

🚨 E a primeira versao DESTE arquivo deu 5 erros, 4 deles falsos: lia
   comentario como codigo e exigia altura de `View` que cresce com o conteudo.
   Validador que grita a' toa e' pior que nenhum — cada regra aqui so' acusa o
   que ela sabe provar.
"""
import glob
import os
import re
import sys

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
os.chdir(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))


def sem_comentarios(t):
    """🚨 Comentario nao e' codigo. A v1 acusou um `<Pressable>` que so'
    existia dentro de um bloco explicativo."""
    t = re.sub(r"/\*[\s\S]*?\*/", "", t)
    t = re.sub(r"^\s*//.*$", "", t, flags=re.M)
    t = re.sub(r"\{/\*[\s\S]*?\*/\}", "", t)
    return t


# 🚨 No Windows o glob devolve barra invertida. Sem normalizar, o proprio
#    validador acusou «sem volta» num arquivo que tem `router.back()`, e
#    «gesto nao declarado» num `_layout` que o declara. Instrumento que
#    mente e' pior que instrumento nenhum.
norm = lambda p: p.replace("\\", "/")
TELAS = sorted(norm(p) for p in glob.glob("app/**/*.tsx", recursive=True))
COMPS = sorted(norm(p) for p in glob.glob("src/components/*.tsx"))
FONTE = {p: sem_comentarios(open(p, encoding="utf-8").read()) for p in TELAS + COMPS}
CRU = {p: open(p, encoding="utf-8").read() for p in TELAS + COMPS}

achados = []
def erro(p, m): achados.append(("ERRO", p, m))
def nota(p, m): achados.append(("nota", p, m))


def estilos_de(texto):
    saida = {}
    for m in re.finditer(r"(\w+):\s*\{", texto):
        k, prof, tudo = m.end() - 1, 0, ""
        for ch in texto[k:k + 900]:
            tudo += ch
            prof += (ch == "{") - (ch == "}")
            if prof == 0:
                break
        if "StyleSheet" not in tudo:
            saida.setdefault(m.group(1), " ".join(tudo.split()))
    return saida


def tocaveis(texto):
    fora = []
    for m in re.finditer(r"<(Toque|Pressable|TouchableOpacity)\b", texto):
        k, prof, corpo = m.end(), 0, ""
        for ch in texto[k:k + 1600]:
            corpo += ch
            if ch in "{[":
                prof += 1
            elif ch in "}]":
                prof -= 1
            elif ch == ">" and prof <= 0:
                break
        fora.append((texto[:m.start()].count("\n") + 1, m.group(1), corpo))
    return fora


# ── 1 · todo tocavel faz alguma coisa ─────────────────────────────────────
def v_acao():
    for p, t in FONTE.items():
        for linha, tag, corpo in tocaveis(t):
            if "onPress" not in corpo:
                erro(p, "linha %d: <%s> sem `onPress` — beco sem saida" % (linha, tag))
            elif re.search(r"onPress=\{\s*\(\)\s*=>\s*\{\s*\}\s*\}", corpo):
                erro(p, "linha %d: <%s> com `onPress` VAZIO" % (linha, tag))


# ── 2 · todo tocavel se anuncia (VoiceOver) ───────────────────────────────
def v_rotulo():
    for p, t in FONTE.items():
        for linha, tag, corpo in tocaveis(t):
            if not re.search(r"(accessibilityLabel|rotulo)=", corpo):
                nota(p, "linha %d: <%s> sem rotulo de VoiceOver" % (linha, tag))


# ── 3 · quem envolve `children` NAO decide layout deles ───────────────────
# 🚨 A regra que faltava em 26/09.
def v_embrulho():
    for p in COMPS:
        t = FONTE[p]
        if "children" not in t:
            continue
        for nome, corpo in estilos_de(t).items():
            impoe = "height: '100%'" in corpo and "width: '100%'" in corpo
            centra = "alignItems: 'center'" in corpo and "justifyContent: 'center'" in corpo
            aplicado = re.search(r"style=\{\[?[^\]}]*(?:estilos|styles)\.%s\b" % nome, t)
            if impoe and centra and aplicado:
                erro(p, "`%s` impoe 100%% + centro a `children` — quebra todo pai sem "
                        "altura definida. Foi isto que derrubou o app." % nome)


# ── 4 · nenhum estilo mistura `flex: 1` com altura em porcentagem ─────────
def v_altura_ambigua():
    for p, t in FONTE.items():
        for nome, corpo in estilos_de(t).items():
            if "flex: 1" in corpo and "height: '100%'" in corpo:
                erro(p, "`%s` mistura `flex: 1` com `height: '100%%'` — altura indefinida" % nome)


# ── 5 · a navegacao fecha o circuito ──────────────────────────────────────
def v_navegacao():
    ROTA = {"/": "app/index.tsx", "/login": "app/login.tsx", "/reader": "app/reader/[id].tsx"}
    grafo, volta = [], set()
    for p, t in FONTE.items():
        for m in re.finditer(r"router\.(push|replace)\(\s*[`'\"]?([^`'\")]+)", t):
            d = m.group(2).split("$")[0]
            d = "/" if d.strip() in ("/", "") else "/" + d.strip("/").split("/")[0]
            grafo.append((p, m.group(1), d))
        if "router.back()" in t:
            volta.add(p)
    print("\n  mapa da navegacao")
    for o, tp, d in sorted(set(grafo)):
        alvo = ROTA.get(d, "?")
        print("     %-22s --%-7s--> %-9s %s" % (os.path.basename(o), tp, d, os.path.basename(alvo) if alvo != "?" else "SEM TELA"))
        if alvo == "?":
            erro(o, "navega para `%s`, que nao corresponde a nenhuma tela" % d)
        elif tp == "push" and alvo not in volta:
            erro(alvo, "e' alcancada por `push` e NAO tem `router.back()` — sem volta")
    print("     tem volta: %s" % (", ".join(sorted(os.path.basename(x) for x in volta)) or "NENHUMA"))
    gesto = "gestureEnabled: true" in FONTE.get("app/_layout.tsx", "")
    print("     gesto de arrastar da borda: %s" % ("declarado" if gesto else "NAO declarado"))
    if not gesto:
        nota("app/_layout.tsx", "gesto de voltar do iOS nao declarado")


# ── 6 · toda folha/modal abre E fecha ─────────────────────────────────────
def v_saida_das_folhas():
    for p, t in FONTE.items():
        for m in re.finditer(r"\[(\w+),\s*(set\w+)\]\s*=\s*useState\(false\)", t):
            nome, setter = m.group(1), m.group(2)
            if not re.search(r"(?:aberta?|visible)=\{%s\}" % nome, t):
                continue
            if not re.search(r"%s\(true\)" % setter, t):
                erro(p, "`%s` nunca abre" % nome)
            if not re.search(r"%s\(false\)" % setter, t):
                erro(p, "`%s` abre e NUNCA fecha — beco sem saida" % nome)
    # a folha compartilhada precisa de saida VISIVEL, nao so' gesto
    f = FONTE.get("src/components/Folha.tsx", "")
    if f and "accessibilityLabel=\"Fechar\"" not in f:
        erro("src/components/Folha.tsx", "folha sem botao de fechar visivel "
             "(«Always give people an obvious way to dismiss a modal view»)")


# ── 7 · toda tela exporta um componente ───────────────────────────────────
def v_telas():
    for p in TELAS:
        if not re.search(r"export default function", FONTE[p]):
            erro(p, "tela sem `export default` — o expo-router nao a encontra")


for f in (v_acao, v_rotulo, v_embrulho, v_altura_ambigua, v_saida_das_folhas, v_telas):
    f()

print("=" * 74)
print("VALIDACAO DE FLUXO — %d telas, %d componentes" % (len(TELAS), len(COMPS)))
print("=" * 74)
v_navegacao()

E = [a for a in achados if a[0] == "ERRO"]
N = [a for a in achados if a[0] == "nota"]
if E:
    print("\n  ERROS (%d) — bloqueiam o envio:" % len(E))
    for _, p, m in E:
        print("     x %-14s %s" % (os.path.basename(p), m))
if N:
    print("\n  notas (%d):" % len(N))
    for _, p, m in N:
        print("     ! %-14s %s" % (os.path.basename(p), m))
if not E and not N:
    print("\n  nenhum achado")
print()
sys.exit(1 if E else 0)
