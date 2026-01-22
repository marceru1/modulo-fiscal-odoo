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

        ## aqui ele destrincha a mensagem que chegou do laravel
        # pega 
        resposta_id = dados.get('documento_id')
        resposta_mensagem = dados.get('mensagem')

        _logger.info('=================== TESTE PRA SABER SE CRIOU A VARIAVEL %s', resposta_id)

        _logger.info('=================== TESTE PRA SABER SE CRIOU A VARIAVEL %s', resposta_mensagem)
        
        
        pedido = request.env['pos.order'].sudo().search([('pos_reference', '=', resposta_id)], limit=1)

        
        pedido.write({
            'x_fiscal_mensagem': resposta_mensagem,
        })

        
        _logger.info(
            'Pedido atualizado com status fiscal ',
        )

        
   
        return request.make_response(
            json.dumps({'status': 'recebido', 'id_processado': resposta_id}), 
            headers=[('Content-Type', 'application/json')]
        )