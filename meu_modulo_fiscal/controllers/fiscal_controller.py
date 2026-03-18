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
        """
        Recebe o webhook do middleware Laravel com o status da nota na SEFAZ.
        Esta rota é pública, mas a segurança pode ser estendida futuramente via token.
        """
        
        try:

            dados = request.get_json_data()
        
            if not dados:
                dados = {}
            
            _logger.info('=== WEBHOOK FISCAL RECEBIDO ===')
        

            documento_id = dados.get('documento_id')
            fiscal = dados.get('fiscal', {})

            # Validar se o middleware enviou a referência do pedido
            if not documento_id:
                return self._response_json({'status': 'erro', 'mensagem': 'documento_id não informado'}, 400)

            # Buscar o pedido correspondente no Odoo usando o pos_reference
            pedido = request.env['pos.order'].sudo().search([
                ('pos_reference', '=', documento_id)
            ], limit=1)

            # Caso o middleware notifique um pedido que ainda não sincronizou localmente ou não existe
            if not pedido:
                _logger.error(f'Pedido {documento_id} não encontrado')
                return self._response_json({
                    'status': 'erro', 
                    'mensagem': 'pedido_nao_encontrado',
                    'documento_id': documento_id
                }, 404)

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

            # Atualizar os dados fiscais diretamente no pedido do PDV
            pedido.write(valores)
            
            # Garantir a persistência no banco antes de retornar sucesso ao middleware
            request.env.cr.commit()

            return self._response_json({
                'status': 'sucesso',
                'documento_id': documento_id,
                'fiscal_status': valores['x_fiscal_status'],
                'contingencia?': valores['x_fiscal_offline']
            })

        except Exception as e:
            _logger.error(f'Erro no webhook: {str(e)}', exc_info=True)
            return self._response_json({'status': 'erro', 'mensagem': str(e)}, 500)

    def _response_json(self, data, status=200):
        """Helper para responder JSON corretamente em rota type='http'"""
        return request.make_response(
            json.dumps(data),
            headers=[('Content-Type', 'application/json')],
            status=status
        )