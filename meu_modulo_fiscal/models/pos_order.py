import json
import requests
from odoo import models, api, fields
import logging
import os

_logger = logging.getLogger(__name__)

BASE_URL = os.environ.get('MIDDLEWARE_URL', 'http://127.0.0.1:8000')
API_LARAVEL_URL = f"{BASE_URL}/api/odoo/webhook"
API_TOKEN = os.environ.get('MIDDLEWARE_API_TOKEN', '')

class PosOrder(models.Model):
    """
    Extensão do modelo central de Vendas do PDV (pos.order).
    Intercepta a finalização de um pagamento no caixa de loja para 
    disparar, via Webhook, os dados de faturamento para o Middleware Laravel
    responsável pela emissão da NFC-e via FocusNFe.
    """
    _inherit = 'pos.order'

    def action_pos_order_paid(self):
        """
        Sobrescreve a ação de pagamento finalizado do módulo Point of Sale.
        Monta o payload JSON e despacha via HTTP POST sem bloquear a UI do operador.
        
        @return: o retorno da função original action_pos_order_paid() para dar seguimento ao ciclo nativo
        """
        res = super(PosOrder, self).action_pos_order_paid()

        try:
            pagamentos = []
            for pagamento in self.payment_ids:
                pagamentos.append({
                    'tipo': pagamento.payment_method_id.name,
                    'valor': pagamento.amount,
                })

            dados_dos_produtos = []
            numero_item_contador = 1 

            for line in self.lines:
                product = line.product_id
                
                valor_unitario = line.price_unit 
                quantidade = line.qty
                valor_bruto_item = valor_unitario * quantidade
                valor_liquido_item = line.price_subtotal_incl 
                
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
    
                    # Impostos Tributários extraídos do ProductTemplate via campos_fiscais.py
                    'icms_origem': product.x_origem,
                    'icms_situacao_tributaria': product.x_icms,
                    'pis_situacao_tributaria': product.x_pis,
                    'cofins_situacao_tributaria': product.x_cofins,
                }
                
                if valor_desconto_monetario > 0:
                    item_dict['valor_desconto'] = valor_desconto_monetario

                dados_dos_produtos.append(item_dict)
                numero_item_contador += 1
            
            # Payload Estruturado
            payload_completo = {
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
                    'modelo': '65', # NFC-e
                },
                'confirmacao_venda': bool(self.x_confirmacao_venda), 
            }

            json_payload = json.dumps(payload_completo, default=str)
            
            headers = {
                 'Content-Type': 'application/json',
                 'Accept': 'application/json'
            }

            # Timeout restrito de 5s: Previne congelamento da tela do PDV se o middleware/API caírem
            response = requests.post(API_LARAVEL_URL, data=json_payload, headers=headers, timeout=5)

            if response.status_code >= 200 and response.status_code < 300:
                _logger.info(f"[MIDDLEWARE-WEBHOOK] Sucesso. Pedido despachado: {self.name}.")
            else:
                _logger.warning(f"[MIDDLEWARE-WEBHOOK] Erro de Servidor ({response.status_code}) ao despachar pedido {self.name}.")
                
        except requests.exceptions.Timeout:
            _logger.error(f"[MIDDLEWARE-WEBHOOK] Timeout (5s) excedido para {self.name}. A venda local foi mantida normal.")
            
        except requests.exceptions.RequestException as e:
            _logger.error(f"[MIDDLEWARE-WEBHOOK] Falha crítica de conexão para {self.name}: {e}.")
            
        except Exception as e:
            _logger.error(f"[MIDDLEWARE-WEBHOOK] Erro lógico interno ao empacotar {self.name}: {e}.")
        
        return res
    
    class PosSession(models.Model):
        """
        Extensão auxiliar em memória do estado de sessão de caixas de Ponto de Venda.
        Permite sincronizar os meta-dados fiscais customizados com o frontend Javascript (Owl).
        """
        _inherit = 'pos.session'

        def _loader_params_pos_order(self):
            """
            Injeta os campos customizados 'x_fiscal' no modelo base de 'pos.order'
            antes que ele seja retornado para hidratação no browser ao fazer reload do PDV.
            """
            params = super(PosSession, self)._loader_params_pos_order()
            
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
