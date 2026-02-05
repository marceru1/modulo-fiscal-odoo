from odoo import http
from odoo.http import request, Response
import logging
import json

_logger = logging.getLogger(__name__)

class FiscalWebhookController(http.Controller):

    @http.route(
        '/api/retorno-fiscal',
        type='http',  
        auth='public',
        methods=['POST'],
        csrf=False
    )
    def retorno_fiscal(self, **kw):
        """Recebe retorno fiscal do Laravel via Webhook padrão"""
        
        try:

            dados = request.get_json_data()
        
            if not dados:
                dados = {}
            
            _logger.info('=== WEBHOOK FISCAL RECEBIDO ===')
        

            documento_id = dados.get('documento_id')
            fiscal = dados.get('fiscal', {})

            # validação do documento_id
            if not documento_id:
                return self._response_json({'status': 'erro', 'mensagem': 'documento_id não informado'}, 400)

            # busca do pedido 
            pedido = request.env['pos.order'].sudo().search([
                ('pos_reference', '=', documento_id)
            ], limit=1)

            if not pedido:
                _logger.error(f'❌ Pedido {documento_id} NÃO ENCONTRADO')
                return self._response_json({
                    'status': 'erro', 
                    'mensagem': 'pedido_nao_encontrado',
                    'documento_id': documento_id
                }, 404)

            # processamento dos dados fiscais
            qrcode_b64 = fiscal.get('qrcode_b64', '')
            
            valores = {
                'x_fiscal_status': fiscal.get('status', 'erro'),
                'x_fiscal_mensagem': fiscal.get('mensagem', '')[:500],
                'x_fiscal_chave': fiscal.get('chave_nfe', ''),
                'x_fiscal_protocolo': fiscal.get('protocolo', ''),
                'x_fiscal_numero': fiscal.get('numero_nota', ''),
                'x_fiscal_serie': fiscal.get('serie', '1'),
                'x_fiscal_url_consulta': fiscal.get('url_consulta', ''),
                'x_fiscal_qrcode_url': fiscal.get('qrcode_url', ''),
                'x_fiscal_offline': bool(fiscal.get('is_contingencia', False)),
                'x_fiscal_qrcode_b64': qrcode_b64, 
            }

            pedido.write(valores)
            
            # commit para garantir persistência imediata antes do return
            request.env.cr.commit()

            _logger.info(f'✅ Pedido {documento_id} atualizado com sucesso.')

            return self._response_json({
                'status': 'sucesso',
                'documento_id': documento_id,
                'fiscal_status': valores['x_fiscal_status']
            })

        except Exception as e:
            _logger.error(f'❌ ERRO CRÍTICO NO WEBHOOK: {str(e)}', exc_info=True)
            # retornar erro JSON válido para o Laravel
            return self._response_json({'status': 'erro', 'mensagem': str(e)}, 500)

    def _response_json(self, data, status=200):
        """Helper para responder JSON corretamente em rota type='http'"""
        return request.make_response(
            json.dumps(data),
            headers=[('Content-Type', 'application/json')],
            status=status
        )