import json
import requests  # usado pra enviar requisicoes ao middleware
from odoo import models, api, fields
import logging

# utlizamos o logger padrao do odoo pra debug
_logger = logging.getLogger(__name__)

# url e token de quem vai receber o hook
API_LARAVEL_URL = "http://127.0.0.1:8000/api/odoo/webhook"
API_TOKEN = "123"




class PosOrder(models.Model):





    _inherit = 'pos.order'

  

    def action_pos_order_paid(self):
       
        # metodo nativo do odoo executado quando uma venda eh finalizada 
        res = super(PosOrder, self).action_pos_order_paid()

        # self eh a ordem que acabou de ser paga
        try:
            # aqui eh so montando os dados etc etc

            pagamentos = []

            for pagamento in self.payment_ids:
                pagamentos.append({
                    'tipo': pagamento.payment_method_id.name,
                    'valor': pagamento.amount,
                })

            dados_dos_produtos = []
            numero_item_contador = 1 # A Focus exige sequencial: 1, 2, 3...

            for line in self.lines:
                product = line.product_id
                
                # Prepara o NCM (como você disse que limpa no Laravel, mandamos o raw aqui, 
                # MAS a chave tem que ser 'codigo_ncm')
                
                dados_dos_produtos.append({
                    # --- OBRIGATÓRIOS DA TABELA FOCUS ---
                    'numero_item': numero_item_contador,
                    'codigo_produto': product.default_code or str(product.id),
                    'descricao': product.name,
                    'codigo_ncm': product.x_ncm_id.code, # A API pede "codigo_ncm", não "ncm"
                    'cfop': product.x_cfop,
                    
                    # GTIN (Opcional na tabela mas essencial pra validar sem erro)
                    # Se não tiver, melhor não mandar ou mandar "SEM GTIN" dependendo da config do Laravel
                    'codigo_barras': product.barcode or 'SEM GTIN', 

                    # --- QUANTIDADES E UNIDADES (Comercial vs Tributável) ---
                    # Para varejo, geralmente são iguais
                    'quantidade_comercial': line.qty,
                    'quantidade_tributavel': line.qty,
                    
                    'unidade_comercial': line.product_uom_id.name,
                    'unidade_tributavel': line.product_uom_id.name,

                    # --- VALORES ---
                    'valor_unitario_comercial': line.price_unit,
                    'valor_unitario_tributavel': line.price_unit,
                    
                    # A API pede valor_bruto. 
                    # Se tiver desconto, o bruto é (unit * qty) e o desconto vai em campo separado.
                    # Se 'price_subtotal_incl' já tem desconto deduzido, cuidado!
                    'valor_bruto': line.price_unit * line.qty, 
                    
                    # Caso tenha desconto no item, a Focus pede o campo 'valor_desconto'
                    # 'valor_desconto': (line.price_unit * line.qty) - line.price_subtotal_incl,

                    # --- IMPOSTOS (ICMS/PIS/COFINS) ---
                    'icms_origem': product.x_origem,
                    
                    # Simples Nacional (CSOSN 102 do seu XML)
                    'icms_situacao_tributaria': product.x_icms, 
                    
                    # A documentação Focus para PIS/COFINS segue o padrão do ICMS
                    'pis_situacao_tributaria': product.x_pis,
                    'cofins_situacao_tributaria': product.x_cofins,
                })
                
                numero_item_contador += 1
            
            # Cria o payload final
            payload_completo = {
                'venda': {
                    'id_odoo': self.name,
                    'data': self.date_order,
                    'total': self.amount_total,
                    'numero_caixa': self.config_id.name,
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


            # transforma o payload em json pra enviar pro middleware
            json_payload = json.dumps(payload_completo, default=str)
            
            # loggando pra ver se deu certo
            _logger.info(f"--- enviando venda {payload_completo} ---")



            # aqui embaixo eh pra fazer o envio
            
            
            headers = {
                 'Content-Type': 'application/json',
                 'Authorization': f'Bearer {API_TOKEN}',
                 'Accept': 'application/json'
            }

            response = requests.post(API_LARAVEL_URL, data=json_payload, headers=headers, timeout=5)

            if response.status_code >= 200 and response.status_code < 300:
                _logger.info(f"API SUCESSO para {self.name}. Resposta: {response.text}")
            else:
                _logger.warning(f"API ERRO para {self.name}. Status: {response.status_code}, Resposta: {response.text}")
                
        # boas praticas do odoo pra logging

        except requests.exceptions.Timeout:
            _logger.error(f"FALHA API (TIMEOUT) para {self.name}. A venda FOI concluída, mas o JSON não foi enviado.")
            
        except requests.exceptions.RequestException as e:
            _logger.error(f"FALHA API (GERAL) para {self.name}: {e}. A venda FOI concluída, mas o JSON não foi enviado.")
            
        except Exception as e:
            # pega qualquer outro erro
            _logger.error(f"ERRO INESPERADO ao processar {self.name}: {e}. A venda PODE ter sido concluída, mas o JSON falhou.")
        
        return res
    



# isso aqui serve pra colocar oq vem do laravel-controller na nota do odoo
    class PosSession(models.Model):
        _inherit = 'pos.session'

        def _loader_params_pos_order(self):
            # Pega a lista padrão de campos que o Odoo carrega
            params = super(PosSession, self)._loader_params_pos_order()
            
            # Adiciona o seu campo 'x_fiscal_mensagem' na lista
            # Agora, quando o PDV carregar os pedidos pagos, esse campo vem junto
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
            ])
            
            return params
