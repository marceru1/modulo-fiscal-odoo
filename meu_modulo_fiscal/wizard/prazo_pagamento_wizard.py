from odoo import api, fields, models
from odoo.exceptions import UserError


class XPrazoPagamentoWizard(models.TransientModel):
    """Wizard 'Registrar Pagamento' da conta a prazo do CONTATO.

    DEC-A/DEC-B da spec prazo-por-contato: a conta a prazo vive no
    ``res.partner``. O wizard recebe o contato (fatura em aberto, valor
    editável — default = residual — e diário contábil editável). Confirmar
    dispara o núcleo compartilhado de recebimento
    (``account.move._prazo_registrar_recebimento``).
    """

    _name = 'x.prazo.pagamento.wizard'
    _description = 'Registrar Pagamento de Fatura A Prazo'

    partner_id = fields.Many2one(
        'res.partner',
        string='Contato',
        required=True,
        ondelete='cascade',
        help='Contato dono da fatura a prazo. É a fonte única do vínculo — '
             'o mesmo contato usado pelo saldo e pelo histórico.',
    )
    fatura_id = fields.Many2one(
        'account.move',
        string='Fatura',
        required=True,
        domain="[('partner_id', '=', partner_id), "
               "('move_type', '=', 'out_invoice'), "
               "('state', '=', 'posted'), "
               "('payment_state', 'in', ['not_paid', 'partial'])]",
    )
    valor = fields.Float(
        'Valor',
        digits=(16, 2),
        required=True,
        help='Default = saldo da fatura; aceita valor parcial.',
    )
    journal_id = fields.Many2one(
        'account.journal',
        string='Forma de Pagamento',
        required=True,
        default=lambda self: self._journal_padrao(),
        domain="[('type', 'in', ['bank', 'cash'])]",
    )

    @api.model
    def _journal_padrao(self):
        """Diário default do pagamento: o do método de pagamento do contato,
        senão o primeiro banco/caixa da empresa — a MESMA regra que o core
        (account.payment._compute_journal_id) aplicaria sozinho."""
        partner_id = self.env.context.get('default_partner_id')
        partner = (
            self.env['res.partner'].browse(partner_id) if partner_id
            else self.env['res.partner']
        )
        journal = (
            partner.with_company(self.env.company)
            .property_inbound_payment_method_line_id.journal_id
            if partner else self.env['account.journal']
        )
        if not journal:
            journal = self.env['account.journal'].search([
                ('company_id', '=', self.env.company.id),
                ('type', 'in', ['bank', 'cash']),
            ], limit=1)
        return journal

    @api.onchange('fatura_id')
    def _onchange_fatura_id(self):
        """Escolher a fatura preenche o valor com o saldo dela."""
        if self.fatura_id:
            self.valor = self.fatura_id.amount_residual

    def action_confirmar(self):
        """Paga a fatura escolhida pelo núcleo compartilhado (DEC-002)."""
        self.ensure_one()

        partner = self.partner_id
        if not partner:
            raise UserError('Selecione o contato antes de registrar o pagamento.')

        if self.fatura_id.partner_id != partner:
            raise UserError(
                'A fatura %s não pertence a %s.'
                % (self.fatura_id.display_name, partner.display_name)
            )

        resultado = self.fatura_id._prazo_registrar_recebimento(
            amount=self.valor,
            journal_id=self.journal_id,
            memo_prefix='Recebimento A Prazo',
        )
        if not resultado['success']:
            raise UserError(resultado['message'])

        # soft_reload: a ficha do contato recarrega e mostra a mov nova e o
        # saldo atualizado (o saldo é o partner.credit nativo).
        return {
            'type': 'ir.actions.client',
            'tag': 'display_notification',
            'params': {
                'title': 'Pagamento registrado',
                'message': resultado['message'],
                'type': 'success',
                'sticky': False,
                'next': {'type': 'ir.actions.client', 'tag': 'soft_reload'},
            },
        }
