# -*- coding: utf-8 -*-
"""Custo da remetente e total dos produtos na nota (ticket 05)."""

from odoo.tests import TransactionCase

from .nfe_helper import NfeTransferMixin


class TestNfeCusto(NfeTransferMixin, TransactionCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls._nfe_preparar_cenario()
        cls.empresa_b = cls.env['res.company'].create({'name': 'Empresa B custo NF-e'})

    def _nota(self, picking, **kw):
        return self.env['nfe.documento'].with_context(**kw)._nfe_obter_ou_criar(picking)

    # ── Critério 4: custo da remetente ───────────────────────────────────────
    def test_custo_da_remetente_com_outra_empresa_ativa(self):
        self.produto.with_company(self.env.company).standard_price = 10.0
        self.produto.with_company(self.empresa_b).standard_price = 30.0
        picking = self._criar_transferencia(quantidade=2.0)

        # Simula a outra empresa ativa na interface.
        nota = self.env['nfe.documento'].with_company(self.empresa_b)._nfe_obter_ou_criar(picking)

        self.assertEqual(nota.company_id, picking.company_id)
        self.assertEqual(nota.linha_ids.custo_unitario, 10.0)
        self.assertEqual(nota.linha_ids.total_linha, 20.0)
        self.assertEqual(nota.total_produtos, 20.0)
        self.assertEqual(nota.currency_id, picking.company_id.currency_id)

    # ── Unidade da linha ─────────────────────────────────────────────────────
    def test_custo_ajustado_a_unidade_da_linha(self):
        duzia = self.env.ref('uom.product_uom_dozen')
        self.produto.with_company(self.env.company).standard_price = 10.0
        picking = self._criar_transferencia(quantidade=2.0, uom=duzia)

        nota = self.env['nfe.documento']._nfe_obter_ou_criar(picking)

        self.assertEqual(nota.linha_ids.uom_id, duzia)
        self.assertEqual(nota.linha_ids.custo_unitario, 120.0, "1 dúzia = 12 unidades × 10")
        self.assertEqual(nota.total_produtos, 240.0)

    # ── Critério 5: valores preservados ──────────────────────────────────────
    def test_valores_capturados_nao_sao_recalculados(self):
        self.produto.with_company(self.env.company).standard_price = 10.0
        picking = self._criar_transferencia(quantidade=2.0)
        nota = self._nota(picking)

        self.produto.with_company(self.env.company).standard_price = 99.0
        repetida = picking.action_nfe_emitir()['res_id']

        self.assertEqual(repetida, nota.id)
        self.assertEqual(nota.linha_ids.custo_unitario, 10.0)
        self.assertEqual(nota.total_produtos, 20.0)

    # ── Arredondamento ───────────────────────────────────────────────────────
    def test_total_arredonda_pela_moeda_sem_arredondar_o_unitario(self):
        # Custo com mais de 2 decimais exige precisão "Product Price" maior:
        # o próprio standard_price é arredondado para os dígitos do campo.
        self.env['decimal.precision'].search(
            [('name', '=', 'Product Price')]
        ).digits = 4
        self.produto.with_company(self.env.company).standard_price = 3.3333
        picking = self._criar_transferencia(quantidade=3.0)

        nota = self.env['nfe.documento']._nfe_obter_ou_criar(picking)

        self.assertAlmostEqual(nota.linha_ids.custo_unitario, 3.3333, places=4)
        self.assertEqual(nota.linha_ids.total_linha, 10.0, "9,9999 arredonda para 10,00")
        self.assertEqual(nota.total_produtos, 10.0)

    # ── Somente leitura ──────────────────────────────────────────────────────
    def test_custo_quantidade_e_unidade_somente_leitura(self):
        campos = self.env['nfe.documento.linha']._fields
        for campo in ('custo_unitario', 'quantidade', 'uom_id', 'product_id', 'total_linha'):
            self.assertTrue(campos[campo].readonly, "%s deve ser somente leitura" % campo)
