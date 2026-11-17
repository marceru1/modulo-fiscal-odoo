# -*- coding: utf-8 -*-
"""NF-e modelo 55: documento fiscal próprio, originado na transferência.

NUNCA ``account.move``: o crediário usa a fatura nativa e este fluxo é outro
documento (spec, decisão 3). O vínculo com a transferência é obrigatório e
único — um picking gera no máximo uma nota (DEC-004).

Idempotência: o clique repetido é resolvido por um ``unique(picking_id)`` no
banco, com ``savepoint`` + ``IntegrityError`` para o caso de dois usuários
criarem ao mesmo tempo (o segundo cai no registro do primeiro). Não há
``with_for_update`` porque o registro ainda não existe quando a corrida
começa — o lock não teria o que travar.

Dados do documento são SNAPSHOT: preenchidos na primeira preparação e não
recalculados ao reabrir (tickets 05 e 07 completam os valores).
"""

from psycopg2 import IntegrityError

from odoo import _, api, fields, models

NFE_STATE_SELECTION = [
    ('rascunho', 'Rascunho'),
    ('validada', 'Validada'),
]


class NfeDocumento(models.Model):
    _name = 'nfe.documento'
    _description = 'NF-e modelo 55 originada em transferência'
    _order = 'id desc'

    name = fields.Char(
        string="Referência",
        default=lambda self: self._nfe_proxima_referencia(),
        copy=False,
        readonly=True,
        index=True,
    )
    picking_id = fields.Many2one(
        'stock.picking',
        string="Transferência",
        required=True,
        ondelete='restrict',
        index=True,
        readonly=True,
    )
    # Emitente = empresa responsável pela movimentação (picking_type.company_id);
    # NUNCA a empresa ativa na interface nem o campo Empresa do picking.
    company_id = fields.Many2one(
        'res.company',
        string="Emitente",
        related='picking_id.company_id',
        store=True,
        readonly=True,
        index=True,
    )
    filial_id = fields.Many2one('res.company', string="Filial destinatária", readonly=True)
    state = fields.Selection(
        NFE_STATE_SELECTION,
        string="Situação",
        default='rascunho',
        required=True,
        readonly=True,
    )
    data_movimentacao = fields.Datetime(string="Data da movimentação", readonly=True)
    data_preparacao = fields.Datetime(
        string="Data de preparação",
        default=fields.Datetime.now,
        readonly=True,
    )
    linha_ids = fields.One2many(
        'nfe.documento.linha',
        'documento_id',
        string="Produtos",
        readonly=True,
    )

    _sql_constraints = [
        ('picking_uniq', 'unique(picking_id)',
         'Já existe uma NF-e para esta transferência.'),
    ]

    # ── Referência ───────────────────────────────────────────────────────────
    @api.model
    def _nfe_proxima_referencia(self):
        """Identidade estável do documento (futuro uso no middleware).

        Sequência de referência do Odoo; a numeração fiscal real será do
        middleware. Sem número fictício de NF-e aqui.
        """
        return self.env['ir.sequence'].next_by_code('nfe.documento') or _("NFE/Nova")

    # ── Criação idempotente ──────────────────────────────────────────────────
    @api.model
    def _nfe_obter_ou_criar(self, picking):
        """Retorna a nota da transferência, criando na primeira chamada."""
        documento = self.search([('picking_id', '=', picking.id)], limit=1)
        if documento:
            return documento
        try:
            with self.env.cr.savepoint():
                documento = self.create(self._nfe_vals_do_picking(picking))
        except IntegrityError:
            # Outro clique criou a nota entre o search e o insert: o
            # savepoint desfez o insert (nada duplicado) e o registro do
            # vencedor é reaproveitado.
            self.env.invalidate_all()
            documento = self.search([('picking_id', '=', picking.id)], limit=1)
            if not documento:
                raise
        # O picking pode ter o vínculo em cache (computed não armazenado).
        picking.invalidate_recordset(['x_nfe_documento_id', 'x_nfe_documento_state'])
        return documento

    @api.model
    def _nfe_vals_do_picking(self, picking):
        return {
            'picking_id': picking.id,
            'filial_id': picking.x_nfe_filial_id.id,
            'data_movimentacao': picking.date_done,
            'linha_ids': [
                (0, 0, self._nfe_linha_vals(move))
                for move in picking._nfe_moves_realizados()
            ],
        }

    @api.model
    def _nfe_linha_vals(self, move):
        """Item de origem: produto, unidade e quantidade REALIZADA.

        ``stock.move.quantity`` é a quantidade feita (soma das move lines),
        então uma transferência parcial de 8 entre 10 vale 8.
        """
        return {
            'move_id': move.id,
            'product_id': move.product_id.id,
            'uom_id': move.product_uom.id,
            'quantidade': move.quantity,
        }


class NfeDocumentoLinha(models.Model):
    _name = 'nfe.documento.linha'
    _description = 'Item da NF-e modelo 55'
    _order = 'documento_id, id'

    documento_id = fields.Many2one(
        'nfe.documento',
        string="NF-e",
        required=True,
        ondelete='cascade',
        index=True,
    )
    move_id = fields.Many2one(
        'stock.move',
        string="Movimento de origem",
        ondelete='restrict',
        readonly=True,
    )
    product_id = fields.Many2one('product.product', string="Produto", required=True, readonly=True)
    uom_id = fields.Many2one('uom.uom', string="Unidade", required=True, readonly=True)
    quantidade = fields.Float(
        string="Quantidade realizada",
        digits='Product Unit of Measure',
        readonly=True,
    )
