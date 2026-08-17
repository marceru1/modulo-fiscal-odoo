from odoo import api, models, fields


class HrEmployee(models.Model):
    _inherit = 'hr.employee'

    x_limite_prazo = fields.Float(
        related='work_contact_id.credit_limit',
        string='Limite A Prazo',
        readonly=False,
        digits=(16, 2),
    )

    x_saldo_prazo = fields.Float(
        string='Saldo A Prazo',
        compute='_compute_saldo_prazo',
        digits=(16, 2),
        store=False,
    )

    x_historico_prazo_ids = fields.One2many(
        'x.prazo.movimentacao',
        'employee_id',
        string='Histórico A Prazo',
    )

    @api.depends('work_contact_id', 'user_id')
    def _compute_saldo_prazo(self):
        for employee in self:
            partner = employee.work_contact_id or (
                employee.user_id.partner_id if employee.user_id else None
            )
            # N15: .sudo() evita erro de acesso em multi-empresa (partner.credit
            # pode estar em empresa diferente da do usuário logado)
            employee.x_saldo_prazo = partner.sudo().credit if partner else 0.0
