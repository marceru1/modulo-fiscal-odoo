from unittest.mock import patch

from odoo.exceptions import AccessError
from odoo.tests import TransactionCase

from .paridade_offline_helper import criar_pedido, montar_pos_offline, paridade, snapshot


class TestFechamentoOfflineSnapshot(TransactionCase):
    """Snapshot do servidor para o fechamento offline (ticket 01).

    Seam: ``pos.session.get_fechamento_offline_snapshot()`` — devolve numa só
    chamada os dados do popup (``get_closing_control_data``), os do relatório
    (``get_fechamento_data``) e os ids dos pedidos contados. A paridade
    snapshot+delta ↔ servidor é coberta em ``test_fechamento_offline_parity``.
    """

    def setUp(self):
        super().setUp()
        montar_pos_offline(self)

    # ── Helpers ──────────────────────────────────────────────────────────────
    def _create_order(self, amount, method):
        return criar_pedido(self, amount, method)

    def _snapshot(self):
        return snapshot(self)

    # ── Contrato do snapshot ─────────────────────────────────────────────────
    def test_snapshot_contrato(self):
        """Retorno tem as três chaves; closing/fechamento no shape dos métodos."""
        snap = self._snapshot()

        self.assertEqual(set(snap.keys()), {'closing', 'fechamento', 'order_ids'})
        self.assertIn('orders_details', snap['closing'])
        self.assertIn('default_cash_details', snap['closing'])
        self.assertIn('non_cash_payment_methods', snap['closing'])
        self.assertIn('metodos_pagamento', snap['fechamento'])
        self.assertIn('saldo_detalhado', snap['fechamento'])
        self.assertEqual(snap['order_ids'], [])

    def test_snapshot_sessao_sem_pedidos(self):
        """Sessão vazia: zero vendas, dinheiro zerado, sem pedidos contados."""
        snap = self._snapshot()

        self.assertEqual(snap['closing']['orders_details']['quantity'], 0)
        self.assertEqual(snap['closing']['orders_details']['amount'], 0.0)
        self.assertEqual(snap['closing']['default_cash_details']['payment_amount'], 0.0)
        self.assertEqual(snap['closing']['default_cash_details']['amount'], 0.0)
        self.assertEqual(snap['fechamento']['identificacao']['qtd_vendas'], 0)

    def test_snapshot_venda_dinheiro(self):
        """Venda de 60 em dinheiro entra no cash details e no relatório."""
        order = self._create_order(60.0, self.cash_pm)
        snap = self._snapshot()

        cash = snap['closing']['default_cash_details']
        self.assertEqual(cash['payment_amount'], 60.0)
        self.assertEqual(cash['amount'], 60.0)
        self.assertEqual(snap['closing']['orders_details']['quantity'], 1)
        self.assertEqual(snap['closing']['orders_details']['amount'], 60.0)
        self.assertEqual(snap['order_ids'], [order.id])

        metodos = {m['nome']: m['valor'] for m in snap['fechamento']['metodos_pagamento']}
        self.assertEqual(metodos['Dinheiro'], 60.0)
        self.assertEqual(snap['fechamento']['identificacao']['qtd_vendas'], 1)

    def test_snapshot_venda_a_prazo(self):
        """Venda a prazo não entra no dinheiro; aparece no método e em vendas_prazo."""
        order = self._create_order(40.0, self.later_pm)
        snap = self._snapshot()

        self.assertEqual(snap['closing']['default_cash_details']['payment_amount'], 0.0)
        non_cash = {pm['name']: pm for pm in snap['closing']['non_cash_payment_methods']}
        self.assertEqual(non_cash['A Prazo']['amount'], 40.0)
        self.assertEqual(non_cash['A Prazo']['number'], 1)

        self.assertEqual(snap['fechamento']['total_vendas_prazo'], 40.0)
        self.assertEqual(len(snap['fechamento']['vendas_prazo']), 1)
        self.assertEqual(snap['order_ids'], [order.id])

    def test_snapshot_sangria_e_suprimento(self):
        """Sangria/suprimento aparecem em moves do popup e nas listas do relatório."""
        self.pos_session.try_cash_in_out('out', 30.0, 'Sangria', {'translatedType': 'out'})
        self.pos_session.try_cash_in_out('in', 20.0, 'Suprimento', {'translatedType': 'in'})
        snap = self._snapshot()

        amounts = sorted(m['amount'] for m in snap['closing']['default_cash_details']['moves'])
        self.assertEqual(amounts, [-30.0, 20.0])
        # opening 0 + vendas em dinheiro 0 + moves (-10)
        self.assertEqual(snap['closing']['default_cash_details']['amount'], -10.0)

        fech = snap['fechamento']
        self.assertEqual(fech['total_sangrias'], 30.0)
        self.assertEqual(fech['total_suprimentos'], 20.0)
        self.assertEqual([s['motivo'] for s in fech['sangrias']], ['Sangria'])
        self.assertEqual([s['motivo'] for s in fech['suprimentos']], ['Suprimento'])
        self.assertEqual(fech['saldo_movimentacao']['saldo'], -10.0)

    def test_snapshot_order_ids_bate_quantity(self):
        """order_ids é exatamente o conjunto contado por orders_details.quantity."""
        self._create_order(10.0, self.cash_pm)
        self._create_order(20.0, self.bank_pm)
        self._create_order(30.0, self.later_pm)
        snap = self._snapshot()

        self.assertEqual(len(snap['order_ids']), 3)
        self.assertEqual(snap['closing']['orders_details']['quantity'], 3)
        self.assertEqual(
            snap['fechamento']['identificacao']['qtd_vendas'], 3
        )

    def test_snapshot_um_unico_calculo(self):
        """get_closing_control_data roda UMA vez: o snapshot repassa ao relatório."""
        real = self.pos_session.get_closing_control_data
        chamadas = {'n': 0}

        def contar(*args, **kwargs):
            chamadas['n'] += 1
            return real()

        with patch.object(type(self.pos_session), 'get_closing_control_data', contar):
            self._snapshot()

        self.assertEqual(chamadas['n'], 1)

    def test_snapshot_exige_grupo_pos(self):
        """Usuário sem grupo POS recebe AccessError (mesma regra do core)."""
        usuario = self.env['res.users'].create({
            'name': 'Sem POS',
            'login': 'sem_pos_offline',
            'groups_id': [(6, 0, [self.env.ref('base.group_user').id])],
        })
        with self.assertRaises(AccessError):
            self.pos_session.with_user(usuario).get_fechamento_offline_snapshot()

    def test_snapshot_paridade_com_fixture_vazia(self):
        """O snapshot vazio bate com o cenário `sessao_vazia` das fixtures."""
        import json
        import os

        fixtures_path = os.path.join(os.path.dirname(__file__), 'fixtures', 'fechamento_offline_parity.json')
        with open(fixtures_path, encoding='utf-8') as f:
            fixture = json.load(f)['cenarios'][0]
        self.assertEqual(fixture['nome'], 'sessao_vazia')

        snap = self._snapshot()
        esperado = paridade(fixture['snapshot']['closing'], fixture['snapshot']['fechamento'])
        obtido = paridade(snap['closing'], snap['fechamento'])
        self.assertEqual(obtido, esperado)
