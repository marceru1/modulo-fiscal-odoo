"""
Teste standalone: garante a ordem load-bearing dos assets no manifest.

botao-atualizar-pdv:
  - atualizar_button.xml ancora num DropdownItem criado por recebimento_button.xml
  - portanto recebimento_button.xml DEVE vir antes de atualizar_button.xml
    na lista do bundle point_of_sale._assets_pos.

Rodar: python .agents/tests/test_manifest_order.py
"""
import ast
import os
import sys

# Este teste fica em .agents/tests/, então o repo fica dois níveis acima.
REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
MANIFEST_PATH = os.path.join(
    REPO_ROOT, "meu_modulo_fiscal", "__manifest__.py"
)
BUNDLE = "point_of_sale._assets_pos"

RECEBIMENTO = "meu_modulo_fiscal/static/src/xml/recebimento_button.xml"
ATUALIZAR = "meu_modulo_fiscal/static/src/xml/atualizar_button.xml"

# prazo-por-contato: a ficha do contato carrega o historico + o botao da conta
# a prazo. A view precisa estar na lista `data` do manifest (sem ela a UI da
# feature nao existe); a ordem relativa as demais views nao e load-bearing.
PARTNER_PRAZO_VIEW = "views/res_partner_prazo_views.xml"
HR_PRAZO_VIEW = "views/hr_employee_prazo_views.xml"
HR_MODEL_FILE = "meu_modulo_fiscal/models/hr_employee.py"
# ticket 08: o data file liga account_use_credit_limit nas empresas para o
# grupo nativo "Credit Limits" aparecer na aba Faturamento do contato.
CREDITO_CONFIG_DATA = "data/prazo_credito_config.xml"


def main():
    assert os.path.exists(MANIFEST_PATH), f"Manifest não encontrado: {MANIFEST_PATH}"

    with open(MANIFEST_PATH, "r", encoding="utf-8") as f:
        content = f.read()

    # __manifest__.py é um dict Python puro; ast.literal_eval é seguro.
    manifest = ast.literal_eval(content)
    assets = manifest.get("assets", {}).get(BUNDLE, [])

    assert RECEBIMENTO in assets, f"{RECEBIMENTO} não está no bundle {BUNDLE}"
    assert ATUALIZAR in assets, f"{ATUALIZAR} não está no bundle {BUNDLE}"

    idx_recebimento = assets.index(RECEBIMENTO)
    idx_atualizar = assets.index(ATUALIZAR)

    assert idx_recebimento < idx_atualizar, (
        f"Ordem load-bearing violada no {BUNDLE}: "
        f"{RECEBIMENTO} (idx={idx_recebimento}) deve vir antes de "
        f"{ATUALIZAR} (idx={idx_atualizar})"
    )

    print(f"✓ {RECEBIMENTO} (idx={idx_recebimento}) vem antes de {ATUALIZAR} (idx={idx_atualizar})")

    data = manifest.get("data", [])
    assert PARTNER_PRAZO_VIEW in data, (
        f"{PARTNER_PRAZO_VIEW} não está na lista `data` do manifest — "
        "a ficha do contato não teria histórico nem botão da conta a prazo"
    )
    print(f"✓ {PARTNER_PRAZO_VIEW} está na lista `data`")

    # DEC-F (ticket 06): o modulo nao depende mais de `hr` e nao tem view de
    # funcionario. O guard existe para ninguem reintroduzir a dependencia sem
    # querer — a conta a prazo vive so no contato.
    assert "hr" not in manifest.get("depends", []), (
        "`hr` não pode constar em depends: a conta a prazo é do contato (DEC-F)"
    )
    assert HR_PRAZO_VIEW not in data, (
        f"{HR_PRAZO_VIEW} não pode constar na lista `data`: a aba do funcionário "
        "foi removida (ticket 06)"
    )
    assert not os.path.exists(os.path.join(REPO_ROOT, HR_MODEL_FILE)), (
        f"{HR_MODEL_FILE} não pode existir: sem extensão de hr.employee (DEC-F)"
    )
    print("✓ sem dependência de `hr`, sem view/modelo de funcionário")

    assert CREDITO_CONFIG_DATA in data, (
        f"{CREDITO_CONFIG_DATA} não está na lista `data` do manifest — sem ele "
        "a flag de limite de crédito não é ligada no upgrade"
    )
    print(f"✓ {CREDITO_CONFIG_DATA} está na lista `data`")

    print("✓ Ordem load-bearing do manifest validada")


if __name__ == "__main__":
    main()
