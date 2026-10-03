from odoo.tests.common import TransactionCase

class TestAnaliseVendasPdv(TransactionCase):
    """Testa se o campo amount_acrescimo é populado corretamente no report.pos.order."""

    def setUp(self):
        super().setUp()
        self.company = self.env.company
        
        self.partner = self.env['res.partner'].create({
            'name': 'Cliente Teste Acrescimo',
        })
        
        self.product = self.env['product.product'].create({
            'name': 'Produto Teste Report',
            'list_price': 100.0,
        })
        
        # Odoo 18 - Point of Sale requer POS Config
        self.pos_config = self.env.ref('point_of_sale.pos_config_main', raise_if_not_found=False)
        if not self.pos_config:
            self.pos_config = self.env['pos.config'].create({
                'name': 'Main POS Config',
                'company_id': self.company.id,
            })
            
        self.pos_session = self.env['pos.session'].create({
            'config_id': self.pos_config.id,
            'user_id': self.env.uid,
        })
        self.pos_session.action_pos_session_open()

    def test_amount_acrescimo_computed(self):
        # Cria pedido com acréscimo 5.0
        order1 = self.env['pos.order'].create({
            'session_id': self.pos_session.id,
            'partner_id': self.partner.id,
            'x_amount_other_value': 5.0,
            'lines': [(0, 0, {
                'product_id': self.product.id,
                'qty': 1,
                'price_unit': 100.0,
                'price_subtotal': 100.0,
                'price_subtotal_incl': 100.0,
            })]
        })

        # Cria pedido sem acréscimo
        order2 = self.env['pos.order'].create({
            'session_id': self.pos_session.id,
            'partner_id': self.partner.id,
            'x_amount_other_value': 0.0,
            'lines': [(0, 0, {
                'product_id': self.product.id,
                'qty': 1,
                'price_unit': 100.0,
                'price_subtotal': 100.0,
                'price_subtotal_incl': 100.0,
            })]
        })

        # Em testes, as views SQL frequentemente não estão atualizadas imediatamente a menos que
        # flush seja chamado, e em alguns casos é preciso consultar diretamente
        self.env.flush_all()

        report1_lines = self.env['report.pos.order'].search(
            [('order_id', '=', order1.id)], limit=100
        )
        report2_lines = self.env['report.pos.order'].search(
            [('order_id', '=', order2.id)], limit=100
        )

        # Garante que o report tem linhas — sem isso, o for abaixo passaria em branco
        # sem exercitar nenhuma asserção (falso positivo silencioso).
        # NOTA: se order1/order2 estiverem em 'draft', o SQL view pode não retornar linhas.
        # Nesse caso, o teste deve ser ajustado para fechar a sessão antes de buscar.
        self.assertTrue(
            report1_lines,
            "report.pos.order deve conter linhas para order1 — verifique se o pedido está em estado correto"
        )
        self.assertTrue(
            report2_lines,
            "report.pos.order deve conter linhas para order2 — verifique se o pedido está em estado correto"
        )

        for line in report1_lines:
            self.assertEqual(line.amount_acrescimo, 5.0, "O acréscimo do pedido 1 deve refletir 5.0 no relatório")

        for line in report2_lines:
            self.assertEqual(line.amount_acrescimo, 0.0, "O acréscimo do pedido 2 deve refletir 0.0 no relatório")

