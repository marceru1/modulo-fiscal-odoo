"""Conta a prazo na ficha do contato (spec: prazo-por-contato, tickets 01-02).

Seams testados:
- ``res.partner.x_historico_prazo_ids`` — histórico filtrado pelo contato;
- ``res.partner.x_prazo_tem_fatura_aberta`` — visibilidade do botão (DEC-J);
- ``res.partner.action_registrar_pagamento_prazo`` — abre o wizard com o contato;
- view herdada de ``base.view_partner_form`` — tudo DENTRO do grupo nativo
  ``credit_limits``, sem aba/menu novos (DEC-B).
"""

from lxml import etree

from odoo import fields
from odoo.tests import TransactionCase


class TestPrazoContato(TransactionCase):
    def setUp(self):
        super().setUp()
        self.mov_model = self.env['x.prazo.movimentacao']
        self.partner = self.env['res.partner'].create({'name': 'Contato A Prazo'})
        self.outro = self.env['res.partner'].create({'name': 'Outro Contato'})

    def _fatura(self, valor=100.0, partner=None):
        fatura = self.env['account.move'].create({
            'move_type': 'out_invoice',
            'partner_id': (partner or self.partner).id,
            'invoice_date': fields.Date.today(),
            'invoice_line_ids': [(0, 0, {
                'name': 'Compra a prazo',
                'quantity': 1.0,
                'price_unit': valor,
            })],
        })
        fatura.action_post()
        return fatura

    # ── Histórico ────────────────────────────────────────────────────────────
    def test_historico_lista_so_as_movs_do_contato(self):
        mov = self.mov_model.create({
            'partner_id': self.partner.id,
            'valor': 10.0,
            'tipo': 'compra',
        })
        self.mov_model.create({
            'partner_id': self.outro.id,
            'valor': 20.0,
            'tipo': 'compra',
        })

        self.assertEqual(
            self.partner.x_historico_prazo_ids.ids, [mov.id],
            'A ficha do contato só pode listar as movs dele',
        )
        self.assertEqual(
            self.outro.x_historico_prazo_ids.ids,
            self.mov_model.search([('partner_id', '=', self.outro.id)]).ids,
        )

    # ── Botão (DEC-J) ────────────────────────────────────────────────────────
    def test_botao_so_aparece_com_fatura_aberta(self):
        self.assertFalse(
            self.partner.x_prazo_tem_fatura_aberta,
            'Sem fatura, o botão Registrar Pagamento fica oculto',
        )

        self._fatura(100.0)

        # store=False: no mesmo env do teste o cache do campo precisa cair;
        # na ficha real cada abertura faz um read novo.
        self.env.invalidate_all()
        self.assertTrue(
            self.partner.x_prazo_tem_fatura_aberta,
            'Com fatura a prazo em aberto, o botão aparece',
        )

    def test_botao_oculto_quando_a_fatura_sai_de_aberto(self):
        fatura = self._fatura(100.0)
        self.env.invalidate_all()
        self.assertTrue(self.partner.x_prazo_tem_fatura_aberta)

        fatura.button_draft()  # rascunho não é fatura em aberto
        self.env.invalidate_all()

        self.assertFalse(self.partner.x_prazo_tem_fatura_aberta)

    def test_botao_abre_o_wizard_com_o_contato(self):
        acao = self.partner.action_registrar_pagamento_prazo()

        self.assertEqual(acao['res_model'], 'x.prazo.pagamento.wizard')
        self.assertEqual(acao['context']['default_partner_id'], self.partner.id)

    # ── View nativa ──────────────────────────────────────────────────────────
    def test_view_entra_no_grupo_nativo_sem_aba_nova(self):
        """A herança injeta histórico/botão DENTRO do grupo Credit Limits da
        aba Faturamento — herdando as condições de visibilidade do core."""
        arvore = etree.fromstring(
            self.env['res.partner'].get_view(
                self.env.ref('base.view_partner_form').id, 'form'
            )['arch']
        )

        grupos = arvore.xpath("//group[@name='credit_limits']")
        self.assertEqual(len(grupos), 1, 'O grupo nativo Credit Limits deveria existir')
        grupo = grupos[0]
        self.assertEqual(
            len(grupo.xpath(".//button[@name='action_registrar_pagamento_prazo']")),
            1,
            'Falta o botão Registrar Pagamento dentro do grupo nativo',
        )
        self.assertEqual(
            len(grupo.xpath(".//field[@name='x_historico_prazo_ids']")),
            1,
            'Falta o histórico dentro do grupo nativo',
        )
        self.assertFalse(
            arvore.xpath("//page[@name='conta_prazo']"),
            'Não pode existir aba nova no contato (DEC-B)',
        )
