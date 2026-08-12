from odoo.tests import TransactionCase


class TestSangriaSaldo(TransactionCase):
    """Regressão da feature sangria-reduzir-dinheiro (RF-01/RF-03).

    O backend já calculava ``saldo_caixa`` corretamente, mas o front-end
    exibia o total bruto de vendas em dinheiro. Esta feature expõe
    ``dinheiro_liquido`` (vendas em dinheiro − sangrias) no payload de
    ``get_fechamento_data`` para o popup/relatório exibirem o valor correto.

    O seam de teste é o helper ``_calc_dinheiro_liquido`` (cálculo puro) e o
    contrato de ``get_fechamento_data`` (a chave existe no payload).
    """

    def setUp(self):
        super().setUp()
        self.company = self.env.company

        self.journal = self.env['account.journal'].create({
            'name': 'Diário PDV Teste Sangria',
            'type': 'sale',
            'code': 'PDV',
            'company_id': self.company.id,
        })

        self.pos_config = self.env['pos.config'].create({
            'name': 'PDV Teste Sangria',
            'journal_id': self.journal.id,
        })

        self.pos_session = self.env['pos.session'].create({
            'config_id': self.pos_config.id,
            'user_id': self.env.user.id,
        })
        self.pos_session.action_pos_session_open()

    # ── Helpers ──────────────────────────────────────────────────────────────
    def _cash_details(self, payment_amount, moves=None):
        """Monta um dict default_cash_details no formato do core."""
        return {
            'name': 'Dinheiro',
            'payment_amount': payment_amount,
            'moves': moves or [],
        }

    # ── Caso 1: sangria reduz o dinheiro (AC-01) ────────────────────────────
    def test_dinheiro_liquido_com_sangria(self):
        """Vendas em dinheiro 100 − sangria 30 → dinheiro_liquido 70."""
        cash = self._cash_details(100.0)
        result = self.pos_session._calc_dinheiro_liquido(cash, 30.0)
        self.assertAlmostEqual(result, 70.0, places=2)

    # ── Caso 2: sem sangria → total bruto (AC-06) ──────────────────────────
    def test_dinheiro_liquido_sem_sangria(self):
        """Vendas em dinheiro 100 − sangria 0 → dinheiro_liquido 100."""
        cash = self._cash_details(100.0)
        result = self.pos_session._calc_dinheiro_liquido(cash, 0.0)
        self.assertAlmostEqual(result, 100.0, places=2)

    # ── Caso 3: múltiplas sangrias somam (AC-05) ────────────────────────────
    def test_dinheiro_liquido_multiplas_sangrias(self):
        """Vendas em dinheiro 100 − sangrias 15+30=45 → dinheiro_liquido 55."""
        cash = self._cash_details(100.0)
        result = self.pos_session._calc_dinheiro_liquido(cash, 45.0)
        self.assertAlmostEqual(result, 55.0, places=2)

    # ── Caso 4: sem cash_details → 0 − sangrias (edge case) ─────────────────
    def test_dinheiro_liquido_sem_cash_details(self):
        """Sem default_cash_details → dinheiro_bruto 0, líquido = −sangrias."""
        result = self.pos_session._calc_dinheiro_liquido({}, 10.0)
        self.assertAlmostEqual(result, -10.0, places=2)

    # ── Caso 5: contrato — get_fechamento_data expõe dinheiro_liquido ───────
    def test_get_fechamento_data_expoe_dinheiro_liquido(self):
        """O payload de get_fechamento_data deve conter a chave dinheiro_liquido
        (numérica), que alimenta o template do popup/relatório."""
        dados = self.pos_session.get_fechamento_data()
        self.assertIn('dinheiro_liquido', dados)
        self.assertIsInstance(dados['dinheiro_liquido'], float)
