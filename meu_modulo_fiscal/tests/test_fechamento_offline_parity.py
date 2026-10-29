import json
import os

from odoo.tests import TransactionCase

from .paridade_offline_helper import criar_pedido, montar_pos_offline, paridade, snapshot


class TestFechamentoOfflineParidade(TransactionCase):
    """Paridade servidor ↔ fixtures do fechamento offline (ticket 02).

    Para cada cenário de ``fixtures/fechamento_offline_parity.json``:
    1. monta o estado do instante T no ORM e confere que o snapshot do
       servidor bate com ``fixture.snapshot``;
    2. aplica o delta (pedidos pagos e sangrias/suprimentos) e confere que o
       snapshot final do servidor bate com ``fixture.esperado``.

    O teste Node (``test_fechamento_offline_core.js``) compara o cálculo local
    (snapshot + delta) com o MESMO ``esperado``. Se o servidor mudar a
    aritmética sem atualizar as fixtures, este teste quebra primeiro.
    """

    def setUp(self):
        super().setUp()
        montar_pos_offline(self)
        caminho = os.path.join(
            os.path.dirname(__file__), 'fixtures', 'fechamento_offline_parity.json'
        )
        with open(caminho, encoding='utf-8') as arquivo:
            self.fixtures = json.load(arquivo)['cenarios']

    # ── Helpers ──────────────────────────────────────────────────────────────
    @staticmethod
    def _separar(snap):
        return {'closing': snap['closing'], 'fechamento': snap['fechamento']}

    def _cenario(self, nome):
        for cenario in self.fixtures:
            if cenario['nome'] == nome:
                return cenario
        raise AssertionError('Cenário %s não está nas fixtures' % nome)

    def _aplicar_delta(self, cenario):
        for pedido in cenario['eventos']['pedidos']:
            pagamentos = pedido['payments']
            assert len(pagamentos) == 1, (
                'Fixture %s usa mais de um pagamento por pedido; ajuste o helper'
                % cenario['nome']
            )
            pagamento = pagamentos[0]
            partner = None
            cliente = pedido.get('cliente')
            if cliente and cliente != 'CONSUMIDOR':
                partner = self.env['res.partner'].create({'name': cliente})
            criar_pedido(
                self,
                pedido['amount_total'],
                self.pms_por_nome[pagamento['method_name']],
                partner=partner,
            )
        for movimento in cenario['eventos']['movimentos']:
            self.pos_session.try_cash_in_out(
                movimento['tipo'],
                movimento['valor'],
                movimento['motivo'],
                {'translatedType': movimento['tipo']},
            )

    def _verificar_cenario(self, nome):
        cenario = self._cenario(nome)

        # 1. Estado no instante T (antes do delta) == snapshot da fixture.
        self.assertEqual(
            paridade(**self._separar(snapshot(self))),
            paridade(**self._separar(cenario['snapshot'])),
            'Snapshot inicial de %s divergiu das fixtures' % nome,
        )

        # 2. Estado final (T + delta) == esperado da fixture.
        self._aplicar_delta(cenario)
        self.assertEqual(
            paridade(**self._separar(snapshot(self))),
            paridade(**self._separar(cenario['esperado'])),
            'Snapshot final de %s divergiu das fixtures' % nome,
        )

    # ── Cenários (mesmos nomes do JSON) ──────────────────────────────────────
    def test_paridade_sessao_vazia(self):
        self._verificar_cenario('sessao_vazia')

    def test_paridade_venda_dinheiro(self):
        self._verificar_cenario('venda_dinheiro')

    def test_paridade_venda_prazo(self):
        self._verificar_cenario('venda_prazo')

    def test_paridade_reembolso(self):
        self._verificar_cenario('reembolso')

    def test_paridade_sangria_suprimento(self):
        self._verificar_cenario('sangria_suprimento')
