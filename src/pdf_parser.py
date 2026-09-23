"""Extração de texto de PDFs usando PyMuPDF."""

import fitz  # PyMuPDF
import re
import os
import collections
import functools


# =========================================================================
# TEXTO SOLETRADO  (ler antes de mexer em _clean_text)
#
# Muito e-book desenha título e etiqueta com LETTER-SPACING largo. O PyMuPDF
# enxerga a folga entre glifos e devolve espaço de verdade:
#
#     'T E X T O  B Í B L I C O  P A R A  M E D I T A Ç Ã O'
#      ^ letra     ^^ DOIS espaços = fronteira de PALAVRA
#
# A informação está toda ali: um espaço separa LETRA, dois ou mais separam
# PALAVRA. Só que o `re.sub(r" {2,}", " ", ...)` que vinha logo depois
# colapsava os dois em um — e aí não havia mais como saber onde terminava a
# palavra. O edge-tts recebia letras soltas e SOLETRAVA.
#
# Medido em 09/2026 no acervo real: 119 das 148 páginas de "Buscando os Dons
# Espirituais" tinham trecho soletrado (618 trechos). Nos outros dois livros
# da biblioteca, zero — é característica do PDF, não do leitor.
#
# 🚨 Por isso a de-soletração roda POR LINHA e ANTES de colapsar espaço. Depois
# não dá: a fronteira de palavra já se perdeu.
# =========================================================================

_SINAL = r"(?:[^\W\d_]|\d|[.\-–—,;:!?ºª/])"
_SOLETRADO = re.compile(r"(?<!\S)" + _SINAL + r"(?:[ \t]{1,4}" + _SINAL + r"){2,}(?!\S)")


def _juntar_soletrado(m: re.Match) -> str:
    bruto = m.group(0)
    sinais = [c for c in bruto if not c.isspace()]
    letras = [c for c in sinais if c.isalpha()]

    # 🚨 Freio contra falso positivo. Em português "o", "a" e "e" são palavras
    # de verdade, e três delas seguidas ("e a o") casariam com o padrão. Então
    # só dispara quando o trecho está todo em CAIXA ALTA — que é como esse
    # recurso tipográfico aparece na prática — ou quando é longo demais (5+
    # sinais) para ser texto corrido. Com esta regra, os dois livros sem
    # letter-spacing saíram byte a byte idênticos na medição.
    if letras and not all(c.isupper() for c in letras) and len(sinais) < 5:
        return bruto

    # Espaço duplo ou maior = fronteira de palavra (vira UM espaço).
    # Espaço simples = só o letter-spacing (some).
    junto = (
        re.sub(r"[ \t]{2,}", "\x00", bruto)
        .replace(" ", "")
        .replace("\t", "")
        .replace("\x00", " ")
    )
    return " ".join(_separar_numero_de_palavra(p) for p in junto.split(" "))


# '1 C O R Í N T I O S' vem com a MESMA folga entre o "1" e o "C" e entre as
# letras — ali o PDF não deixou pista de fronteira, e o resultado sai colado:
# "1CORÍNTIOS". Um número curto grudado num bloco de 3+ letras é quase sempre
# numeral + palavra, e separá-los devolve "1 CORÍNTIOS" ao narrador.
# 🚨 Só quando o número vem NA FRENTE e a palavra tem 3+ letras: assim "H2O",
# "A4" e "COVID19" ficam intactos.
_NUM_COLADO = re.compile(r"^(\d{1,3})([^\W\d_]{3,})$")


def _separar_numero_de_palavra(palavra: str) -> str:
    m = _NUM_COLADO.match(palavra)
    return f"{m.group(1)} {m.group(2)}" if m else palavra


def desoletrar(linha: str) -> str:
    """'T E X T O  B Í B L I C O' -> 'TEXTO BÍBLICO'. Idempotente."""
    return _SOLETRADO.sub(_juntar_soletrado, linha)


# --- Cabeçalho e rodapé correntes ----------------------------------------
# O mesmo título de capítulo impresso no alto e no pé de toda página é lido em
# voz alta duas vezes por página. Medido: 301 leituras repetidas em 144 das 148
# páginas do mesmo e-book — e ZERO nos outros dois livros, que não usam o
# recurso. O filtro é, portanto, inócuo em quem não tem o problema.
#
# 🚨 Não basta "linha que se repete na página": no Essencialismo há trecho de
# corpo de texto legitimamente repetido ('Sent', 'Acha que'). O que separa uma
# coisa da outra é a POSIÇÃO — cabeçalho vive na margem, texto vive no miolo.
_BANDA_TOPO = 0.12
_BANDA_RODAPE = 0.88


def _linhas_correntes(doc) -> set[str]:
    """Textos que se repetem em muitas páginas e vivem sempre na margem."""
    total = len(doc)
    if total < 4:
        return set()

    ocorrencias: dict[str, list[float]] = collections.defaultdict(list)
    for i in range(total):
        pagina = doc[i]
        altura = pagina.rect.height or 1
        try:
            blocos = pagina.get_text("dict")["blocks"]
        except Exception:
            continue
        for bloco in blocos:
            for linha in bloco.get("lines", []):
                texto = desoletrar("".join(s["text"] for s in linha.get("spans", [])).strip())
                if not texto or len(texto) > 70:
                    continue
                meio = ((linha["bbox"][1] + linha["bbox"][3]) / 2) / altura
                ocorrencias[texto].append(meio)

    minimo = max(3, total * 0.10)
    correntes = set()
    for texto, alturas in ocorrencias.items():
        if len(alturas) < minimo:
            continue
        na_margem = sum(1 for y in alturas if y < _BANDA_TOPO or y > _BANDA_RODAPE)
        if na_margem >= len(alturas) * 0.9:
            correntes.add(texto)
    return correntes


def extract_text_from_pdf(file_path: str) -> list[dict]:
    """Extrai texto do PDF página por página.

    Retorna lista de {page: int, text: str}
    """
    doc = fitz.open(file_path)
    correntes = _linhas_correntes(doc)
    pages = []

    for page_num in range(len(doc)):
        page = doc[page_num]
        text = page.get_text("text")
        text = _clean_text(text, correntes)
        if text.strip():
            pages.append({"page": page_num + 1, "text": text})

    doc.close()
    return pages


def chunk_pages(pages: list[dict], max_chars: int = 1200) -> list[dict]:
    """Divide páginas em chunks de tamanho adequado para TTS.

    Cada chunk tem ~1200 chars (aprox. 40-60s de áudio) — rápido para gerar.
    Respeita limites de parágrafo quando possível.
    """
    chunks = []
    chunk_index = 0

    for page_data in pages:
        page_num = page_data["page"]
        text = page_data["text"]
        paragraphs = text.split("\n\n")

        current_chunk = ""

        for para in paragraphs:
            para = para.strip()
            if not para:
                continue

            if len(current_chunk) + len(para) + 2 > max_chars and current_chunk:
                chunks.append({
                    "chunk_index": chunk_index,
                    "page_number": page_num,
                    "text": current_chunk.strip(),
                })
                chunk_index += 1
                current_chunk = ""

            current_chunk += para + "\n\n"

        if current_chunk.strip():
            chunks.append({
                "chunk_index": chunk_index,
                "page_number": page_num,
                "text": current_chunk.strip(),
            })
            chunk_index += 1

    return chunks


def get_pdf_info(file_path: str) -> dict:
    """Retorna metadados do PDF."""
    doc = fitz.open(file_path)
    info = {
        "total_pages": len(doc),
        "title": doc.metadata.get("title", "") or "",
        "author": doc.metadata.get("author", "") or "",
    }
    doc.close()
    return info


def extract_cover(file_path: str, output_path: str, width: int = 400) -> bool:
    """Extrai a primeira página do PDF como imagem PNG para usar como capa."""
    try:
        doc = fitz.open(file_path)
        if len(doc) == 0:
            doc.close()
            return False

        page = doc[0]
        zoom = width / page.rect.width
        mat = fitz.Matrix(zoom, zoom)
        pix = page.get_pixmap(matrix=mat)
        pix.save(output_path)
        doc.close()
        return True
    except Exception:
        return False


def render_page(file_path: str, page_num: int, output_path: str, width: int = 800) -> bool:
    """Renderiza uma página específica do PDF como imagem PNG."""
    try:
        doc = fitz.open(file_path)
        if page_num < 1 or page_num > len(doc):
            doc.close()
            return False

        page = doc[page_num - 1]
        zoom = width / page.rect.width
        mat = fitz.Matrix(zoom, zoom)
        pix = page.get_pixmap(matrix=mat)
        pix.save(output_path)
        doc.close()
        return True
    except Exception:
        return False


# =========================================================================
# SUMÁRIO  (ler antes de mexer em get_toc)
#
# O outline embutido no PDF nem sempre é um sumário. Editor gráfico costuma
# virar CADA caixa de texto em marcador: no e-book "Buscando os Dons
# Espirituais" são 565 entradas para 148 páginas — 3,82 por página —, com
# frases de corpo de texto cortadas no meio ('Os 14 Dias de Jejum e
# Consagração serão um tempo de '). Isso não é índice, é ruído.
#
# Medido nos três livros da biblioteca:
#     Essencialismo      32 entradas / 215 páginas = 0,15 por página   OK
#     Carnegie           43 entradas / 294 páginas = 0,15 por página   OK
#     Dons Espirituais  565 entradas / 148 páginas = 3,82 por página   ruído
#
# São 25x de separação — por isso o corte em 1,0 por página não é chute.
# Quando o outline reprova, o sumário é DERIVADO da tipografia da página.
# Conferido contra o sumário impresso do próprio livro (páginas 4 e 5): os
# 12 capítulos saem certos, com 15 entradas no lugar de 565.
# =========================================================================

_MAX_ENTRADAS_POR_PAGINA = 1.0


def get_toc(file_path: str) -> list[dict]:
    """Sumário do documento: o embutido quando presta, senão o derivado.

    🚨 CACHEADO. Derivar o sumário custa uma varredura de tipografia no
    documento inteiro — medido em 1.716 ms num livro de 148 páginas, contra
    3 ms quando o outline embutido serve. Esta função é chamada a cada
    abertura do leitor, de dentro de uma rota async: sem cache, cada abertura
    trava o servidor inteiro por quase dois segundos. O PDF guardado nunca
    muda (o nome em disco é gerado pelo servidor), e a chave ainda leva
    tamanho e mtime para o caso de o arquivo ser trocado por baixo.
    """
    try:
        st = os.stat(file_path)
        return list(_toc_cacheado(file_path, st.st_mtime_ns, st.st_size))
    except OSError:
        return _calcular_toc(file_path)


@functools.lru_cache(maxsize=64)
def _toc_cacheado(file_path: str, _mtime: int, _tamanho: int) -> tuple:
    return tuple(_calcular_toc(file_path))


def _calcular_toc(file_path: str) -> list[dict]:
    doc = fitz.open(file_path)
    try:
        total = max(1, len(doc))
        try:
            embutido = [
                {"level": item[0], "title": desoletrar(item[1].strip()), "page": item[2]}
                for item in doc.get_toc()
                if item[1] and item[1].strip()
            ]
        except Exception:
            embutido = []

        if embutido and len(embutido) / total <= _MAX_ENTRADAS_POR_PAGINA:
            return embutido

        derivado = derivar_titulos(doc)
        # Outline ruim e nada derivado: melhor o ruim do que tela vazia.
        return derivado or embutido
    finally:
        doc.close()


def derivar_titulos(doc, max_niveis: int = 3) -> list[dict]:
    """Deriva títulos e subtítulos da TIPOGRAFIA, quando não há índice bom.

    Título é texto curto impresso maior que o corpo. O corpo é medido só nas
    linhas LONGAS (40+ caracteres) — essas são corpo de texto por definição, e
    tomar a moda delas é bem mais estável do que tomar a moda de tudo, que num
    livro com muita legenda e infográfico aponta para o tamanho errado.
    """
    total = len(doc)
    if total == 0:
        return []

    linhas = []
    peso_corpo: collections.Counter = collections.Counter()

    for i in range(total):
        pagina = doc[i]
        try:
            blocos = pagina.get_text("dict")["blocks"]
        except Exception:
            continue
        for bloco in blocos:
            for linha in bloco.get("lines", []):
                spans = linha.get("spans", [])
                if not spans:
                    continue
                texto = desoletrar("".join(s["text"] for s in spans).strip())
                if not texto:
                    continue
                maior = max(spans, key=lambda s: s["size"])
                tamanho = round(maior["size"], 1)
                if len(texto) >= 40:
                    peso_corpo[tamanho] += len(texto)
                linhas.append({
                    "pg": i + 1,
                    "txt": texto,
                    "tam": tamanho,
                    "neg": bool(maior["flags"] & 16),  # bit 4 do PyMuPDF = negrito
                    "y0": linha["bbox"][1],
                    "y1": linha["bbox"][3],
                })

    if not peso_corpo or not linhas:
        return []
    corpo = max(peso_corpo.items(), key=lambda x: x[1])[0]

    def candidatos(fator: float) -> list[dict]:
        return [
            linha for linha in linhas
            if 2 <= len(linha["txt"]) <= 90
            and not re.fullmatch(r"[\d\W]+", linha["txt"])
            and (linha["tam"] >= corpo * fator or (linha["neg"] and linha["tam"] >= corpo * 1.06))
        ]

    fator = 1.18
    limpo: list[dict] = []
    for _ in range(6):
        # Um título de display quebra em várias linhas ('Um Dom' / 'Para Quê?').
        # Linhas seguidas, mesma página, mesmo corpo de letra e coladas na
        # vertical são o MESMO título — senão o sumário sai picado.
        fundido: list[dict] = []
        for linha in candidatos(fator):
            anterior = fundido[-1] if fundido else None
            if (
                anterior
                and anterior["pg"] == linha["pg"]
                and anterior["tam"] == linha["tam"]
                and -linha["tam"] * 0.6 <= linha["y0"] - anterior["y1"] <= linha["tam"] * 1.9
            ):
                anterior["txt"] += " " + linha["txt"]
                anterior["y1"] = linha["y1"]
            else:
                fundido.append(dict(linha))

        # Cabeçalho corrente é título de capítulo: entra uma vez, não a cada página.
        frequencia = collections.Counter(x["txt"] for x in fundido)
        vistos: set[str] = set()
        limpo = []
        for x in fundido:
            if frequencia[x["txt"]] >= max(3, total * 0.15):
                if x["txt"] in vistos:
                    continue
                vistos.add(x["txt"])
            limpo.append(x)

        # Ainda parecendo ruído? aperta o corte e tenta de novo.
        if len(limpo) <= total * _MAX_ENTRADAS_POR_PAGINA or fator > 2.4:
            break
        fator += 0.25

    if not limpo:
        return []

    # Nível sai do tamanho da letra, agrupando o que é quase igual (20%):
    # o designer encolhe o título comprido só para caber, e isso não rebaixa
    # o capítulo a subtítulo.
    tamanhos = sorted({x["tam"] for x in limpo}, reverse=True)
    grupos: list[list[float]] = []
    for t in tamanhos:
        if grupos and t >= grupos[-1][0] * 0.80:
            grupos[-1].append(t)
        else:
            grupos.append([t])
    nivel = {t: i + 1 for i, grupo in enumerate(grupos[:max_niveis]) for t in grupo}

    return [
        {"level": nivel[x["tam"]], "title": x["txt"], "page": x["pg"]}
        for x in limpo
        if x["tam"] in nivel
    ]


def search_words_on_page(file_path: str, page_num: int, words: list[str]) -> dict:
    """Busca palavras numa página e retorna suas posições relativas (0-1).

    Retorna {page_width, page_height, results: [{word, rects: [{x0,y0,x1,y1}]}]}
    """
    doc = fitz.open(file_path)
    if page_num < 1 or page_num > len(doc):
        doc.close()
        return {"page_width": 0, "page_height": 0, "results": []}

    page = doc[page_num - 1]
    pw = page.rect.width
    ph = page.rect.height

    results = []
    for word in words:
        rects = page.search_for(word)
        results.append({
            "word": word,
            "rects": [
                {
                    "x0": round(r.x0 / pw, 4),
                    "y0": round(r.y0 / ph, 4),
                    "x1": round(r.x1 / pw, 4),
                    "y1": round(r.y1 / ph, 4),
                }
                for r in rects[:3]  # máx 3 ocorrências por palavra
            ],
        })

    doc.close()
    return {"page_width": pw, "page_height": ph, "results": results}


def get_word_positions_on_page(file_path: str, page_num: int) -> list[dict]:
    """Retorna TODAS as palavras da página com suas posições relativas.

    Retorna [{word, x0, y0, x1, y1}] em coordenadas relativas (0-1).

    🚨 As letras de um trecho soletrado são JUNTADAS aqui também. O destaque no
    PDF casa esta lista com o texto do chunk; se o chunk diz "TEXTO" e esta
    lista traz 'T','E','X','T','O', o destaque anda sozinho e erra a linha.
    Os dois lados têm de contar a mesma história.
    """
    doc = fitz.open(file_path)
    if page_num < 1 or page_num > len(doc):
        doc.close()
        return []

    page = doc[page_num - 1]
    pw = page.rect.width
    ph = page.rect.height

    # get_text("words") retorna (x0, y0, x1, y1, word, block_no, line_no, word_no)
    raw = page.get_text("words")
    doc.close()

    return [
        {
            "word": w[4],
            "x0": round(w[0] / pw, 4),
            "y0": round(w[1] / ph, 4),
            "x1": round(w[2] / pw, 4),
            "y1": round(w[3] / ph, 4),
            "block": w[5],
            "line": w[6],
        }
        for w in _juntar_letras_soltas(raw)
    ]


def _juntar_letras_soltas(raw: list) -> list:
    """Funde letras isoladas da mesma linha numa palavra só, com a caixa unida.

    O critério é o mesmo da de-soletração do texto: três ou mais sinais de um
    caractere seguidos, na mesma linha do mesmo bloco. A folga horizontal entre
    eles decide onde termina a palavra — folga larga é fronteira, como o espaço
    duplo é no texto.
    """
    if not raw:
        return raw

    saida: list = []
    i = 0
    n = len(raw)
    while i < n:
        j = i
        while (
            j + 1 < n
            and len(raw[j + 1][4]) == 1
            and len(raw[j][4]) == 1
            and raw[j + 1][5] == raw[j][5]   # mesmo bloco
            and raw[j + 1][6] == raw[j][6]   # mesma linha
        ):
            j += 1

        if j - i + 1 < 3:
            saida.append(raw[i])
            i += 1
            continue

        grupo = raw[i:j + 1]
        # Folga típica entre letras; o que passar de 2,2x dela separa palavras.
        folgas = [grupo[k + 1][0] - grupo[k][2] for k in range(len(grupo) - 1)]
        positivas = sorted(f for f in folgas if f > 0)
        base = positivas[len(positivas) // 2] if positivas else 0
        corte = base * 2.2 if base > 0 else float("inf")

        atual = list(grupo[0])
        for k in range(1, len(grupo)):
            if folgas[k - 1] > corte:
                saida.append(tuple(atual))
                atual = list(grupo[k])
            else:
                atual[2] = grupo[k][2]                      # x1 estende
                atual[1] = min(atual[1], grupo[k][1])       # y0
                atual[3] = max(atual[3], grupo[k][3])       # y1
                atual[4] = atual[4] + grupo[k][4]           # texto concatena
        saida.append(tuple(atual))
        i = j + 1

    return saida


_SO_NUMERO = re.compile(r"^[\s\d]{1,6}$")


def _clean_text(text: str, ignorar: set[str] = frozenset()) -> str:
    """Limpa texto extraído de PDF.

    🚨 A ORDEM É A CORREÇÃO. A de-soletração e o corte de número de página
    precisam rodar POR LINHA, antes de as linhas virarem parágrafo e antes de
    os espaços colapsarem — depois disso a informação já não existe mais.
    """
    # Remove hífens de quebra de linha
    text = re.sub(r"(\w)-\n(\w)", r"\1\2", text)

    linhas = []
    for linha in text.split("\n"):
        linha = desoletrar(linha)
        nu = linha.strip()
        # Número de página solto. A regra antiga rodava DEPOIS da junção de
        # linhas, quando já não havia linha com só um número para casar —
        # era regra morta, e o número ia para a narração.
        if nu and _SO_NUMERO.match(nu) and nu.replace(" ", "").isdigit():
            continue
        if nu and nu in ignorar:  # cabeçalho/rodapé corrente
            continue
        linhas.append(linha)
    text = "\n".join(linhas)

    # Junta linhas dentro do mesmo parágrafo
    text = re.sub(r"(?<!\n)\n(?!\n)", " ", text)
    # Remove espaços múltiplos
    text = re.sub(r" {2,}", " ", text)
    return text.strip()
