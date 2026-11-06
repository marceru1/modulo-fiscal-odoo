"""Seam de leitura do limite a prazo pelo PDV (spec: prazo-por-contato, DEC-G).

``res.partner.prazo_limite_credito`` é o ÚNICO ponto que o caixa usa para ler
``credit``/``credit_limit`` — campos restritos aos grupos de contabilidade do
core. O teste prova que o seam funciona para um usuário de caixa SEM esses
grupos, que ele devolve somente os dois números e que parceiro inexistente
devolve zeros (sem levantar).
"""

from odoo import fields
from odoo.exceptions import AccessError
from odoo.tests import TransactionCase


class TestPrazoLimitePdv(TransactionCase):
    def setUp(self):
        super().setUp()
        self.partner = self.env['res.partner'].create({'name': 'Cliente do Caixa'})
        # Limite e saldo exigem grupo de contabilidade (account.models.partner).
        self.partner.credit_limit = 200.0
        fatura = self.env['account.move'].create({
            'move_type': 'out_invoice',
            'partner_id': self.partner.id,
            'invoice_date': fields.Date.today(),
            'invoice_line_ids': [(0, 0, {
                'name': 'Compra a prazo',
                'quantity': 1.0,
                'price_unit': 100.0,
            })],
        })
        fatura.action_post()
        self.env.invalidate_all()

        self.caixa = self.env['res.users'].with_context(
            no_reset_password=True
        ).create({
            'name': 'Caixa Sem Contabilidade',
            'login': 'caixa_prazo_seam_teste',
            'groups_id': [(6, 0, [self.env.ref('base.group_user').id])],
        })

    def test_caixa_sem_contabilidade_le_pelo_seam(self):
        dados = self.env['res.partner'].with_user(
            self.caixa
        ).prazo_limite_credito(self.partner.id)

        self.assertEqual(set(dados), {'credit', 'credit_limit'},
                         'O seam não pode expor outros campos do contato')
        self.assertAlmostEqual(dados['credit'], 100.0, places=2)
        self.assertAlmostEqual(dados['credit_limit'], 200.0, places=2)

    def test_leitura_direta_pelo_caixa_falha(self):
        """Sem o seam (com sudo), o caixa não lê os campos — é o motivo do
        DEC-G existir."""
        with self.assertRaises(AccessError):
            self.env['res.partner'].with_user(self.caixa).browse(
                self.partner.id
            ).read(['credit', 'credit_limit'])

    def test_parceiro_inexistente_devolve_zeros(self):
        for partner_id in (99999999, False, None):
            dados = self.env['res.partner'].prazo_limite_credito(partner_id)
            self.assertEqual(
                dados, {'credit': 0.0, 'credit_limit': 0.0},
                'Parceiro inexistente/vazio não pode levantar (trata como sem limite)',
            )
