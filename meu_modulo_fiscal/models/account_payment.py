"""
Extensão do account.payment para persistir a forma de pagamento do PDV
escolhida no recebimento parcial de faturas (DEC-004).
"""
from odoo import models, fields


class AccountPayment(models.Model):
    _inherit = 'account.payment'

    x_payment_method_id = fields.Many2one(
        'pos.payment.method',
        string='Forma de Pagamento PDV',
        ondelete='set null',
        help='Método de pagamento selecionado no PDV ao registrar um '
             'recebimento parcial de fatura. Nullable para compatibilidade '
             'com pagamentos criados antes desta feature.',
    )
