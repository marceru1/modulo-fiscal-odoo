from odoo import models, fields


class HrEmployee(models.Model):
    _inherit = 'hr.employee'

    x_historico_prazo_ids = fields.One2many(
        'x.prazo.movimentacao',
        'employee_id',
        string='Histórico A Prazo',
    )
