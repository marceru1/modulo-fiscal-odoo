# -*- coding: utf-8 -*-
"""
Controller HTTP para reimpressão do relatório de fechamento de caixa
a partir do backend do Odoo (form view de pos.session).

Renderiza uma página HTML standalone (72mm, formato térmico) com os dados
de ``pos.session.get_fechamento_data()`` e dispara ``window.print()``.
"""
import logging

from odoo import http
from odoo.http import request

_logger = logging.getLogger(__name__)


class FechamentoReportController(http.Controller):
    """Expõe a rota ``/pos/fechamento/<session_id>`` que retorna uma
    página HTML pronta para impressão do fechamento de caixa.
    """

    @http.route(
        '/pos/fechamento/<int:session_id>',
        type='http',
        auth='user',
        methods=['GET'],
    )
    def print_fechamento(self, session_id, **kw):
        session = request.env['pos.session'].sudo().browse(session_id)
        if not session.exists():
            return request.not_found(
                'Sessão POS #%d não encontrada.' % session_id
            )

        try:
            dados = session.get_fechamento_data()
        except Exception as exc:
            _logger.exception(
                '[FECHAMENTO-REPORT] Erro ao coletar dados da sessão %s: %s',
                session_id, exc,
            )
            return request.not_found(
                'Erro ao gerar fechamento: %s' % exc
            )

        # Helper de formatação de moeda (BRL) para o template QWeb.
        def format_currency(value):
            try:
                value = float(value or 0.0)
            except (TypeError, ValueError):
                value = 0.0
            # Formato brasileiro: 1.234,56
            s = '{:,.2f}'.format(value)
            return 'R$ ' + s.replace(',', 'X').replace('.', ',').replace('X', '.')

        html = request.env['ir.qweb']._render(
            'meu_modulo_fiscal.FechamentoReport',
            {
                'data': dados,
                'format_currency': format_currency,
                'session_id': session_id,
            },
        )
        # O template QWeb é XML válido (sem DOCTYPE); prependemos o DOCTYPE
        # para gerar uma página HTML5 completa e válida para impressão.
        if isinstance(html, bytes):
            html = html.decode('utf-8')
        html = '<!DOCTYPE html>\n' + html
        return request.make_response(html.encode('utf-8'), headers=[
            ('Content-Type', 'text/html; charset=utf-8'),
        ])