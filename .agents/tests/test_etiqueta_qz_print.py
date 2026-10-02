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
for chave in ("report_name", "pdf_base64", "page", "rotation"):
    ok(f"'{chave}'" in py, f"payload carrega '{chave}'")
ok("_X_LABEL_ROTATION = 180" in py, "rotacao 180 vem do servidor")
ok("'confeccao': {'width': 105, 'height': 60}" in py, "confeccao = 105x60 (largura do ROLO)")

print("\nJS (widget):")
ok("loadQzTray" in js, "carrega o qz-tray.js sob demanda")
ok("x_get_print_payload" in js, "chama o metodo que gera o PDF")
ok('type: "pixel"' in js or "type: 'pixel'" in js, "usa o modo pixel (o unico que imprime)")
ok('format: "pdf"' in js or "format: 'pdf'" in js, "envia PDF")
ok("payload.rotation" in js, "usa a rotacao que veio do servidor")
ok("payload.page" in js, "usa a geometria que veio do servidor")
ok("/l42/i.test(n)" in js, "busca da impressora prioriza L42")
ok(js.index("/l42/i") < js.index("/elgin/i"), "L42 avaliado ANTES do elgin generico")
ok('units: "mm"' in js, "tamanho em mm")
ok("blackwhite" in js, "colorType blackwhite (etiqueta termica)")
ok('registry.category("fields").add("x_qz_print"' in js, "campo x_qz_print registrado")

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
