from odoo import _, api, fields, models
from odoo.exceptions import UserError
from odoo.tools.pdf import rotate_pdf

import base64


def _x_rotate_etiqueta_pdf(pdf, degrees):
    """Gira o PDF em ``degrees`` (múltiplo de 90) usando o utilitário do core.

    ``rotate_pdf`` do Odoo gira 90° por chamada, então 180° são duas chamadas.
    Ele altera o ``/Rotate`` da página em vez de remontar as dimensões: em 180°
    a folha continua 105x60 e só o conteúdo fica de cabeça pra baixo — que é o
    efeito do "Retrato 180°" do driver da Elgin.

    NÃO usa as opções do QZ Tray para isso: ``rotation`` a lib só declara como
    default (o app Java ignora) e ``orientation`` TROCA a página (105x60 vira
    60x105), fazendo o ``scaleContent`` encolher a etiqueta.
    """
    for _ in range((degrees // 90) % 4):
        pdf = rotate_pdf(pdf)
    return pdf


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
    # Campo-botão: não carrega dado nenhum, só dá lugar ao widget que imprime
    # direto pelo QZ Tray (a impressora é USB na loja; o navegador não fala
    # com ela, então o QZ Tray no Windows faz a ponte).
    x_qz_print = fields.Boolean(string='Imprimir direto')

    #: Formato → geometria da página em mm, para o QZ Tray.
    #: A largura é a do ROLO (na confecção são 3 etiquetas de 35mm lado a lado),
    #: não a de uma etiqueta — é o tamanho que o driver deve receber.
    _X_LABEL_PAGE_MM = {
        'bijuteria': {'width': 35, 'height': 20},
        'confeccao': {'width': 105, 'height': 60},
    }

    #: O perfil do Windows desta classe de Elgin carrega "Retrato 180°" (o fluxo
    #: do BarTender foi desenhado em cima disso), então a página precisa sair
    #: girada. Gira-se o PDF no SERVIDOR: a opção `rotation` do QZ Tray não existe
    #: de fato (a lib só a declara como default e o app Java ignora), e
    #: `orientation` NÃO serve — ele TROCA a página (105x60 vira 60x105) e o
    #: `scaleContent` reescala a etiqueta para caber, encolhendo o conteúdo.
    _X_LABEL_ROTATE_DEGREES = 180

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

    @api.model
    def _x_qz_config(self):
        """Parâmetros do QZ Tray que a tela usa para imprimir direto.

        Ficam no servidor (e não no JS) porque são a mesma decisão do layout:
        a geometria de cada bobina. Assim há um lugar só para mudar quando o
        formato ou a impressora mudar.
        """
        return {
            'pages': self._X_LABEL_PAGE_MM,
        }

    def x_get_print_payload(self):
        """Devolve o PDF do formato escolhido, em base64, e a geometria.

        Chamado pelo JS do wizard quando o operador usa o botão de impressão
        direta: o navegador roda na mesma máquina do QZ Tray, então ele entrega
        este PDF ao QZ Tray, que rasteriza e manda pra impressora USB.

        Devolve ``{'report_name', 'pdf_base64', 'page'}``.

        O PDF sai já girado em ``_X_LABEL_ROTATE_DEGREES`` (a página continua
        105x60): a impressora Elgin recebe a etiqueta de cabeça pra baixo, e o
        fluxo antigo do BarTender resolvia isso com o "Retrato 180" do driver.
        """
        self.ensure_one()
        xml_id, data = self._prepare_report_data()
        report = self.env.ref(xml_id)
        pdf, _ext = report._render_qweb_pdf(xml_id, res_ids=None, data=data)
        pdf = _x_rotate_etiqueta_pdf(pdf, self._X_LABEL_ROTATE_DEGREES)
        page = self._X_LABEL_PAGE_MM.get(self.x_label_format)
        if not page:
            raise UserError(_('Formato de etiqueta inválido: %s', self.x_label_format))
        return {
            'report_name': _('Etiquetas'),
            'pdf_base64': base64.b64encode(pdf).decode('ascii'),
            'page': page,
        }
