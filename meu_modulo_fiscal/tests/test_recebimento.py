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

    # ── Helpers ──────────────────────────────────────────────────────────────
    def _create_payment_method(self, name, journal_type='bank'):
        """Cria um pos.payment.method com diário do tipo informado.

        O ``type`` do método é computado a partir do ``journal_id.type``
        (cash/bank → mesmo tipo; outro → 'pay_later').
        """
        journal = self.env['account.journal'].create({
            'name': 'Diário %s Teste' % name,
            'type': journal_type,
            'company_id': self.company.id,
        })
        return self.env['pos.payment.method'].create({
            'name': name,
            'journal_id': journal.id,
        })

    def _assert_comprovante(self, response, amount, payment_method_name=''):
        """Valida a estrutura da chave ``comprovante`` no retorno de sucesso.

        Seam da spec: a chave ``comprovante`` carrega todos os dados necessários
        para imprimir o comprovante de pagamento na térmica do PDV.
        """
        self.assertIn('comprovante', response)
        comp = response['comprovante']
        self.assertEqual(comp['valor_pago'], amount)
        self.assertEqual(comp['fatura'], self.invoice.name)
        self.assertIsInstance(comp['data_hora'], str)
        # Ticket 04: tipos explícitos + valores vinculados ao contexto da sessão
        self.assertIsInstance(comp['numero_pdv'], int)
        self.assertEqual(comp['numero_pdv'], self.pos_config.id)
        self.assertIsInstance(comp['operador'], str)
        self.assertEqual(comp['operador'], self.pos_session.user_id.name)
        self.assertEqual(comp['forma_pagamento'], payment_method_name)

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
        # DEC-004: comprovante presente e com o valor pago (não o residual)
        self._assert_comprovante(result, 30.0)

    # ── Caso 2: Quitação total ──────────────────────────────────────────────
    def test_quitacao_total(self):
        """Amount = residual → success=True, fatura quitada."""
        result = self.pos_session.create_recebimento(self.invoice.id, 100.0)

        self.assertTrue(result['success'], msg="Quitação total deveria ser aceita")
        self.assertIn(
            self.invoice.payment_state, ('in_payment', 'paid'),
            msg="Fatura quitada deve ter payment_state='in_payment' ou 'paid'"
        )
        # User Story 3: comprovante sai também na quitação total
        self._assert_comprovante(result, 100.0)

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

    # ── Caso 8: payment_method_name explícito (DEC-001) ─────────────────────
    def test_comprovante_payment_method_name(self):
        """payment_method_name passado → comp['forma_pagamento'] == valor."""
        result = self.pos_session.create_recebimento(
            self.invoice.id, 30.0, payment_method_name='Cartão'
        )

        self.assertTrue(result['success'])
        self._assert_comprovante(result, 30.0, payment_method_name='Cartão')

    # ── Caso 9: payment_method_name default (backward-compatible) ───────────
    def test_comprovante_default_payment_method(self):
        """Sem payment_method_name → comp['forma_pagamento'] == '' (default)."""
        result = self.pos_session.create_recebimento(self.invoice.id, 30.0)

        self.assertTrue(result['success'])
        self._assert_comprovante(result, 30.0, payment_method_name='')

    # ── Caso 10: Falha não carrega comprovante (DEC-004) ────────────────────
    def test_falha_sem_comprovante(self):
        """success=False → chave 'comprovante' ausente do retorno."""
        result = self.pos_session.create_recebimento(self.invoice.id, 0.0)

        self.assertFalse(result['success'])
        self.assertNotIn('comprovante', result)

    # ── Caso 11: payment_method_id válido (DEC-001) ─────────────────────────
    def test_payment_method_id_salvo(self):
        """payment_method_id válido → x_payment_method_id salvo no account.payment
        e comp['forma_pagamento'] == nome do método."""
        pm = self._create_payment_method('PIX')
        result = self.pos_session.create_recebimento(
            self.invoice.id, 30.0, payment_method_id=pm.id
        )

        self.assertTrue(result['success'])
        payment = self.env['account.payment'].search([
            ('memo', 'like', 'Recebimento PDV'),
        ], limit=1, order='id desc')
        self.assertEqual(
            payment.x_payment_method_id, pm,
            msg="account.payment deve ter x_payment_method_id apontando pro método"
        )
        self._assert_comprovante(result, 30.0, payment_method_name='PIX')

    # ── Caso 12: payment_method_id=None (backward-compatible) ───────────────
    def test_payment_method_id_none_backward_compat(self):
        """Sem payment_method_id, payment_method_name='PIX' → forma_pagamento='PIX'
        (compat retrógrada mantida)."""
        result = self.pos_session.create_recebimento(
            self.invoice.id, 30.0, payment_method_name='PIX'
        )

        self.assertTrue(result['success'])
        self._assert_comprovante(result, 30.0, payment_method_name='PIX')

    # ── Caso 13: payment_method_id inválido (graceful fallback) ─────────────
    def test_payment_method_id_invalido(self):
        """payment_method_id inexistente → recebimento ainda criado com sucesso
        (fallback: usa payment_method_name, não quebra)."""
        result = self.pos_session.create_recebimento(
            self.invoice.id, 30.0, payment_method_id=999999
        )

        self.assertTrue(result['success'])
        self._assert_comprovante(result, 30.0, payment_method_name='')

    # ── Caso 14: _get_recebimentos com método (DEC-005) ────────────────────
    def test_get_recebimentos_com_metodo(self):
        """Pagamento com x_payment_method_id → forma_pagamento correto e
        recebimentos_por_metodo somando no método certo."""
        pm = self._create_payment_method('PIX')
        self.pos_session.create_recebimento(
            self.invoice.id, 30.0, payment_method_id=pm.id
        )

        recebimentos, total, por_metodo = self.pos_session._get_recebimentos()

        self.assertEqual(len(recebimentos), 1)
        self.assertEqual(recebimentos[0]['forma_pagamento'], 'PIX')
        self.assertAlmostEqual(total, 30.0, places=2)
        self.assertEqual(por_metodo, {'PIX': 30.0})

    # ── Caso 15: _get_recebimentos sem método (DEC-005) ────────────────────
    def test_get_recebimentos_sem_metodo(self):
        """Pagamento sem x_payment_method_id → forma_pagamento '—' e
        recebimentos_por_metodo usa '—' como chave (não quebra)."""
        self.pos_session.create_recebimento(self.invoice.id, 30.0)

        recebimentos, total, por_metodo = self.pos_session._get_recebimentos()

        self.assertEqual(len(recebimentos), 1)
        self.assertEqual(recebimentos[0]['forma_pagamento'], '—')
        self.assertAlmostEqual(total, 30.0, places=2)
        self.assertEqual(por_metodo, {'—': 30.0})

    # ── Caso 16: _calc_saldo_detalhado soma recebimentos (DEC-006) ─────────
    def test_calc_saldo_detalhado_soma_recebimentos(self):
        """Vendas PIX 100 + recebimentos PIX 50 → calculado 150."""
        metodos = [{'nome': 'PIX', 'valor': 100.0}]
        por_metodo = {'PIX': 50.0}

        saldo = self.pos_session._calc_saldo_detalhado(metodos, por_metodo)

        self.assertEqual(len(saldo), 1)
        self.assertEqual(saldo[0]['nome'], 'PIX')
        self.assertAlmostEqual(saldo[0]['calculado'], 150.0, places=2)
        self.assertAlmostEqual(saldo[0]['diferenca'], -150.0, places=2)

    # ── Caso 17: método só em recebimentos (DEC-006) ───────────────────────
    def test_calc_saldo_detalhado_metodo_so_em_recebimentos(self):
        """Método 'Dinheiro' só em recebimentos (sem venda) → aparece no
        resultado com calculado == valor do recebimento."""
        metodos = [{'nome': 'PIX', 'valor': 100.0}]
        por_metodo = {'Dinheiro': 200.0}

        saldo = self.pos_session._calc_saldo_detalhado(metodos, por_metodo)

        nomes = {s['nome'] for s in saldo}
        self.assertEqual(nomes, {'PIX', 'Dinheiro'})
        dinheiro = next(s for s in saldo if s['nome'] == 'Dinheiro')
        self.assertAlmostEqual(dinheiro['calculado'], 200.0, places=2)
        pix = next(s for s in saldo if s['nome'] == 'PIX')
        self.assertAlmostEqual(pix['calculado'], 100.0, places=2)
