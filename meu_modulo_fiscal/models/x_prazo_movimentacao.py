import logging

from odoo import api, models, fields

_logger = logging.getLogger(__name__)


class XPrazoMovimentacao(models.Model):
    _name = 'x.prazo.movimentacao'
    _description = 'Movimentação A Prazo'
    _order = 'data desc'

    employee_id = fields.Many2one('hr.employee', string='Funcionário', ondelete='cascade')
    partner_id = fields.Many2one('res.partner', string='Parceiro')
    data = fields.Datetime(string='Data', default=fields.Datetime.now)
    valor = fields.Float(string='Valor', digits=(16, 2))
    tipo = fields.Selection([
        ('compra', 'Compra'),
        ('pagamento', 'Pagamento'),
        ('baixa', 'Baixa Manual'),
    ], string='Tipo', required=True)
    # Número da fatura (account.move) ligada à movimentação. Campo próprio —
    # pos_reference é a chave de dedupe de _register_prazo_movimentacoes e não
    # pode ser reaproveitado (DEC-001).
    fatura_name = fields.Char(string='Fatura')
    pos_reference = fields.Char(string='Cupom')
    session_id = fields.Many2one('pos.session', string='Sessão')

    @api.model
    def _backfill_fatura_name(self):
        """Preenche ``fatura_name`` nas movimentações de compra antigas.

        Retroativo one-shot do upgrade (DEC-004): casa a mov de compra com o
        pedido pelo cupom (``pos_reference``) e copia o número da fatura já
        gerada pelo pedido. Chamado por ``data/prazo_fatura_backfill.xml``.

        Idempotente: só busca movs ainda sem fatura — reexecutar não escreve
        nada. Sem pedido faturado correspondente, a mov fica como está, e
        recebimentos antigos não são tocados (não têm cupom para casar).
        """
        movs = self.search([
            ('tipo', '=', 'compra'),
            ('fatura_name', '=', False),
            ('pos_reference', '!=', False),
        ])
        if not movs:
            return

        refs = list(set(movs.mapped('pos_reference')))
        # O dedupe usa ``order.pos_reference or order.name`` — o retroativo
        # aceita as duas origens de cupom numa única busca (OR).
        orders = self.env['pos.order'].sudo().search([
            ('account_move', '!=', False),
            '|',
            ('pos_reference', 'in', refs),
            ('name', 'in', refs),
        ])

        faturas = {}
        for order in orders:
            # DEC-007: fatura cancelada mantém o número (rastreio contábil).
            fatura = order.account_move.name
            if fatura and fatura != '/':
                faturas[order.pos_reference or order.name] = fatura

        preenchidas = 0
        for mov in movs:
            fatura = faturas.get(mov.pos_reference)
            if fatura:
                mov.fatura_name = fatura
                preenchidas += 1
        if preenchidas:
            _logger.info(
                '[PRAZO] Retroativo: %d movimentação(ões) de compra ganharam a fatura',
                preenchidas
            )
