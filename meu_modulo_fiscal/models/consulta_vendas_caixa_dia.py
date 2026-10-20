import pytz
from datetime import datetime, time, timedelta

from odoo import _, api, fields, models
from odoo.exceptions import UserError


class PosOrder(models.Model):
    """Consulta de vendas por caixa e dia (feature consulta-vendas-caixa-dia).

    Fonte: pos.order direto (uma linha por cupom). Não usa report.pos.order,
    que tem granularidade por item.
    """
    _inherit = 'pos.order'

    ESTADOS_VENDA = ('paid', 'done', 'invoiced')
    FUSO_PADRAO = 'America/Manaus'

    @api.model
    def get_vendas_caixa_dia(self, config_id, data):
        """Vendas de um caixa (pos.config) em um dia civil.

        O dia é interpretado no fuso do usuário logado e convertido para UTC
        como [00:00 do dia inclusive, 00:00 do dia seguinte exclusivo), com
        base em date_order — sem corte em 23:59:59.

        Usa o search do próprio modelo, sem sudo(): empresa e demais record
        rules do usuário são respeitadas.

        Args:
            config_id (int): id do pos.config (caixa).
            data (str): dia no formato 'YYYY-MM-DD'.

        Returns:
            dict: {
                'caixa': {'id': int, 'nome': str},
                'data': str,
                'fuso': str,
                'vendas': [{
                    'id', 'date_order' (UTC), 'cupom', 'pos_reference',
                    'operador', 'cliente', 'valor', 'currency_id',
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
            UserError: caixa inacessível/inexistente ou data inválida.
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

        try:
            dia = datetime.strptime(data, '%Y-%m-%d').date()
        except (TypeError, ValueError):
            raise UserError(_('Data inválida. Use o formato AAAA-MM-DD.'))

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

        inicio = tz.localize(datetime.combine(dia, time.min))
        fim = tz.localize(datetime.combine(dia + timedelta(days=1), time.min))
        inicio_utc = inicio.astimezone(pytz.UTC).replace(tzinfo=None)
        fim_utc = fim.astimezone(pytz.UTC).replace(tzinfo=None)

        pedidos = self.search([
            ('config_id', '=', config.id),
            ('date_order', '>=', inicio_utc),
            ('date_order', '<', fim_utc),
            ('state', 'in', list(self.ESTADOS_VENDA)),
        ], order='date_order desc, id desc')

        rotulos_estado = dict(
            self._fields['state']._description_selection(self.env)
        )
        vendas = []
        totais_por_moeda = {}
        devolucoes = 0
        for pedido in pedidos:
            if pedido.amount_total < 0:
                devolucoes += 1

            moeda = pedido.currency_id
            acumulado = totais_por_moeda.setdefault(moeda.id, {
                'currency_id': moeda.id,
                'moeda': moeda.name,
                'total': 0.0,
            })
            acumulado['total'] += pedido.amount_total

            vendas.append({
                'id': pedido.id,
                'date_order': fields.Datetime.to_string(pedido.date_order),
                'cupom': pedido.name,
                'pos_reference': pedido.pos_reference or '',
                'operador': pedido.user_id.name or '',
                'cliente': pedido.partner_id.display_name or '',
                'valor': pedido.amount_total,
                'currency_id': moeda.id,
                'state': pedido.state,
                'situacao': rotulos_estado.get(pedido.state, pedido.state),
            })

        return {
            'caixa': {'id': config.id, 'nome': config.name},
            'data': data,
            'fuso': tz_name,
            'vendas': vendas,
            'resumo': {
                'quantidade': len(vendas),
                'quantidade_devolucoes': devolucoes,
                'totais': list(totais_por_moeda.values()),
            },
        }
