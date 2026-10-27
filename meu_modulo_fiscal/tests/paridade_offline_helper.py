"""Normalização de paridade do fechamento offline.

Concentra o subconjunto de campos comparado entre:
- o servidor (``get_fechamento_offline_snapshot``), nos testes Python;
- o cálculo local (``fechamento_offline_core.js``), no teste Node.

Ids, datas, nome do usuário/empresa e o nome do movimento do servidor
(``POS/00001-out-Motivo``) variam por execução e ficam de fora. Floats são
arredondados em 2 casas para eliminar ruído binário. As listas são ordenadas
por chave estável: a comparação é de conteúdo, não de ordem.
"""


def _r(valor):
    return round(float(valor or 0.0), 2)


# ── Ambiente de POS compartilhado pelos testes offline ────────────────────
def montar_pos_offline(teste):
    """Cria journals, métodos (Dinheiro/Cartão/A Prazo), config, sessão e produto.

    Deixa em ``teste``: ``company``, ``cash_pm``, ``bank_pm``, ``later_pm``,
    ``pms_por_nome``, ``pos_config``, ``pos_session``, ``product`` e
    ``pricelist``. Usado pelo teste do snapshot (ticket 01) e pela paridade
    (ticket 02) para o cenário ser idêntico nos dois.
    """
    env = teste.env
    teste.company = env.company

    teste.cash_journal = env['account.journal'].create({
        'name': 'Caixa Teste Offline',
        'type': 'cash',
        'code': 'OF',
        'company_id': teste.company.id,
    })
    teste.bank_journal = env['account.journal'].create({
        'name': 'Banco Teste Offline',
        'type': 'bank',
        'code': 'OFB',
        'company_id': teste.company.id,
    })
    teste.sale_journal = env['account.journal'].create({
        'name': 'Vendas Teste Offline',
        'type': 'sale',
        'code': 'OFV',
        'company_id': teste.company.id,
    })

    teste.cash_pm = env['pos.payment.method'].create({
        'name': 'Dinheiro',
        'journal_id': teste.cash_journal.id,
    })
    teste.bank_pm = env['pos.payment.method'].create({
        'name': 'Cartão',
        'journal_id': teste.bank_journal.id,
    })
    teste.later_pm = env['pos.payment.method'].create({
        'name': 'A Prazo',
    })
    teste.pms_por_nome = {
        'Dinheiro': teste.cash_pm,
        'Cartão': teste.bank_pm,
        'A Prazo': teste.later_pm,
    }

    teste.pos_config = env['pos.config'].create({
        'name': 'PDV Teste Offline',
        'journal_id': teste.sale_journal.id,
        'payment_method_ids': [
            (6, 0, [teste.cash_pm.id, teste.bank_pm.id, teste.later_pm.id])
        ],
    })
    teste.pos_session = env['pos.session'].create({
        'config_id': teste.pos_config.id,
        'user_id': env.user.id,
    })
    teste.pos_session.action_pos_session_open()

    teste.product = env['product.product'].create({
        'name': 'Produto Teste Offline',
        'type': 'consu',
        'list_price': 10.0,
        'available_in_pos': True,
    })
    teste.pricelist = env['product.pricelist'].create({
        'name': 'Pricelist Teste Offline',
        'currency_id': teste.company.currency_id.id,
    })


def criar_pedido(teste, amount, method, partner=None):
    """Cria um pos.order 'done' com um pagamento no método informado."""
    order = teste.env['pos.order'].create({
        'session_id': teste.pos_session.id,
        'partner_id': (partner or teste.env.ref('base.public_partner')).id,
        'pricelist_id': teste.pricelist.id,
        'state': 'draft',
        'amount_tax': 0.0,
        'amount_total': amount,
        'amount_paid': amount,
        'amount_return': 0.0,
        'lines': [(0, 0, {
            'product_id': teste.product.id,
            'price_unit': amount,
            'qty': 1.0,
            'price_subtotal': amount,
            'price_subtotal_incl': amount,
        })],
        'payment_ids': [(0, 0, {
            'amount': amount,
            'payment_method_id': method.id,
        })],
    })
    order.state = 'done'
    return order


def snapshot(teste):
    return teste.pos_session.get_fechamento_offline_snapshot()


def paridade(closing, fechamento):
    """Devolve o subconjunto comparável de ``closing`` + ``fechamento``."""
    cash = closing.get('default_cash_details') or {}
    orders = closing.get('orders_details') or {}

    closing_par = {
        'orders_details': {
            'quantity': int(orders.get('quantity', 0) or 0),
            'amount': _r(orders.get('amount', 0.0)),
        },
        'cash': {
            'name': cash.get('name'),
            'amount': _r(cash.get('amount', 0.0)),
            'opening': _r(cash.get('opening', 0.0)),
            'payment_amount': _r(cash.get('payment_amount', 0.0)),
            'moves_total': _r(sum(m.get('amount', 0.0) for m in cash.get('moves', []))),
        } if cash else {},
        'non_cash': sorted(
            [
                {
                    'name': pm.get('name'),
                    'amount': _r(pm.get('amount', 0.0)),
                    'number': int(pm.get('number', 0) or 0),
                    'type': pm.get('type'),
                }
                for pm in closing.get('non_cash_payment_methods', [])
            ],
            key=lambda x: (x['name'] or ''),
        ),
    }

    ident = fechamento.get('identificacao') or {}
    fechamento_par = {
        'qtd_vendas': int(ident.get('qtd_vendas', 0) or 0),
        'qtd_cupons': int(ident.get('qtd_cupons', 0) or 0),
        'metodos_pagamento': sorted(
            [
                {'nome': m.get('nome'), 'valor': _r(m.get('valor', 0.0))}
                for m in fechamento.get('metodos_pagamento', [])
            ],
            key=lambda x: (x['nome'] or ''),
        ),
        'total_vendas': _r(fechamento.get('total_vendas', 0.0)),
        'vendas_prazo': sorted(
            [
                {'cliente': v.get('cliente'), 'valor': _r(v.get('valor', 0.0))}
                for v in fechamento.get('vendas_prazo', [])
            ],
            key=lambda x: (x['cliente'] or '', x['valor']),
        ),
        'total_vendas_prazo': _r(fechamento.get('total_vendas_prazo', 0.0)),
        'sangrias': sorted(
            [
                {'motivo': s.get('motivo'), 'valor': _r(s.get('valor', 0.0))}
                for s in fechamento.get('sangrias', [])
            ],
            key=lambda x: (x['motivo'] or '', x['valor']),
        ),
        'total_sangrias': _r(fechamento.get('total_sangrias', 0.0)),
        'suprimentos': sorted(
            [
                {'motivo': s.get('motivo'), 'valor': _r(s.get('valor', 0.0))}
                for s in fechamento.get('suprimentos', [])
            ],
            key=lambda x: (x['motivo'] or '', x['valor']),
        ),
        'total_suprimentos': _r(fechamento.get('total_suprimentos', 0.0)),
        'total_recebimentos': _r(fechamento.get('total_recebimentos', 0.0)),
        'dinheiro_liquido': _r(fechamento.get('dinheiro_liquido', 0.0)),
        'saldo_movimentacao': {
            k: _r((fechamento.get('saldo_movimentacao') or {}).get(k, 0.0))
            for k in ('entradas', 'saidas', 'saldo')
        },
        'movimentacao_total': {
            k: _r((fechamento.get('movimentacao_total') or {}).get(k, 0.0))
            for k in ('entradas', 'saidas', 'saldo')
        },
        'saldo_detalhado': sorted(
            [
                {'nome': s.get('nome'), 'calculado': _r(s.get('calculado', 0.0))}
                for s in fechamento.get('saldo_detalhado', [])
            ],
            key=lambda x: (x['nome'] or ''),
        ),
    }

    return {'closing': closing_par, 'fechamento': fechamento_par}
