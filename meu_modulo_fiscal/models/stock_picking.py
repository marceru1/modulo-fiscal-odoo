from odoo import models


class StockPicking(models.Model):
    _inherit = 'stock.picking'

    # Tipos de picking que devem imprimir automaticamente ao validar (D2).
    # Escopo: transferência interna (internal) e recebimento (incoming).
    # Outgoing/delivery NÃO imprime automaticamente.
    _PRINT_ON_VALIDATE_TYPES = ('internal', 'incoming')

    def button_validate(self):
        result = super().button_validate()

        # Só sobrescreve o retorno quando a validação realmente concluiu:
        #   (a) `result is True` — o core retorna True em sucesso; se retornar
        #       um dict (wizard de backorder, do_multi_print de autoprint,
        #       reception report) NÃO devemos clobberar (R2).
        #   (b) todos os pickings foram a `done` (sem backorder pendente).
        #   (c) todos os pickings são internal/incoming (D2).
        if (
            result is True
            and self
            and all(p.state == 'done' for p in self)
            and all(p.picking_type_code in self._PRINT_ON_VALIDATE_TYPES for p in self)
        ):
            return (
                self.env.ref('stock.action_report_delivery')
                .report_action(self)
            )

        return result
