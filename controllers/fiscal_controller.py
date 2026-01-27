from odoo import http
from odoo.http import request
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
    def retorno_fiscal(self, **payload):

        # ==============================
        # 1. Ler JSON recebido
        # ==============================
        try:
            dados = request.get_json_data()
        except ValueError:
            dados = {}

        _logger.info('Webhook fiscal recebido: %s', dados)

        # ==============================
        # 2. Extrair dados principais
        # ==============================
        resposta_id = dados.get('documento_id')
        fiscal = dados.get('fiscal', {})

        if not resposta_id:
            return request.make_response(
                json.dumps({'status': 'erro', 'mensagem': 'documento_id_nao_informado'}),
                headers=[('Content-Type', 'application/json')],
                status=400
            )

        # ==============================
        # 3. Buscar pedido no POS
        # ==============================
        pedido = request.env['pos.order'].sudo().search(
            [('pos_reference', '=', resposta_id)],
            limit=1
        )

        if not pedido:
            _logger.error('Pedido não encontrado: %s', resposta_id)
            return request.make_response(
                json.dumps({
                    'status': 'erro',
                    'mensagem': 'pedido_nao_encontrado',
                    'documento_id': resposta_id
                }),
                headers=[('Content-Type', 'application/json')],
                status=404
            )

        # ==============================
        # 4. Dados fiscais recebidos
        # ==============================
        resposta_status        = fiscal.get('status')
        resposta_mensagem      = fiscal.get('mensagem')
        resposta_cod_erro      = fiscal.get('codigo_erro_sefaz')

        resposta_chave         = fiscal.get('chave_nfe')
        resposta_protocolo     = fiscal.get('protocolo')
        resposta_serie         = fiscal.get('serie')
        resposta_numero        = fiscal.get('numero_nota')

        resposta_qrcode        = fiscal.get('qrcode_url')
        resposta_url_consulta  = fiscal.get('url_consulta')

        resposta_contingencia  = fiscal.get('is_contingencia', False)

        # ==============================
        # 5. Atualizar pedido
        # ==============================
        pedido.write({
            'x_fiscal_status': resposta_status,
            'x_fiscal_mensagem': resposta_mensagem,

            'x_fiscal_chave': resposta_chave,
            'x_fiscal_protocolo': resposta_protocolo,
            'x_fiscal_numero': resposta_numero,
            'x_fiscal_serie': resposta_serie,

            'x_fiscal_qrcode_url': resposta_qrcode,
            'x_fiscal_url_consulta': resposta_url_consulta,

            'x_fiscal_offline': resposta_contingencia,


        })

        _logger.info('Pedido %s atualizado com sucesso', resposta_id)

        # ==============================
        # 6. Retorno para o middleware
        # ==============================
        return request.make_response(
            json.dumps({
                'status': 'recebido',
                'documento_id': resposta_id,
                'status_fiscal': resposta_status
            }),
            headers=[('Content-Type', 'application/json')]
        )
