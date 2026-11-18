# -*- coding: utf-8 -*-
"""Origem da NF-e modelo 55: transferência de estoque concluída (DEC-001/006/007).

Este arquivo é a única extensão de ``stock.picking`` do módulo. Ele NÃO altera
locais, rotas, armazéns, regras de movimentação nem a validação nativa: apenas
acrescenta a filial destinatária e a checagem de elegibilidade lida do estado
atual do picking.

Fonte (Odoo 18, ``addons/stock/models/stock_picking.py``):
  - ``state``                            → :566
  - ``return_id`` (devolução)            → :557
  - ``picking_type_code`` (related)      → :623
  - ``date_done``                        → :602
  - ``company_id`` é related de
    ``picking_type_id.company_id``       → :632 (é o EMITENTE, nunca a filial)
  - ``stock.move.quantity`` (realizada,
    soma das move lines)                 → stock_move.py:170
  - ``stock.move.state``                 → stock_move.py:109
"""

from odoo import _, fields, models
from odoo.exceptions import UserError

# DEC-006: na instalação (banco grupo20mais, 17/11/2026) o envio para a filial
# é o tipo de operação `internal` — "Transferências internas", sequências INT
# (ids 7 e 16). Recebimentos (`incoming`), entregas (`outgoing`) e o PDV
# (`outgoing` POS) não são origens desta NF-e. Ponto único de mudança caso a
# instalação adote outro código técnico no futuro.
NFE_TIPO_OPERACAO_ENVIO_FILIAL = 'internal'


class StockPicking(models.Model):
    _inherit = 'stock.picking'

    x_nfe_filial_id = fields.Many2one(
        'res.company',
        string="Filial destinatária",
        index='btree_not_null',
        help="Empresa filial que recebe esta transferência. Necessária para "
             "preparar a NF-e modelo 55; não altera locais, rotas nem a "
             "empresa emitente da movimentação.",
    )
    # Vínculo de leitura com a nota (uma por picking — DEC-004). Computed não
    # armazenado: a fonte da verdade é o unique em nfe.documento.picking_id.
    x_nfe_documento_id = fields.Many2one(
        'nfe.documento',
        string="NF-e",
        compute='_compute_x_nfe_documento',
    )
    x_nfe_documento_state = fields.Selection(
        [('rascunho', 'Rascunho'), ('validada', 'Validada')],
        string="Situação da NF-e",
        compute='_compute_x_nfe_documento',
    )

    def _compute_x_nfe_documento(self):
        documentos = self.env['nfe.documento'].search([('picking_id', 'in', self.ids)])
        por_picking = {documento.picking_id.id: documento for documento in documentos}
        for picking in self:
            documento = por_picking.get(picking.id)
            picking.x_nfe_documento_id = documento
            picking.x_nfe_documento_state = documento.state if documento else False

    # ── Elegibilidade ────────────────────────────────────────────────────────
    def _nfe_motivos_inelegibilidade(self):
        """Lista de motivos (texto) que impedem a preparação fiscal.

        Lista vazia = picking elegível. É a única fonte da regra: tanto a
        visibilidade do botão quanto os métodos chamados pelo servidor
        (preparar, validar, simular) usam esta checagem.
        """
        self.ensure_one()
        motivos = []
        if self.state != 'done':
            motivos.append(_("A transferência ainda não foi concluída (estado: %s).", self.state))
        if self.picking_type_id.code != NFE_TIPO_OPERACAO_ENVIO_FILIAL:
            motivos.append(
                _("A operação '%s' não é um envio para filial.", self.picking_type_id.display_name)
            )
        if not self.x_nfe_filial_id:
            motivos.append(_("Informe a Filial destinatária na transferência."))
        if self.return_id:
            motivos.append(_("Devoluções não são origem de NF-e nesta versão."))
        if not self._nfe_moves_realizados():
            motivos.append(_("A transferência não tem quantidade realizada para os produtos."))
        return motivos

    def nfe_verificar_elegibilidade(self):
        """Valida a origem fiscal; levanta ``UserError`` se não for elegível.

        Público de propósito: é a checagem que o servidor repete em toda ação
        do fluxo (preparar, validar, simular), independentemente da
        visibilidade do botão na tela.
        """
        self.ensure_one()
        motivos = self._nfe_motivos_inelegibilidade()
        if motivos:
            raise UserError("\n".join(motivos))
        return True

    def _nfe_moves_realizados(self):
        """Movimentos concluídos com quantidade realizada positiva.

        Linhas canceladas, zeradas e negativas ficam fora desta versão
        (spec, decisão 2). ``stock.move.quantity`` é a quantidade realizada,
        não a solicitada — numa transferência parcial de 8 entre 10 vale 8.
        """
        return self.move_ids.filtered(
            lambda move: move.state == 'done' and not move.scrapped and move.quantity > 0
        )

    # ── Ações ────────────────────────────────────────────────────────────────
    def action_nfe_emitir(self):
        """Botão **Emitir NF-e**: abre a nota, criando-a no primeiro clique.

        A elegibilidade é revalidada AQUI (servidor), não só pela
        visibilidade do botão. Cliques repetidos — inclusive simultâneos —
        retornam a mesma nota (unique em ``nfe.documento.picking_id``).
        """
        self.ensure_one()
        self.nfe_verificar_elegibilidade()
        documento = self.env['nfe.documento']._nfe_obter_ou_criar(self)
        return self._nfe_acao_documento(documento)

    def action_nfe_abrir_documento(self):
        """Stat button da transferência: abre a nota já preparada."""
        self.ensure_one()
        documento = self.x_nfe_documento_id
        if not documento:
            raise UserError(_("Esta transferência ainda não tem NF-e preparada."))
        return self._nfe_acao_documento(documento)

    def _nfe_acao_documento(self, documento):
        return {
            'type': 'ir.actions.act_window',
            'name': _("NF-e"),
            'res_model': 'nfe.documento',
            'res_id': documento.id,
            'view_mode': 'form',
            'target': 'current',
        }
