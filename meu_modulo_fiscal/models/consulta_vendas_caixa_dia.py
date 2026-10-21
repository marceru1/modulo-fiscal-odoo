import pytz
from datetime import datetime, time, timedelta

from odoo import _, api, fields, models
from odoo.exceptions import UserError
from odoo.osv import expression
from odoo.tools import float_round


class PosOrder(models.Model):
    """Consulta de vendas por caixa e dias avulsos (consulta-vendas-caixa-dia).

    Fonte: pos.order direto (uma linha por cupom). Não usa report.pos.order,
    que tem granularidade por item.
    """
    _inherit = 'pos.order'

    ESTADOS_VENDA = ('paid', 'done', 'invoiced')
    FUSO_PADRAO = 'America/Manaus'
    MAX_DIAS_POR_CONSULTA = 31

    @api.model
    def get_vendas_caixa_dia(self, config_ids, datas):
        """Vendas de um ou mais caixas (pos.config) em dias avulsos.

        Cada dia é interpretado no fuso do usuário logado e convertido para
        UTC como [00:00 do dia inclusive, 00:00 do dia seguinte exclusivo),
        com base em date_order — sem corte em 23:59:59. As janelas dos dias
        marcados são unidas por OU (não é um intervalo contínuo) e os caixas
        marcados por um `config_id IN (...)` (DEC-010).

        Usa o search do próprio modelo, sem sudo(): empresa e demais record
        rules do usuário são respeitadas.

        Args:
            config_ids (list[int]): ids dos pos.config (caixas) marcados.
            datas (list[str]): dias no formato 'YYYY-MM-DD'. Máximo de 31 dias
                distintos por consulta.

        Returns:
            dict: {
                'caixas': [{'id': int, 'nome': str}],  # ordenados por nome
                'datas': [str],  # dias consultados, ordenados e sem repetição
                'fuso': str,
                'vendas': [{
                    'id', 'date_order' (UTC), 'cupom', 'pos_reference',
                    'caixa' (nome), 'operador', 'valor', 'currency_id', 'moeda',
                    'formas_pagamento',
                }],
                'resumo': {
                    'quantidade': int,
                    'quantidade_devolucoes': int,
                    # Total do conjunto (atravessa os caixas), por moeda —
                    # nunca somar moedas diferentes.
                    'totais': [{'currency_id', 'moeda', 'total'}],
                },
            }

        Raises:
            UserError: caixa inacessível/inexistente, dia inválido, nenhum dia
                marcado ou mais de 31 dias.
        """
        configs = self._validar_caixas(config_ids)
        dias = self._validar_dias(datas)

        tz_name = (
            self.env.context.get('tz')
            or self.env.user.tz
            or self.FUSO_PADRAO
        )
        try:
            tz = pytz.timezone(tz_name)
        except pytz.UnknownTimeZoneError:
            tz = pytz.timezone(self.FUSO_PADRAO)
            tz_name = self.FUSO_PADRAO

        janelas = []
        for dia in dias:
            inicio = tz.localize(datetime.combine(dia, time.min))
            fim = tz.localize(datetime.combine(dia + timedelta(days=1), time.min))
            janelas.append([
                ('date_order', '>=', inicio.astimezone(pytz.UTC).replace(tzinfo=None)),
                ('date_order', '<', fim.astimezone(pytz.UTC).replace(tzinfo=None)),
            ])

        pedidos = self.search(expression.AND([
            [
                ('config_id', 'in', configs.ids),
                ('state', 'in', list(self.ESTADOS_VENDA)),
            ],
            expression.OR(janelas),
        ]), order='date_order desc, id desc')

        formas_por_pedido = self._formas_pagamento_por_pedido(pedidos.ids)
        vendas = []
        devolucoes = 0
        for pedido in pedidos:
            if pedido.amount_total < 0:
                devolucoes += 1

            moeda = pedido.currency_id
            vendas.append({
                'id': pedido.id,
                'date_order': fields.Datetime.to_string(pedido.date_order),
                'cupom': pedido.name,
                'pos_reference': pedido.pos_reference or '',
                'caixa': pedido.config_id.name or '',
                'operador': pedido.user_id.name or '',
                'valor': pedido.amount_total,
                'currency_id': moeda.id,
                'moeda': moeda.name,
                'formas_pagamento': formas_por_pedido.get(pedido.id, ''),
            })

        return {
            'caixas': [
                {'id': config.id, 'nome': config.name} for config in configs
            ],
            'datas': [dia.isoformat() for dia in dias],
            'fuso': tz_name,
            'vendas': vendas,
            'resumo': {
                'quantidade': len(vendas),
                'quantidade_devolucoes': devolucoes,
                'totais': self._totais_por_moeda(vendas),
            },
        }

    def _validar_caixas(self, config_ids):
        """Normaliza os caixas marcados: sem repetição e todos acessíveis.

        Um caixa removido ou fora das regras de acesso derruba a consulta
        inteira (não devolve resultado parcial do conjunto).
        """
        if isinstance(config_ids, int):
            config_ids = [config_ids]

        ids = []
        for config_id in config_ids or []:
            try:
                config_id = int(config_id)
            except (TypeError, ValueError):
                continue
            if config_id and config_id not in ids:
                ids.append(config_id)
        if not ids:
            raise UserError(_('Selecione ao menos um caixa para consultar as vendas.'))

        configs = self.env['pos.config'].search(
            [('id', 'in', ids)], order='name, id'
        )
        if len(configs) != len(ids):
            raise UserError(_('Caixa não encontrado ou sem acesso.'))
        return configs

    def _validar_dias(self, datas):
        """Normaliza a lista de dias: sem repetição, ordenada, até 31 dias."""
        if isinstance(datas, str):
            datas = [datas]
        if not datas:
            raise UserError(_('Selecione ao menos um dia para consultar as vendas.'))

        dias = set()
        for data in datas:
            try:
                dias.add(datetime.strptime(data, '%Y-%m-%d').date())
            except (TypeError, ValueError):
                raise UserError(_('Data inválida. Use o formato AAAA-MM-DD.'))

        if len(dias) > self.MAX_DIAS_POR_CONSULTA:
            raise UserError(_(
                'Selecione no máximo %(limite)s dias por consulta.',
                limite=self.MAX_DIAS_POR_CONSULTA,
            ))
        return sorted(dias)

    def _formas_pagamento_por_pedido(self, pedido_ids):
        """Formas de pagamento por cupom, lidas em lote (uma query só).

        São os métodos DISTINTOS dos pagamentos do cupom, na ordem em que
        foram registrados (pos.payment.payment_method_id → nome do
        pos.payment.method): pagamento único mostra um nome; dividido mostra
        os nomes unidos ("Dinheiro + Cartão"). Cupom sem pagamento fica ''.
        """
        if not pedido_ids:
            return {}

        pagamentos = self.env['pos.payment'].search_read(
            [('pos_order_id', 'in', list(pedido_ids))],
            ['pos_order_id', 'payment_method_id'],
            order='id asc',
        )
        nomes_por_pedido = {}
        for pagamento in pagamentos:
            pedido = pagamento['pos_order_id']
            metodo = pagamento['payment_method_id']
            if not pedido or not metodo:
                continue
            pedido_id = pedido[0] if isinstance(pedido, (list, tuple)) else pedido
            nomes = nomes_por_pedido.setdefault(pedido_id, [])
            if metodo[1] not in nomes:
                nomes.append(metodo[1])

        return {
            pedido_id: ' + '.join(nomes)
            for pedido_id, nomes in nomes_por_pedido.items()
        }

    def _totais_por_moeda(self, vendas):
        """Soma os valores por moeda — moedas diferentes nunca se misturam.

        O acumulador é float, então o total de cada moeda é arredondado com a
        precisão dessa moeda (decimal_places do res.currency) antes de sair do
        servidor: somar centavos não devolve resíduo de ponto flutuante.
        """
        totais = {}
        for venda in vendas:
            acumulado = totais.setdefault(venda['currency_id'], {
                'currency_id': venda['currency_id'],
                'moeda': venda['moeda'],
                'total': 0.0,
            })
            acumulado['total'] += venda['valor']

        moedas = self.env['res.currency'].browse(list(totais))
        for moeda in moedas:
            total = totais.get(moeda.id)
            if total:
                total['total'] = float_round(
                    total['total'], precision_digits=moeda.decimal_places
                )
        return list(totais.values())
