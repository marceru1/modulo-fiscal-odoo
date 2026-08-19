from odoo.tests import TransactionCase


class TestSangriaSaldo(TransactionCase):
    """Regressão da feature sangria-reduzir-dinheiro (RF-01/RF-03).

    O backend já calculava ``saldo_caixa`` corretamente, mas o front-end
    exibia o total bruto de vendas em dinheiro. Esta feature expõe
    ``dinheiro_liquido`` (vendas em dinheiro − sangrias) no payload de
    ``get_fechamento_data`` para o popup/relatório exibirem o valor correto.

    O seam de teste é o helper ``_calc_dinheiro_liquido`` (cálculo puro) e o
    contrato de ``get_fechamento_data`` (a chave existe no payload).

    Cobertura adicional (fix SALDO DO CAIXA): ``_calc_saldo_caixa_dinheiro``
    (gaveta física = fundo + vendas em dinheiro + suprimentos + recebimentos
    em dinheiro − sangrias, excluindo cartão/PIX/a prazo) e o contrato do
    payload ``saldo_movimentacao`` (gaveta) + ``movimentacao_total`` (auditoria
    todos-os-métodos).
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

    # ── Caso 6: contrato — saldo_movimentacao (gaveta) + movimentacao_total ─
    def test_get_fechamento_data_expoe_saldo_e_movimentacao_total(self):
        """O payload deve ter saldo_movimentacao (gaveta física, só dinheiro)
        com saldo float, e movimentacao_total (todos os métodos, auditoria)
        como dict com entradas/saidas/saldo float."""
        dados = self.pos_session.get_fechamento_data()
        # Gaveta física
        self.assertIn('saldo_movimentacao', dados)
        self.assertIsInstance(dados['saldo_movimentacao']['saldo'], float)
        # Auditoria todos-os-métodos
        self.assertIn('movimentacao_total', dados)
        mov = dados['movimentacao_total']
        self.assertIsInstance(mov['entradas'], float)
        self.assertIsInstance(mov['saidas'], float)
        self.assertIsInstance(mov['saldo'], float)

    # ── Helper _calc_saldo_caixa_dinheiro (gaveta física) ───────────────────
    # Cenário do bug: vendas em dinheiro 100 + cartão 50 + sangria 30.
    # O cartão NÃO entra na gaveta → SALDO DO CAIXA = 70, não 120.

    def test_saldo_caixa_exclui_cartao(self):
        """Cartão/PIX nunca entram na gaveta: 100 dinheiro − 30 sangria = 70."""
        result = self.pos_session._calc_saldo_caixa_dinheiro(
            self._cash_details(100.0), 30.0, 0.0, {}, 0.0,
        )
        self.assertAlmostEqual(result['saldo'], 70.0, places=2)
        self.assertAlmostEqual(result['vendas_dinheiro'], 100.0, places=2)

    def test_saldo_caixa_inclui_fundo_suprimentos_receb_dinheiro(self):
        """fundo 10 + vendas 100 + supr 20 + receb dinheiro 15 − sangria 30 = 115."""
        result = self.pos_session._calc_saldo_caixa_dinheiro(
            self._cash_details(100.0), 30.0, 20.0, {'Dinheiro': 15.0}, 10.0,
        )
        self.assertAlmostEqual(result['entradas'], 145.0, places=2)
        self.assertAlmostEqual(result['saidas'], 30.0, places=2)
        self.assertAlmostEqual(result['saldo'], 115.0, places=2)
        self.assertAlmostEqual(result['receb_dinheiro'], 15.0, places=2)

    def test_saldo_caixa_recebimento_nome_diferente_fallback_zero(self):
        """Se o nome do método de dinheiro não bate em recebimentos_por_metodo,
        o recebimento em dinheiro cai em 0 (conservativo). Documenta a fragilidade
        do match por nome (DEC: namespaces diferentes)."""
        cash = {'name': 'Cash', 'payment_amount': 100.0}
        result = self.pos_session._calc_saldo_caixa_dinheiro(
            cash, 30.0, 0.0, {'Dinheiro': 15.0}, 0.0,
        )
        self.assertAlmostEqual(result['receb_dinheiro'], 0.0, places=2)
        self.assertAlmostEqual(result['saldo'], 70.0, places=2)

    def test_saldo_caixa_negativo_sangria_maior_que_vendas(self):
        """Sangria > vendas → gaveta negativa (válida, sem clamp)."""
        result = self.pos_session._calc_saldo_caixa_dinheiro(
            self._cash_details(50.0), 80.0, 0.0, {}, 0.0,
        )
        self.assertAlmostEqual(result['saldo'], -30.0, places=2)

    def test_saldo_caixa_sem_cash_details(self):
        """Sem cash_details → vendas_dinheiro 0, saldo = fundo+supr+receb − sangrias."""
        result = self.pos_session._calc_saldo_caixa_dinheiro(
            {}, 10.0, 0.0, {}, 0.0,
        )
        self.assertAlmostEqual(result['vendas_dinheiro'], 0.0, places=2)
        self.assertAlmostEqual(result['saldo'], -10.0, places=2)
