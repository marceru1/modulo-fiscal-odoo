# -*- coding: utf-8 -*-
"""Emitir: simulação com JSON, sem transmissão (ticket 09)."""

from unittest.mock import patch

from odoo.exceptions import UserError
from odoo.tests import TransactionCase

from .nfe_helper import NfeTransferMixin

TAG_SIMULACAO = 'meu_modulo_fiscal.nfe_simulacao'


class TestNfeEmissao(NfeTransferMixin, TransactionCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls._nfe_preparar_cenario()

    def _nota_validada(self, **kw):
        nota = self._nfe_preparar_nota_valida(**kw)
        nota.nfe_validar()
        self.assertEqual(nota.state, 'validada')
        return nota

    # ── Critério 8: JSON + estado ────────────────────────────────────────────
    def test_emitir_devolve_action_client_com_json(self):
        nota = self._nota_validada()

        acao = nota.nfe_emitir()

        self.assertEqual(acao['type'], 'ir.actions.client')
        self.assertEqual(acao['tag'], TAG_SIMULACAO)
        self.assertIn('json', acao['params'])
        self.assertEqual(nota.state, 'validada', "simulação não muda o estado")

    def test_emitir_em_rascunho_falha(self):
        picking = self._criar_transferencia()
        nota = self.env['nfe.documento']._nfe_obter_ou_criar(picking)

        with self.assertRaises(UserError):
            nota.nfe_emitir()

    def test_emitir_origem_inelegivel_falha_no_servidor(self):
        nota = self._nota_validada()
        nota.picking_id.x_nfe_filial_id = False

        with self.assertRaises(UserError):
            nota.nfe_emitir()

    # ── Sem transmissão ──────────────────────────────────────────────────────
    def test_simulacao_nao_faz_requisicao_http(self):
        nota = self._nota_validada()

        with patch('requests.post') as post, patch('requests.get') as get, \
                patch('requests.request') as request:
            nota.nfe_emitir()

        self.assertFalse(post.called, "não pode chamar o middleware/Focus")
        self.assertFalse(get.called)
        self.assertFalse(request.called)

    # ── Critério 5: repetir não recalcula ────────────────────────────────────
    def test_repetir_simulacao_mantem_valores_e_identificador(self):
        nota = self._nota_validada()

        primeiro = nota.nfe_emitir()['params']['json']
        segundo = nota.nfe_emitir()['params']['json']

        self.assertEqual(primeiro, segundo)
        self.assertEqual(primeiro['nota']['id'], nota.id)
        self.assertEqual(primeiro['nota']['referencia'], nota.name)
        self.assertEqual(nota.state, 'validada')

    # ── Conteúdo do JSON preliminar ──────────────────────────────────────────
    def test_json_tem_todos_os_blocos_da_spec(self):
        nota = self._nota_validada()
        nota.write({'informacoes_adicionais': 'Carga conferida'})

        carga = nota.nfe_emitir()['params']['json']

        for bloco in ('nota', 'origem', 'emitente', 'destinataria', 'ambiente',
                      'serie', 'operacao', 'itens', 'totais', 'transporte',
                      'pagamento', 'observacoes'):
            self.assertIn(bloco, carga, "bloco %s" % bloco)

        self.assertEqual(carga['origem']['transferencia'], nota.picking_id.name)
        self.assertEqual(carga['emitente']['cnpj'], nota.emitente_cnpj)
        self.assertEqual(carga['destinataria']['cnpj'], nota.destinataria_cnpj)
        self.assertEqual(carga['ambiente'], 'homologacao')
        self.assertEqual(carga['operacao']['natureza'], 'Transferência para filial')
        self.assertEqual(carga['pagamento']['forma'], 'sem_pagamento')
        self.assertEqual(carga['pagamento']['valor'], 0.0)
        self.assertEqual(carga['observacoes'], 'Carga conferida')

        item = carga['itens'][0]
        linha = nota.linha_ids
        self.assertEqual(item['produto_id'], linha.product_id.id)
        self.assertEqual(item['ncm'], linha.ncm)
        self.assertEqual(item['cfop'], '5152')
        self.assertEqual(item['quantidade'], linha.quantidade)
        self.assertEqual(item['custo_unitario'], linha.custo_unitario)
        self.assertEqual(item['total'], linha.total_linha)
        self.assertEqual(carga['totais']['total_produtos'], nota.total_produtos)

    # ── Critério 9: sem efeitos colaterais ───────────────────────────────────
    def test_emitir_nao_altera_estoque_nem_financeiro(self):
        nota = self._nota_validada()
        picking = nota.picking_id
        quantidades = picking.move_ids.mapped('quantity')
        moves = self.env['stock.move'].search_count([])
        faturas = self.env['account.move'].search_count([])

        nota.nfe_emitir()

        self.assertEqual(picking.move_ids.mapped('quantity'), quantidades)
        self.assertEqual(self.env['stock.move'].search_count([]), moves)
        self.assertEqual(self.env['account.move'].search_count([]), faturas)
