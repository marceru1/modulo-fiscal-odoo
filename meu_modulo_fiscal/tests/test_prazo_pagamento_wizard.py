"""Receber fatura pelo cadastro do funcionário (spec: prazo-pagar-no-cadastro).

Seams testados (Testing Decisions da spec):
- ``x.prazo.pagamento.wizard`` — total, parcial, validações (fatura inválida,
  valor acima do residual, fatura já paga);
- ``account.move._prazo_registrar_recebimento`` — núcleo compartilhado com o
  PDV (mesma validação, mesmo pagamento/reconciliação, mesma mov 'pagamento');
- ``res.partner._prazo_faturas_abertas`` — fonte ÚNICA da lista (wizard e PDV);
- paridade das movs 'pagamento' PDV × backend (fatura_name nos dois);
- isolamento: pagamento do backend NÃO entra no caixa da sessão do PDV.
"""

from lxml import etree

from odoo import fields
from odoo.exceptions import UserError
from odoo.tests import TransactionCase

from .paridade_offline_helper import montar_pos_offline


class TestPrazoPagamentoWizard(TransactionCase):
    def setUp(self):
        super().setUp()
        # Ambiente de POS (journals, métodos, sessão) reaproveitado dos
        # testes offline — o teste de paridade precisa de uma sessão real.
        montar_pos_offline(self)
        self.mov_model = self.env['x.prazo.movimentacao']
        self.wizard_model = self.env['x.prazo.pagamento.wizard']

        self.funcionaria = self.env['res.partner'].create({
            'name': 'Funcionária Teste',
        })
        self.employee = self.env['hr.employee'].create({
            'name': 'Funcionária Teste',
            'work_contact_id': self.funcionaria.id,
        })

    # ── Helpers ───────────────────────────────────────────────────────────────
    def _fatura(self, valor=100.0, partner=None, postar=True):
        fatura = self.env['account.move'].create({
            'move_type': 'out_invoice',
            'partner_id': (partner or self.funcionaria).id,
            'invoice_date': fields.Date.today(),
            'invoice_line_ids': [(0, 0, {
                'name': 'Compra a prazo',
                'quantity': 1.0,
                'price_unit': valor,
            })],
        })
        if postar:
            fatura.action_post()
        return fatura

    def _wizard(self, fatura, valor=None, journal=None, employee=None):
        vals = {
            'employee_id': (employee or self.employee).id,
            'fatura_id': fatura.id,
            # default real do formulário é o onchange; aqui o helper já resolve
            'valor': fatura.amount_residual if valor is None else valor,
        }
        if journal is not None:
            vals['journal_id'] = journal.id
        return self.wizard_model.create(vals)

    def _movs_pagamento(self):
        return self.mov_model.search([
            ('employee_id', '=', self.employee.id),
            ('tipo', '=', 'pagamento'),
        ])

    # ── Total ────────────────────────────────────────────────────────────────
    def test_valor_default_vem_do_residual(self):
        """Escolher a fatura preenche o valor com o saldo dela (onchange)."""
        fatura = self._fatura(100.0)
        wizard = self.wizard_model.new({
            'employee_id': self.employee.id,
            'fatura_id': fatura.id,
        })

        wizard._onchange_fatura_id()

        self.assertAlmostEqual(wizard.valor, 100.0, places=2)

    def test_pagamento_total_quita_a_fatura(self):
        """Valor default = residual → fatura quitada, mov 'pagamento' com a
        fatura e saldo da aba zerado."""
        fatura = self._fatura(100.0)
        self.assertAlmostEqual(self.employee.x_saldo_prazo, 100.0, places=2)

        self._wizard(fatura).action_confirmar()

        self.assertIn(fatura.payment_state, ('in_payment', 'paid'))
        self.assertAlmostEqual(fatura.amount_residual, 0.0, places=2)

        movs = self._movs_pagamento()
        self.assertEqual(len(movs), 1, 'O pagamento deveria gerar 1 movimentação')
        self.assertEqual(movs.fatura_name, fatura.name)
        self.assertEqual(movs.partner_id, self.funcionaria)
        # Paridade com o PDV: a mov registra o residual pós-baixa (DEC-003
        # do create_recebimento) — quitada, residual 0.
        self.assertAlmostEqual(movs.valor, 0.0, places=2)

        # O saldo (computed, não armazenado) é recalculado quando a ficha é
        # recarregada — no teste, força o descarte do cache do env.
        self.env.invalidate_all()
        self.assertAlmostEqual(
            self.employee.x_saldo_prazo, 0.0, places=2,
            msg='O saldo da aba (partner.credit) deve cair sozinho',
        )

    # ── Parcial ──────────────────────────────────────────────────────────────
    def test_pagamento_parcial_deixa_residual(self):
        """Valor < residual → payment_state='partial', residual correto e a
        mov registra o saldo restante (mesmo critério do PDV)."""
        fatura = self._fatura(100.0)

        self._wizard(fatura, valor=30.0).action_confirmar()

        self.assertEqual(fatura.payment_state, 'partial')
        self.assertAlmostEqual(fatura.amount_residual, 70.0, places=2)

        movs = self._movs_pagamento()
        self.assertEqual(len(movs), 1)
        self.assertEqual(movs.fatura_name, fatura.name)
        self.assertAlmostEqual(movs.valor, 70.0, places=2)
        self.env.invalidate_all()
        self.assertAlmostEqual(self.employee.x_saldo_prazo, 70.0, places=2)

    # ── Validações do wizard ─────────────────────────────────────────────────
    def test_valor_acima_do_residual_rejeitado(self):
        fatura = self._fatura(100.0)

        with self.assertRaises(UserError) as erro:
            self._wizard(fatura, valor=110.0).action_confirmar()

        self.assertIn('superior', str(erro.exception).lower())
        self.assertEqual(self._movs_pagamento(), self.mov_model)

    def test_valor_abaixo_do_minimo_rejeitado(self):
        fatura = self._fatura(100.0)

        with self.assertRaises(UserError) as erro:
            self._wizard(fatura, valor=0.50).action_confirmar()

        self.assertIn('minimo', str(erro.exception).lower())

    def test_fatura_ja_paga_rejeitada(self):
        fatura = self._fatura(100.0)
        self._wizard(fatura).action_confirmar()

        with self.assertRaises(UserError) as erro:
            self._wizard(fatura, valor=10.0).action_confirmar()

        self.assertIn('quitada', str(erro.exception).lower())
        self.assertEqual(len(self._movs_pagamento()), 1,
                         'A tentativa recusada não pode registrar movimentação')

    def test_fatura_rascunho_rejeitada(self):
        """Fatura não postada não é recebível (o domain do campo já a esconde;
        o núcleo valida de novo)."""
        fatura = self._fatura(100.0, postar=False)

        with self.assertRaises(UserError) as erro:
            self._wizard(fatura).action_confirmar()

        self.assertIn('confirmada', str(erro.exception).lower())

    def test_fatura_de_outro_parceiro_rejeitada(self):
        outra = self.env['res.partner'].create({'name': 'Outra Pessoa'})
        fatura = self._fatura(100.0, partner=outra)

        with self.assertRaises(UserError) as erro:
            self._wizard(fatura).action_confirmar()

        self.assertIn('pertence', str(erro.exception).lower())
        self.assertEqual(outra.credit, 100.0,
                         'A fatura de outro parceiro deve continuar em aberto')

    # ── Journal (forma de pagamento) ─────────────────────────────────────────
    def test_journal_default_e_editavel(self):
        """Default = journal contábil (bank/cash) da empresa; trocar o journal
        no wizard usa o escolhido no account.payment."""
        fatura = self._fatura(100.0)

        wizard = self._wizard(fatura)
        self.assertIn(wizard.journal_id.type, ('bank', 'cash'),
                      'O default deve ser um diário contábil de pagamento')

        escolhido = self.env['account.journal'].create({
            'name': 'Banco Escolhido Teste',
            'type': 'bank',
            'code': 'BET',
            'company_id': self.company.id,
        })
        wizard = self._wizard(fatura, journal=escolhido)
        wizard.action_confirmar()

        payment = self.env['account.payment'].search([
            ('partner_id', '=', self.funcionaria.id),
            ('payment_type', '=', 'inbound'),
        ], limit=1)
        self.assertEqual(payment.journal_id, escolhido)

    # ── Fonte única das faturas em aberto ────────────────────────────────────
    def test_faturas_em_aberto_fonte_unica(self):
        """O helper do parceiro e a listagem do PDV devolvem a MESMA coisa;
        faturas pagas/rascunho ficam de fora."""
        aberta = self._fatura(100.0)
        paga = self._fatura(50.0)
        self._wizard(paga).action_confirmar()
        self._fatura(70.0, postar=False)  # rascunho

        do_parceiro = self.funcionaria._prazo_faturas_abertas()
        do_pdv = self.pos_session.faturas_aberto_data(self.funcionaria.id)

        self.assertEqual(
            [f['id'] for f in do_parceiro['faturas']],
            [f['id'] for f in do_pdv['faturas']],
            'PDV e wizard devem ler a MESMA lista',
        )
        self.assertEqual([f['id'] for f in do_parceiro['faturas']], [aberta.id])
        self.assertAlmostEqual(do_pdv['total_residual'], 100.0, places=2)

    # ── Paridade PDV × backend ───────────────────────────────────────────────
    def test_mov_pagamento_paridade_pdv_e_backend(self):
        """Mesma fatura/valor pelos dois caminhos → movs equivalentes, cada
        uma com o fatura_name da fatura recebida."""
        pelo_pdv = self._fatura(100.0)
        pelo_backend = self._fatura(100.0)

        resultado = self.pos_session.create_recebimento(pelo_pdv.id, 30.0)
        self.assertTrue(resultado['success'], resultado.get('message'))
        self.assertIn('comprovante', resultado)

        self._wizard(pelo_backend, valor=30.0).action_confirmar()

        mov_pdv = self.mov_model.search([
            ('employee_id', '=', self.employee.id),
            ('tipo', '=', 'pagamento'),
            ('fatura_name', '=', pelo_pdv.name),
        ])
        mov_backend = self.mov_model.search([
            ('employee_id', '=', self.employee.id),
            ('tipo', '=', 'pagamento'),
            ('fatura_name', '=', pelo_backend.name),
        ])
        self.assertEqual(len(mov_pdv), 1, 'O PDV deveria registrar a mov')
        self.assertEqual(len(mov_backend), 1, 'O backend deveria registrar a mov')

        for campo in ('employee_id', 'partner_id', 'tipo', 'valor'):
            self.assertEqual(
                mov_pdv[campo], mov_backend[campo],
                'Paridade quebrada no campo %s' % campo,
            )
        self.assertAlmostEqual(mov_backend.valor, 70.0, places=2)

    # ── Isolamento do caixa ──────────────────────────────────────────────────
    def test_pagamento_do_backend_nao_entra_no_caixa(self):
        """O pagamento do cadastro não é da sessão do PDV: sem pos_session_id,
        fora de _get_recebimentos e com memo próprio."""
        fatura = self._fatura(100.0)

        self._wizard(fatura, valor=30.0).action_confirmar()

        payment = self.env['account.payment'].search([
            ('partner_id', '=', self.funcionaria.id),
            ('payment_type', '=', 'inbound'),
        ], limit=1)
        self.assertFalse(payment.pos_session_id)
        self.assertNotIn('Recebimento PDV', payment.memo)
        self.assertIn(fatura.name, payment.memo)

        recebimentos, total, por_metodo = self.pos_session._get_recebimentos()
        self.assertEqual(recebimentos, [], 'O caixa não pode ver o pagamento do cadastro')
        self.assertAlmostEqual(total, 0.0, places=2)
        self.assertEqual(por_metodo, {})

    # ── Botão na aba ─────────────────────────────────────────────────────────
    def test_botao_registrar_pagamento_na_aba(self):
        """O botão existe DENTRO da aba 'Conta A Prazo' da ficha do funcionário
        (a mesma aba do grupo hr.group_hr_user)."""
        arch = self.env.ref('meu_modulo_fiscal.view_employee_form_prazo').arch
        arvore = etree.fromstring(arch)
        paginas = arvore.xpath("//page[@name='conta_prazo']")
        self.assertEqual(len(paginas), 1, 'A aba Conta A Prazo deveria existir')
        botoes = paginas[0].xpath(
            ".//button[@name='action_registrar_pagamento_prazo']"
        )
        self.assertEqual(len(botoes), 1, 'Falta o botão Registrar Pagamento na aba')

    def test_wizard_restrito_ao_grupo_da_aba(self):
        """A regra de acesso do wizard usa o mesmo grupo da aba (DEC-004)."""
        regra = self.env.ref(
            'meu_modulo_fiscal.access_x_prazo_pagamento_wizard'
        )
        self.assertEqual(regra.group_id, self.env.ref('hr.group_hr_user'))
