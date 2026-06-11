from odoo import fields, models

class ResConfigSettings(models.TransientModel):
    _inherit = 'res.config.settings'

    pos_x_fiscal_payment_method_ids = fields.Many2many(
        related='pos_config_id.x_fiscal_payment_method_ids',
        readonly=False,
    )
