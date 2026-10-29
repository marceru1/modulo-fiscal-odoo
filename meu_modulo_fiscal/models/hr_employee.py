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

    def _prazo_partner(self):
        """Parceiro (res.partner) do funcionário no controle A Prazo.

        Contato de trabalho (work_contact_id) ou, na falta dele, o parceiro do
        usuário vinculado. É a mesma fonte usada pelo saldo da aba e pelo
        wizard de pagamento — um só lugar para a regra do vínculo.
        """
        self.ensure_one()
        return self.work_contact_id or (
            self.user_id.partner_id if self.user_id else self.env['res.partner']
        )

    @api.model
    def _find_by_partner(self, partner_id):
        """Devolve o hr.employee vinculado ao partner_id, ou recordset vazio.

        Fonte única da busca: o contato de trabalho (work_contact_id) ou o
        parceiro do usuário (user_id.partner_id). Usado pelo registro de
        movimentações, pelo recebimento do PDV e pelo pagamento pelo cadastro.
        """
        if not partner_id:
            return self.env['hr.employee']
        return self.search([
            '|',
            ('work_contact_id', '=', partner_id),
            ('user_id.partner_id', '=', partner_id),
        ], limit=1)

    @api.depends('work_contact_id', 'user_id')
    def _compute_saldo_prazo(self):
        for employee in self:
            partner = employee._prazo_partner()
            # N15: .sudo() evita erro de acesso em multi-empresa (partner.credit
            # pode estar em empresa diferente da do usuário logado)
            employee.x_saldo_prazo = partner.sudo().credit if partner else 0.0

    def action_registrar_pagamento_prazo(self):
        """Abre o wizard de pagamento da aba 'Conta A Prazo' (DEC-001)."""
        self.ensure_one()
        return {
            'type': 'ir.actions.act_window',
            'name': 'Registrar Pagamento',
            'res_model': 'x.prazo.pagamento.wizard',
            'view_mode': 'form',
            'view_id': self.env.ref(
                'meu_modulo_fiscal.view_prazo_pagamento_wizard_form'
            ).id,
            'target': 'new',
            'context': {'default_employee_id': self.id},
        }
