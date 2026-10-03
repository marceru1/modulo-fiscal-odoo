from odoo import models, fields, api


class PosOrderReport(models.Model):
    _inherit = 'report.pos.order'

    amount_acrescimo = fields.Float(
        string='Acréscimo',
        compute='_compute_amount_acrescimo',
        store=False,
    )

    @api.depends('order_id.x_amount_other_value')
    def _compute_amount_acrescimo(self):
        for rec in self:
            rec.amount_acrescimo = rec.order_id.x_amount_other_value or 0.0

