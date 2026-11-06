from odoo import api, fields, models


def prazo_faturas_abertas_domain(partner_id):
    """Domain das faturas EM ABERTO do parceiro (fonte única).

    DEC-003 da spec prazo-pagar-no-cadastro: o popup de Recebimento do PDV e o
    dropdown do wizard do cadastro leem da MESMA query — o que o gerente vê é o
    que o PDV vê. Fatura de cliente (out_invoice) postada e não quitada.
    """
    return [
        ('partner_id', '=', partner_id),
        ('move_type', '=', 'out_invoice'),
        ('payment_state', 'in', ['not_paid', 'partial']),
        ('state', '=', 'posted'),
    ]


class ResPartner(models.Model):
    _inherit = 'res.partner'

    # DEC-A/DEC-B da spec prazo-por-contato: a conta a prazo vive no contato.
    # O limite e o saldo são os campos nativos (credit_limit / credit) da aba
    # Faturamento; aqui ficam só o histórico e o gatilho do wizard.
    x_historico_prazo_ids = fields.One2many(
        'x.prazo.movimentacao',
        'partner_id',
        string='Histórico A Prazo',
        readonly=True,
    )

    x_prazo_tem_fatura_aberta = fields.Boolean(
        string='Tem Fatura A Prazo em Aberto',
        compute='_compute_prazo_tem_fatura_aberta',
        store=False,
        help='Controla a visibilidade do botão Registrar Pagamento na ficha '
             '(DEC-J: botão só com saldo a prazo em aberto).',
    )

    def _prazo_faturas_abertas(self, limit=50):
        """Faturas em aberto do parceiro + o TOTAL residual, tudo no backend.

        Args:
            limit (int): teto de faturas (o popup do PDV não pagina; 50 cobre
                o caso real de uso).

        Returns:
            dict: {'faturas': [{id, name, invoice_date_due, amount_residual,
            payment_state}...], 'total_residual': float} — faturas ordenadas
            por vencimento.
        """
        self.ensure_one()
        faturas = self.env['account.move'].search_read(
            prazo_faturas_abertas_domain(self.id),
            ['name', 'invoice_date_due', 'amount_residual', 'payment_state'],
            limit=limit,
            order='invoice_date_due',
        )
        # `date` cru não sobe por JSON (TypeError no serializador): normaliza
        # para string 'YYYY-MM-DD' — o JS já fatia ano-mês-dia no label.
        for f in faturas:
            f['invoice_date_due'] = str(f['invoice_date_due'] or '')
        # Soma no Python: os registros já vieram lidos; uma segunda query de
        # aggregate (read_group) gastaria um round-trip e duplicaria o domínio.
        total = sum((f['amount_residual'] for f in faturas), 0.0)
        return {'faturas': faturas, 'total_residual': total}

    def _compute_prazo_tem_fatura_aberta(self):
        for partner in self:
            partner.x_prazo_tem_fatura_aberta = bool(
                self.env['account.move'].search_count(
                    prazo_faturas_abertas_domain(partner.id)
                )
            )

    def action_registrar_pagamento_prazo(self):
        """Abre o wizard de pagamento da conta a prazo do contato (DEC-B)."""
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
            'context': {'default_partner_id': self.id},
        }

    @api.model
    def prazo_limite_credito(self, partner_id):
        """Leitura mínima de crédito para o PDV (DEC-G da spec).

        ``credit`` e ``credit_limit`` são restritos aos grupos de contabilidade
        do core; o caixa não os tem. Este é o ÚNICO seam que o PDV usa: roda
        com ``sudo()`` e devolve SÓ esses dois números — nenhum outro campo do
        contato é exposto. O limite é lido no contexto da empresa do usuário
        (``credit_limit`` é company_dependent).

        O nome É público por necessidade: ``odoo/service/model.py``
        (``get_public_method``) rejeita métodos prefixados por ``_`` em qualquer
        chamada RPC (``/web/dataset/call_kw`` incluso) — a versão ``_prazo_`` do
        seam nunca chegava ao servidor e travava a venda a prazo com RPC_ERROR.

        Args:
            partner_id (int|False): contato do pedido.

        Returns:
            dict: ``{'credit': float, 'credit_limit': float}``; zeros quando o
            contato não existe (o cliente trata como sem limite).
        """
        partner = (
            self.sudo().browse(partner_id).exists() if partner_id
            else self.sudo().browse()
        )
        if not partner:
            return {'credit': 0.0, 'credit_limit': 0.0}
        return {
            'credit': partner.credit or 0.0,
            'credit_limit': partner.credit_limit or 0.0,
        }
