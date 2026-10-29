"""Fatura no histórico A Prazo (spec: prazo-fatura-na-aba).

Seams testados:
- campo ``x.prazo.movimentacao.fatura_name`` (existência e ordem na lista);
- ``pos.order._generate_pos_order_invoice`` (preenche a mov de compra);
- ``pos.session.create_recebimento`` (mov de pagamento nasce com a fatura);
- ``x.prazo.movimentacao._backfill_fatura_name`` (retroativo idempotente);
- dedupe de ``_register_prazo_movimentacoes`` (pos_reference continua a chave).
"""

from odoo.tests import TransactionCase

from .paridade_offline_helper import criar_pedido, montar_pos_offline


class TestPrazoFatura(TransactionCase):
    def setUp(self):
        super().setUp()
        self.mov_model = self.env['x.prazo.movimentacao']
        # Ambiente de POS (journals, métodos Dinheiro/Cartão/A Prazo, sessão)
        # reaproveitado dos testes de fechamento offline.
        montar_pos_offline(self)
        self.funcionaria = self.env['res.partner'].create({
            'name': 'Funcionária Teste',
        })
        self.employee = self.env['hr.employee'].create({
            'name': 'Funcionária Teste',
            'work_contact_id': self.funcionaria.id,
        })

    # ── Helper ───────────────────────────────────────────────────────────────
    def _ref(self, order):
        return order.pos_reference or order.name

    def _movs(self, order):
        return self.mov_model.search([('pos_reference', '=', self._ref(order))])

    # ── Campo + lista ────────────────────────────────────────────────────────
    def test_movimentacao_tem_campo_fatura(self):
        """``fatura_name`` existe no modelo (spec: Implementation Decisions)."""
        self.assertIn('fatura_name', self.mov_model._fields)

    def test_lista_mostra_fatura_antes_do_cupom(self):
        """A lista de movimentações exibe Fatura ANTES de Cupom (DEC-005)."""
        arch = self.env.ref(
            'meu_modulo_fiscal.view_x_prazo_movimentacao_list'
        ).arch
        self.assertIn('fatura_name', arch)
        self.assertLess(
            arch.index('fatura_name'), arch.index('pos_reference'),
            'A coluna Fatura deve vir antes da coluna Cupom',
        )

    # ── Compra a prazo: fatura na movimentação ───────────────────────────────
    def test_compra_recebe_fatura_ao_gerar_invoice(self):
        """Venda a prazo → mov 'compra' nasce sem fatura e a recebe após o
        core gerar+postar o account.move (DEC-002)."""
        order = criar_pedido(self, 100.0, self.later_pm, partner=self.funcionaria)
        mov = self._movs(order)
        self.assertEqual(len(mov), 1, 'A venda a prazo deveria gerar 1 movimentação')
        self.assertEqual(mov.tipo, 'compra')
        self.assertFalse(mov.fatura_name, 'Sem fatura antes do faturamento')

        order.with_context(generate_pdf=False)._generate_pos_order_invoice()

        self.assertTrue(order.account_move, 'O core deveria ter gerado a fatura')
        self.assertEqual(mov.fatura_name, order.account_move.name)
        self.assertNotEqual(mov.fatura_name, '/', 'Fatura postada tem número')

    def test_pedido_sem_pay_later_nao_cria_mov(self):
        """Pedido sem pay_later → nenhuma movimentação e nenhum erro (no-op)."""
        order = criar_pedido(self, 50.0, self.bank_pm, partner=self.funcionaria)
        self.assertFalse(
            self.mov_model.search_count([('employee_id', '=', self.employee.id)]),
            'Pagamento em cartão não gera movimentação a prazo',
        )

        order.with_context(generate_pdf=False)._generate_pos_order_invoice()

        self.assertTrue(order.account_move, 'A fatura é gerada normalmente')
        self.assertFalse(
            self.mov_model.search_count([('employee_id', '=', self.employee.id)]),
            'O hook não pode criar movimentação para quem não comprou a prazo',
        )

    def test_dedupe_intacto_em_resync(self):
        """Re-executar _register_prazo_movimentacoes no mesmo pedido não duplica
        e não apaga a fatura já gravada (pos_reference segue chave de dedupe)."""
        order = criar_pedido(self, 100.0, self.later_pm, partner=self.funcionaria)
        order.with_context(generate_pdf=False)._generate_pos_order_invoice()

        order._register_prazo_movimentacoes()
        order._register_prazo_movimentacoes()

        movs = self._movs(order)
        self.assertEqual(len(movs), 1, 'Re-sync não pode duplicar a movimentação')
        self.assertEqual(movs.fatura_name, order.account_move.name)
