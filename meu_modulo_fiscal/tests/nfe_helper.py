# -*- coding: utf-8 -*-
"""Cenário compartilhado dos testes da NF-e modelo 55.

Uma transferência interna concluída, com filial destinatária, é o ponto de
partida de todo o fluxo (elegibilidade, preparo, custo, divergência).
"""


class NfeTransferMixin:
    @classmethod
    def _nfe_preparar_cenario(cls):
        cls.filial = cls.env['res.company'].create({'name': 'Filial NF-e Teste'})
        cls.produto = cls.env['product.product'].create({
            'name': 'Produto Transferência NF-e',
            'is_storable': True,
        })
        cls.tipo_interno = cls.env.ref('stock.picking_type_internal')
        cls.tipo_recebimento = cls.env.ref('stock.picking_type_in')
        cls.tipo_entrega = cls.env.ref('stock.picking_type_out')

    def _criar_transferencia(self, tipo=None, quantidade=10.0, realizada=None,
                             filial=None, produto=None, uom=None, validar=True):
        """Cria (e opcionalmente conclui) a transferência da filial."""
        tipo = tipo or self.tipo_interno
        produto = produto or self.produto
        uom = uom or produto.uom_id
        picking = self.env['stock.picking'].create({
            'picking_type_id': tipo.id,
            'location_id': tipo.default_location_src_id.id,
            'location_dest_id': tipo.default_location_dest_id.id,
            'x_nfe_filial_id': (filial or self.filial).id,
        })
        self.env['stock.move'].create({
            'name': produto.name,
            'product_id': produto.id,
            'product_uom_qty': quantidade,
            'product_uom': uom.id,
            'location_id': picking.location_id.id,
            'location_dest_id': picking.location_dest_id.id,
            'picking_id': picking.id,
        })
        picking.action_confirm()
        if not validar:
            return picking
        for move in picking.move_ids:
            move.quantity = quantidade if realizada is None else realizada
        # skip_backorder: sem o wizard, a parte pendente vira backorder —
        # exatamente o cenário "parcial 8 de 10" da spec.
        picking.with_context(skip_backorder=True).button_validate()
        return picking

    def _concluir_transferencia(self, picking):
        picking.action_confirm()
        for move in picking.move_ids:
            move.quantity = move.product_uom_qty
        picking.with_context(skip_backorder=True).button_validate()
        return picking
