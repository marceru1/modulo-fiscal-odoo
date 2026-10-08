"""
Teste standalone dos xml_id da feature etiquetas-produto-impressao.

Odoo não roda nesta máquina (sem Postgres, venv sem `odoo`), então o
`meu_modulo_fiscal/tests/test_etiquetas_wizard.py` (seam 1 + smoke) não pode ser
executado aqui. Este teste cobre estaticamente a classe de erro mais provável da
feature — justamente o que os tickets 02/03/04 pedem para conferir:

  1. `_X_LABEL_REPORTS` do wizard aponta para `ir.actions.report` que existem;
  2. o `report_name` de cada report casa com um `<template>` do módulo;
  3. o `report.<report_name>` existe como AbstractModel no Python;
  4. os `paperformat_id` resolvem para `report.paperformat` do módulo;
  5. todo `t-call="meu_modulo_fiscal.*"` resolve para um template do módulo;
  6. o `env.ref(...)` da server action resolve para um act_window do módulo.

Rodar: python3 .agents/tests/test_etiquetas_xmlids.py
"""
import ast
import glob
import os
import re
import sys

from lxml import etree

MODULE = "meu_modulo_fiscal"
REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
MODULE_DIR = os.path.join(REPO_ROOT, MODULE)
MANIFEST_PATH = os.path.join(MODULE_DIR, "__manifest__.py")

# Módulos externos cujos xml_id não conseguimos resolver a partir deste repo.
EXTERNAL_PREFIX = {"web", "product", "stock", "base", "uom", "hr", "point_of_sale"}


def load_manifest():
    with open(MANIFEST_PATH, encoding="utf-8") as fh:
        return ast.literal_eval(fh.read())


def collect_records():
    """{xml_id local -> model} e o conjunto de templates locais."""
    records = {}
    templates = set()
    manifest = load_manifest()
    for rel_path in manifest["data"]:
        if not rel_path.endswith(".xml"):
            continue
        tree = etree.parse(os.path.join(MODULE_DIR, rel_path))
        for record in tree.iter("record"):
            records[record.get("id")] = record.get("model")
        for template in tree.iter("template"):
            templates.add(template.get("id"))
    return records, templates


def refs_in(rel_path):
    """Todos os `ref=` e `t-call=` de um arquivo XML."""
    tree = etree.parse(os.path.join(MODULE_DIR, rel_path))
    found = []
    for node in tree.iter():
        if node.get("ref"):
            found.append(node.get("ref"))
        call = node.get("t-call")
        if call:
            found.append(call)
    return found


def local(xml_id):
    """xml_id do módulo -> id local; None se for de outro módulo."""
    if "." not in xml_id:
        # Ref sem prefixo resolve dentro do próprio módulo.
        return xml_id
    if xml_id.startswith(MODULE + "."):
        return xml_id[len(MODULE) + 1:]
    return None


def main():
    failures = []
    records, templates = collect_records()

    wizard_src = open(
        os.path.join(MODULE_DIR, "wizard", "product_label_layout.py"), encoding="utf-8"
    ).read()

    # 1 — _X_LABEL_REPORTS aponta para ir.actions.report existentes.
    report_xml_ids = re.findall(r"'(" + MODULE + r"\.action_report_etiqueta_\w+)'", wizard_src)
    assert report_xml_ids, "Não encontrei _X_LABEL_REPORTS no wizard"
    for xml_id in report_xml_ids:
        model = records.get(local(xml_id))
        if model != "ir.actions.report":
            failures.append(f"_X_LABEL_REPORTS: {xml_id} não é um ir.actions.report ({model!r})")

    # 2 + 3 — report_name casa com um template e com um AbstractModel `report.<name>`.
    reports_xml = os.path.join(MODULE_DIR, "report", "etiquetas_reports.xml")
    tree = etree.parse(reports_xml)
    report_names = []
    for record in tree.iter("record"):
        if record.get("model") != "ir.actions.report":
            continue
        name_field = record.find("field[@name='report_name']")
        if name_field is None:
            continue
        report_name = name_field.text.strip()
        report_names.append(report_name)
        if report_name.split(".", 1)[1] not in templates:
            failures.append(f"report_name {report_name} não tem <template> correspondente")
        expected_model = "report.%s" % report_name
        report_py = open(
            os.path.join(MODULE_DIR, "report", "etiqueta_reports.py"), encoding="utf-8"
        ).read()
        if expected_model not in report_py:
            failures.append(f"AbstractModel {expected_model} não existe em etiqueta_reports.py")

    assert len(report_names) == len(report_xml_ids), (
        f"{len(report_xml_ids)} reports no wizard vs {len(report_names)} registrados"
    )

    # 4 + 5 + 6 — refs/t-calls do módulo resolvem.
    xml_files = sorted(glob.glob(os.path.join(MODULE_DIR, "report", "*.xml"))) + sorted(
        glob.glob(os.path.join(MODULE_DIR, "views", "etiquetas_*.xml"))
    )
    for path in xml_files:
        for ref in refs_in(os.path.relpath(path, MODULE_DIR)):
            target = local(ref)
            if target is None:
                if ref.split(".", 1)[0] not in EXTERNAL_PREFIX:
                    failures.append(f"{os.path.basename(path)}: ref externo desconhecido {ref}")
                continue
            if target not in records and target not in templates:
                failures.append(f"{os.path.basename(path)}: ref {ref} não resolve")

    # paperformat_id aponta para paperformat do módulo.
    for record in tree.iter("record"):
        pf = record.find("field[@name='paperformat_id']")
        if pf is None:
            continue
        target = local(pf.get("ref"))
        if records.get(target) != "report.paperformat":
            failures.append(f"paperformat_id {pf.get('ref')} não é report.paperformat")

    # A action do wizard referenciada pela server action tem que existir.
    server_refs = re.findall(r"env\.ref\('(" + MODULE + r"\.\w+)'\)", open(
        os.path.join(MODULE_DIR, "views", "etiquetas_wizard_views.xml"), encoding="utf-8").read())
    for ref in server_refs:
        if records.get(local(ref)) != "ir.actions.act_window":
            failures.append(f"server action: env.ref('{ref}') não é act_window")

    # Guard anti-regressão (bug de 06/10/2026): estilos de etiqueta NUNCA como
    # herança de view QWeb — extension se aplica a TODO render da mãe
    # (ir_ui_view._get_combined_arch) e o position="replace" no <style> inteiro
    # apagava o CSS de 105mm da Confecção. A Bijuteria tem que ser view PRÓPRIA
    # (record de ir.ui.view, mode primary, sem inherit_id).
    tree_styles = etree.parse(os.path.join(MODULE_DIR, "report", "etiqueta_styles.xml"))
    for template_el in tree_styles.iter("template"):
        if template_el.get("inherit_id") and "etiqueta_styles" in template_el.get("inherit_id"):
            failures.append(
                "etiqueta_styles.xml: template %s herda de %s — estilos de etiqueta "
                "não podem ser view extension (aplica no render da mãe também)"
                % (template_el.get("id"), template_el.get("inherit_id"))
            )
    if records.get("etiqueta_styles_bijuteria") != "ir.ui.view":
        failures.append(
            "etiqueta_styles_bijuteria deve ser <record> de ir.ui.view (view própria "
            "standalone), não <template inherit_id>")
    rec_bij = tree_styles.find("record[@id='etiqueta_styles_bijuteria']")
    if rec_bij is not None:
        mode = rec_bij.find("field[@name='mode']")
        inherit = rec_bij.find("field[@name='inherit_id']")
        if mode is None or mode.get("eval") != "primary":
            failures.append("etiqueta_styles_bijuteria: mode deve ser primary")
        if inherit is None or inherit.get("eval") != "False":
            failures.append("etiqueta_styles_bijuteria: inherit_id deve ser False")

    if failures:
        print("FALHAS:")
        for failure in failures:
            print("  ✗", failure)
        return 1

    print(f"✓ {len(report_xml_ids)} reports: wizard → ir.actions.report → template → AbstractModel")
    print(f"✓ refs/t-calls resolvem em {len(xml_files)} arquivos XML")
    print("✓ xml_id da feature etiquetas-produto-impressao consistentes")
    return 0


if __name__ == "__main__":
    sys.exit(main())
