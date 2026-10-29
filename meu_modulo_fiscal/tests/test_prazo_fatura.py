"""Fatura no histórico A Prazo (spec: prazo-fatura-na-aba).

Seams testados:
- campo ``x.prazo.movimentacao.fatura_name`` (existência e ordem na lista);
- ``pos.order._generate_pos_order_invoice`` (preenche a mov de compra);
- ``pos.session.create_recebimento`` (mov de pagamento nasce com a fatura);
- ``x.prazo.movimentacao._backfill_fatura_name`` (retroativo idempotente);
- dedupe de ``_register_prazo_movimentacoes`` (pos_reference continua a chave).
"""

from odoo import fields
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
        return self.mov_model.search([
            ('pos_reference', '=', self._ref(order)),
            ('partner_id', '=', order.partner_id.id),
        ])

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

    # ── Cupom igual em outro parceiro (DEC-006) ──────────────────────────────
    def _outro_parceiro(self):
        return self.env['res.partner'].create({'name': 'Outra Parceira'})

    def test_hook_ignora_mov_de_outro_parceiro(self):
        """Cupom repetido em outra parceira não recebe a fatura deste pedido:
        a busca é por cupom + parceiro (DEC-006)."""
        order = criar_pedido(self, 100.0, self.later_pm, partner=self.funcionaria)
        intrusa = self.mov_model.create({
            'employee_id': self.employee.id,
            'partner_id': self._outro_parceiro().id,
            'valor': 10.0,
            'tipo': 'compra',
            'pos_reference': self._ref(order),
        })

        order.with_context(generate_pdf=False)._generate_pos_order_invoice()

        propria = self._movs(order)
        self.assertEqual(len(propria), 1)
        self.assertEqual(propria.fatura_name, order.account_move.name)
        self.assertFalse(
            intrusa.fatura_name,
            'A mov de outra parceira não pode receber a fatura deste pedido',
        )

    def test_dedupe_considera_o_parceiro(self):
        """Cupom repetido em outra parceira não bloqueia o registro do pedido
        (o dedupe passou a casar cupom + parceiro)."""
        order = criar_pedido(self, 100.0, self.later_pm, partner=self.funcionaria)
        self._movs(order).unlink()  # limpa a mov criada no create
        self.mov_model.create({
            'employee_id': self.employee.id,
            'partner_id': self._outro_parceiro().id,
            'valor': 10.0,
            'tipo': 'compra',
            'pos_reference': self._ref(order),
        })

        order._register_prazo_movimentacoes()

        self.assertEqual(
            len(self._movs(order)), 1,
            'A mov do parceiro do pedido deveria ser criada normalmente',
        )

    # ── Recebimento pelo PDV ─────────────────────────────────────────────────
    def test_recebimento_registra_fatura(self):
        """Recebimento pelo PDV → mov 'pagamento' nasce com a fatura recebida
        (DEC-003: o invoice.name já está em mãos no método)."""
        invoice = self.env['account.move'].create({
            'move_type': 'out_invoice',
            'partner_id': self.funcionaria.id,
            'invoice_date': fields.Date.today(),
            'invoice_line_ids': [(0, 0, {
                'name': 'Compra a prazo',
                'quantity': 1.0,
                'price_unit': 100.0,
            })],
        })
        invoice.action_post()

        result = self.pos_session.create_recebimento(invoice.id)
        self.assertTrue(result['success'], result.get('message'))

        mov = self.mov_model.search([
            ('employee_id', '=', self.employee.id),
            ('tipo', '=', 'pagamento'),
        ])
        self.assertEqual(len(mov), 1, 'O recebimento deveria gerar 1 movimentação')
        self.assertEqual(mov.fatura_name, invoice.name)

    # ── Retroativo (DEC-004) ─────────────────────────────────────────────────
    def _order_faturado(self):
        """Pedido a prazo com fatura, devolvendo (order, mov de compra)."""
        order = criar_pedido(self, 100.0, self.later_pm, partner=self.funcionaria)
        order.with_context(generate_pdf=False)._generate_pos_order_invoice()
        return order, self._movs(order)

    def test_retroativo_preenche_compras_antigas(self):
        """Histórico anterior à feature: mov de compra sem fatura é preenchida
        pelo cupom do pedido; sem pedido faturado, fica como está."""
        order, mov = self._order_faturado()
        mov.fatura_name = False  # simula mov gravada antes desta feature

        # Compra órfã: cupom que não existe em pos.order → não pode ser casada.
        orfa = self.mov_model.create({
            'employee_id': self.employee.id,
            'partner_id': self.funcionaria.id,
            'valor': 30.0,
            'tipo': 'compra',
            'pos_reference': 'CUPOM-SEM-PEDIDO',
        })
        # Recebimento antigo (sem cupom) → fora do escopo do retroativo.
        recebimento_antigo = self.mov_model.create({
            'employee_id': self.employee.id,
            'partner_id': self.funcionaria.id,
            'valor': 20.0,
            'tipo': 'pagamento',
        })

        self.mov_model._backfill_fatura_name()

        self.assertEqual(mov.fatura_name, order.account_move.name)
        self.assertFalse(orfa.fatura_name, 'Sem pedido faturado não há o que preencher')
        self.assertFalse(
            recebimento_antigo.fatura_name,
            'Recebimentos antigos ficam como estão (out of scope)',
        )

    def test_retroativo_idempotente(self):
        """Rodar o backfill duas vezes não muda nada nem duplica movs."""
        order, mov = self._order_faturado()
        mov.fatura_name = False

        self.mov_model._backfill_fatura_name()
        primeira = mov.fatura_name
        self.assertEqual(primeira, order.account_move.name)

        self.mov_model._backfill_fatura_name()

        self.assertEqual(mov.fatura_name, primeira)
        self.assertEqual(self._movs(order).ids, [mov.id], 'Nenhuma mov duplicada')

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
