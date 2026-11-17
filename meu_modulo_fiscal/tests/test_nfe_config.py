# -*- coding: utf-8 -*-
"""Grupos e configuração fiscal da NF-e por empresa (ticket 02)."""

from odoo.exceptions import AccessError, ValidationError
from odoo.tests import TransactionCase
from psycopg2 import IntegrityError


class TestNfeConfig(TransactionCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.empresa_a = cls.env.company
        cls.empresa_b = cls.env['res.company'].create({'name': 'Empresa B NF-e'})
        cls.grupo_usuario = cls.env.ref('meu_modulo_fiscal.group_nfe_usuario')
        cls.grupo_responsavel = cls.env.ref('meu_modulo_fiscal.group_nfe_responsavel_fiscal')

        cls.usuario_nfe = cls.env['res.users'].create({
            'name': 'Usuário NF-e',
            'login': 'nfe_usuario_teste',
            'groups_id': [(6, 0, [cls.env.ref('base.group_user').id, cls.grupo_usuario.id])],
            'company_id': cls.empresa_a.id,
            'company_ids': [(6, 0, [cls.empresa_a.id])],
        })
        cls.responsavel = cls.env['res.users'].create({
            'name': 'Responsável Fiscal NF-e',
            'login': 'nfe_responsavel_teste',
            'groups_id': [(6, 0, [cls.env.ref('base.group_user').id, cls.grupo_responsavel.id])],
            'company_id': cls.empresa_a.id,
            'company_ids': [(6, 0, [cls.empresa_a.id, cls.empresa_b.id])],
        })

    def _criar_config(self, empresa=None, **vals):
        return self.env['nfe.config'].create({
            'company_id': (empresa or self.empresa_a).id,
            **vals,
        })

    # ── Ambiente e independência da NFC-e ────────────────────────────────────
    def test_ambiente_padrao_homologacao(self):
        config = self._criar_config()

        self.assertEqual(config.ambiente, 'homologacao')

    def test_ambiente_nao_usa_o_da_nfce(self):
        """O ambiente da NFC-e (produção) não define o da NF-e."""
        self.empresa_a.x_ambiente_fiscal = 'producao'
        csc_id_antes = self.empresa_a.x_csc_id

        config = self._criar_config()

        self.assertEqual(config.ambiente, 'homologacao')
        self.assertEqual(self.empresa_a.x_ambiente_fiscal, 'producao')
        self.assertEqual(self.empresa_a.x_csc_id, csc_id_antes)

    # ── Reuso de CNPJ/IE + campos estruturados ───────────────────────────────
    def test_cnpj_e_ie_vem_do_cadastro_da_empresa(self):
        self.empresa_a.x_cnpj = '26343314000180'
        self.empresa_a.x_ie = '053917464'

        config = self._criar_config()

        self.assertEqual(config.cnpj, '26343314000180')
        self.assertEqual(config.ie, '053917464')

    def test_endereco_estruturado_e_campos_fiscais_gravam(self):
        config = self._criar_config(
            crt='1',
            ibge_municipio='1302702',
            serie=6,
            logradouro='Av. 7 de Setembro',
            numero='767',
            bairro='Centro',
            complemento='Sala 2',
            municipio='Itacoatiara',
            uf='13',
            cep='69100000',
        )

        self.assertEqual(config.crt, '1')
        self.assertEqual(config.ibge_municipio, '1302702')
        self.assertEqual(config.serie, 6)
        self.assertEqual(config.numero, '767')
        self.assertEqual(config.uf, '13')

    def test_uf_sugerida_do_cadastro_sem_parse(self):
        self.empresa_a.x_uf_codigo = '13'
        config = self.env['nfe.config'].new({'company_id': self.empresa_a.id})

        config._onchange_company_id_uf()

        self.assertEqual(config.uf, '13')
        self.assertFalse(config.logradouro, "Não deve inventar logradouro a partir do texto livre")

    def test_ibge_so_digitos(self):
        with self.assertRaises(ValidationError):
            self._criar_config(ibge_municipio='13A2702')

    def test_config_unica_por_empresa(self):
        self._criar_config()

        # Constraint é SQL (robusta a cliques simultâneos). Na RPC o Odoo
        # converte a violação em ValidationError (odoo/service/model.py:131);
        # no ORM direto do teste ela chega como IntegrityError.
        with self.assertRaises(IntegrityError), self.cr.savepoint():
            self._criar_config()

    # ── Acesso ───────────────────────────────────────────────────────────────
    def test_responsavel_implica_usuario(self):
        self.assertTrue(
            self.responsavel.has_group('meu_modulo_fiscal.group_nfe_usuario'),
            "Responsável fiscal deve herdar as ações do Usuário NF-e",
        )

    def test_usuario_nfe_nao_acessa_configuracao(self):
        config = self._criar_config()

        with self.assertRaises(AccessError):
            self.env['nfe.config'].with_user(self.usuario_nfe).search([])
        with self.assertRaises(AccessError):
            config.with_user(self.usuario_nfe).read(['crt'])
        with self.assertRaises(AccessError):
            self.env['nfe.config'].with_user(self.usuario_nfe).create({
                'company_id': self.empresa_a.id,
            })

    def test_responsavel_le_e_grava_configuracao(self):
        config = self._criar_config()

        lido = config.with_user(self.responsavel).read(['crt', 'ambiente'])
        self.assertEqual(lido[0]['ambiente'], 'homologacao')
        config.with_user(self.responsavel).write({'serie': 7})
        self.assertEqual(config.serie, 7)

    def test_responsavel_so_ve_configuracao_das_empresas_permitidas(self):
        config_a = self._criar_config(self.empresa_a)
        config_b = self._criar_config(self.empresa_b, crt='3')

        visiveis = self.env['nfe.config'].with_user(self.responsavel).search([])
        self.assertIn(config_a, visiveis)
        self.assertIn(config_b, visiveis)

        # Restringindo as empresas permitidas, a configuração da B desaparece.
        self.responsavel.company_ids = [(6, 0, [self.empresa_a.id])]
        visiveis = self.env['nfe.config'].with_user(self.responsavel).search([])
        self.assertIn(config_a, visiveis)
        self.assertNotIn(config_b, visiveis)
        with self.assertRaises(AccessError):
            config_b.with_user(self.responsavel).read(['crt'])

    def test_menu_configuracao_so_para_responsavel(self):
        menu = self.env.ref('meu_modulo_fiscal.menu_nfe_config')
        self.assertIn(self.grupo_responsavel, menu.groups_id)
