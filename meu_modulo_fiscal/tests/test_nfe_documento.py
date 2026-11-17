# -*- coding: utf-8 -*-
"""Nota preparada a partir da transferência (ticket 04)."""

from unittest.mock import patch

from odoo.exceptions import AccessError, UserError
from odoo.tests import TransactionCase

from .nfe_helper import NfeTransferMixin


class TestNfeDocumento(NfeTransferMixin, TransactionCase):
    """Seam: ``stock.picking.action_nfe_emitir`` (o método do botão).

    O teste chama o método direto — o mesmo caminho do servidor quando o
    botão é clicado —, então cobre a revalidação que independe da tela.
    """

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls._nfe_preparar_cenario()

    # ── Criação ──────────────────────────────────────────────────────────────
    def test_botao_cria_nota_com_cabecalho_e_itens(self):
        picking = self._criar_transferencia()

        acao = picking.action_nfe_emitir()
        nota = self.env['nfe.documento'].browse(acao['res_id'])

        self.assertEqual(acao['res_model'], 'nfe.documento')
        self.assertEqual(nota.picking_id, picking)
        self.assertEqual(nota.company_id, picking.company_id)
        self.assertEqual(nota.filial_id, self.filial)
        self.assertEqual(nota.state, 'rascunho')
        self.assertEqual(nota.data_movimentacao, picking.date_done)
        self.assertTrue(nota.data_preparacao)
        self.assertTrue(nota.name.startswith('NFE/'))

        self.assertEqual(len(nota.linha_ids), 1)
        linha = nota.linha_ids
        self.assertEqual(linha.product_id, self.produto)
        self.assertEqual(linha.uom_id, self.produto.uom_id)
        self.assertEqual(linha.quantidade, 10.0)
        self.assertEqual(linha.move_id, picking.move_ids)

    def test_emitente_e_a_empresa_da_movimentacao(self):
        """Outra empresa ativa na interface não muda o emitente."""
        picking = self._criar_transferencia()

        acao = self.env['stock.picking'].with_company(self.filial).browse(
            picking.id
        ).action_nfe_emitir()
        nota = self.env['nfe.documento'].browse(acao['res_id'])

        self.assertEqual(nota.company_id, picking.company_id)
        self.assertNotEqual(nota.company_id, self.filial)

    def test_segundo_clique_abre_a_mesma_nota(self):
        picking = self._criar_transferencia()

        primeira = picking.action_nfe_emitir()['res_id']
        segunda = picking.action_nfe_emitir()['res_id']

        self.assertEqual(primeira, segunda)
        self.assertEqual(
            self.env['nfe.documento'].search_count([('picking_id', '=', picking.id)]), 1
        )

    def test_corrida_na_criacao_reaproveita_a_nota(self):
        """Outro usuário criou entre o search e o insert: mesma nota."""
        picking = self._criar_transferencia()
        nota = self.env['nfe.documento']._nfe_obter_ou_criar(picking)

        Documento = self.env['nfe.documento']
        busca_original = type(Documento).search
        chamadas = {'n': 0}

        def busca_que_perde_a_corrida(modelo, dominio, *args, **kwargs):
            chamadas['n'] += 1
            if chamadas['n'] == 1:
                return modelo.browse()  # finge que ainda não existe
            return busca_original(modelo, dominio, *args, **kwargs)

        with patch.object(
            type(Documento), 'search', autospec=True,
            side_effect=busca_que_perde_a_corrida,
        ):
            nota_repetida = Documento._nfe_obter_ou_criar(picking)

        self.assertEqual(nota_repetida, nota)
        self.assertEqual(
            Documento.search_count([('picking_id', '=', picking.id)]), 1
        )

    # ── Origem inválida ──────────────────────────────────────────────────────
    def test_nao_elegivel_nao_cria_nota(self):
        picking = self._criar_transferencia(validar=False)

        with self.assertRaises(UserError):
            picking.action_nfe_emitir()

        self.assertEqual(
            self.env['nfe.documento'].search_count([('picking_id', '=', picking.id)]), 0
        )

    # ── Parcial ──────────────────────────────────────────────────────────────
    def test_parcial_gera_nota_proporcional_e_resto_em_outra_nota(self):
        picking = self._criar_transferencia(quantidade=10.0, realizada=8.0)

        nota = self.env['nfe.documento']._nfe_obter_ou_criar(picking)
        self.assertEqual(nota.linha_ids.quantidade, 8.0)

        backorder = self.env['stock.picking'].search([('backorder_id', '=', picking.id)])
        self.assertTrue(backorder, "a parte pendente vira backorder")
        self.assertEqual(backorder.x_nfe_filial_id, self.filial)
        self.assertEqual(
            self.env['nfe.documento'].search_count([('picking_id', '=', backorder.id)]),
            0,
            "transferência pendente ainda não tem nota",
        )

        self._concluir_transferencia(backorder)
        nota_do_resto = self.env['nfe.documento']._nfe_obter_ou_criar(backorder)

        self.assertNotEqual(nota_do_resto, nota)
        self.assertEqual(nota_do_resto.linha_ids.quantidade, 2.0)

    # ── Efeitos colaterais ───────────────────────────────────────────────────
    def test_preparar_nao_altera_estoque_nem_financeiro(self):
        picking = self._criar_transferencia(quantidade=10.0, realizada=8.0)
        quantidades = picking.move_ids.mapped('quantity')
        moves = self.env['stock.move'].search_count([])
        linhas = self.env['stock.move.line'].search_count([])
        faturas = self.env['account.move'].search_count([])

        self.env['nfe.documento']._nfe_obter_ou_criar(picking)

        self.assertEqual(picking.move_ids.mapped('quantity'), quantidades)
        self.assertEqual(self.env['stock.move'].search_count([]), moves)
        self.assertEqual(self.env['stock.move.line'].search_count([]), linhas)
        self.assertEqual(self.env['account.move'].search_count([]), faturas)

    # ── Acesso ───────────────────────────────────────────────────────────────
    def test_usuario_sem_grupo_nfe_nao_prepara(self):
        picking = self._criar_transferencia()
        usuario_estoque = self.env['res.users'].create({
            'name': 'Usuário Só Estoque',
            'login': 'nfe_sem_grupo',
            'groups_id': [(6, 0, [self.env.ref('base.group_user').id,
                                  self.env.ref('stock.group_stock_user').id])],
            'company_id': self.env.company.id,
            'company_ids': [(6, 0, [self.env.company.id])],
        })

        with self.assertRaises(AccessError):
            picking.with_user(usuario_estoque).action_nfe_emitir()

        self.assertEqual(
            self.env['nfe.documento'].search_count([('picking_id', '=', picking.id)]), 0
        )
