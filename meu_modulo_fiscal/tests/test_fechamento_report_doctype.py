# -*- coding: utf-8 -*-
"""
Regressão: a página de reimpressão do fechamento (rota /pos/fechamento/<id>)
deve começar com um DOCTYPE HTML de verdade, não com o texto escapado
'&lt;!DOCTYPE html&gt;'.

Bug original: o controller concatenava '<!DOCTYPE html>' + resultado de
``ir.qweb._render()``, que devolve ``markupsafe.Markup``. Em 'str + Markup',
o Markup trata o operando esquerdo (str puro) como não-confiável e o escapa —
o DOCTYPE virava texto visível impresso no topo do cupom.

Seam testado: a resposta HTTP bruta da rota (comportamento externo), não a
implementação interna do controller.
"""
import re

from odoo.tests import HttpCase, tagged


@tagged('post_install', '-at_install')
class TestFechamentoReportDoctype(HttpCase):
    """A rota de reimpressão tem que entregar HTML válido."""

    def setUp(self):
        super().setUp()
        # Usa um usuário real da base: authenticate() resolve credenciais
        # contra res.users, então 'admin'/'admin' (padrão em bases novas) não
        # existe aqui — derrubaria o teste com KeyError, não com o bug real.
        self.admin_user = self.env['res.users'].search(
            [('login', '=', 'adm@grupo20mais.com.br')], limit=1
        ) or self.env.ref('base.user_admin')
        self.journal = self.env['account.journal'].create({
            'name': 'Diário PDV Teste Doctype',
            'type': 'sale',
            'code': 'PDVDOC',
        })
        self.pos_config = self.env['pos.config'].create({
            'name': 'PDV Teste Doctype',
            'journal_id': self.journal.id,
        })
        self.pos_session = self.env['pos.session'].create({
            'config_id': self.pos_config.id,
            'user_id': self.env.user.id,
        })
        self.pos_session.action_pos_session_open()

    def test_rota_fechamento_nao_escapa_doctype(self):
        """O corpo da resposta começa com '<!DOCTYPE html>', sem entidades."""
        self.authenticate(self.admin_user.login, 'x')
        response = self.url_open('/pos/fechamento/%d' % self.pos_session.id)
        self.assertEqual(response.status_code, 200)
        body = response.text

        self.assertTrue(
            body.lstrip().startswith('<!DOCTYPE html>'),
            "A página deve começar com um DOCTYPE literal; começou com: %r"
            % body[:60],
        )
        self.assertNotIn(
            '&lt;!DOCTYPE',
            body,
            "O DOCTYPE não pode sair escapado como entidade HTML",
        )
        # Garante que só existe UM doctype na página (nem escapado nem perdido).
        self.assertEqual(
            len(re.findall(r'(?i)<!doctype', body)), 1,
            "A página deve conter exatamente um DOCTYPE",
        )
        # O conteúdo do relatório continua renderizado (não foi engolido).
        self.assertIn('FECHAMENTO DE CAIXA', body)

    def test_rota_fechamento_sessao_inexistente_retorna_404(self):
        """Sessão inexistente → 404, sem traceback."""
        self.authenticate(self.admin_user.login, 'x')
        response = self.url_open('/pos/fechamento/99999999')
        self.assertEqual(response.status_code, 404)
