"""Precisão da leitura: texto soletrado, número de página e sumário.

O defeito que deu origem a estes testes: o PyMuPDF devolve título com
letter-spacing como letras soltas ('T E X T O  B Í B L I C O'), e o
`re.sub(r" {2,}", " ")` que vinha depois apagava a fronteira de palavra. O
edge-tts recebia letras e soletrava — em 119 das 148 páginas de um dos livros.
"""

import fitz
import pytest

from src.pdf_parser import (
    _clean_text,
    _juntar_letras_soltas,
    _separar_numero_de_palavra,
    desoletrar,
    extract_text_from_pdf,
    get_toc,
)


# --- de-soletração --------------------------------------------------------

def test_junta_letras_e_guarda_a_fronteira_de_palavra():
    # um espaço separa letra, dois separam palavra — é o que o PyMuPDF entrega
    assert desoletrar("T E X T O  B Í B L I C O") == "TEXTO BÍBLICO"
    assert desoletrar("1 4  D I A S  D E  C O N S A G R A Ç Ã O") == "14 DIAS DE CONSAGRAÇÃO"


def test_desoletrar_e_idempotente():
    uma = desoletrar("A P R E S E N T A Ç Ã O")
    assert desoletrar(uma) == uma == "APRESENTAÇÃO"


def test_nao_estraga_texto_normal():
    frase = "A manifestação do Espírito é concedida a cada um visando a um fim proveitoso."
    assert desoletrar(frase) == frase


def test_nao_junta_palavras_de_uma_letra_em_minuscula():
    # 🚨 o freio que evita o falso positivo: "e", "a" e "o" são palavras
    assert desoletrar("o que é e o que a gente faz") == "o que é e o que a gente faz"


def test_nao_mexe_em_sigla_ja_junta():
    assert desoletrar("O PDF e a NF-e continuam iguais") == "O PDF e a NF-e continuam iguais"


# --- _clean_text ----------------------------------------------------------

def test_clean_text_desoletra_antes_de_colapsar_espaco():
    bruto = "T E X T O  B Í B L I C O\nA manifestação do Espírito"
    assert _clean_text(bruto) == "TEXTO BÍBLICO A manifestação do Espírito"


def test_clean_text_tira_linha_que_e_so_numero_de_pagina():
    # a regra antiga rodava depois da junção de linhas e nunca casava
    assert "26" not in _clean_text("Primeira linha\n26\nSegunda linha")


def test_clean_text_tira_numero_de_pagina_soletrado():
    assert _clean_text("Primeira\n0 2\nSegunda") == "Primeira Segunda"


def test_clean_text_nao_tira_numero_dentro_da_frase():
    assert "14.1" in _clean_text("1 CORÍNTIOS 14.1 diz que")


def test_clean_text_remove_cabecalho_corrente_informado():
    saida = _clean_text("APRESENTAÇÃO\nO texto de verdade\nAPRESENTAÇÃO", {"APRESENTAÇÃO"})
    assert saida == "O texto de verdade"


# --- posições das palavras (destaque) -------------------------------------

def _p(x0, x1, texto, linha=0):
    return (x0, 100.0, x1, 110.0, texto, 0, linha, 0)


def test_junta_letras_soltas_para_o_destaque():
    # 'T E X T O' vira uma caixa só, e a folga larga separa a palavra seguinte
    cru = [_p(0, 5, "T"), _p(6, 11, "E"), _p(12, 17, "X"), _p(18, 23, "T"), _p(24, 29, "O"),
           _p(60, 65, "B"), _p(66, 71, "I"), _p(72, 77, "M")]
    saida = _juntar_letras_soltas(cru)
    assert [w[4] for w in saida] == ["TEXTO", "BIM"]
    assert saida[0][0] == 0 and saida[0][2] == 29  # caixa unida da primeira


def test_nao_junta_palavra_de_uma_letra_isolada():
    cru = [_p(0, 5, "a"), _p(10, 40, "casa"), _p(50, 55, "e")]
    assert [w[4] for w in _juntar_letras_soltas(cru)] == ["a", "casa", "e"]


def test_nao_junta_letras_de_linhas_diferentes():
    cru = [_p(0, 5, "A", linha=0), _p(6, 11, "B", linha=1), _p(12, 17, "C", linha=2)]
    assert [w[4] for w in _juntar_letras_soltas(cru)] == ["A", "B", "C"]


# --- sumário --------------------------------------------------------------

def _pdf(tmp_path, paginas, outline=None):
    doc = fitz.open()
    for titulo, corpo in paginas:
        pg = doc.new_page(width=400, height=600)
        if titulo:
            pg.insert_text((40, 80), titulo, fontsize=28)
        pg.insert_text((40, 200), corpo, fontsize=10)
    if outline:
        doc.set_toc(outline)
    caminho = str(tmp_path / "livro.pdf")
    doc.save(caminho)
    doc.close()
    return caminho


CORPO = "Esta e uma linha longa de corpo de texto com bastante conteudo para medir."


def test_usa_o_outline_embutido_quando_ele_presta(tmp_path):
    caminho = _pdf(
        tmp_path,
        [("Capitulo Um", CORPO), (None, CORPO), (None, CORPO), (None, CORPO),
         ("Capitulo Dois", CORPO), (None, CORPO)],
        outline=[[1, "Capitulo Um", 1], [1, "Capitulo Dois", 5]],
    )
    toc = get_toc(caminho)
    assert [t["title"] for t in toc] == ["Capitulo Um", "Capitulo Dois"]


def test_descarta_outline_degenerado_e_deriva_pela_tipografia(tmp_path):
    """Editor gráfico vira cada caixa de texto em marcador: 565 para 148 páginas.

    O corte é ENTRADAS POR PÁGINA (limite 1,0). Aqui são 40 entradas para 6
    páginas — 6,7 por página, bem acima do corte, como no livro real.
    """
    paginas = [("Capitulo Um", CORPO), (None, CORPO), (None, CORPO), (None, CORPO),
               ("Capitulo Dois", CORPO), (None, CORPO)]
    lixo = [[1, f"fragmento de corpo numero {i}", (i % 6) + 1] for i in range(40)]
    caminho = _pdf(tmp_path, paginas, outline=lixo)

    toc = get_toc(caminho)
    assert len(toc) < 40, "outline de 40 entradas para 6 páginas tinha de ser recusado"
    assert [t["title"] for t in toc] == ["Capitulo Um", "Capitulo Dois"]


def test_deriva_quando_nao_ha_outline_nenhum(tmp_path):
    caminho = _pdf(tmp_path, [("Capitulo Um", CORPO), (None, CORPO), ("Capitulo Dois", CORPO)])
    assert [t["title"] for t in get_toc(caminho)] == ["Capitulo Um", "Capitulo Dois"]


# --- ponta a ponta --------------------------------------------------------

def test_cabecalho_corrente_sai_do_texto_lido(tmp_path):
    """Mesmo título no alto E no pé de toda página = duas leituras por página."""
    doc = fitz.open()
    for _ in range(10):
        pg = doc.new_page(width=400, height=600)
        pg.insert_text((40, 30), "APRESENTACAO", fontsize=9)     # topo (y=0,05)
        pg.insert_text((40, 300), CORPO, fontsize=10)            # miolo
        pg.insert_text((40, 575), "APRESENTACAO", fontsize=9)    # rodape (y=0,96)
    caminho = str(tmp_path / "corrente.pdf")
    doc.save(caminho)
    doc.close()

    inteiro = " ".join(p["text"] for p in extract_text_from_pdf(caminho))
    assert "APRESENTACAO" not in inteiro
    assert "corpo de texto" in inteiro


def test_texto_repetido_no_miolo_nao_e_confundido_com_cabecalho(tmp_path):
    """🚨 O Essencialismo repete trecho de corpo legítimo em páginas diferentes.

    O que separa cabeçalho de texto é a POSIÇÃO, não a repetição.
    """
    doc = fitz.open()
    for _ in range(10):
        pg = doc.new_page(width=400, height=600)
        pg.insert_text((40, 300), "Acha que tudo e importante", fontsize=10)
    caminho = str(tmp_path / "miolo.pdf")
    doc.save(caminho)
    doc.close()

    inteiro = " ".join(p["text"] for p in extract_text_from_pdf(caminho))
    assert "Acha que tudo e importante" in inteiro


@pytest.mark.parametrize("entrada,esperado", [
    ("B U S Q U E M  C O M  Z E L O", "BUSQUEM COM ZELO"),
    # a interrogação está colada no "Ê" no PDF, e é assim que se lê
    ("U M  D O M  P A R A  Q U Ê ?", "UM DOM PARA QUÊ?"),
    # 🚨 aqui o PDF não deixou pista: a folga entre "1" e "C" é a mesma das
    # letras. Quem separa é a regra do número colado.
    ("1 C O R Í N T I O S  1 4 . 1  —  N A A", "1 CORÍNTIOS 14.1 — NAA"),
    ("T E X T O  D E  A B E R T U R A", "TEXTO DE ABERTURA"),
])
def test_casos_reais_do_acervo(entrada, esperado):
    assert desoletrar(entrada) == esperado


@pytest.mark.parametrize("palavra", ["H2O", "A4", "COVID19", "MP3", "R2"])
def test_numero_colado_nao_estraga_sigla(palavra):
    # o freio: número só se separa quando vem NA FRENTE de 3+ letras
    assert _separar_numero_de_palavra(palavra) == palavra


def test_numero_colado_separa_numeral_de_palavra():
    assert _separar_numero_de_palavra("1CORÍNTIOS") == "1 CORÍNTIOS"
    assert _separar_numero_de_palavra("2TIMÓTEO") == "2 TIMÓTEO"
