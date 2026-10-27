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
