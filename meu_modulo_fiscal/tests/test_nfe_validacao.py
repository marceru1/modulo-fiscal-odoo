# -*- coding: utf-8 -*-
"""Validação local da nota com pendências por campo e item (ticket 08)."""

from odoo.exceptions import AccessError
from odoo.tests import TransactionCase

from .nfe_helper import NfeTransferMixin

GRUPO_RESPONSAVEL = 'meu_modulo_fiscal.group_nfe_responsavel_fiscal'
GRUPO_USUARIO = 'meu_modulo_fiscal.group_nfe_usuario'


class TestNfeValidacao(NfeTransferMixin, TransactionCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls._nfe_preparar_cenario()
        cls.usuario_nfe = cls.env['res.users'].create({
            'name': 'Usuário NF-e Validação',
            'login': 'nfe_usuario_validacao',
            'groups_id': [(6, 0, [cls.env.ref('base.group_user').id,
                                  cls.env.ref(GRUPO_USUARIO).id])],
            'company_id': cls.env.company.id,
            'company_ids': [(6, 0, [cls.env.company.id])],
        })
        cls.responsavel = cls.env['res.users'].create({
            'name': 'Responsável Validação',
            'login': 'nfe_responsavel_validacao',
            'groups_id': [(6, 0, [cls.env.ref('base.group_user').id,
                                  cls.env.ref(GRUPO_RESPONSAVEL).id])],
            'company_id': cls.env.company.id,
            'company_ids': [(6, 0, [cls.env.company.id])],
        })

    # ── Caminho feliz ────────────────────────────────────────────────────────
    def test_validar_nota_completa(self):
        nota = self._nfe_preparar_nota_valida()

        resultado = nota.nfe_validar()

        self.assertIs(resultado, True)
        self.assertEqual(nota.state, 'validada')
        self.assertFalse(nota.pendencias)

    def test_usuario_nfe_pode_validar(self):
        nota = self._nfe_preparar_nota_valida()

        nota.with_user(self.usuario_nfe).nfe_validar()

        self.assertEqual(nota.state, 'validada')

    # ── Pendências ───────────────────────────────────────────────────────────
    def test_pendencias_por_campo_e_por_item(self):
        self.env.company.write({'x_cnpj': False, 'x_ie': False})
        picking = self._criar_transferencia()
        nota = self.env['nfe.documento']._nfe_obter_ou_criar(picking)

        acao = nota.nfe_validar()

        self.assertEqual(nota.state, 'rascunho')
        self.assertEqual(acao['type'], 'ir.actions.act_window')
        pendencias = nota.pendencias
        self.assertIn("Configuração fiscal da empresa ausente", pendencias)
        self.assertIn("Emitente: CNPJ ausente", pendencias)
        self.assertIn("Destinatária: CNPJ ausente", pendencias)
        self.assertIn("NCM ausente", pendencias)
        self.assertIn("CFOP ausente", pendencias)
        self.assertIn(self.produto.display_name, pendencias)

    def test_pendencia_de_custo_e_quantidade(self):
        self._nfe_config_completa()
        self.produto.x_ncm_id = self.env['br.ncm'].search([], limit=1)
        self.env.company.write({'x_cnpj': '26343311800180', 'x_ie': '1'})
        # Sem custo cadastrado.
        self.produto.with_company(self.env.company).standard_price = 0.0
        nota = self.env['nfe.documento']._nfe_obter_ou_criar(self._criar_transferencia())

        nota.nfe_validar()

        self.assertIn("custo unitário ausente", nota.pendencias)

    def test_configuracao_nao_conferida_e_pendencia(self):
        nota = self._nfe_preparar_nota_valida()
        self.env['nfe.config'].search([('company_id', '=', self.env.company.id)]).write({
            'cfop': '5151',  # alterar tributário desmarca a conferência
        })

        nota.nfe_validar()

        self.assertEqual(nota.state, 'rascunho')
        self.assertIn("não conferida", nota.pendencias)

    def test_origem_que_deixou_de_ser_elegivel_nao_valida(self):
        nota = self._nfe_preparar_nota_valida()
        nota.picking_id.x_nfe_filial_id = False

        nota.nfe_validar()

        self.assertEqual(nota.state, 'rascunho')
        self.assertIn("Filial destinatária", nota.pendencias)

    # ── Volta para Rascunho ao corrigir ──────────────────────────────────────
    def test_editar_item_fiscal_de_nota_validada_volta_para_rascunho(self):
        nota = self._nfe_preparar_nota_valida()
        nota.nfe_validar()
        self.assertEqual(nota.state, 'validada')

        nota.linha_ids.with_user(self.responsavel).write({'cfop': '5151'})

        self.assertEqual(nota.state, 'rascunho')

    def test_editar_cabecalho_fiscal_de_nota_validada_volta_para_rascunho(self):
        nota = self._nfe_preparar_nota_valida()
        nota.nfe_validar()

        nota.with_user(self.responsavel).write({'emitente_numero': '768'})

        self.assertEqual(nota.state, 'rascunho')

    def test_usuario_nao_edita_fiscal_para_revalidar(self):
        nota = self._nfe_preparar_nota_valida()
        nota.nfe_validar()

        with self.assertRaises(AccessError):
            nota.linha_ids.with_user(self.usuario_nfe).write({'ncm': '0000.00.00'})

    # ── Efeitos colaterais e estados ─────────────────────────────────────────
    def test_validar_nao_altera_estoque_nem_financeiro(self):
        nota = self._nfe_preparar_nota_valida()
        picking = nota.picking_id
        quantidades = picking.move_ids.mapped('quantity')
        moves = self.env['stock.move'].search_count([])
        faturas = self.env['account.move'].search_count([])

        nota.nfe_validar()

        self.assertEqual(picking.move_ids.mapped('quantity'), quantidades)
        self.assertEqual(self.env['stock.move'].search_count([]), moves)
        self.assertEqual(self.env['account.move'].search_count([]), faturas)

    def test_estados_somente_rascunho_e_validada(self):
        estados = [chave for chave, _rotulo in self.env['nfe.documento']._fields['state'].selection]

        self.assertEqual(estados, ['rascunho', 'validada'])
