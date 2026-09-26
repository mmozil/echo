# -*- coding: utf-8 -*-
"""Auditoria estatica do app Discoo/Echo.

Roda antes de CADA build. Cada verificacao existe porque um defeito real
passou por ali — a regra e' so' entrar aqui depois de ter custado alguma coisa.

    python scripts/auditar.py

Sai 1 se houver achado BLOQUEANTE.
"""
import glob
import os
import re
import sys

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
os.chdir(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

ARQS = sorted(glob.glob("app/**/*.tsx", recursive=True) + glob.glob("src/**/*.tsx", recursive=True))
TUDO = {a: open(a, encoding="utf-8").read() for a in ARQS}
ESCALA_IOS = {34, 28, 22, 20, 17, 16, 15, 13, 12, 11}  # Large (default), developer.apple.com

bloqueios, avisos = [], []
def bloqueia(m): bloqueios.append(m)
def avisa(m): avisos.append(m)


# ── 1 ─────────────────────────────────────────────────────────────────────
# 🚨 O defeito que quebrou o app inteiro em 26/09: `Toque` impunha
#    `width/height: 100%` + `center` a TODO filho. Onde o pai tem tamanho fixo
#    (botoes do player) funcionava; nos cartoes `flex: 1` da biblioteca, nao —
#    e o app "so' tocava audio". Componente tocavel NAO decide layout do filho.
def v1_embrulho_nao_impoe_layout():
    for a, t in TUDO.items():
        for m in re.finditer(r"(\w+):\s*\{([^{}]*)\}", t):
            nome, corpo = m.group(1), m.group(2)
            tem100 = "height: '100%'" in corpo and "width: '100%'" in corpo
            centra = "alignItems: 'center'" in corpo and "justifyContent: 'center'" in corpo
            if tem100 and centra:
                # so' e' problema se esse estilo for aplicado a um CONTENEDOR de children
                if re.search(r"style=\{\[?\s*estilos\.%s|style=\{estilos\.%s" % (nome, nome), t):
                    bloqueia("%s: estilo `%s` impoe 100%% + centro a filhos — "
                             "quebra todo pai sem altura definida" % (a, nome))


# ── 2 ─────────────────────────────────────────────────────────────────────
# «Offer sufficiently sized controls» — minimo 44pt, requisito da Apple.
def v2_alvo_de_toque():
    for a, t in TUDO.items():
        for m in re.finditer(r"(\w+):\s*\{([^{}]*width:\s*(\d+),\s*height:\s*(\d+)[^{}]*)\}", t):
            nome, w, h = m.group(1), int(m.group(3)), int(m.group(4))
            if nome == "shadowOffset":
                continue
            if (w < 44 or h < 44) and re.search(r"(bot|btn|pular|tocar|nav|sair|fechar)", nome, re.I):
                avisa("%s: `%s` tem %dx%d — a Apple pede 44 minimo" % (a, nome, w, h))


# ── 3 ─────────────────────────────────────────────────────────────────────
# Escala do iOS (`Large (default)`). 🚨 A tabela certa NAO e' a primeira da
# pagina da Apple: sao 22, uma por tamanho do Dynamic Type. A ancora e' Body=17.
def v3_escala_e_entrelinha():
    for a, t in TUDO.items():
        fora = sorted({int(x) for x in re.findall(r"fontSize:\s*(\d+)", t)} - ESCALA_IOS)
        if fora:
            avisa("%s: tamanhos fora da escala do iOS: %s" % (a, fora))
        sem = [b for b in re.findall(r"\{[^{}]*fontSize:[^{}]*\}", t) if "lineHeight" not in b]
        if sem:
            avisa("%s: %d estilo(s) de texto sem `lineHeight`" % (a, len(sem)))


# ── 4 ─────────────────────────────────────────────────────────────────────
# Modo escuro: cor fixa nao responde ao tema. O player e' escuro de proposito.
def v4_cor_fixa():
    for a, t in TUDO.items():
        if "PlayerBar" in a or "Vidro" in a:
            continue
        fixas = sorted({h for h in re.findall(r"['\"](#[0-9A-Fa-f]{6})['\"]", t)})
        if fixas:
            avisa("%s: cor fixa, nao segue o tema: %s" % (a, fixas))


# ── 5 ─────────────────────────────────────────────────────────────────────
# «accessibilityLabel on every interactive element».
def v5_voiceover():
    for a, t in TUDO.items():
        pres = len(re.findall(r"<Pressable", t))
        rot = len(re.findall(r"accessibilityLabel", t))
        if pres > rot:
            avisa("%s: %d Pressable para %d rotulo(s) de VoiceOver" % (a, pres, rot))


# ── 6 ─────────────────────────────────────────────────────────────────────
# 🚨 Modulo nativo chamado no escopo do MODULO roda ANTES do React: qualquer
#    tropeco e' tela branca sem pista. Foi o risco do `expo-glass-effect`.
def v6_nativo_no_escopo_do_modulo():
    for a, t in TUDO.items():
        cabeca = t[: t.find("export function")] if "export function" in t else t[:1500]
        if re.search(r"^(export )?const \w+ = \(\(\) => \{", cabeca, re.M) and \
           re.search(r"require\(|isLiquidGlass|isGlassEffect", cabeca):
            bloqueia("%s: modulo nativo avaliado no escopo do modulo — mover para dentro do ciclo do React" % a)


# ── 7 ─────────────────────────────────────────────────────────────────────
# Contraste WCAG: 4,5:1 texto normal, 3:1 elemento de interface.
def v7_contraste():
    def lum(h):
        h = h.lstrip("#")
        r, g, b = (int(h[i:i + 2], 16) / 255 for i in (0, 2, 4))
        f = lambda c: c / 12.92 if c <= .03928 else ((c + .055) / 1.055) ** 2.4
        return .2126 * f(r) + .7152 * f(g) + .0722 * f(b)
    def raz(x, y):
        a, b = sorted([lum(x), lum(y)], reverse=True)
        return (a + .05) / (b + .05)
    pares = [("acento claro", "#455FFF", "#FAFBFC"), ("acento escuro", "#8C9CFF", "#141416"),
             ("texto claro", "#1A1A1A", "#FAFBFC"), ("texto escuro", "#FFFFFF", "#1C1C1E"),
             ("secundario claro", "#64748B", "#FAFBFC"), ("secundario escuro", "#A1A1A6", "#1C1C1E")]
    for nome, fg, bg in pares:
        r = raz(fg, bg)
        if r < 4.5:
            bloqueia("contraste %s: %.2f:1 (precisa de 4,5)" % (nome, r))


for v in (v1_embrulho_nao_impoe_layout, v2_alvo_de_toque, v3_escala_e_entrelinha,
          v4_cor_fixa, v5_voiceover, v6_nativo_no_escopo_do_modulo, v7_contraste):
    v()

print("=" * 66)
print("AUDITORIA — %d arquivos" % len(ARQS))
print("=" * 66)
if bloqueios:
    print("\nBLOQUEIA O BUILD (%d):" % len(bloqueios))
    for m in bloqueios:
        print("   x " + m)
if avisos:
    print("\nAVISOS (%d):" % len(avisos))
    for m in avisos:
        print("   ! " + m)
if not bloqueios and not avisos:
    print("\n   tudo limpo")
print()
sys.exit(1 if bloqueios else 0)
