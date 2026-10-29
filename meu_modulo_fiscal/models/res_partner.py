from odoo import models


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
