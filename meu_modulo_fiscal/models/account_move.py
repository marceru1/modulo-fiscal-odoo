import logging

from odoo import models, fields

_logger = logging.getLogger(__name__)


class AccountMove(models.Model):
    _inherit = 'account.move'

    def _prazo_registrar_recebimento(self, amount=None, payment_method_name='',
                                     payment_method_id=None, journal_id=None,
                                     pos_session=None,
                                     memo_prefix='Recebimento A Prazo'):
        """Núcleo ÚNICO de recebimento de fatura A Prazo (DEC-002).

        Valida a fatura, cria o ``account.payment`` inbound, posta, reconcilia
        com a linha a receber e registra a movimentação 'pagamento' em
        ``x.prazo.movimentacao`` (com ``fatura_name``) quando o parceiro é
        funcionário. Serve os dois caminhos:

        - PDV: ``pos.session.create_recebimento`` delega e acrescenta só os
          enfeites de caixa (sessão, comprovante térmico, operador);
        - cadastro: o wizard da aba 'Conta A Prazo' chama direto (sem
          comprovante — impressão é coisa de PDV, DEC-005).

        Args:
            amount: valor a receber; None usa o residual da fatura.
            payment_method_name: nome exibido no comprovante (fallback legado).
            payment_method_id: ID do pos.payment.method escolhido no PDV; tem
                prioridade sobre o nome. Inválido cai no fallback sem quebrar.
            journal_id: account.journal do pagamento. Sem ele o Odoo computa o
                default contábil (mesma regra do core).
            pos_session: pos.session de origem (só o PDV passa). Sem ele o
                pagamento nasce fora do caixa — não entra em _get_recebimentos.
            memo_prefix: prefixo do memo do pagamento (rastreio da origem).

        Returns:
            dict: em falha ``{'success': False, 'message': str}``; em sucesso
            ``{'success': True, 'message': str, 'payment': account.payment,
            'residual': float}`` — ``residual`` é o saldo da fatura APÓS a
            reconciliação (mesmo critério da mov 'pagamento', DEC-003).
        """
        self.ensure_one()

        if not self.exists():
            return {'success': False, 'message': 'Fatura nao encontrada'}

        if self.state != 'posted':
            return {'success': False, 'message': 'Fatura nao esta confirmada (state=%s)' % self.state}

        if self.payment_state not in ('not_paid', 'partial'):
            return {'success': False, 'message': 'Fatura ja foi quitada (payment_state=%s)' % self.payment_state}

        # Se amount nao foi passado, usa o residual (compatibilidade retrograda)
        if amount is None:
            amount = self.amount_residual

        # Valida o amount
        if amount <= 0:
            return {'success': False, 'message': 'Valor invalido (%.2f). O valor deve ser maior que zero.' % amount}

        if amount < 1.0:
            return {'success': False, 'message': 'Valor minimo de R$ 1,00'}

        if amount > self.amount_residual + 0.001:
            return {
                'success': False,
                'message': 'Valor superior ao saldo da fatura (R$ %.2f)' % self.amount_residual,
            }

        # DEC-001: resolve o metodo de pagamento. payment_method_id (int) tem
        # prioridade; payment_method_name (str) e o fallback legado. Um id
        # inexistente cai no fallback sem quebrar o recebimento.
        # Nota: se o frontend passar ambos (payment_method_name + id invalido),
        # o nome legado vence silenciosamente — intencional, coberto por
        # test_payment_method_id_invalido.
        if payment_method_id:
            payment_method = self.env['pos.payment.method'].browse(payment_method_id)
        else:
            payment_method = self.env['pos.payment.method']
        if payment_method.exists():
            payment_method_name = payment_method.name

        partner = self.partner_id

        # Monta o memo: diferenciado para pagamento parcial
        is_partial = amount < self.amount_residual - 0.001
        if is_partial:
            memo = '%s - Fatura %s - Parcial R$ %.2f' % (memo_prefix, self.name, amount)
        else:
            memo = '%s - Fatura %s' % (memo_prefix, self.name)

        # Cria o pagamento de entrada (inbound) pelo valor informado
        vals = {
            'payment_type': 'inbound',
            'partner_type': 'customer',
            'partner_id': partner.id,
            'amount': amount,
            'date': fields.Date.context_today(self),
            'memo': memo,
            'x_payment_method_id': payment_method.id if payment_method.exists() else False,
        }
        if journal_id:
            vals['journal_id'] = journal_id.id
        if pos_session:
            vals['pos_session_id'] = pos_session.id
        payment = self.env['account.payment'].create(vals)
        payment.action_post()

        _logger.info(
            '[RECEBIMENTO] Pagamento criado | Fatura: %s | Parceiro: %s (ID=%d) | Valor: %.2f | Payment ID=%d',
            self.name, partner.name, partner.id, amount, payment.id
        )

        # Reconcilia o pagamento com a fatura via linhas a receber
        # No Odoo 18, as linhas contábeis do pagamento ficam em payment.move_id.line_ids
        payment_move = payment.move_id
        payment_line = payment_move.line_ids.filtered(
            lambda l: l.account_id.account_type == 'asset_receivable'
        )
        invoice_line = self.line_ids.filtered(
            lambda l: l.account_id.account_type == 'asset_receivable' and not l.reconciled
        )
        if payment_line and invoice_line:
            (payment_line + invoice_line).reconcile()
            _logger.info(
                '[RECEBIMENTO] Reconciliacao realizada | Fatura: %s | Payment ID=%d',
                self.name, payment.id
            )
        else:
            _logger.warning(
                '[RECEBIMENTO] Nao foi possivel reconciliar | Fatura: %s | '
                'payment_line=%s | invoice_line=%s',
                self.name, bool(payment_line), bool(invoice_line)
            )

        # Le o saldo residual APOS reconciliacao (DEC-003)
        residual_pos = self.amount_residual

        # Registra movimentacao se o parceiro for funcionario (I10: helper extraído)
        # Usa o saldo residual pos-reconciliacao (DEC-003)
        employee = self.env['hr.employee']._find_by_partner(partner.id)
        if employee:
            self.env['x.prazo.movimentacao'].create({
                'employee_id': employee.id,
                'partner_id': partner.id,
                'data': fields.Datetime.now(),
                'valor': residual_pos,
                'tipo': 'pagamento',
                # DEC-003: a fatura recebida já está em mãos aqui — sem lookback
                'fatura_name': self.name,
            })
            _logger.info(
                '[RECEBIMENTO] Movimentacao registrada | Funcionario: %s | Valor residual: %.2f',
                employee.name, residual_pos
            )

        return {
            'success': True,
            'message': 'Recebido R$ %.2f | Saldo restante: R$ %.2f | Fatura %s' % (
                amount, residual_pos, self.name
            ),
            'payment': payment,
            'residual': residual_pos,
        }
