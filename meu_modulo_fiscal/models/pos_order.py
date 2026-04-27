import json
import requests
from odoo import models, api, fields
import logging
import os

_logger = logging.getLogger(__name__)

BASE_URL = os.environ.get('MIDDLEWARE_URL', 'http://127.0.0.1:8000')
API_LARAVEL_URL = f"{BASE_URL}/api/odoo/webhook"
# Shared secret sent in X-Webhook-Token for the middleware security layer.
# Must match ODOO_WEBHOOK_SECRET set in the middleware .env.
# Leave empty if the middleware is on an internal-only network (no public domain).
WEBHOOK_SECRET = os.environ.get('MIDDLEWARE_WEBHOOK_SECRET', '')

class PosOrder(models.Model):
    """
    Extensão do modelo central de Vendas do PDV (pos.order).
    Responsável por armazenar meta-dados da NFC-e e despachar
    via Webhook para o Middleware Laravel.
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
    x_fiscal_qrcode_b64 = fields.Text(string='QR Code Base64', help='QR Code fiscal gerado offline convertido em base64')
    
    x_fiscal_url_consulta = fields.Char(string='URL de Consulta', help="URL SEFAZ para consultar a chave na web")
    x_fiscal_url_pdf = fields.Char(string='Link do PDF (Danfe)', help="Download do Cupom fiscal gerado")
    x_fiscal_url_xml = fields.Char(string='Link do XML', help="Download do XML de emissão oficial")

    # ==========================================================
    # CONTROLE DE CONTINGÊNCIA E OFFLINE
    # ==========================================================
    x_fiscal_offline = fields.Boolean(string='Emitido em Contingência?', default=False, help="Marca se essa NFC-e foi emitida pelo Odoo PDV Offline Mode")
    x_contingencia_payload = fields.Text(string='Payload Contingência Offline', default='', help="Dados JSON gerados offline (numero, serie, codigo_unico)")

    @api.model
    def _order_fields(self, ui_order):
        """
        Interpreta e intercepta os dados disparados do Browser pelo Odoo JS (Owl) 
        antes que o Odoo os salve no Python/Postgres.
        """
        vals = super(PosOrder, self)._order_fields(ui_order)
        
        campos_para_sincronizar = ['x_cpf_nota', 'x_email_cliente', 'x_contingencia_payload']
        for campo in campos_para_sincronizar:
            if campo in ui_order:
                vals[campo] = ui_order.get(campo)
                
        if 'x_confirmacao_venda' in ui_order:
            vals['x_confirmacao_venda'] = bool(ui_order.get('x_confirmacao_venda'))

        return vals

    def _prepare_nfce_payload(self):
        """
        Monta o dicionário de dados da venda para enviar ao Middleware.
        """
        pagamentos = [{
            'tipo': p.payment_method_id.name,
            'valor': p.amount,
        } for p in self.payment_ids]

        dados_dos_produtos = []
        for i, line in enumerate(self.lines, start=1):
            product = line.product_id
            valor_bruto = line.price_unit * line.qty
            valor_liq = line.price_subtotal_incl 
            desconto = max(0.0, valor_bruto - valor_liq)

            item = {
                'numero_item': i,
                'codigo_produto': product.default_code or str(product.id),
                'descricao': product.name,
                'codigo_barras': product.barcode or 'SEM GTIN',
                'codigo_ncm': product.x_ncm_id.code if product.x_ncm_id else '', 
                'cfop': product.x_cfop, 
                'quantidade_comercial': line.qty,
                'quantidade_tributavel': line.qty,
                'unidade_comercial': line.product_uom_id.name,
                'unidade_tributavel': line.product_uom_id.name,
                'valor_unitario_comercial': line.price_unit,
                'valor_unitario_tributavel': line.price_unit,
                'valor_bruto': valor_bruto,
                'icms_origem': product.x_origem,
                'icms_situacao_tributaria': product.x_icms,
                'pis_situacao_tributaria': product.x_pis,
                'cofins_situacao_tributaria': product.x_cofins,
            }
            if desconto > 0:
                item['valor_desconto'] = desconto

            dados_dos_produtos.append(item)

        return {
            'venda': {
                'id_odoo': self.name,
                'data': self.date_order,
                'total': self.amount_total,
                'numero_caixa': self.user_id.name,
                'numero_ordem': self.pos_reference,
            },
            'cliente': {
                'nome': 'CONSUMIDOR FINAL',
                'cpf': self.x_cpf_nota,
                'email': self.x_email_cliente,
            },
            'produtos': dados_dos_produtos,
            'pagamentos': pagamentos,
            'fiscal': {
                'estado': 'AM',
                'modelo': '65',
            },
            'confirmacao_venda': bool(self.x_confirmacao_venda), 
            'contingencia': {
                'ativa': bool(self.x_fiscal_offline),
                'payload': self.x_contingencia_payload or None,
            },
        }

    def action_pos_order_paid(self):
        """
        Sobrescreve a ação de pagamento finalizado disparando o webhook.
        """
        res = super(PosOrder, self).action_pos_order_paid()

        try:
            payload = self._prepare_nfce_payload()
            json_payload = json.dumps(payload, default=str)
            
            headers = {
                'Content-Type': 'application/json',
                'Accept': 'application/json',
            }

            if WEBHOOK_SECRET:
                headers['X-Webhook-Token'] = WEBHOOK_SECRET

            response = requests.post(API_LARAVEL_URL, data=json_payload, headers=headers, timeout=5)

            if 200 <= response.status_code < 300:
                _logger.info(f"[MIDDLEWARE-WEBHOOK] Sucesso. Pedido despachado: {self.name}.")
            else:
                _logger.warning(f"[MIDDLEWARE-WEBHOOK] Erro ({response.status_code}) ao despachar pedido {self.name}.")
                
        except requests.exceptions.Timeout:
            _logger.error(f"[MIDDLEWARE-WEBHOOK] Timeout (5s) excedido para {self.name}.")
        except requests.exceptions.RequestException as e:
            _logger.error(f"[MIDDLEWARE-WEBHOOK] Falha crítica de conexão para {self.name}: {e}.")
        except Exception as e:
            _logger.error(f"[MIDDLEWARE-WEBHOOK] Erro interno ao empacotar {self.name}: {e}.")
        
        return res

class PosSession(models.Model):
    _inherit = 'pos.session'

    def _loader_params_pos_order(self):
        params = super()._loader_params_pos_order()
        params['search_params']['fields'].extend([
            'x_fiscal_status',
            'x_fiscal_mensagem',
            'x_fiscal_chave',
            'x_fiscal_qrcode_url',
            'x_fiscal_url_consulta',
            'x_fiscal_offline',
            'x_fiscal_numero',
            'x_fiscal_serie',
            'x_fiscal_protocolo',
            'x_fiscal_qrcode_b64',
            'x_cpf_nota',  
            'x_email_cliente',  
            'x_contingencia_payload',
        ])
        return params
