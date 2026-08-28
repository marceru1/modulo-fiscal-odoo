from odoo.tests import TransactionCase


class TestStockPickingPrint(TransactionCase):
    """Override de ``button_validate``: retorna ``report_action`` do delivery
    slip ao validar pickings ``internal``/``incoming`` (D2), preservando os
    demais fluxos (outgoing, backorder, autoprint).

    Seam da spec: ``stock.picking.button_validate``.
    """

    def setUp(self):
        super().setUp()
        self.product = self.env['product.product'].create({
            'name': 'Produto Teste Impressão',
            'is_storable': True,
        })
        self.picking_type_internal = self.env.ref('stock.picking_type_internal')
        self.picking_type_in = self.env.ref('stock.picking_type_in')
        self.picking_type_out = self.env.ref('stock.picking_type_out')

    # ── Helpers ──────────────────────────────────────────────────────────────
    def _create_picking(self, picking_type, qty=10.0, qty_done=None):
        """Cria um picking confirmado com um move de ``qty`` (e ``qty_done``)."""
        picking = self.env['stock.picking'].create({
            'picking_type_id': picking_type.id,
            'location_id': picking_type.default_location_src_id.id,
            'location_dest_id': picking_type.default_location_dest_id.id,
        })
        self.env['stock.move'].create({
            'name': self.product.name,
            'product_id': self.product.id,
            'product_uom_qty': qty,
            'product_uom': self.product.uom_id.id,
            'location_id': picking.location_id.id,
            'location_dest_id': picking.location_dest_id.id,
            'picking_id': picking.id,
        })
        picking.action_confirm()
        if qty_done is None:
            qty_done = qty
        for move in picking.move_ids:
            move.quantity = qty_done
        return picking

    def _assert_report_action(self, result, picking):
        """Valida que o retorno é o ``report_action`` do delivery slip."""
        self.assertEqual(result['type'], 'ir.actions.report')
        self.assertEqual(result['report_name'], 'stock.report_deliveryslip')
        self.assertEqual(result['report_type'], 'qweb-pdf')
        self.assertEqual(result['context']['active_ids'], picking.ids)

    # ── T4: validar internal sem backorder → done + report action ────────────
    def test_validate_internal_returns_report(self):
        picking = self._create_picking(self.picking_type_internal)

        result = picking.button_validate()

        self.assertEqual(picking.state, 'done')
        self._assert_report_action(result, picking)

    # ── T6: validar incoming sem backorder → done + report action ────────────
    def test_validate_incoming_returns_report(self):
        picking = self._create_picking(self.picking_type_in)

        result = picking.button_validate()

        self.assertEqual(picking.state, 'done')
        self._assert_report_action(result, picking)

    # ── T3: validar outgoing → comportamento inalterado (True) ───────────────
    def test_validate_outgoing_unchanged(self):
        picking = self._create_picking(self.picking_type_out)

        result = picking.button_validate()

        self.assertEqual(picking.state, 'done')
        self.assertIs(result, True, "Outgoing não pode ser sobrescrito com report")

    # ── T5: validar internal com backorder → wizard, sem report ──────────────
    def test_validate_internal_with_backorder_returns_wizard(self):
        picking = self._create_picking(
            self.picking_type_internal, qty=10.0, qty_done=5.0
        )

        result = picking.button_validate()

        self.assertEqual(result['type'], 'ir.actions.act_window')
        self.assertEqual(result['res_model'], 'stock.backorder.confirmation')
        self.assertNotEqual(
            picking.state, 'done',
            "Com backorder o picking não pode ir a done antes do wizard"
        )
