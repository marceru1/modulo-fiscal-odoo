from odoo import models, fields, api

class PosOrder_Adicionais(models.Model):
    _inherit = 'pos.order'

    # cria as colunas no banco
    x_cpf_nota = fields.Char(string="CPF na nota")

    x_confirmacao_venda = fields.Boolean(string="Venda enviada?")

    x_email_cliente = fields.Char(string="email do cliente")


    #aqui cria no banco a coluna pra armazenar a resposta do middleware
    x_fiscal_status = fields.Char(string='Status Fiscal')
    x_fiscal_mensagem = fields.Text(string='Mensagem Fiscal')
    x_fiscal_chave = fields.Char(string='Chave de Acesso')
    x_fiscal_protocolo = fields.Char(string='Protocolo')
    x_fiscal_numero = fields.Char(string='Número da NFCe')
    x_fiscal_serie = fields.Char(string='Série')
    
    # Links e URLs
    x_fiscal_qrcode_url = fields.Char(string='URL do QR Code')
    x_fiscal_qrcode_b64 = fields.Text(string='QR Code Base64')
    x_fiscal_url_consulta = fields.Char(string='URL de Consulta')
    x_fiscal_url_pdf = fields.Char(string='Link do PDF (Danfe)')
    x_fiscal_url_xml = fields.Char(string='Link do XML')

    # Controle de Contingência (Boolean)
    x_fiscal_offline = fields.Boolean(string='Emitido em Contingência?', default=False)

    @api.model
    def _order_fields(self, ui_order):

        #joga os dados adicionais do pdv no banco de dados

        vals = super(PosOrder_Adicionais, self)._order_fields(ui_order)
      
        if 'x_cpf_nota' in ui_order:
            vals['x_cpf_nota'] = ui_order.get('x_cpf_nota')

        if 'x_confirmacao_venda' in ui_order:
            vals['x_confirmacao_venda'] = bool(ui_order.get('x_confirmacao_venda'))

        if 'x_email_cliente' in ui_order:
            vals['x_email_cliente'] = ui_order.get('x_email_cliente')

        return vals