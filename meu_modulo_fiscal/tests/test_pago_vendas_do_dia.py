"""Backend do tab Pago: ordem opcional em search_paid_order_ids.

Spec: ``pago-vendas-do-dia`` — DEC-002. O core
(``addons/point_of_sale/models/pos_order.py:1327-1355``) fixa a ordem do
servidor em ``create_date desc``; "Mais antigas" precisa paginar do início do
dia, então a sobrescrita aceita ``order`` opcional com whitelist (o valor entra
no ORDER BY do ``search``, nunca string livre) e default idêntico ao core.

Seam testado: ``pos.order.search_paid_order_ids`` — a ordem do servidor é o que
define QUAIS 30 registros cada página devolve; a ordenação fina da tela é feita
no cliente. Por isso as asserções são sobre o conjunto de ids por página e sobre
o ``totalCount``, não sobre a ordem do dict ``orders_info``.
"""

from odoo.tests import TransactionCase

from ..models.pos_order import (
    ORDEM_PEDIDOS_PAGOS_PADRAO,
    normalizar_ordem_pedidos_pagos,
)
from .paridade_offline_helper import criar_pedido, montar_pos_offline


class TestPagoVendasDoDia(TransactionCase):
    def setUp(self):
        super().setUp()
        montar_pos_offline(self)

    # ── Helpers ──────────────────────────────────────────────────────────────
    def _pedido(self, momento):
        """Cria um pedido 'done' com data de venda e de criação controladas."""
        order = criar_pedido(self, 10.0, self.cash_pm)
        order.write({'date_order': momento, 'create_date': momento})
        return order

    def _buscar(self, order=None, limit=30, offset=0, domain=None):
        kwargs = {
            'config_id': self.pos_config.id,
            'domain': domain or [],
            'limit': limit,
            'offset': offset,
        }
        if order is not None:
            kwargs['order'] = order
        resultado = self.env['pos.order'].search_paid_order_ids(**kwargs)
        return resultado

    def _ids(self, resultado):
        return {info[0] for info in resultado['ordersInfo']}

    # ── Default idêntico ao core (retrocompatibilidade) ──────────────────────
    def test_sem_order_equivale_ao_default_explicito(self):
        """As duas formas caem no mesmo branch (delegação ao super): mesma
        lista e mesmo totalCount. A paridade de ordem com o core é garantida
        pela delegação, não por uma segunda implementação."""
        pedidos = [
            self._pedido('2026-11-13 08:00:00'),
            self._pedido('2026-11-13 12:00:00'),
            self._pedido('2026-11-13 16:00:00'),
        ]

        sem_parametro = self._buscar()
        com_default = self._buscar(order=ORDEM_PEDIDOS_PAGOS_PADRAO)

        self.assertEqual(self._ids(sem_parametro), self._ids(com_default))
        self.assertEqual(sem_parametro['totalCount'], com_default['totalCount'])
        self.assertEqual(sem_parametro['totalCount'], len(pedidos))

    def test_default_devolve_os_mais_recentes_na_primeira_pagina(self):
        """create_date desc = comportamento atual do core."""
        antigo = self._pedido('2026-11-13 08:00:00')
        recente = self._pedido('2026-11-13 16:00:00')

        pagina = self._buscar(limit=1)

        self.assertEqual(self._ids(pagina), {recente.id})
        self.assertNotIn(antigo.id, self._ids(pagina))

    # ── Ordem ascendente ─────────────────────────────────────────────────────
    def test_order_asc_devolve_os_mais_antigos_na_primeira_pagina(self):
        antigo = self._pedido('2026-11-13 08:00:00')
        meio = self._pedido('2026-11-13 12:00:00')
        recente = self._pedido('2026-11-13 16:00:00')

        pagina = self._buscar(order='date_order asc', limit=2)

        self.assertEqual(self._ids(pagina), {antigo.id, meio.id})
        self.assertNotIn(recente.id, self._ids(pagina))
        self.assertEqual(pagina['totalCount'], 3)

    def test_order_asc_respeita_offset(self):
        antigo = self._pedido('2026-11-13 08:00:00')
        meio = self._pedido('2026-11-13 12:00:00')
        self._pedido('2026-11-13 16:00:00')

        segunda = self._buscar(order='date_order asc', limit=1, offset=1)

        self.assertEqual(self._ids(segunda), {meio.id})
        self.assertNotIn(antigo.id, self._ids(segunda))

    def test_order_asc_por_create_date_tambem_e_aceito(self):
        """Chips/scroll podem pedir a ordem simétrica à do core."""
        antigo = self._pedido('2026-11-13 08:00:00')
        self._pedido('2026-11-13 16:00:00')

        pagina = self._buscar(order='create_date asc', limit=1)

        self.assertEqual(self._ids(pagina), {antigo.id})

    def test_domain_continua_sendo_aplicado(self):
        """O filtro do tab Pago (janela do dia) chega no domain — o override
        não pode descartá-lo."""
        do_dia = self._pedido('2026-11-13 08:00:00')
        outro_dia = self._pedido('2026-11-12 08:00:00')

        pagina = self._buscar(
            order='date_order asc',
            domain=[['date_order', '>=', '2026-11-13 00:00:00'],
                    ['date_order', '<', '2026-11-14 00:00:00']],
        )

        self.assertEqual(self._ids(pagina), {do_dia.id})
        self.assertNotIn(outro_dia.id, self._ids(pagina))
        self.assertEqual(pagina['totalCount'], 1)

    # ── Whitelist (segurança) ────────────────────────────────────────────────
    def test_order_invalido_cai_no_default_sem_explodir(self):
        self._pedido('2026-11-13 08:00:00')

        default = self._buscar()
        injetado = self._buscar(order='create_date desc; DROP TABLE pos_order')

        self.assertEqual(self._ids(injetado), self._ids(default))

    def test_total_count_nao_depende_da_ordem(self):
        for hora in ('08:00:00', '12:00:00', '16:00:00'):
            self._pedido(f'2026-11-13 {hora}')

        desc = self._buscar(limit=1)
        asc = self._buscar(order='date_order asc', limit=1)

        self.assertEqual(desc['totalCount'], asc['totalCount'])

    # ── Filtro da loja no domain (o core só o aplica com domain vazio) ──────
    def test_domain_com_config_nao_traz_pedido_de_outro_caixa(self):
        """O tab Pago manda `config_id` no domain (a janela do dia nunca é
        vazia, então o branch `domain == []` do core não roda)."""
        meu = self._pedido('2026-11-13 10:00:00')

        outro_config, outra_sessao = self._segundo_caixa()
        de_outro_caixa = self._pedido('2026-11-13 11:00:00')
        de_outro_caixa.write({'session_id': outra_sessao.id})
        self.assertEqual(de_outro_caixa.config_id, outro_config)

        resultado = self._buscar(
            order='date_order asc',
            domain=[['config_id', '=', self.pos_config.id]],
        )

        self.assertEqual(self._ids(resultado), {meu.id})
        self.assertEqual(resultado['totalCount'], 1)

    def test_order_nao_default_com_domain_vazio_filtra_a_loja(self):
        """O branch não-default repete o core: com `domain=[]` o `config_id`
        entra no domain. Sem isso, um chamador com order e sem domain veria
        pedidos de todos os caixas."""
        meu = self._pedido('2026-11-13 10:00:00')

        _outro_config, outra_sessao = self._segundo_caixa()
        de_outro = self._pedido('2026-11-13 11:00:00')
        de_outro.write({'session_id': outra_sessao.id})

        resultado = self._buscar(order='date_order asc')  # helper manda domain=[]

        self.assertEqual(self._ids(resultado), {meu.id})
        self.assertEqual(resultado['totalCount'], 1)

    def _segundo_caixa(self):
        """Config + sessão de outro caixa (mesma empresa/moeda)."""
        journal = self.env['account.journal'].create({
            'name': 'Vendas Teste Outro Caixa',
            'type': 'sale',
            'code': 'OFC',
            'company_id': self.env.company.id,
        })
        config = self.env['pos.config'].create({
            'name': 'PDV Teste Outro Caixa',
            'journal_id': journal.id,
            'payment_method_ids': [(6, 0, [self.cash_pm.id])],
        })
        session = self.env['pos.session'].create({
            'config_id': config.id,
            'user_id': self.env.user.id,
        })
        session.action_pos_session_open()
        return config, session


class TestNormalizarOrdemPedidosPagos(TransactionCase):
    """Whitelist pura — roda sem precisar de pedidos criados."""

    def test_none_devolve_default_do_core(self):
        self.assertEqual(normalizar_ordem_pedidos_pagos(None), ORDEM_PEDIDOS_PAGOS_PADRAO)
        self.assertEqual(normalizar_ordem_pedidos_pagos(''), ORDEM_PEDIDOS_PAGOS_PADRAO)

    def test_aceita_whitelist_com_espacos_e_maiusculas(self):
        self.assertEqual(normalizar_ordem_pedidos_pagos('  DATE_ORDER   ASC '), 'date_order asc')
        self.assertEqual(normalizar_ordem_pedidos_pagos('create_date desc'), 'create_date desc')

    def test_rejeita_qualquer_outra_coisa(self):
        for tentativa in (
            'id asc',
            'create_date',
            'create_date asc, (select 1)',
            '1; drop table pos_order',
        ):
            self.assertEqual(
                normalizar_ordem_pedidos_pagos(tentativa),
                ORDEM_PEDIDOS_PAGOS_PADRAO,
                f'{tentativa!r} deveria cair no default',
            )
