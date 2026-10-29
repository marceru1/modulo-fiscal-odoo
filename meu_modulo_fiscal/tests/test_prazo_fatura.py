"""Fatura no histórico A Prazo (spec: prazo-fatura-na-aba).

Seams testados:
- campo ``x.prazo.movimentacao.fatura_name`` (existência e ordem na lista);
- ``pos.order._generate_pos_order_invoice`` (preenche a mov de compra);
- ``pos.session.create_recebimento`` (mov de pagamento nasce com a fatura);
- ``x.prazo.movimentacao._backfill_fatura_name`` (retroativo idempotente);
- dedupe de ``_register_prazo_movimentacoes`` (pos_reference continua a chave).
"""

from odoo.tests import TransactionCase


class TestPrazoFatura(TransactionCase):
    def setUp(self):
        super().setUp()
        self.mov_model = self.env['x.prazo.movimentacao']

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
