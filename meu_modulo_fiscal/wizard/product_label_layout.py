from odoo import _, api, fields, models
from odoo.exceptions import UserError
from odoo.tools.pdf import (
    DecodedStreamObject,
    NameObject,
    PdfFileReader,
    PdfFileWriter,
    generic,
)

import base64
import io


def _x_normalizar_mediabox(pdf, largura_mm, altura_mm):
    """Força o MediaBox de TODAS as páginas = tamanho físico da etiqueta.

    Por quê: o wkhtmltopdf só emite páginas inteiras. Com conteúdo CSS de
    34,8mm em papel de 35mm ele devolve página de 99,0x57,0pt
    (34,925x20,108mm) — UM FIO maior que a mídia da bobina. A Confecção
    (conteudo == papel, 105/60) fica dentro, mas a Bijuteria estoura e o
    driver da L42Pro Full não repagina: páginas consecutivas andam pra
    frente e "uma etiqueta sai em cima da outra".

    A página é REESCRITA como ``RectangleObject([0, 0, w, h])`` (FloatObject
    implícito): alvo 99,2126x56,6929pt == 35,0x20,0mm EXATOS. Provas:
    normalização aplicada ao PDF real (render local) manteve conteúdo
    íntegro (mesmas imagens/words) e fitz mediu 35,0000x20,0000mm.
    """
    MM = 72.0 / 25.4
    w, h = largura_mm * MM, altura_mm * MM
    reader = PdfFileReader(io.BytesIO(pdf), strict=False)
    writer = PdfFileWriter()
    for page in reader.pages:
        page.mediaBox = generic.RectangleObject([0, 0, w, h])
        for box in ('/CropBox', '/BleedBox', '/TrimBox', '/ArtBox'):
            if box in page:
                page[NameObject(box)] = generic.RectangleObject([0, 0, w, h])
        writer.addPage(page)
    buf = io.BytesIO()
    writer.write(buf)
    return buf.getvalue()


def _x_rotate_etiqueta_pdf(pdf, degrees):
    """Gira o CONTEUDO do PDF, injetando a matriz ``cm`` no stream.

    Caminhos que NAO funcionam (testados de verdade):
      - ``rotation: 180`` no config do QZ Tray: a lib so o declara como default
        e o app Java ignora.
      - ``orientation: 'reverse-portrait'``: TROCA a pagina (105x60 vira
        60x105) e o ``scaleContent`` reescala, encolhendo a etiqueta.
      - ``/Rotate`` na pagina: o rasterizador do QZ Tray ignora o flag.
      - ``mergeTransformedPage`` com matriz crua: na PyPDF2 2.x (container) a
        matriz e silenciosamente descartada (roda sem erro, PDF sai IGUAL).

    O que funciona e injecao cirurgica: o stream ``/Contents`` da pagina e
    envelopado em ``q <matriz> cm <conteudo> Q``. A matriz -1 0 0 -1 w h
    espelha o desenho em torno do centro da folha (== girar 180). Qualquer
    rasterizador APPLICA a matriz porque ela e parte do desenho.

    A folha continua 105x60 e a pagina reutiliza mediaBox/objetos originais.

    Imports SO via odoo.tools.pdf: o PyPDF2 do dev local (1.26) expoe
    PageObject em PyPDF2.pdf, ja o do container (2.12.1) no pacote raiz --
    importar direto quebra um dos dois lados. Os nomes reexportados pelo core
    existem garantidamente em qualquer instalacao Odoo 18.
    """
    resto = degrees % 360
    if resto == 0:
        return pdf
    if resto != 180:
        raise UserError(_('Rotação de %s° não suportada (só 180).', degrees))

    reader = PdfFileReader(io.BytesIO(pdf), strict=False)
    writer = PdfFileWriter()
    # Matriz unica da rotacao 180 (espelha em torno do centro).
    MATRIZ = b'q -1 0 0 -1 %.6f %.6f cm\n'
    for i in range(reader.getNumPages()):
        page = reader.getPage(i)
        w = float(page.mediaBox.getWidth())
        h = float(page.mediaBox.getHeight())
        conteudo = page.getContents()
        if conteudo is None:
            bruto = b''
        elif hasattr(conteudo, 'getData'):
            # stream unico
            bruto = conteudo.getData()
        else:
            # ArrayObject: varios streams (possivelmente IndirectObject)
            bruto = b''.join(
                (s.getData() if hasattr(s, 'getData') else s.getObject().getData())
                for s in conteudo
            )
        novo = DecodedStreamObject()
        novo.setData(MATRIZ % (w, h) + bruto + b'\nQ\n')
        page[NameObject('/Contents')] = writer._add_object(novo)
        writer.addPage(page)
    buf = io.BytesIO()
    writer.write(buf)
    return buf.getvalue()


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

    #: Graus de rotação do PDF na impressão direta (0, 90, 180, 270).
    #:
    #: Os ambientes precisam de valores DIFERENTES: a impressora da DEV rasteriza
    #: a página como veio (código funciona com 0) e a da PROD processa a folha
    #: girada 180° (sai de ponta-cabeça E começa pela coluna da direita —
    #: assinatura de página rodada pela máquina/driver). O valor por BANCO
    #: resolve sem dividir o código: cada base grava o que a sua impressora
    #: exige. Preenchido pela _x_default quando o ir.config não tem valor.
    x_rotate_degrees = fields.Selection(
        selection=[
            ('0', '0° (etiqueta direita)'),
            ('180', '180° (etiqueta de cabeça pra baixo)'),
        ],
        string='Rotação da Etiqueta',
        default='0',
    )

    #: Formato → geometria da página em mm, para o QZ Tray.
    #: A largura é a do ROLO em AMBOS os formatos (a bobina da bijuteria
    #: também é de 3 vias de 35mm lado a lado — confirmado na loja; na
    #: confecção idem) — é o tamanho que o driver deve receber.
    _X_LABEL_PAGE_MM = {
        'bijuteria': {'width': 105, 'height': 20},
        'confeccao': {'width': 105, 'height': 60},
    }

    #: Padrões por formato: a DEV/impressora de casa rasteriza a página como
    #: veio (0°). A PROD (Elgin da loja) processa a folha girada 180°.
    _X_LABEL_ROTATE_DEFAULT = '0'

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

    @api.model
    def _x_rotate_degrees(self):
        """Valor corrente de rotação: wizard → sistema → default da classe.

        Ordem: o valor gravado na ABA do wizard vence (o operador pode trocar
        numa impressão pontual); sem ele, o default do campo.
        """
        self.ensure_one()
        return int(self.x_rotate_degrees or self._X_LABEL_ROTATE_DEFAULT)

    @api.model
    def _x_qz_config(self):
        """Parâmetros do QZ Tray que a tela usa para imprimir direto.

        Ficam no servidor (e não no JS) porque são a mesma decisão do layout:
        a geometria de cada bobina. Assim há um lugar só para mudar quando o
        formato ou a impressora mudar.
        """
        return {
            'default_rotation': self.default_get(['x_rotate_degrees']).get('x_rotate_degrees'),
            'pages': self._X_LABEL_PAGE_MM,
        }

    def x_get_print_payload(self):
        """Devolve o PDF do formato escolhido, em base64, e a geometria.

        Chamado pelo JS do wizard quando o operador usa o botão de impressão
        direta: o navegador roda na mesma máquina do QZ Tray, então ele entrega
        este PDF ao QZ Tray, que rasteriza e manda pra impressora USB.

        Devolve ``{'report_name', 'pdf_base64', 'page'}``.

        O PDF sai girado conforme ``x_rotate_degrees`` (0 ou 180) — a folha
        fica 105x60 e o conteúdo gira dentro do stream (a matriz injetada).
        Impressoras variam: a da dev rasteriza como veio (0°) e a da loja
        processa a folha girada (180°).
        """
        self.ensure_one()
        pdf = self._x_render_etiqueta_pdf()
        page = self._X_LABEL_PAGE_MM.get(self.x_label_format)
        if not page:
            raise UserError(_('Formato de etiqueta inválido: %s', self.x_label_format))
        return {
            'report_name': _('Etiquetas'),
            'pdf_base64': base64.b64encode(pdf).decode('ascii'),
            'page': page,
        }

    def _x_render_etiqueta_pdf(self):
        """PDF da etiqueta do formato atual, já normalizado pro papel físico.

        Ponto ÚNICO de render dos dois formatos (os dois caminhos de impressão
        passam aqui):
          - botão "Imprimir (PDF)" → ``process()`` → action report → core
          - botão direto (QZ Tray) → ``x_get_print_payload()`` → este método

        Normalização do MediaBox depois do render: o wkhtmltopdf devolve
        página 34,925x20,108mm quando o conteúdo CSS é menor que o papel —
        estoura a mídia da bobina e o driver imprime em cima (ver
        ``_x_normalizar_mediabox``).
        """
        self.ensure_one()
        xml_id, data = self._prepare_report_data()
        report = self.env.ref(xml_id)
        pdf, _ext = report._render_qweb_pdf(xml_id, res_ids=None, data=data)
        page = self._X_LABEL_PAGE_MM.get(self.x_label_format)
        if not page:
            raise UserError(_('Formato de etiqueta inválido: %s', self.x_label_format))
        pdf = _x_normalizar_mediabox(pdf, page['width'], page['height'])
        pdf = _x_rotate_etiqueta_pdf(pdf, self._x_rotate_degrees())
        return pdf

    def process(self):
        self.ensure_one()
        if not self.x_label_format:
            return super().process()

        # Mesma normalização do payload do QZ: o PDF que o navegador entrega
        # (Ctrl+P) tem que ter o MediaBox = papel físico, senão o driver da
        # loja anda o papel a cada página (etiqueta em cima da outra).
        self._x_render_etiqueta_pdf()
        xml_id, data = self._prepare_report_data()
        report_action = self.env.ref(xml_id).report_action(None, data=data, config=False)
        report_action.update({'close_on_report_download': True})
        return report_action
