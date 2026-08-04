from odoo.tests import TransactionCase
from odoo import fields
from datetime import datetime


class TestRecebimento(TransactionCase):
    """Testa o recebimento parcial de faturas no PDV (create_recebimento)."""

    def setUp(self):
        super().setUp()
        # ── Company padrão ──────────────────────────────────────────────────
        self.company = self.env.company

        # ── Partner ────────────────────────────────────────────────────────
        self.partner = self.env['res.partner'].create({
            'name': 'Cliente Teste Recebimento',
        })

        # ── Pos Config ──────────────────────────────────────────────────────
        # Cria um diário de vendas para o POS
        self.journal = self.env['account.journal'].create({
            'name': 'Diário PDV Teste',
            'type': 'sale',
            'code': 'PDV',
            'company_id': self.company.id,
        })

        self.pos_config = self.env['pos.config'].create({
            'name': 'PDV Teste Recebimento',
            'journal_id': self.journal.id,
        })

        # ── Pos Session ────────────────────────────────────────────────────
        self.pos_session = self.env['pos.session'].create({
            'config_id': self.pos_config.id,
            'user_id': self.env.user.id,
        })
        self.pos_session.action_pos_session_open()

        # ── Fatura (account.move) ───────────────────────────────────────────
        # Cria uma fatura de cliente (out_invoice) de R$ 100,00
        self.invoice = self.env['account.move'].create({
            'move_type': 'out_invoice',
            'partner_id': self.partner.id,
            'invoice_date': fields.Date.today(),
            'invoice_line_ids': [(0, 0, {
                'name': 'Produto Teste',
                'quantity': 1.0,
                'price_unit': 100.0,
            })],
        })
        self.invoice.action_post()

    # ── Caso 1: Pagamento parcial ──────────────────────────────────────────
    def test_pagamento_parcial(self):
        """Amount < residual → success=True, payment_state='partial', saldo correto."""
        result = self.pos_session.create_recebimento(self.invoice.id, 30.0)

        self.assertTrue(result['success'], msg="Pagamento parcial deveria ser aceito")
        self.assertIn("70", result['message'],
                       msg="Mensagem deve conter o saldo restante (70)")
        self.assertEqual(
            self.invoice.payment_state, 'partial',
            msg="Fatura parcialmente quitada deve ter payment_state='partial'"
        )
        self.assertAlmostEqual(
            self.invoice.amount_residual, 70.0, places=2,
            msg="Saldo residual deve ser R$ 70,00 após pagamento de R$ 30,00"
        )

    # ── Caso 2: Quitação total ──────────────────────────────────────────────
    def test_quitacao_total(self):
        """Amount = residual → success=True, fatura quitada."""
        result = self.pos_session.create_recebimento(self.invoice.id, 100.0)

        self.assertTrue(result['success'], msg="Quitação total deveria ser aceita")
        self.assertIn(
            self.invoice.payment_state, ('in_payment', 'paid'),
            msg="Fatura quitada deve ter payment_state='in_payment' ou 'paid'"
        )

    # ── Caso 3: Amount zero ────────────────────────────────────────────────
    def test_amount_zero(self):
        """Amount = 0 → success=False."""
        result = self.pos_session.create_recebimento(self.invoice.id, 0.0)

        self.assertFalse(result['success'], msg="Amount zero deve ser rejeitado")

    # ── Caso 4: Abaixo do mínimo ──────────────────────────────────────────
    def test_amount_abaixo_minimo(self):
        """Amount = 0.50 (< 1.0) → success=False."""
        result = self.pos_session.create_recebimento(self.invoice.id, 0.50)

        self.assertFalse(result['success'], msg="Amount abaixo de R$ 1,00 deve ser rejeitado")
        self.assertIn(
            "minimo", result['message'].lower(),
            msg="Mensagem deve mencionar valor mínimo"
        )

    # ── Caso 5: Acima do residual ─────────────────────────────────────────
    def test_amount_acima_residual(self):
        """Amount > residual + 0.001 → success=False."""
        result = self.pos_session.create_recebimento(self.invoice.id, 110.0)

        self.assertFalse(result['success'], msg="Amount acima do residual deve ser rejeitado")
        self.assertIn(
            "superior", result['message'].lower(),
            msg="Mensagem deve mencionar que valor é superior ao saldo"
        )

    # ── Caso 6: Fatura inexistente ────────────────────────────────────────
    def test_fatura_inexistente(self):
        """invoice_id inválido → success=False."""
        result = self.pos_session.create_recebimento(9999999, 30.0)

        self.assertFalse(result['success'], msg="Fatura inexistente deve ser rejeitada")
        self.assertIn(
            "nao encontrada", result['message'].lower(),
            msg="Mensagem deve indicar que fatura não foi encontrada"
        )

    # ── Caso 7: Fatura já quitada ──────────────────────────────────────────
    def test_fatura_ja_quitada(self):
        """Fatura com payment_state='paid' → success=False."""
        # Primeiro quita a fatura totalmente
        self.pos_session.create_recebimento(self.invoice.id, 100.0)

        # Tenta receber novamente
        result = self.pos_session.create_recebimento(self.invoice.id, 10.0)

        self.assertFalse(result['success'], msg="Fatura já quitada deve ser rejeitada")
        self.assertIn(
            "quitada", result['message'].lower(),
            msg="Mensagem deve indicar que fatura já foi quitada"
        )
