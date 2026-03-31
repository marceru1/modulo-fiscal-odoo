from odoo import models, fields, api

class PosOrder_Adicionais(models.Model):
    """
    Extensão auxiliar do modelo 'pos.order' dedicada exclusivamente a armazenar
    os metadados fiscais devolvidos pelo Webhook do Middleware (Focus NFe) após emissão,
    além de capturar os dados informados pelo Consumidor Final na tela do Ponto de Venda.
    """
    _inherit = 'pos.order'

    # ==========================================================
    # DADOS CAPTURADOS DO CONSUMIDOR NA TELA DO CAIXA
    # ==========================================================
    x_cpf_nota = fields.Char(string="CPF na nota", help="CPF informado pelo cliente para a via do consumidor.")
    x_email_cliente = fields.Char(string="E-mail do cliente", help="Para envio do XML/Danfe contigenciado.")
    x_confirmacao_venda = fields.Boolean(string="Venda enviada?", help="Flag que dita se o PDV já sincronizou a criação offline dessa venda.")

    # ==========================================================
    # RETORNO FISCAL DO MIDDLEWARE (FOCUS NFE)
    # ==========================================================
    x_fiscal_status = fields.Char(string='Status Fiscal', help="Status Sefaz (autorizado, rejeitado, processando)")
    x_fiscal_mensagem = fields.Text(string='Mensagem Fiscal', help="Motivo da rejeição ou mensagem sucesso Sefaz")
    x_fiscal_chave = fields.Char(string='Chave de Acesso', help="Chave de 44 dígitos da NFC-e")
    x_fiscal_protocolo = fields.Char(string='Protocolo', help="Protocolo de Autorização de Uso")
    x_fiscal_numero = fields.Char(string='Número da NFCe', help="Número sequencial do documento fiscal")
    x_fiscal_serie = fields.Char(string='Série', help="Série do documento fiscal emissor")
    
    x_fiscal_qrcode_url = fields.Char(string='URL do QR Code', help="Link direto oficial para o QR Code da Sefaz")
    x_fiscal_qrcode_b64 = fields.Text(string='QR Code Base64', help='QR Code fiscal gerado offline/contingência convertido em base64 (SEM prefixo data:image)')
    
    x_fiscal_url_consulta = fields.Char(string='URL de Consulta', help="URL SEFAZ para consultar a chave na web")
    x_fiscal_url_pdf = fields.Char(string='Link do PDF (Danfe)', help="Download do Cupom fiscal gerado")
    x_fiscal_url_xml = fields.Char(string='Link do XML', help="Download do XML de emissão oficial")

    # ==========================================================
    # CONTROLE DE CONTINGÊNCIA E OFFLINE
    # ==========================================================
    x_fiscal_offline = fields.Boolean(string='Emitido em Contingência?', default=False, help="Marca se essa NFC-e foi emitida pelo Odoo PDV Offline Mode")

    @api.model
    def _order_fields(self, ui_order):
        """
        Interpreta e intercepta os dados disparados do Browser pelo Odoo JS (Owl) 
        antes que o Odoo os salve no Python/Postgres. Aqui fazemos a pescaria
        dos nossos três campos customizados criados no PopUp JS do Caixa.
        """
        vals = super(PosOrder_Adicionais, self)._order_fields(ui_order)
      
        if 'x_cpf_nota' in ui_order:
            vals['x_cpf_nota'] = ui_order.get('x_cpf_nota')
            
        if 'x_confirmacao_venda' in ui_order:
            vals['x_confirmacao_venda'] = bool(ui_order.get('x_confirmacao_venda'))
            
        if 'x_email_cliente' in ui_order:
            vals['x_email_cliente'] = ui_order.get('x_email_cliente')

        return vals