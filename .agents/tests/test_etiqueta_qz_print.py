#!/usr/bin/env python3
"""Contrato do payload de impressao direta (QZ Tray).

Le o codigo do modulo e confere:
  - x_get_print_payload existe e devolve as chaves que o JS consome
  - o JS chama o metodo certo e usa as chaves certas
  - o JS usa o modo 'pixel' (o unico que imprime nesta impressora)
  - a rotacao vem do servidor (nao hardcoded no JS)
  - a busca de impressora prioriza L42 (a maquina tem 'ELGIN i9' tambem)
  - o campo/asset/view estao registrados
"""
import sys
from pathlib import Path

BASE = Path(__file__).resolve().parents[2] / "meu_modulo_fiscal"
PY = BASE / "wizard" / "product_label_layout.py"
JS = BASE / "static" / "src" / "js" / "etiqueta_qz_print.js"
XML = BASE / "static" / "src" / "xml" / "etiqueta_qz_print.xml"
VIEW = BASE / "views" / "etiquetas_wizard_views.xml"
MANIFEST = BASE / "__manifest__.py"

falhas = []


def ok(cond, msg):
    print(("  OK   " if cond else "  FALHOU ") + msg)
    if not cond:
        falhas.append(msg)


py = PY.read_text()
js = JS.read_text()
xml = XML.read_text()
view = VIEW.read_text()
manifest = MANIFEST.read_text()

print("Python (payload):")
ok("def x_get_print_payload" in py, "metodo x_get_print_payload existe")
ok("base64.b64encode(pdf)" in py, "PDF vai em base64")
for chave in ("report_name", "pdf_base64", "page"):
    ok(f"'{chave}'" in py, f"payload carrega '{chave}'")
ok("mergeTransformedPage" in py or "cm" in py, "gira o CONTEUDO (o /Rotate o QZ ignora)")
ok("_X_LABEL_ROTATE_DEFAULT = '0'" in py, "rotação 0 é o default da classe (dev)")
ok("x_rotate_degrees" in py, "rotação é campo do wizard (por impressão)")
ok("_x_rotate_degrees" in py, "resolução: wizard -> default")
ok("'confeccao': {'width': 105, 'height': 60}" in py, "confeccao = 105x60 (largura do ROLO)")
ok("'bijuteria': {'width': 105, 'height': 20}" in py, "bijuteria = 105x20 (ROLO de 3 vias) — mono-via empilhava na coluna da esquerda")
ok('per_page" t-value="3"' in open(BASE / "report" / "etiqueta_bijuteria_template.xml").read(),
   "bijuteria: template monta 3 colunas por página (mesma arquitetura da confeccao)")
# MediaBox = papel físico: o wkhtmltopdf emite página inteira (34,925x20,108
# quando o CSS usa 34,8) e o driver da bobina NÃO repagina — páginas
# consecutivas andam pra frente e a etiqueta sai em cima da outra.
ok("_x_normalizar_mediabox" in py, "MediaBox normalizado pro papel físico")
ok("def _x_render_etiqueta_pdf" in py, "render ÚNICO (cobre QZ direto e Ctrl+P)")
import re as _re_proc
_proc_codigo = _re_proc.sub(r"#[^\n]*", "", py[py.index("def process"):py.index("def process") + 900])
ok("_x_render_etiqueta_pdf" in _proc_codigo, "process() passa pelo render único (Ctrl+P também sai normalizado)")

print("\nJS (widget):")
ok("loadQzTray" in js, "carrega o qz-tray.js sob demanda")
ok("x_get_print_payload" in js, "chama o metodo que gera o PDF")
ok('type: "pixel"' in js or "type: 'pixel'" in js, "usa o modo pixel (o unico que imprime)")
ok('format: "pdf"' in js or "format: 'pdf'" in js, "envia PDF")
ok("payload.page" in js, "usa a geometria que veio do servidor")
# A rotacao NAO vai mais pro QZ Tray: `rotation` a lib so declara como default
# (o Java ignora) e `orientation` TROCA a pagina e encolhe a etiqueta. O PDF sai
# girado do servidor (odoo.tools.pdf.rotate_pdf).
ok("orientation:" not in js, "nao manda orientation pro QZ (trocaria a pagina)")
ok("rotation:" not in js, "nao manda rotation pro QZ (o Java ignora)")
# A impressora e decidida PELO FORMATO (dois ramos): bijuteria -> /bijut/
# primeiro; confeccao (e vazio) -> /confec[cç]/ primeiro. Fallbacks L42 e
# Elgin nos dois ramos. Um /l42/ so escolheria a fila errada quando as duas
# Elgin estao ligadas.
ok("/confec[cç]/i" in js, "confeccao casando com a fila dela")
ok("/bijut/i" in js, "bijuteria casando com a fila dela")
ok("/l42/i" in js, "tem o modelo L42 como fallback")
ok("/elgin/i" in js, "tem Elgin generico como ultimo recurso")
_p_conf = js.index("/confec[cç]/i")
_p_l42_2, _p_l42_1 = js.rindex("/l42/i"), js.index("/l42/i")   # 2 ramos usam L42
_p_elg_2, _p_elg_1 = js.rindex("/elgin/i"), js.index("/elgin/i")
_p_bij = js.index("/bijut/i")
ok(_p_conf < _p_l42_2 < _p_elg_2, "ramo confeccao: confecção -> L42 -> elgin")
ok(_p_bij < _p_l42_1, "ramo bijuteria: bijut antes dos fallbacks")
ok('units: "mm"' in js, "tamanho em mm")
ok("blackwhite" in js, "colorType blackwhite (etiqueta termica)")
ok('registry.category("fields").add("x_qz_print"' in js, "campo x_qz_print registrado")
# A IMPRESSORA E DECIDIDA PELO FORMATO (sem dropdown): confeccao -> fila
# confecção, bijuteria -> fila bijuteria. Fallback L42/Elgin. A loja imprime
# com o radio do formato; o operador nao escolhe fila.
ok("impressoras:" not in js and "_carregarImpressoras" not in js, "sem dropdown de impressora (o formato decide)")
ok('formato === "bijuteria"' in js and "/bijut/i" in js, "bijuteria casando com a fila dela")
ok('"/confec[cç]/i"' in js or "/confec[cç]/i" in js, "confeccao casando com a fila dela")
ok("select" not in xml, "template sem dropdown")
# `qz.security.setPromise` NAO existe na API (e setCertificatePromise /
# setSignaturePromise). Chamar a inexistente abortava a impressao antes de
# conectar, e o QZ Tray nunca chegava a pedir permissao.
ok("setPromise(" not in js, "nao chama qz.security.setPromise (nao existe na API)")
ok("qz.websocket.connect()" in js, "conecta ao QZ Tray")
# Sem salvar, o servidor le o x_line_ids do BANCO e imprime a quantidade antiga
# (default 1) — sintoma: "sempre sai 1 etiqueta". urgentSave grava e mantem o
# dialogo aberto; root.save() fecharia a janela.
ok("urgentSave()" in js, "salva antes de imprimir (urgentSave)")
# Compara a ORDEM no CODIGO, ignorando comentarios: um comentario explicando o
# bug menciona x_get_print_payload e daria falso positivo.
import re as _re2
_js_codigo = _re2.sub(r"//[^\n]*", "", _re2.sub(r"/\*.*?\*/", "", js, flags=_re2.S))
ok(
    _js_codigo.index("urgentSave()") < _js_codigo.index("x_get_print_payload"),
    "salva ANTES de pedir o PDF (na ordem do codigo)",
)

print("\nView / XML / manifest:")
ok('field name="x_qz_print" widget="x_qz_print"' in view, "wizard usa o widget")
ok('string="Imprimir (PDF)"' in view, "botao de PDF renomeado (distinguir do direto)")
ok("meu_modulo_fiscal.XQzPrintField" in xml, "template define o componente")
ok('t-on-click="onClick"' in xml, "template liga o clique")
# Armadilha que derrubou o web client inteiro: asset de CLIENTE nao usa a forma
# de servidor (<odoo><templates>). O bundle tenta ler <odoo> como template e
# falha com "'O nome do modelo esta ausente'". Olha a ESTRUTURA (o elemento
# raiz), nao o texto: um comentario pode mencionar <odoo>.
import re as _re
raiz = _re.sub(r"<!--.*?-->", "", xml, flags=_re.S).lstrip()
ok(raiz.startswith("<?xml"), "tem cabecalho XML")
ok("<odoo>" not in raiz.split("\n", 1)[-1][:200], "a raiz NAO e <odoo> (forma de servidor)")
ok("<templates" in raiz, "raiz e <templates> (forma de asset de cliente)")
ok('<templates xml:space="preserve">' in xml, "raiz e <templates xml:space=preserve>")
ok("meu_modulo_fiscal." in xml, "t-name usa o nome do modulo Python")
ok("etiqueta_qz_print.js" in manifest, "JS no manifest")
ok("etiqueta_qz_print.xml" in manifest, "XML no manifest")
ok(
    manifest.index("etiqueta_qz_print.js") < manifest.index("etiqueta_qz_print.xml"),
    "JS antes do XML no manifest",
)
ok((BASE / "static" / "lib" / "qz-tray.js").exists(), "qz-tray.js presente no modulo")

print()
if falhas:
    print(f"TEM FALHA ({len(falhas)})")
    sys.exit(1)
print("Todos os testes passaram")
