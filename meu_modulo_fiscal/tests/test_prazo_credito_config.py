"""Visibilidade da aba Faturamento no contato (spec: prazo-por-contato, ticket 08).

O grupo nativo "Credit Limits" da aba Faturamento só aparece quando a empresa
tem ``account_use_credit_limit`` ligado (addons/account/views/partner_view.xml:
273-275). O módulo liga a flag de forma idempotente no install/upgrade para o
admin ver limite e saldo sem caçar configuração do core (DEC-B/DEC-H).

Seam testado: ``res.company._prazo_habilitar_limite_credito`` — comportamento
externo apenas (flag liga quando falsa, não reescreve empresa já ligada).
"""

from odoo.tests import TransactionCase


class TestPrazoCreditoConfig(TransactionCase):
    def test_flag_ligada_pelo_upgrade(self):
        """O data file do módulo rodou no install/upgrade do ambiente de teste."""
        self.assertTrue(
            self.env.company.account_use_credit_limit,
            'A flag account_use_credit_limit deveria estar ligada após o upgrade',
        )

    def test_liga_quando_falso(self):
        empresa = self.env.company
        empresa.account_use_credit_limit = False

        self.env['res.company']._prazo_habilitar_limite_credito()

        self.assertTrue(
            empresa.account_use_credit_limit,
            'A função deve ligar a flag quando a empresa está com ela falsa',
        )

    def test_idempotente_nao_reescreve_empresa_ja_ligada(self):
        empresa = self.env.company
        self.assertTrue(empresa.account_use_credit_limit)
        write_date_antes = empresa.write_date

        self.env['res.company']._prazo_habilitar_limite_credito()

        self.assertEqual(
            empresa.write_date, write_date_antes,
            'Empresa já ligada não deve ser reescrita (função idempotente)',
        )
        self.assertTrue(empresa.account_use_credit_limit)
