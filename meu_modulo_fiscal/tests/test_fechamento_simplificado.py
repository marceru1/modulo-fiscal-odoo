from odoo.tests import TransactionCase


class TestFechamentoSimplificado(TransactionCase):
    """Regressão do fechamento simplificado: o SALDO DETALHADO do relatório
    deve continuar contendo todos os métodos de pagamento (dinheiro, cartão,
    PIX, a prazo), mesmo com a remoção dos inputs "Counted" do popup.

    O backend não muda nesta feature — o `_calc_saldo_detalhado` já monta a
    lista com todos os métodos. Este teste trava o contrato: o relatório
    impresso (FechamentoReceipt) itera `saldo_detalhado`, então se um método
    sumir daqui, ele some do relatório.
    """

    def setUp(self):
        super().setUp()
        self.company = self.env.company

        self.journal = self.env['account.journal'].create({
            'name': 'Diário PDV Teste Fechamento',
            'type': 'sale',
            'code': 'PDV',
            'company_id': self.company.id,
        })

        self.pos_config = self.env['pos.config'].create({
            'name': 'PDV Teste Fechamento',
            'journal_id': self.journal.id,
        })

        self.pos_session = self.env['pos.session'].create({
            'config_id': self.pos_config.id,
            'user_id': self.env.user.id,
        })
        self.pos_session.action_pos_session_open()

    def test_saldo_detalhado_inclui_todos_metodos(self):
        """SALDO DETALHADO deve conter dinheiro, cartão, PIX e a prazo."""
        metodos = [
            {'nome': 'Dinheiro', 'valor': 100.0},
            {'nome': 'Cartão', 'valor': 50.0},
            {'nome': 'PIX', 'valor': 30.0},
            {'nome': 'A Prazo', 'valor': 20.0},
        ]
        saldo = self.pos_session._calc_saldo_detalhado(metodos)

        self.assertEqual(len(saldo), 4, "Todos os métodos devem aparecer no saldo detalhado")
        nomes = [s['nome'] for s in saldo]
        for nome in ('Dinheiro', 'Cartão', 'PIX', 'A Prazo'):
            self.assertIn(nome, nomes, "Método %s deve estar no saldo detalhado" % nome)

    def test_saldo_detalhado_calculado_igual_valor_sistema(self):
        """calculado = valor do sistema; informado default 0 (frontend sobrepõe)."""
        metodos = [
            {'nome': 'Dinheiro', 'valor': 100.0},
            {'nome': 'Cartão', 'valor': 50.0},
        ]
        saldo = self.pos_session._calc_saldo_detalhado(metodos)
        by_name = {s['nome']: s for s in saldo}

        self.assertEqual(by_name['Cartão']['calculado'], 50.0)
        self.assertEqual(by_name['Dinheiro']['calculado'], 100.0)
        # Backend default: informado=0, diferença=-calculado.
        # O frontend (_getCountedValues) sobrepõe informado/diferença no PDV.
        self.assertEqual(by_name['Cartão']['informado'], 0.0)
        self.assertEqual(by_name['Cartão']['diferenca'], -50.0)
