from odoo import fields, models, api

class ResCompany(models.Model):
    _inherit = 'res.company'

    # =========================================================
    # Dados Fiscais — NFC-e Contingência Offline
    # =========================================================

    x_cnpj = fields.Char(
        string="CNPJ",
        size=14,
        help="CNPJ da empresa somente com dígitos (14 caracteres). Ex: 26343314000180"
    )
    
    x_ie = fields.Char(
        string="Inscrição Estadual (IE)",
        help="Inscrição Estadual da empresa"
    )
    
    x_endereco_linha1 = fields.Char(
        string="Endereço Fiscal (Linha 1)",
        help="Ex: Av. 7 DE SETEMBRO, 767"
    )
    
    x_endereco_linha2 = fields.Char(
        string="Endereço Fiscal (Linha 2)",
        help="Ex: Centro, Itacoatiara, AM"
    )

    x_url_qrcode_homolog = fields.Char(
        string="URL QR Code (Homologação)",
        default="https://homnfce.sefaz.am.gov.br/nfce/qrcode",
        help="URL Sefaz para consulta QRCode em homologação."
    )

    x_url_qrcode_producao = fields.Char(
        string="URL QR Code (Produção)",
        default="https://sistemas.sefaz.am.gov.br/nfceweb/consultarNFCe.jsp",
        help="URL Sefaz para consulta QRCode em produção."
    )


    x_uf_codigo = fields.Selection(
        selection=[
            ('11', 'RO - Rondônia'), ('12', 'AC - Acre'), ('13', 'AM - Amazonas'),
            ('14', 'RR - Roraima'), ('15', 'PA - Pará'), ('16', 'AP - Amapá'),
            ('17', 'TO - Tocantins'), ('21', 'MA - Maranhão'), ('22', 'PI - Piauí'),
            ('23', 'CE - Ceará'), ('24', 'RN - Rio Grande do Norte'), ('25', 'PB - Paraíba'),
            ('26', 'PE - Pernambuco'), ('27', 'AL - Alagoas'), ('28', 'SE - Sergipe'),
            ('29', 'BA - Bahia'), ('31', 'MG - Minas Gerais'), ('32', 'ES - Espírito Santo'),
            ('33', 'RJ - Rio de Janeiro'), ('35', 'SP - São Paulo'), ('41', 'PR - Paraná'),
            ('42', 'SC - Santa Catarina'), ('43', 'RS - Rio Grande do Sul'),
            ('50', 'MS - Mato Grosso do Sul'), ('51', 'MT - Mato Grosso'),
            ('52', 'GO - Goiás'), ('53', 'DF - Distrito Federal'),
        ],
        string="UF (Código IBGE)",
        default='13',
        help="Código numérico IBGE do estado emissor. Compõe os 2 primeiros dígitos da Chave de Acesso."
    )

    x_ambiente_fiscal = fields.Selection(
        selection=[
            ('homologacao', 'Homologação (Testes)'),
            ('producao', 'Produção'),
        ],
        string="Ambiente Fiscal",
        default='homologacao',
        help="Define se as NFC-e são enviadas ao ambiente de testes ou produção da Sefaz."
    )

    # CSC — Código de Segurança do Contribuinte (necessário para o QR Code com hash)
    x_csc_id = fields.Char(
        string="IdCSC",
        help="Identificador numérico do CSC fornecido pela Sefaz do estado. Ex: 000001"
    )
    x_csc_token = fields.Char(
        string="Token CSC (Sefaz)",
        help="Código de Segurança do Contribuinte (hash). Obtido junto à Sefaz estadual."
    )

    @api.model
    def _load_pos_data_fields(self, config_id):
        """
        [Odoo 18] Estende a lista de campos da Empresa que devem ser 
        baixados para a memória Javascript do Point of Sale na inicialização.
        Isso nos permite acessar self.company.x_cnpj diretamente no JS da contingência.
        """
        fields = super()._load_pos_data_fields(config_id)
        fields.extend([
            'x_cnpj',
            'x_ie',
            'x_endereco_linha1',
            'x_endereco_linha2',
            'x_uf_codigo',
            'x_ambiente_fiscal',
            'x_csc_id',
            'x_csc_token',
            'x_url_qrcode_homolog',
            'x_url_qrcode_producao',
            'phone',
            'name',
        ])
        return fields
