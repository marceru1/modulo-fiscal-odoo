# -*- coding: utf-8 -*-
"""Configuração tributária da transferência e marca de conferida (ticket 03)."""

from odoo.exceptions import AccessError, ValidationError
from odoo.tests import TransactionCase


class TestNfeConfigTributaria(TransactionCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.grupo_responsavel = cls.env.ref('meu_modulo_fiscal.group_nfe_responsavel_fiscal')
        cls.grupo_usuario = cls.env.ref('meu_modulo_fiscal.group_nfe_usuario')
        cls.usuario_nfe = cls.env['res.users'].create({
            'name': 'Usuário NF-e Tributário',
            'login': 'nfe_usuario_tributario',
            'groups_id': [(6, 0, [cls.env.ref('base.group_user').id, cls.grupo_usuario.id])],
            'company_id': cls.env.company.id,
            'company_ids': [(6, 0, [cls.env.company.id])],
        })
        cls.responsavel = cls.env['res.users'].create({
            'name': 'Responsável Fiscal Tributário',
            'login': 'nfe_responsavel_tributario',
            'groups_id': [(6, 0, [cls.env.ref('base.group_user').id, cls.grupo_responsavel.id])],
            'company_id': cls.env.company.id,
            'company_ids': [(6, 0, [cls.env.company.id])],
        })

    def _config(self, **vals):
        return self.env['nfe.config'].create({
            'company_id': self.env.company.id,
            **vals,
        })

    # ── Estado inicial ───────────────────────────────────────────────────────
    def test_nasce_nao_conferida_com_referencias(self):
        config = self._config()

        self.assertFalse(config.conferida)
        self.assertEqual(config.cfop_mesma_uf, '5152')
        self.assertEqual(config.icms_cst_csosn, '102')
        self.assertEqual(config.pis_cst, '07')
        self.assertEqual(config.cofins_cst, '07')

    # ── Conferência ──────────────────────────────────────────────────────────
    def test_editar_campo_tributario_desmarca_conferida(self):
        config = self._config()
        config.conferida = True

        config.write({'cfop_mesma_uf': '5151'})

        self.assertFalse(config.conferida)

    def test_editar_qualquer_campo_tributario_desmarca(self):
        config = self._config()
        for campo, valor in (
            ('natureza_operacao', 'Remessa'),
            ('finalidade', '3'),
            ('cfop_outra_uf', '6152'),
            ('icms_cst_csosn', '00'),
            ('origem', '1'),
            ('pis_cst', '01'),
            ('cofins_cst', '49'),
        ):
            config.conferida = True

            config.write({campo: valor})

            self.assertFalse(config.conferida, "Alterar %s deve desmarcar a conferência" % campo)

    def test_editar_campo_nao_tributario_mantem_conferida(self):
        config = self._config()
        config.conferida = True

        config.write({'logradouro': 'Rua Nova', 'serie': 6})

        self.assertTrue(config.conferida)

    def test_marcar_conferida_no_mesmo_write_dos_campos_vale(self):
        """O form ajusta o campo e marca "Conferida" antes de salvar."""
        config = self._config()

        config.write({'cfop_mesma_uf': '5151', 'conferida': True})

        self.assertTrue(config.conferida)

    # ── CFOP por destino ─────────────────────────────────────────────────────
    def test_cfop_por_destino_independente(self):
        config = self._config()

        config.write({'cfop_mesma_uf': '5152', 'cfop_outra_uf': '6152'})

        self.assertEqual(config.cfop_mesma_uf, '5152')
        self.assertEqual(config.cfop_outra_uf, '6152')

    def test_cfop_invalido_e_rejeitado(self):
        config = self._config()

        for invalido in ('515', '51520', '51A2'):
            with self.assertRaises(ValidationError):
                config.write({'cfop_mesma_uf': invalido})

    # ── Acesso ───────────────────────────────────────────────────────────────
    def test_usuario_nfe_nao_altera_operacao(self):
        config = self._config()

        with self.assertRaises(AccessError):
            config.with_user(self.usuario_nfe).write({'cfop_mesma_uf': '5151'})
        with self.assertRaises(AccessError):
            config.with_user(self.usuario_nfe).write({'conferida': True})

    def test_responsavel_marca_e_grava_operacao(self):
        config = self._config()

        config.with_user(self.responsavel).write({
            'natureza_operacao': 'Transferência para filial',
            'cfop_outra_uf': '6152',
            'conferida': True,
        })

        self.assertTrue(config.conferida)
        self.assertEqual(config.natureza_operacao, 'Transferência para filial')

    # ── CFOP comercial do produto não é sobrescrito ──────────────────────────
    def test_configuracao_nao_toca_o_cfop_do_produto(self):
        produto = self.env['product.product'].create({
            'name': 'Produto CFOP Comercial',
            'is_storable': True,
            'x_cfop': '5102',
        })

        config = self._config(cfop_mesma_uf='5152')
        config.conferida = True

        self.assertEqual(config.cfop_mesma_uf, '5152')
        self.assertEqual(produto.x_cfop, '5102')
