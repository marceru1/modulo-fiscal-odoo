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
    print("✓ Ordem load-bearing do manifest validada")


if __name__ == "__main__":
    main()
