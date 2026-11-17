# -*- coding: utf-8 -*-
"""Snapshot fiscal e endereços copiados na nota (ticket 07)."""

from odoo.exceptions import AccessError
from odoo.tests import TransactionCase

from .nfe_helper import NfeTransferMixin


class TestNfeDadosFiscais(NfeTransferMixin, TransactionCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls._nfe_preparar_cenario()
        cls.grupo_responsavel = cls.env.ref('meu_modulo_fiscal.group_nfe_responsavel_fiscal')
        cls.grupo_usuario = cls.env.ref('meu_modulo_fiscal.group_nfe_usuario')
        cls.usuario_nfe = cls.env['res.users'].create({
            'name': 'Usuário NF-e Fiscal',
            'login': 'nfe_usuario_fiscal',
            'groups_id': [(6, 0, [cls.env.ref('base.group_user').id, cls.grupo_usuario.id])],
            'company_id': cls.env.company.id,
            'company_ids': [(6, 0, [cls.env.company.id])],
        })
        cls.responsavel = cls.env['res.users'].create({
            'name': 'Responsável Fiscal NF-e',
            'login': 'nfe_responsavel_fiscal_dados',
            'groups_id': [(6, 0, [cls.env.ref('base.group_user').id, cls.grupo_responsavel.id])],
            'company_id': cls.env.company.id,
            'company_ids': [(6, 0, [cls.env.company.id])],
        })

    def _config(self, empresa=None, **vals):
        return self.env['nfe.config'].create({
            'company_id': (empresa or self.env.company).id,
            **vals,
        })

    def _config_completa(self, empresa=None):
        return self._config(
            empresa,
            crt='1',
            ibge_municipio='1302702',
            ambiente='homologacao',
            serie=5,
            logradouro='Av. 7 de Setembro',
            numero='767',
            bairro='Centro',
            complemento='Sala 2',
            municipio='Itacoatiara',
            uf='13',
            cep='69100000',
            natureza_operacao='Transferência para filial',
            cfop='5152',
            icms_cst_csosn='102',
            origem='0',
            pis_cst='07',
            cofins_cst='07',
        )

    def _nota(self, picking):
        return self.env['nfe.documento']._nfe_obter_ou_criar(picking)

    # ── Snapshot do emitente e dos itens ─────────────────────────────────────
    def test_snapshot_do_emitente_e_dos_itens(self):
        self.env.company.write({'x_cnpj': '26343314000180', 'x_ie': '053917464'})
        config = self._config_completa()
        ncm = self.env['br.ncm'].search([], limit=1)
        self.produto.x_ncm_id = ncm
        self.produto.x_cfop = '5102'
        picking = self._criar_transferencia()

        nota = self._nota(picking)
        linha = nota.linha_ids

        # Cabeçalho: tudo da configuração da empresa emitente.
        self.assertEqual(nota.emitente_cnpj, self.env.company.x_cnpj)
        self.assertEqual(nota.emitente_ie, self.env.company.x_ie)
        self.assertEqual(nota.emitente_crt, config.crt)
        self.assertEqual(nota.emitente_ibge_municipio, '1302702')
        self.assertEqual(nota.emitente_logradouro, 'Av. 7 de Setembro')
        self.assertEqual(nota.emitente_numero, '767')
        self.assertEqual(nota.emitente_bairro, 'Centro')
        self.assertEqual(nota.emitente_complemento, 'Sala 2')
        self.assertEqual(nota.emitente_municipio, 'Itacoatiara')
        self.assertEqual(nota.emitente_uf, '13')
        self.assertEqual(nota.emitente_cep, '69100000')
        self.assertEqual(nota.ambiente, 'homologacao')
        self.assertEqual(nota.serie, 5)

        # Item: descrição, NCM, CFOP e tributação da operação.
        self.assertTrue(linha.descricao)
        self.assertEqual(linha.ncm, ncm.code)
        self.assertEqual(linha.cfop, '5152')
        self.assertEqual(linha.origem, '0')
        self.assertEqual(linha.icms_cst_csosn, '102')
        self.assertEqual(linha.pis_cst, '07')
        self.assertEqual(linha.cofins_cst, '07')
        # CFOP comercial do produto não é sobrescrito.
        self.assertEqual(self.produto.x_cfop, '5102')

    def test_snapshot_da_destinataria(self):
        self.filial.write({'x_cnpj': '11222333000144', 'x_ie': '999888777'})
        self._config_completa()
        self._config_completa(self.filial)  # configuração da filial
        picking = self._criar_transferencia()

        nota = self._nota(picking)

        self.assertEqual(nota.destinataria_cnpj, self.filial.x_cnpj)
        self.assertEqual(nota.destinataria_crt, '1')
        self.assertEqual(nota.destinataria_ibge_municipio, '1302702')
        self.assertEqual(nota.destinataria_logradouro, 'Av. 7 de Setembro')
        self.assertEqual(nota.destinataria_numero, '767')
        self.assertEqual(nota.destinataria_municipio, 'Itacoatiara')
        self.assertEqual(nota.destinataria_uf, '13')

    # ── Critério 5: snapshot não é recalculado ───────────────────────────────
    def test_mudanca_no_cadastro_e_na_config_nao_atualiza_a_nota(self):
        config = self._config_completa()
        ncm = self.env['br.ncm'].search([], limit=1)
        self.produto.x_ncm_id = ncm
        picking = self._criar_transferencia()
        nota = self._nota(picking)

        config.write({'cfop': '5151', 'logradouro': 'Rua Nova'})
        outro_ncm = self.env['br.ncm'].search([('id', '!=', ncm.id)], limit=1)
        self.produto.write({'x_ncm_id': outro_ncm.id, 'name': 'Nome novo do produto'})
        # Reabre/reprepara.
        self.assertEqual(picking.action_nfe_emitir()['res_id'], nota.id)

        self.assertEqual(nota.linha_ids.cfop, '5152')
        self.assertEqual(nota.emitente_logradouro, 'Av. 7 de Setembro')
        self.assertEqual(nota.linha_ids.ncm, ncm.code)

    # ── Pagamento e transporte padrão ────────────────────────────────────────
    def test_pagamento_padrao_sem_pagamento_e_transporte_simples(self):
        self._config_completa()
        nota = self._nota(self._criar_transferencia())

        self.assertEqual(nota.forma_pagamento, 'sem_pagamento')
        self.assertEqual(nota.valor_pagamento, 0.0)
        self.assertEqual(nota.modalidade_frete, '9')

    # ── Acesso ao snapshot ───────────────────────────────────────────────────
    def test_usuario_le_o_snapshot_sem_acesso_a_config_da_filial(self):
        self.filial.write({'x_cnpj': '11222333000144'})
        self._config_completa()
        config_filial = self._config_completa(self.filial)
        nota = self._nota(self._criar_transferencia())

        self.assertEqual(
            nota.with_user(self.usuario_nfe).read(['destinataria_cnpj'])[0]['destinataria_cnpj'],
            self.filial.x_cnpj,
        )
        with self.assertRaises(AccessError):
            config_filial.with_user(self.usuario_nfe).read(['logradouro'])

    def test_ajuste_fiscal_por_item_so_responsavel(self):
        self._config_completa()
        nota = self._nota(self._criar_transferencia())
        linha = nota.linha_ids

        with self.assertRaises(AccessError):
            linha.with_user(self.usuario_nfe).write({'cfop': '5151'})
        with self.assertRaises(AccessError):
            nota.with_user(self.usuario_nfe).write({'emitente_logradouro': 'Rua Nova'})

        linha.with_user(self.responsavel).write({'cfop': '5151'})
        nota.with_user(self.responsavel).write({'emitente_logradouro': 'Rua Nova'})

        self.assertEqual(linha.cfop, '5151')
        self.assertEqual(nota.emitente_logradouro, 'Rua Nova')

    def test_sem_configuracao_a_nota_e_criada_com_campos_vazios(self):
        """Faltar config não impede preparar; a pendência é da validação."""
        nota = self._nota(self._criar_transferencia())

        self.assertFalse(nota.emitente_crt)
        self.assertFalse(nota.linha_ids.cfop)
        self.assertEqual(nota.state, 'rascunho')
