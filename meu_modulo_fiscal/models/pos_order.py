import json
import requests  # usado pra enviar requisicoes ao middleware
from odoo import models, api, fields
import logging
import os


_logger = logging.getLogger(__name__)

BASE_URL = os.environ.get('MIDDLEWARE_URL', 'http://127.0.0.1:8000')
API_LARAVEL_URL = f"{BASE_URL}/api/odoo/webhook"
API_TOKEN = os.environ.get('MIDDLEWARE_API_TOKEN', '')




class PosOrder(models.Model):

    _inherit = 'pos.order'

  

    def action_pos_order_paid(self):
        """
        Sobrescreve a ação de pagamento do PDV para disparar o envio ao middleware.
        Não bloqueia a conclusão da venda caso o middleware esteja indisponível.
        """
        res = super(PosOrder, self).action_pos_order_paid()


        try:
            pagamentos = []

            for pagamento in self.payment_ids:
                pagamentos.append({
                    'tipo': pagamento.payment_method_id.name,
                    'valor': pagamento.amount,
                })

            # Montagem estruturada dos itens da venda para a nota fiscal
            dados_dos_produtos = []
            numero_item_contador = 1 

            for line in self.lines:
                product = line.product_id
                
                valor_unitario = line.price_unit 
                quantidade = line.qty
                valor_bruto_item = valor_unitario * quantidade
                valor_liquido_item = line.price_subtotal_incl 
                
                # calculo do desconto

                valor_desconto_monetario = valor_bruto_item - valor_liquido_item
                if valor_desconto_monetario < 0.01:
                    valor_desconto_monetario = 0.0

                item_dict = {
                    'numero_item': numero_item_contador,
                    'codigo_produto': product.default_code or str(product.id),
                    'descricao': product.name,
                    'codigo_barras': product.barcode or 'SEM GTIN',
                    'codigo_ncm': product.x_ncm_id.code, 
                    'cfop': product.x_cfop, 
                    'quantidade_comercial': quantidade,
                    'quantidade_tributavel': quantidade,
                    'unidade_comercial': line.product_uom_id.name,
                    'unidade_tributavel': line.product_uom_id.name,
                    'valor_unitario_comercial': valor_unitario,
                    'valor_unitario_tributavel': valor_unitario,
                    'valor_bruto': valor_bruto_item, 
    
                    # Impostos
                    'icms_origem': product.x_origem,
                    'icms_situacao_tributaria': product.x_icms,
                    'pis_situacao_tributaria': product.x_pis,
                    'cofins_situacao_tributaria': product.x_cofins,
                }
                if valor_desconto_monetario > 0:
                    item_dict['valor_desconto'] = valor_desconto_monetario

                dados_dos_produtos.append(item_dict)
                numero_item_contador += 1
            
            # payload final para middleware
            payload_completo = {
                'venda': {
                    'id_odoo': self.name,
                    'data': self.date_order,
                    'total': self.amount_total,
                    'numero_caixa': self.user_id.name, #operador
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
            }

            json_payload = json.dumps(payload_completo, default=str)
            
            headers = {
                 'Content-Type': 'application/json',
                 'Authorization': f'Bearer {API_TOKEN}',
                 'Accept': 'application/json'
            }

            # Timeout curto para não congelar o caixa do PDV caso a API externa sofra gargalo
            response = requests.post(API_LARAVEL_URL, data=json_payload, headers=headers, timeout=5)

            if response.status_code >= 200 and response.status_code < 300:
                _logger.info(f"API SUCESSO para {self.name}.")
            else:
                _logger.warning(f"API ERRO para {self.name}. Status: {response.status_code}")
                

        except requests.exceptions.Timeout:
            _logger.error(f"FALHA API (TIMEOUT) para {self.name}. JSON não enviado.")
            
        except requests.exceptions.RequestException as e:
            _logger.error(f"FALHA API (GERAL) para {self.name}: {e}.")
            
        except Exception as e:
            _logger.error(f"ERRO INESPERADO ao processar {self.name}: {e}.")
        
        return res
    

    class PosSession(models.Model):
        """
        Estende a sessão do PDV para disponibilizar campos fiscais ao carregar as vendas.
        Necessário para que a interface de PDV em JS possa ler e atualizar QR Code, Status, etc.
        """
        _inherit = 'pos.session'

        def _loader_params_pos_order(self):
            params = super(PosSession, self)._loader_params_pos_order()
            
            # campos retornados pelo middleware
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
            ])
            
            return params
