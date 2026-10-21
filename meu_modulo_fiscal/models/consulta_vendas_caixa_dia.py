import pytz
from datetime import datetime, time, timedelta

from odoo import _, api, fields, models
from odoo.exceptions import UserError
from odoo.osv import expression


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
    def get_vendas_caixa_dia(self, config_id, datas):
        """Vendas de um caixa (pos.config) em dias avulsos.

        Cada dia é interpretado no fuso do usuário logado e convertido para
        UTC como [00:00 do dia inclusive, 00:00 do dia seguinte exclusivo),
        com base em date_order — sem corte em 23:59:59. As janelas dos dias
        marcados são unidas por OU (não é um intervalo contínuo).

        Usa o search do próprio modelo, sem sudo(): empresa e demais record
        rules do usuário são respeitadas.

        Args:
            config_id (int): id do pos.config (caixa).
            datas (list[str]): dias no formato 'YYYY-MM-DD'. Máximo de 31 dias
                distintos por consulta.

        Returns:
            dict: {
                'caixa': {'id': int, 'nome': str},
                'datas': [str],  # dias consultados, ordenados e sem repetição
                'fuso': str,
                'vendas': [{
                    'id', 'date_order' (UTC), 'cupom', 'pos_reference',
                    'operador', 'cliente', 'valor', 'currency_id', 'moeda',
                    'state', 'situacao',
                }],
                'resumo': {
                    'quantidade': int,
                    'quantidade_devolucoes': int,
                    # Total por moeda — nunca somar moedas diferentes.
                    'totais': [{'currency_id', 'moeda', 'total'}],
                },
            }

        Raises:
            UserError: caixa inacessível/inexistente, dia inválido, nenhum dia
                marcado ou mais de 31 dias.
        """
        try:
            config_id = int(config_id or 0)
        except (TypeError, ValueError):
            config_id = 0

        config = self.env['pos.config'].search(
            [('id', '=', config_id)], limit=1
        ) if config_id else self.env['pos.config']
        if not config:
            raise UserError(_('Caixa não encontrado ou sem acesso.'))

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
            [('config_id', '=', config.id), ('state', 'in', list(self.ESTADOS_VENDA))],
            expression.OR(janelas),
        ]), order='date_order desc, id desc')

        rotulos_estado = dict(
            self._fields['state']._description_selection(self.env)
        )
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
                'operador': pedido.user_id.name or '',
                'cliente': pedido.partner_id.display_name or '',
                'valor': pedido.amount_total,
                'currency_id': moeda.id,
                'moeda': moeda.name,
                'state': pedido.state,
                'situacao': rotulos_estado.get(pedido.state, pedido.state),
            })

        return {
            'caixa': {'id': config.id, 'nome': config.name},
            'datas': [dia.isoformat() for dia in dias],
            'fuso': tz_name,
            'vendas': vendas,
            'resumo': {
                'quantidade': len(vendas),
                'quantidade_devolucoes': devolucoes,
                'totais': self._totais_por_moeda(vendas),
            },
        }

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

    def _totais_por_moeda(self, vendas):
        """Soma os valores por moeda — moedas diferentes nunca se misturam."""
        totais = {}
        for venda in vendas:
            acumulado = totais.setdefault(venda['currency_id'], {
                'currency_id': venda['currency_id'],
                'moeda': venda['moeda'],
                'total': 0.0,
            })
            acumulado['total'] += venda['valor']
        return list(totais.values())
