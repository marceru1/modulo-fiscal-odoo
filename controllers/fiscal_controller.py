from odoo import http
from odoo.http import request
import logging
import json  

_logger = logging.getLogger(__name__)
# aqui recebe o que volta do middleware
class FiscalWebhookController(http.Controller):

    @http.route(
        '/api/retorno-fiscal',
        type='http',
        auth='public',
        methods=['POST'],
        csrf=False
    )
    def retorno_fiscal(self, **payload):
    
        try:
            dados = request.get_json_data()
        except ValueError:
        
            dados = {}

        _logger.info('Webhook fiscal recebido: %s', dados)

   
        documento_id = dados.get('documento_id')
        
   
        return request.make_response(
            json.dumps({'status': 'recebido', 'id_processado': documento_id}), 
            headers=[('Content-Type', 'application/json')]
        )