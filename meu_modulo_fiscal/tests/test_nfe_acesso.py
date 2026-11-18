# -*- coding: utf-8 -*-
"""Lista, filtros e acesso por empresa da NF-e (ticket 06)."""

from odoo.exceptions import AccessError
from odoo.tests import TransactionCase

from .nfe_helper import NfeTransferMixin


class TestNfeAcesso(NfeTransferMixin, TransactionCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls._nfe_preparar_cenario()

        # Segunda empresa EMITENTE, com armazém próprio (o fluxo de estoque
        # da filial não é tocado: aqui só nasce uma nota de outra empresa).
        cls.empresa_b = cls.env['res.company'].create({'name': 'Empresa B acesso NF-e'})
        cls.armazem_b = cls.env['stock.warehouse'].create({
            'name': 'Armazém B', 'code': 'ARB', 'company_id': cls.empresa_b.id,
        })
        # Locais do armazém B na própria empresa B (sem isso o picking herda
        # o local padrão da empresa ativa e o check_company do move recusa).
        cls.armazem_b.int_type_id.write({
            'default_location_src_id': cls.armazem_b.lot_stock_id.id,
            'default_location_dest_id': cls.armazem_b.lot_stock_id.id,
        })

        cls.grupo_usuario = cls.env.ref('meu_modulo_fiscal.group_nfe_usuario')
        cls.usuario_nfe = cls.env['res.users'].create({
            'name': 'Usuário NF-e Acesso',
            'login': 'nfe_usuario_acesso',
            'groups_id': [(6, 0, [cls.env.ref('base.group_user').id, cls.grupo_usuario.id])],
            'company_id': cls.env.company.id,
            'company_ids': [(6, 0, [cls.env.company.id])],
        })

        cls.nota_a = cls.env['nfe.documento']._nfe_obter_ou_criar(
            cls._criar_transferencia(quantidade=3.0)
        )
        cls.nota_b = cls.env['nfe.documento']._nfe_obter_ou_criar(
            cls._criar_transferencia(
                tipo=cls.armazem_b.int_type_id, filial=cls.filial, quantidade=4.0,
            )
        )

    # ── Critério 10: empresa ─────────────────────────────────────────────────
    def test_usuario_ve_so_notas_das_empresas_permitidas(self):
        self.assertEqual(self.nota_a.company_id, self.env.company)
        self.assertEqual(self.nota_b.company_id, self.empresa_b)

        visiveis = self.env['nfe.documento'].with_user(self.usuario_nfe).search([])

        self.assertIn(self.nota_a, visiveis)
        self.assertNotIn(self.nota_b, visiveis)

    def test_usuario_nao_le_nota_de_outra_empresa(self):
        with self.assertRaises(AccessError):
            self.nota_b.with_user(self.usuario_nfe).read(['name'])

    def test_itens_seguem_a_empresa_da_nota(self):
        linhas = self.env['nfe.documento.linha'].with_user(self.usuario_nfe).search([])

        self.assertTrue(linhas <= self.nota_a.linha_ids)
        with self.assertRaises(AccessError):
            self.nota_b.linha_ids.with_user(self.usuario_nfe).read(['quantidade'])

    # ── Menu ─────────────────────────────────────────────────────────────────
    def test_menu_nfe_visivel_sem_acesso_a_faturas(self):
        menus = self.env['ir.ui.menu'].with_user(self.usuario_nfe)._visible_menu_ids()

        self.assertIn(self.env.ref('meu_modulo_fiscal.menu_nfe_root').id, menus)
        self.assertIn(self.env.ref('meu_modulo_fiscal.menu_nfe_notas').id, menus)
        # O menu pai Faturamento aparece só para pendurar o NF-e...
        self.assertIn(self.env.ref('account.menu_finance').id, menus)
        # ...sem abrir as faturas do crediário (ACL de account.move intacta).
        self.assertNotIn(
            self.env.ref('account.menu_action_move_out_invoice_type').id, menus
        )
        with self.assertRaises(AccessError):
            self.env['account.move'].with_user(self.usuario_nfe).search([])

    def test_configuracao_nao_aparece_para_o_usuario(self):
        menus = self.env['ir.ui.menu'].with_user(self.usuario_nfe)._visible_menu_ids()

        self.assertNotIn(self.env.ref('meu_modulo_fiscal.menu_nfe_config').id, menus)

    # ── Lista e filtros ──────────────────────────────────────────────────────
    def test_lista_sem_criacao_avulsa(self):
        """Odoo 18 não tem mais ``create`` na action: a trava é no view."""
        acao = self.env.ref('meu_modulo_fiscal.action_nfe_documento')
        arch_lista = self.env.ref('meu_modulo_fiscal.view_nfe_documento_list').arch

        self.assertEqual(acao.res_model, 'nfe.documento')
        self.assertIn('create="false"', arch_lista)
        self.assertNotIn('menu_nfe_new', arch_lista)

    def test_lista_e_busca_tem_colunas_e_filtros_da_spec(self):
        arch_lista = self.env.ref('meu_modulo_fiscal.view_nfe_documento_list').arch
        for campo in ('name', 'picking_id', 'data_movimentacao', 'company_id',
                      'filial_id', 'total_produtos', 'state'):
            self.assertIn('name="%s"' % campo, arch_lista, "coluna %s" % campo)

        arch_busca = self.env.ref('meu_modulo_fiscal.view_nfe_documento_search').arch
        self.assertIn('name="periodo"', arch_busca)
        self.assertIn("picking_id.name', 'ilike'", arch_busca)
        for filtro in ('situacao_rascunho', 'situacao_validada',
                       'agrupar_empresa', 'agrupar_filial'):
            self.assertIn('name="%s"' % filtro, arch_busca, "filtro %s" % filtro)

    def test_reabrir_pela_lista_abre_a_mesma_nota(self):
        nota = self.env['nfe.documento'].with_user(self.usuario_nfe).search(
            [('id', '=', self.nota_a.id)]
        )

        self.assertEqual(nota, self.nota_a)
        self.assertEqual(nota.picking_id.x_nfe_documento_id, self.nota_a)
