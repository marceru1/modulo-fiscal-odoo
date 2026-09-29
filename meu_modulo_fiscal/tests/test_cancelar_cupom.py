# -*- coding: utf-8 -*-
"""
Testes da feature cancelar-cupom-nfce-pdv (evento 110111).

Cobre os três tickets do lado Odoo:

  01 — o cupom cancelado sai do fechamento de caixa ("como se nunca tivesse
       sido recebido", DEC-005) sem mexer no ``state`` do pedido (DEC-001);
  02 — ``pos.order.action_cancelar_nfce``: guards + POST ao middleware;
  03 — o callback do middleware marca ``x_fiscal_cancelado`` e devolve estoque.

Seams escolhidos (o mais alto possível):
  - a rota HTTP ``/api/retorno-fiscal`` (comportamento externo do ticket 03,
    testado com HttpCase — mesmo seam de test_fechamento_report_doctype.py);
  - os helpers puros de fechamento e ``action_cancelar_nfce`` no modelo.

O que NÃO é testado aqui: o popup e o atalho N do PDV (JS) — ficam em
test_cancelar_cupom.js e test_cancelamento_justificativa_popup.js, que rodam
com ``node`` sem Odoo.

Sem rede de verdade: ``requests.post`` é mockado (nenhum teste fala com o
middleware). O callback é exercitado pela rota, com o payload que o middleware
manda.
"""
import json
from datetime import timedelta
from unittest import mock

from odoo import fields
from odoo.tests import HttpCase, TransactionCase, tagged


class _CancelamentoBase:
    """Setup compartilhado: PDV aberto com método de dinheiro e de cartão."""

    def setUp(self):
        super().setUp()
        self.company = self.env.company

        self.journal = self.env['account.journal'].create({
            'name': 'Diário PDV Teste Cancelamento',
            'type': 'sale',
            'code': 'PDVC',
            'company_id': self.company.id,
        })
        self.cash_journal = self.env['account.journal'].create({
            'name': 'Caixa PDV Teste Cancelamento',
            'type': 'cash',
            'code': 'CXCC',
            'company_id': self.company.id,
        })
        self.bank_journal = self.env['account.journal'].create({
            'name': 'Banco PDV Teste Cancelamento',
            'type': 'bank',
            'code': 'BNCC',
            'company_id': self.company.id,
        })

        # pos.payment.method.type é computado do journal_id.type (cash/bank) —
        # é ele que o _get_dinheiro_cancelado usa para escolher a gaveta.
        self.cash_method = self.env['pos.payment.method'].create({
            'name': 'Dinheiro',
            'journal_id': self.cash_journal.id,
        })
        self.bank_method = self.env['pos.payment.method'].create({
            'name': 'Cartão',
            'journal_id': self.bank_journal.id,
        })

        self.pos_config = self.env['pos.config'].create({
            'name': 'PDV Teste Cancelamento',
            'journal_id': self.journal.id,
            'payment_method_ids': [(6, 0, [
                self.cash_method.id, self.bank_method.id,
            ])],
        })
        self.pos_session = self.env['pos.session'].create({
            'config_id': self.pos_config.id,
            'user_id': self.env.user.id,
        })
        self.pos_session.action_pos_session_open()

    # ── Helpers ──────────────────────────────────────────────────────────────
    def _criar_pedido(self, pos_reference, status='autorizado', offline=False,
                      date_order=None, state='invoiced', cancelado=False,
                      chave='35260912345678901234567890123456789012345678'):
        """Cria um pos.order com os campos fiscais da feature.

        Os campos de valor são obrigatórios no core; ``state`` vai direto para
        o valor final porque é assim que o pedido chega do PDV (o callback não
        mexe no state — DEC-001).
        """
        return self.env['pos.order'].create({
            'session_id': self.pos_session.id,
            'partner_id': self.env.user.partner_id.id,
            'pos_reference': pos_reference,
            'amount_total': 100.0,
            'amount_tax': 0.0,
            'amount_paid': 100.0,
            'amount_return': 0.0,
            'date_order': date_order or fields.Datetime.now(),
            'state': state,
            'x_fiscal_status': status,
            'x_fiscal_offline': offline,
            'x_fiscal_cancelado': cancelado,
            'x_fiscal_chave': chave,
        })

    def _pagar(self, order, method, amount):
        return self.env['pos.payment'].create({
            'pos_order_id': order.id,
            'payment_method_id': method.id,
            'amount': amount,
        })

    def _cash_details(self, payment_amount, name='Dinheiro'):
        """dict default_cash_details no formato do core."""
        return {
            'name': name,
            'payment_amount': payment_amount,
            'moves': [],
        }

    @staticmethod
    def _resposta(status_code=200, json_data=None, text=''):
        """Resposta HTTP falsa de requests.post."""
        resposta = mock.Mock()
        resposta.status_code = status_code
        resposta.text = text
        resposta.json.return_value = json_data if json_data is not None else {}
        return resposta


# =========================================================================
# 01 — Fechamento de caixa desconta o cupom cancelado
# =========================================================================
class TestFechamentoCancelado(_CancelamentoBase, TransactionCase):

    # ── Helpers puros: retrocompatibilidade ─────────────────────────────────
    def test_calc_dinheiro_liquido_sem_total_cancelado(self):
        """Chamadas antigas (2 args) continuam valendo — test_sangria_saldo.py
        invoca assim e não podia quebrar com o parâmetro novo."""
        cash = self._cash_details(100.0)
        self.assertAlmostEqual(
            self.pos_session._calc_dinheiro_liquido(cash, 30.0), 70.0, places=2
        )

    def test_calc_dinheiro_liquido_desconta_cancelado(self):
        """Vendas em dinheiro 150 − 50 do cupom cancelado → 100."""
        cash = self._cash_details(150.0)
        self.assertAlmostEqual(
            self.pos_session._calc_dinheiro_liquido(cash, 0.0, 50.0), 100.0, places=2
        )

    def test_calc_saldo_caixa_sem_total_cancelado(self):
        """A assinatura antiga (5 args) segue idêntica: fundo 100 + vendas 200
        + suprimento 20 + recebimento 10 − sangria 50 = 280."""
        cash = self._cash_details(200.0)
        saldo = self.pos_session._calc_saldo_caixa_dinheiro(
            cash, 50.0, 20.0, {'Dinheiro': 10.0}, 100.0
        )
        self.assertAlmostEqual(saldo['saldo'], 280.0, places=2)
        self.assertAlmostEqual(saldo['vendas_dinheiro'], 200.0, places=2)

    def test_calc_saldo_caixa_desconta_cancelado(self):
        """O cupom cancelado sai das vendas em dinheiro da gaveta."""
        cash = self._cash_details(200.0)
        saldo = self.pos_session._calc_saldo_caixa_dinheiro(
            cash, 50.0, 20.0, {'Dinheiro': 10.0}, 100.0, 50.0
        )
        self.assertAlmostEqual(saldo['vendas_dinheiro'], 150.0, places=2)
        self.assertAlmostEqual(saldo['saldo'], 230.0, places=2)

    # ── _get_dinheiro_cancelado: só o método de dinheiro padrão ─────────────
    def test_get_dinheiro_cancelado_ignora_cartao(self):
        """Um cupom cancelado pago 50 em dinheiro + 30 no cartão contribui só
        com os 50: o cartão nunca esteve na gaveta."""
        self.assertIn(
            self.cash_method, self.pos_session.payment_method_ids,
            'pré-condição: a sessão precisa ter o método de dinheiro',
        )
        cancelado = self._criar_pedido('Order cancel-001', cancelado=True)
        self._pagar(cancelado, self.cash_method, 50.0)
        self._pagar(cancelado, self.bank_method, 30.0)

        self.assertAlmostEqual(
            self.pos_session._get_dinheiro_cancelado(), 50.0, places=2
        )

    def test_get_dinheiro_cancelado_ignora_pedido_nao_cancelado(self):
        """Só o flag x_fiscal_cancelado manda — pedido autorizado normal conta
        como venda."""
        normal = self._criar_pedido('Order cancel-002')
        self._pagar(normal, self.cash_method, 100.0)

        self.assertAlmostEqual(
            self.pos_session._get_dinheiro_cancelado(), 0.0, places=2
        )

    def test_get_dinheiro_cancelado_sem_metodo_de_dinheiro(self):
        """Sessão sem gaveta não tem o que descontar (guard do helper)."""
        cancelado = self._criar_pedido('Order cancel-003', cancelado=True)
        self._pagar(cancelado, self.cash_method, 40.0)

        # Zera a relação de métodos da sessão: sem método de dinheiro o helper
        # não tem como atribuir pagamento à gaveta.
        self.pos_session.payment_method_ids = [(5, 0, 0)]
        self.assertAlmostEqual(
            self.pos_session._get_dinheiro_cancelado(), 0.0, places=2
        )

    # ── Payload do fechamento (AC do ticket 01) ─────────────────────────────
    def test_get_fechamento_data_desconta_cupom_cancelado(self):
        """Comportamento externo: ligar x_fiscal_cancelado derruba o
        dinheiro_liquido exatamente no valor pago em dinheiro do cupom.

        Assert por DELTA (antes − depois) de propósito: o teste não depende de
        como o core monta o default_cash_details, só do que a feature promete —
        o cupom some do caixa."""
        base = self._criar_pedido('Order cancel-004')
        self._pagar(base, self.cash_method, 100.0)
        self._pagar(base, self.bank_method, 25.0)

        cancelado = self._criar_pedido('Order cancel-005')
        self._pagar(cancelado, self.cash_method, 40.0)

        antes = self.pos_session.get_fechamento_data()

        # Simula o que o callback do middleware escreve (ticket 03). O state
        # NÃO muda — é a decisão DEC-001, e é justamente por isso que o
        # fechamento precisa do desconto explícito.
        cancelado.x_fiscal_cancelado = True
        self.assertEqual(
            cancelado.state, 'invoiced',
            'DEC-001: o cancelamento fiscal não mexe no state',
        )
        depois = self.pos_session.get_fechamento_data()

        self.assertAlmostEqual(
            antes['dinheiro_liquido'] - depois['dinheiro_liquido'], 40.0, places=2,
            msg='o dinheiro do cupom cancelado precisa sair do caixa',
        )
        self.assertAlmostEqual(
            antes['saldo_caixa_dinheiro']['vendas_dinheiro']
            - depois['saldo_caixa_dinheiro']['vendas_dinheiro'],
            40.0, places=2,
            msg='a gaveta física também precisa perder o cupom cancelado',
        )


# =========================================================================
# 02 — action_cancelar_nfce: guards
# =========================================================================
class TestCancelarNfceGuards(_CancelamentoBase, TransactionCase):

    def test_recusa_justificativa_curta(self):
        """Menos de 15 caracteres: mesma barreira do FocusNfceService."""
        resultado = self.env['pos.order'].action_cancelar_nfce(
            'Order qualquer', 'curta'
        )
        self.assertFalse(resultado['success'])
        self.assertIn('15', resultado['mensagem'])

    def test_recusa_justificativa_so_espacos(self):
        """Justificativa de espaços é vazia depois do strip."""
        resultado = self.env['pos.order'].action_cancelar_nfce(
            'Order qualquer', ' ' * 20
        )
        self.assertFalse(resultado['success'])

    def test_recusa_sem_pos_reference(self):
        resultado = self.env['pos.order'].action_cancelar_nfce(
            None, 'Venda cancelada a pedido do cliente'
        )
        self.assertFalse(resultado['success'])
        self.assertIn('não encontrado', resultado['mensagem'].lower())

    def test_recusa_pedido_inexistente(self):
        resultado = self.env['pos.order'].action_cancelar_nfce(
            'Order fantasma-999', 'Venda cancelada a pedido do cliente'
        )
        self.assertFalse(resultado['success'])
        self.assertIn('não encontrado', resultado['mensagem'].lower())

    def test_recusa_status_nao_autorizado(self):
        """DEC-002: só cupom autorizado tem o que cancelar. Este guard espelha
        o do frontend como defesa em profundidade."""
        for status in ('processando', 'rejeitado', 'erro', 'cancelado', ''):
            pedido = self._criar_pedido(
                'Order guard-%s' % (status or 'vazio'), status=status
            )
            resultado = self.env['pos.order'].action_cancelar_nfce(
                pedido.pos_reference, 'Venda cancelada a pedido do cliente'
            )
            self.assertFalse(
                resultado['success'], 'status %r não pode ser cancelado' % status
            )

    def test_recusa_contingencia(self):
        pedido = self._criar_pedido('Order guard-contingencia', offline=True)
        resultado = self.env['pos.order'].action_cancelar_nfce(
            pedido.pos_reference, 'Venda cancelada a pedido do cliente'
        )
        self.assertFalse(resultado['success'])
        self.assertIn('contingência', resultado['mensagem'].lower())

    def test_recusa_sem_data_de_emissao(self):
        pedido = self._criar_pedido('Order guard-sem-data')
        pedido.date_order = False
        resultado = self.env['pos.order'].action_cancelar_nfce(
            pedido.pos_reference, 'Venda cancelada a pedido do cliente'
        )
        self.assertFalse(resultado['success'])
        self.assertIn('data', resultado['mensagem'].lower())

    def test_recusa_fora_da_janela_de_24h(self):
        """A SEFAZ não aceita o 110111 depois de 24h da autorização."""
        pedido = self._criar_pedido(
            'Order guard-25h',
            date_order=fields.Datetime.now() - timedelta(hours=25),
        )
        resultado = self.env['pos.order'].action_cancelar_nfce(
            pedido.pos_reference, 'Venda cancelada a pedido do cliente'
        )
        self.assertFalse(resultado['success'])
        self.assertIn('24h', resultado['mensagem'])

    def test_aceita_no_limite_da_janela(self):
        """23h de vida ainda está dentro do prazo (a borda é 24h)."""
        pedido = self._criar_pedido(
            'Order guard-23h',
            date_order=fields.Datetime.now() - timedelta(hours=23),
        )
        with mock.patch(
            'meu_modulo_fiscal.models.pos_order.requests.post',
            return_value=self._resposta(200, {}),
        ):
            resultado = self.env['pos.order'].action_cancelar_nfce(
                pedido.pos_reference, 'Venda cancelada a pedido do cliente'
            )
        self.assertTrue(resultado['success'])

    def test_guard_nao_chama_o_middleware(self):
        """Guard que barra antes do POST nunca toca a rede."""
        with mock.patch(
            'meu_modulo_fiscal.models.pos_order.requests.post'
        ) as post:
            self.env['pos.order'].action_cancelar_nfce('Order qualquer', 'curta')
            post.assert_not_called()


# =========================================================================
# 02 — action_cancelar_nfce: contrato com o middleware
# =========================================================================
class TestCancelarNfceMiddleware(_CancelamentoBase, TransactionCase):

    def _chamar(self, pedido, justificativa='Venda cancelada a pedido do cliente',
                **kwargs):
        """Chama o action com requests.post mockado e devolve (resultado, mock)."""
        with mock.patch(
            'meu_modulo_fiscal.models.pos_order.requests.post',
            **kwargs
        ) as post:
            resultado = self.env['pos.order'].action_cancelar_nfce(
                pedido.pos_reference, justificativa
            )
        return resultado, post

    def test_sucesso_envia_payload_do_contrato(self):
        """O middleware espera documento_id + justificativa + chave_nfe em
        /api/odoo/cancelar, com o header de token e o timeout configurado."""
        self.env['ir.config_parameter'].sudo().set_param(
            'meu_modulo_fiscal.webhook_secret', 'segredo-de-teste'
        )
        pedido = self._criar_pedido('Order mw-001')

        resultado, post = self._chamar(
            pedido, return_value=self._resposta(200, {'status': 'processando'})
        )

        self.assertTrue(resultado['success'], resultado)
        post.assert_called_once()
        url = post.call_args[0][0]
        self.assertTrue(url.endswith('/api/odoo/cancelar'), url)

        corpo = json.loads(post.call_args[1]['data'])
        self.assertEqual(corpo['documento_id'], 'Order mw-001')
        self.assertEqual(corpo['justificativa'], 'Venda cancelada a pedido do cliente')
        self.assertEqual(
            corpo['chave_nfe'], '35260912345678901234567890123456789012345678'
        )
        self.assertEqual(
            post.call_args[1]['headers'].get('X-Webhook-Token'), 'segredo-de-teste'
        )
        self.assertGreater(post.call_args[1]['timeout'], 0)

    def test_justificativa_e_trimada_antes_de_enviar(self):
        pedido = self._criar_pedido('Order mw-002')
        _, post = self._chamar(
            pedido,
            justificativa='   Venda cancelada a pedido do cliente   ',
            return_value=self._resposta(200, {}),
        )
        corpo = json.loads(post.call_args[1]['data'])
        self.assertEqual(corpo['justificativa'], 'Venda cancelada a pedido do cliente')

    def test_sem_secret_nao_manda_header(self):
        """Installs internos sem secret configurado não podem quebrar."""
        self.env['ir.config_parameter'].sudo().set_param(
            'meu_modulo_fiscal.webhook_secret', ''
        )
        pedido = self._criar_pedido('Order mw-003')
        _, post = self._chamar(pedido, return_value=self._resposta(200, {}))
        self.assertNotIn('X-Webhook-Token', post.call_args[1]['headers'])

    def test_sucesso_nao_marca_o_pedido(self):
        """DEC-004: quem marca é o callback, não a resposta HTTP. O action só
        SOLICITA — a SEFAZ ainda pode recusar depois."""
        pedido = self._criar_pedido('Order mw-004')
        resultado, _ = self._chamar(pedido, return_value=self._resposta(200, {}))
        self.assertTrue(resultado['success'])
        self.assertFalse(pedido.x_fiscal_cancelado)
        self.assertEqual(pedido.x_fiscal_status, 'autorizado')

    def test_recusa_do_middleware_com_error(self):
        pedido = self._criar_pedido('Order mw-005')
        resultado, _ = self._chamar(
            pedido,
            return_value=self._resposta(
                422, {'error': 'Prazo de cancelamento expirado'}, text='...'
            ),
        )
        self.assertFalse(resultado['success'])
        self.assertEqual(resultado['mensagem'], 'Prazo de cancelamento expirado')

    def test_recusa_do_middleware_com_mensagem(self):
        pedido = self._criar_pedido('Order mw-006')
        resultado, _ = self._chamar(
            pedido, return_value=self._resposta(400, {'mensagem': 'Justificativa inválida'})
        )
        self.assertFalse(resultado['success'])
        self.assertEqual(resultado['mensagem'], 'Justificativa inválida')

    def test_recusa_sem_corpo_json_usa_o_http_status(self):
        """Middleware devolvendo HTML/erro de proxy: o operador precisa de uma
        mensagem legível, não de um traceback."""
        pedido = self._criar_pedido('Order mw-007')
        resposta = self._resposta(502, text='<html>Bad Gateway</html>')
        resposta.json.side_effect = ValueError('não é JSON')

        resultado, _ = self._chamar(pedido, return_value=resposta)
        self.assertFalse(resultado['success'])
        self.assertIn('502', resultado['mensagem'])

    def test_timeout_devolve_mensagem_pro_operador(self):
        pedido = self._criar_pedido('Order mw-008')
        import requests as requests_lib
        resultado, _ = self._chamar(
            pedido, side_effect=requests_lib.exceptions.Timeout('estourou')
        )
        self.assertFalse(resultado['success'])
        self.assertIn('esgotado', resultado['mensagem'].lower())

    def test_erro_de_conexao_devolve_mensagem_pro_operador(self):
        pedido = self._criar_pedido('Order mw-009')
        import requests as requests_lib
        resultado, _ = self._chamar(
            pedido, side_effect=requests_lib.exceptions.ConnectionError('offline')
        )
        self.assertFalse(resultado['success'])
        self.assertIn('conexão', resultado['mensagem'].lower())

    def test_erro_inesperado_nao_estoura_no_js(self):
        """Qualquer exceção vira success=False: o orm.call do PDV não pode
        receber traceback (o operador veria 'erro desconhecido')."""
        pedido = self._criar_pedido('Order mw-010')
        resultado, _ = self._chamar(pedido, side_effect=RuntimeError('boom'))
        self.assertFalse(resultado['success'])
        self.assertTrue(resultado['mensagem'])


# =========================================================================
# 03 — Callback marca o pedido e devolve o estoque
# =========================================================================
class TestCancelamentoEstoque(_CancelamentoBase, TransactionCase):

    def test_reverter_estoque_sem_picking_nao_quebra(self):
        """Cupom sem picking concluído (produto sem controle de estoque, por
        exemplo): nada a devolver, nenhum erro."""
        pedido = self._criar_pedido('Order est-001')
        self.assertFalse(pedido.picking_ids)

        # Não levanta — falha de estoque nunca pode desfazer o fiscal.
        pedido._reverter_estoque_cancelamento()
        self.assertFalse(pedido.picking_ids)

    def test_reverter_estoque_nao_cria_devolucao_sem_picking_concluido(self):
        """O core só devolve o que foi entregue: picking em draft/rascunho não
        gera stock.picking de devolução."""
        pedido = self._criar_pedido('Order est-002')
        picking = self.env['stock.picking'].create({
            'picking_type_id': self.env.ref('stock.picking_type_out').id,
            'location_id': self.env.ref('stock.stock_location_stock').id,
            'location_dest_id': self.env.ref('stock.stock_location_customers').id,
        })
        pedido.picking_ids = [(4, picking.id)]

        antes = self.env['stock.picking'].search_count([])
        pedido._reverter_estoque_cancelamento()
        self.assertEqual(
            self.env['stock.picking'].search_count([]), antes,
            'picking não concluído não gera devolução',
        )


@tagged('post_install', '-at_install')
class TestCallbackCancelamento(_CancelamentoBase, HttpCase):
    """O seam do ticket 03: a rota que o middleware chama.

    Testa o comportamento externo (JSON + efeito no banco), não o corpo do
    controller — é o que o middleware observa.
    """

    def _post_callback(self, documento_id, status, **fiscal_extra):
        fiscal = {'status': status}
        fiscal.update(fiscal_extra)
        return self.url_open(
            '/api/retorno-fiscal',
            data=json.dumps({'documento_id': documento_id, 'fiscal': fiscal}),
            headers={'Content-Type': 'application/json'},
        )

    def test_callback_cancelado_marca_o_pedido(self):
        pedido = self._criar_pedido('Order cb-001')

        resposta = self._post_callback(
            pedido.pos_reference, 'cancelado', protocolo='110111000000001'
        )

        self.assertEqual(resposta.status_code, 200, resposta.text)
        self.assertTrue(pedido.x_fiscal_cancelado)
        self.assertEqual(pedido.x_fiscal_status, 'cancelado')
        self.assertEqual(
            pedido.state, 'invoiced',
            'DEC-001: o state do pedido não muda no cancelamento fiscal',
        )

    def test_callback_autorizado_nao_marca_cancelado(self):
        """Regressão: o callback normal de autorização não pode marcar o flag."""
        pedido = self._criar_pedido('Order cb-002', status='processando')

        resposta = self._post_callback(
            pedido.pos_reference, 'autorizado', chave_nfe='3' * 44
        )

        self.assertEqual(resposta.status_code, 200, resposta.text)
        self.assertFalse(pedido.x_fiscal_cancelado)
        self.assertEqual(pedido.x_fiscal_status, 'autorizado')

    def test_callback_cancelado_de_pedido_inexistente_da_404(self):
        """O middleware precisa do 404 pra retentar (pedido ainda não persistido)."""
        resposta = self._post_callback('Order cb-fantasma', 'cancelado')
        self.assertEqual(resposta.status_code, 404)

    def test_callback_cancelado_sem_picking_nao_quebra(self):
        """Cupom sem entrega: marca o fiscal e segue sem erro 500."""
        pedido = self._criar_pedido('Order cb-003')

        resposta = self._post_callback(pedido.pos_reference, 'cancelado')

        self.assertEqual(resposta.status_code, 200, resposta.text)
        self.assertTrue(pedido.x_fiscal_cancelado)

    def test_callback_cancelado_repetido_nao_devolve_estoque_duas_vezes(self):
        """O webhook é retentado pelo middleware (a rota devolve 404 'pro
        Laravel retentar' quando o pedido ainda não existe). Um segundo
        callback do MESMO cancelamento não pode criar outra devolução: o
        estoque voltaria em dobro.

        O spy no _reverter_estoque_cancelamento é o seam: o que importa é que
        ele roda uma vez só, não como ele devolve (isso é testado no core)."""
        pedido = self._criar_pedido('Order cb-004')

        with mock.patch.object(
            type(pedido), '_reverter_estoque_cancelamento'
        ) as reverter:
            primeira = self._post_callback(pedido.pos_reference, 'cancelado')
            segunda = self._post_callback(pedido.pos_reference, 'cancelado')

        self.assertEqual(primeira.status_code, 200, primeira.text)
        self.assertEqual(segunda.status_code, 200, segunda.text)
        self.assertTrue(pedido.x_fiscal_cancelado)
        self.assertEqual(
            reverter.call_count, 1,
            'callback repetido não pode devolver o estoque de novo',
        )
