# -*- coding: utf-8 -*-
"""Divergência da origem e atualização explícita da nota (ticket 10)."""

from odoo.exceptions import UserError
from odoo.tests import TransactionCase

from .nfe_helper import NfeTransferMixin


class TestNfeDivergencia(NfeTransferMixin, TransactionCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls._nfe_preparar_cenario()

    def _nota(self, **kw):
        return self._nfe_preparar_nota_valida(**kw)

    def _move_realizado(self, nota):
        return nota.picking_id._nfe_moves_realizados()

    # ── Detecção ─────────────────────────────────────────────────────────────
    def test_nota_em_dia_nao_e_divergente(self):
        nota = self._nota()

        self.assertFalse(nota.divergente)
        self.assertFalse(nota.divergencia_detalhe)

    def test_quantidade_alterada_na_origem_gera_divergencia(self):
        nota = self._nota(quantidade=8.0)
        nota.nfe_validar()
        self.assertEqual(nota.state, 'validada')

        self._move_realizado(nota).write({'quantity': 6.0})

        self.assertTrue(nota.divergente)
        self.assertIn("8", nota.divergencia_detalhe)
        self.assertIn("6", nota.divergencia_detalhe)

    def test_item_novo_na_origem_gera_divergencia(self):
        nota = self._nota()
        outro = self.env['product.product'].create({
            'name': 'Produto Novo na Origem', 'is_storable': True,
        })

        self.env['stock.move'].create({
            'name': outro.name,
            'product_id': outro.id,
            'product_uom_qty': 2,
            'product_uom': outro.uom_id.id,
            'company_id': nota.company_id.id,
            'location_id': nota.picking_id.location_id.id,
            'location_dest_id': nota.picking_id.location_dest_id.id,
            'picking_id': nota.picking_id.id,
            'state': 'done',
            'quantity': 2,
        })

        self.assertTrue(nota.divergente)
        self.assertIn("item novo", nota.divergencia_detalhe)

    def test_item_zerado_na_origem_conta_como_removido(self):
        nota = self._nota()

        self._move_realizado(nota).write({'quantity': 0.0})

        self.assertTrue(nota.divergente)
        self.assertIn("removido", nota.divergencia_detalhe)

    # ── Bloqueio ─────────────────────────────────────────────────────────────
    def test_nota_divergente_nao_valida_nem_simula(self):
        nota = self._nota(quantidade=8.0)
        nota.nfe_validar()
        self._move_realizado(nota).write({'quantity': 6.0})

        nota.nfe_validar()
        self.assertEqual(nota.state, 'rascunho')
        self.assertIn("quantidade", nota.pendencias)

        with self.assertRaises(UserError):
            nota.nfe_emitir()

    def test_nota_validada_divergente_nao_simula(self):
        nota = self._nota(quantidade=8.0)
        nota.nfe_validar()
        self._move_realizado(nota).write({'quantity': 6.0})

        with self.assertRaises(UserError):
            nota.nfe_emitir()

        self.assertEqual(nota.state, 'validada', "bloqueada, não alterada sozinha")

    # ── Atualização explícita ────────────────────────────────────────────────
    def test_atualizar_quantidade_preserva_custo_capturado(self):
        nota = self._nota(quantidade=8.0)
        nota.nfe_validar()
        self.assertEqual(nota.state, 'validada')
        custo_capturado = nota.linha_ids.custo_unitario

        # Origem corrigida para 6 e custo do cadastro alterado depois disso.
        self._move_realizado(nota).write({'quantity': 6.0})
        self.produto.with_company(self.env.company).standard_price = 99.0

        nota.nfe_atualizar_da_transferencia()

        self.assertFalse(nota.divergente)
        self.assertEqual(nota.state, 'rascunho')
        self.assertEqual(nota.linha_ids.quantidade, 6.0)
        self.assertEqual(nota.linha_ids.custo_unitario, custo_capturado)
        self.assertEqual(nota.linha_ids.total_linha, 6.0 * custo_capturado)
        self.assertFalse(nota.pendencias)

    def test_atualizar_item_novo_captura_custo_vigente(self):
        nota = self._nota()
        custo_antigo = nota.linha_ids.custo_unitario
        outro = self.env['product.product'].create({
            'name': 'Produto Novo Custo', 'is_storable': True,
        })
        outro.with_company(self.env.company).standard_price = 50.0
        self.env['stock.move'].create({
            'name': outro.name,
            'product_id': outro.id,
            'product_uom_qty': 2,
            'product_uom': outro.uom_id.id,
            'company_id': nota.company_id.id,
            'location_id': nota.picking_id.location_id.id,
            'location_dest_id': nota.picking_id.location_dest_id.id,
            'picking_id': nota.picking_id.id,
            'state': 'done',
            'quantity': 2,
        })

        nota.nfe_atualizar_da_transferencia()

        self.assertEqual(len(nota.linha_ids), 2)
        linha_nova = nota.linha_ids.filtered(lambda l: l.product_id == outro)
        linha_antiga = nota.linha_ids - linha_nova
        self.assertEqual(linha_nova.custo_unitario, 50.0)
        self.assertEqual(linha_nova.quantidade, 2.0)
        self.assertEqual(linha_antiga.custo_unitario, custo_antigo)

    def test_atualizar_remove_item_que_saiu_da_origem(self):
        nota = self._nota()
        linha_antiga = nota.linha_ids

        self._move_realizado(nota).write({'quantity': 0.0})
        nota.nfe_atualizar_da_transferencia()

        self.assertFalse(nota.linha_ids.exists() & linha_antiga)
        self.assertFalse(nota.divergente)

    def test_atualizar_exige_nova_validacao(self):
        nota = self._nota()
        nota.nfe_validar()
        self._move_realizado(nota).write({'quantity': 5.0})

        nota.nfe_atualizar_da_transferencia()

        self.assertEqual(nota.state, 'rascunho')
        self.assertEqual(nota.linha_ids.quantidade, 5.0)
        # Nova validação volta a deixar a nota pronta.
        nota.nfe_validar()
        self.assertEqual(nota.state, 'validada')

    def test_atualizar_nao_altera_estoque_nem_financeiro(self):
        nota = self._nota()
        self._move_realizado(nota).write({'quantity': 4.0})
        moves = self.env['stock.move'].search_count([])
        quantidades = nota.picking_id.move_ids.mapped('quantity')
        faturas = self.env['account.move'].search_count([])

        nota.nfe_atualizar_da_transferencia()

        self.assertEqual(self.env['stock.move'].search_count([]), moves)
        self.assertEqual(nota.picking_id.move_ids.mapped('quantity'), quantidades)
        self.assertEqual(self.env['account.move'].search_count([]), faturas)
        self.assertEqual(nota.linha_ids.quantidade, 4.0)
