from odoo import _, api, fields, models
from odoo.exceptions import UserError


class XLabelLine(models.TransientModel):
    """Linha do wizard de etiquetas: um produto e a quantidade dele.

    O requisito da loja é a quantidade POR PRODUTO (não um valor global para
    todos), então o wizard precisa de uma linha por produto selecionado.
    """
    _name = 'x.label.line'
    _description = 'Linha de Etiqueta (produto e quantidade)'

    wizard_id = fields.Many2one(
        'product.label.layout', string='Assistente', required=True, ondelete='cascade')
    product_id = fields.Many2one(
        'product.template', string='Produto', required=True, ondelete='cascade')
    quantity = fields.Integer(string='Quantidade', default=1, required=True)

    @api.constrains('quantity')
    def _check_quantity(self):
        for line in self:
            if line.quantity <= 0:
                raise UserError(_('A quantidade de etiquetas deve ser maior que zero.'))


class ProductLabelLayout(models.TransientModel):
    """Estende o wizard de etiquetas do core (``product.label.layout``).

    O fluxo nativo de estoque/MRP continua intocado: ``x_label_format`` não tem
    *default* de modelo justamente para que os wizards criados por
    ``stock.picking``/``mrp.production``/``stock.picking.batch`` caiam no
    ``super()`` e continuem imprimindo as etiquetas do core.
    """
    _inherit = 'product.label.layout'

    x_label_format = fields.Selection(
        selection=[
            ('bijuteria', 'Bijuteria 34,8×20 mm'),
            ('confeccao', 'Confecção 35×60 mm'),
        ],
        string='Formato da Etiqueta',
    )
    x_line_ids = fields.One2many(
        'x.label.line', 'wizard_id', string='Produtos',
        help='Uma linha por produto, com a quantidade de etiquetas de cada um.')

    #: Formato escolhido → xml_id do `ir.actions.report` correspondente.
    _X_LABEL_REPORTS = {
        'bijuteria': 'meu_modulo_fiscal.action_report_etiqueta_bijuteria',
        'confeccao': 'meu_modulo_fiscal.action_report_etiqueta_confeccao',
    }

    def _x_get_report_xml_id(self):
        """xml_id do relatório do formato escolhido."""
        xml_id = self._X_LABEL_REPORTS.get(self.x_label_format)
        if not xml_id:
            raise UserError(_('Formato de etiqueta inválido: %s', self.x_label_format))
        return xml_id

    def _x_prepare_quantity_by_product(self):
        """Mapa ``{id de product.product: quantidade}`` a partir das linhas.

        O relatório do core trabalha com variantes (``product.product``), mas a
        seleção na lista é de ``product.template`` — resolve para a primeira
        variante, como faz o wizard do core.
        """
        quantity_by_product = {}
        for line in self.x_line_ids:
            variant = line.product_id.product_variant_id
            if not variant:
                continue
            quantity_by_product[variant.id] = quantity_by_product.get(variant.id, 0) + line.quantity
        if not quantity_by_product:
            raise UserError(_('Selecione ao menos um produto para imprimir as etiquetas.'))
        return quantity_by_product

    def _prepare_report_data(self):
        # Sem formato da loja escolhido → comportamento original do core.
        if not self.x_label_format:
            return super()._prepare_report_data()

        self.ensure_one()
        data = {
            'active_model': 'product.product',
            'quantity_by_product': self._x_prepare_quantity_by_product(),
            'layout_wizard': self.id,
        }
        return self._x_get_report_xml_id(), data

    def process(self):
        self.ensure_one()
        if not self.x_label_format:
            return super().process()

        xml_id, data = self._prepare_report_data()
        report_action = self.env.ref(xml_id).report_action(None, data=data, config=False)
        report_action.update({'close_on_report_download': True})
        return report_action
