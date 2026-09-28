import os

from odoo import models


class IrHttp(models.AbstractModel):
    _inherit = 'ir.http'

    def session_info(self):
        """Injeta o rótulo do ambiente (ex: 'TESTE') no session_info.

        Fonte: addons/web/models/ir_http.py:75 monta o session_info e addons
        oficiais (mail/models/ir_http.py:12) injetam nele sobrescrevendo este
        metodo e chamando super() — mesmo padrao usado aqui.

        O valor vem da env var ODOO_ENV_LABEL do container (nao de
        ir.config_parameter): a flag no banco pode ser setada no db errado;
        a env var do service e imutavel por deploy. PROD nao recebe a var —
        o session_info sai com string vazia e o selo nao renderiza.
        """
        result = super().session_info()
        result['environment_label'] = os.environ.get('ODOO_ENV_LABEL', '')
        return result