"""
Override do pos.payment.method para renomear "Customer Account" para "A Prazo".
"""
from odoo import models, fields


class PosPaymentMethod(models.Model):
    _inherit = 'pos.payment.method'

    type = fields.Selection(selection_add=[('pay_later', 'A Prazo')])