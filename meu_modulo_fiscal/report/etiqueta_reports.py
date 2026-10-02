from collections import defaultdict

from odoo import models


class ReportEtiqueta(models.AbstractModel):
    """Resolve o ``data`` do wizard de etiquetas em registros para o template.

    Mesmo padrão do ``product.report_producttemplatelabel_dymo`` do core: o
    ``data`` que trafega na action só carrega tipos nativos (JSON), então a
    resolução para registros acontece aqui.

    O template consome ``quantity`` como ``{produto: [(barcode, quantidade)]}``.
    """
    _name = 'report.meu_modulo_fiscal.report_etiqueta'
    _description = 'Dados comuns dos relatórios de etiqueta'

    def _get_report_values(self, docids, data=None):
        data = data or {}
        # O `data` passa por JSON no caminho real (chaves viram string); normalizar
        # para int deixa o modelo robusto tanto no fluxo web quanto em teste direto.
        quantity_by_product = {
            int(product_id): int(quantity)
            for product_id, quantity in (data.get('quantity_by_product') or {}).items()
        }
        # `browse().exists()` preserva a ordem das linhas do wizard e descarta IDs órfãos.
        products = self.env['product.product'].browse(list(quantity_by_product)).exists()

        quantity = defaultdict(list)
        for product in products:
            quantity[product].append((product.barcode, quantity_by_product[product.id]))

        # Quantidade TOTAL de etiquetas. O template usa para saber quantas
        # paginas (linhas) montar no rolo de 3 colunas.
        total_quantity = sum(quantity_by_product.values())

        return {
            'quantity': quantity,
            'total_quantity': total_quantity,
            'layout_wizard': self.env['product.label.layout'].browse(data.get('layout_wizard')),
        }


class ReportEtiquetaBijuteria(models.AbstractModel):
    _name = 'report.meu_modulo_fiscal.report_etiqueta_bijuteria'
    _inherit = 'report.meu_modulo_fiscal.report_etiqueta'
    _description = 'Etiqueta de produto — Bijuteria 34,8×20 mm'


class ReportEtiquetaConfeccao(models.AbstractModel):
    _name = 'report.meu_modulo_fiscal.report_etiqueta_confeccao'
    _inherit = 'report.meu_modulo_fiscal.report_etiqueta'
    _description = 'Etiqueta de produto — Confecção 35×60 mm'
