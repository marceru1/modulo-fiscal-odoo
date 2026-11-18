# -*- coding: utf-8 -*-
"""Elegibilidade da transferência como origem da NF-e modelo 55 (ticket 01)."""

from odoo.exceptions import UserError
from odoo.tests import TransactionCase

from .nfe_helper import NfeTransferMixin


class TestNfeElegibilidade(NfeTransferMixin, TransactionCase):
    """Regra do servidor (DEC-006/007): a origem precisa ser uma transferência
    interna CONCLUÍDA, com Filial destinatária e quantidade realizada.

    Seam da spec: ``stock.picking.nfe_verificar_elegibilidade`` — o mesmo
    método usado pelas ações do fluxo, então o teste vale por chamada direta
    (não depende da visibilidade do botão).
    """

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls._nfe_preparar_cenario()

    # ── Caminho feliz ────────────────────────────────────────────────────────
    def test_transferencia_interna_concluida_e_elegivel(self):
        picking = self._criar_transferencia(self.tipo_interno)

        self.assertEqual(picking.state, 'done')
        self.assertTrue(picking.nfe_verificar_elegibilidade())
        self.assertEqual(picking._nfe_motivos_inelegibilidade(), [])

    def test_filial_nao_e_obrigatoria_na_transferencia(self):
        """Campo opcional: o fluxo normal de estoque não exige destinatária."""
        picking = self._criar_transferencia(self.tipo_recebimento, validar=False)
        picking.x_nfe_filial_id = False

        for move in picking.move_ids:
            move.quantity = move.product_uom_qty
        picking.with_context(skip_backorder=True).button_validate()

        self.assertEqual(picking.state, 'done')
        self.assertFalse(picking.x_nfe_filial_id)

    # ── Rejeições por chamada direta ao servidor ─────────────────────────────
    def test_rejeita_picking_nao_concluido(self):
        picking = self._criar_transferencia(self.tipo_interno, validar=False)

        self.assertNotEqual(picking.state, 'done')
        with self.assertRaises(UserError):
            picking.nfe_verificar_elegibilidade()

    def test_rejeita_picking_cancelado(self):
        picking = self._criar_transferencia(self.tipo_interno, validar=False)
        picking.action_cancel()

        self.assertEqual(picking.state, 'cancel')
        with self.assertRaises(UserError):
            picking.nfe_verificar_elegibilidade()

    def test_rejeita_recebimento(self):
        picking = self._criar_transferencia(self.tipo_recebimento)

        self.assertEqual(picking.state, 'done')
        with self.assertRaisesRegex(UserError, "não é um envio para filial"):
            picking.nfe_verificar_elegibilidade()

    def test_rejeita_entrega_ao_cliente(self):
        picking = self._criar_transferencia(self.tipo_entrega)

        self.assertEqual(picking.state, 'done')
        with self.assertRaisesRegex(UserError, "não é um envio para filial"):
            picking.nfe_verificar_elegibilidade()

    def test_rejeita_sem_filial_destinataria(self):
        picking = self._criar_transferencia(self.tipo_interno)
        picking.x_nfe_filial_id = False

        with self.assertRaisesRegex(UserError, "Filial destinatária"):
            picking.nfe_verificar_elegibilidade()

    def test_rejeita_devolucao(self):
        origem = self._criar_transferencia(self.tipo_interno)
        wizard = self.env['stock.return.picking'].with_context(
            active_id=origem.id, active_ids=origem.ids, active_model='stock.picking',
        ).create({})
        acao = wizard.action_create_returns_all()
        devolucao = self.env['stock.picking'].browse(acao['res_id'])
        devolucao.x_nfe_filial_id = self.filial

        self.assertEqual(devolucao.return_id, origem)
        devolucao.action_confirm()
        for move in devolucao.move_ids:
            move.quantity = move.product_uom_qty
        devolucao.with_context(skip_backorder=True).button_validate()

        self.assertEqual(devolucao.state, 'done')
        self.assertEqual(devolucao.picking_type_id.code, 'internal')
        with self.assertRaisesRegex(UserError, "Devoluções"):
            devolucao.nfe_verificar_elegibilidade()

    # ── Quantidade realizada (parcial) ───────────────────────────────────────
    def test_quantidade_realizada_ignora_linha_cancelada(self):
        """Movimentos cancelados/zerados não contam como realizados."""
        # Produto distinto: moves com o MESMO produto/locais são fundidos na
        # confirmação nativa (_merge_moves), o que apagaria a linha cancelada.
        outro_produto = self.env['product.product'].create({
            'name': 'Produto Cancelado NF-e',
            'is_storable': True,
        })
        picking = self._criar_transferencia(self.tipo_interno, validar=False)
        cancelado = self.env['stock.move'].create({
            'name': outro_produto.name,
            'product_id': outro_produto.id,
            'product_uom_qty': 5,
            'product_uom': outro_produto.uom_id.id,
            'location_id': picking.location_id.id,
            'location_dest_id': picking.location_dest_id.id,
            'picking_id': picking.id,
        })
        picking.action_confirm()
        cancelado._action_cancel()
        for move in picking.move_ids - cancelado:
            move.quantity = 8.0
        picking.with_context(skip_backorder=True).button_validate()

        self.assertEqual(picking.state, 'done')
        self.assertEqual(cancelado.state, 'cancel')
        realizados = picking._nfe_moves_realizados()
        self.assertEqual(len(realizados), 1)
        self.assertEqual(realizados.quantity, 8.0)
        self.assertNotIn(cancelado, realizados)
