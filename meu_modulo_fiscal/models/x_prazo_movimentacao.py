from odoo import models, fields


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
