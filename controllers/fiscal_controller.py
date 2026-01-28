from odoo import http
from odoo.http import request
import logging
import json

import base64
from io import BytesIO
try:
    import qrcode
except ImportError:
    qrcode = None


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


        
        # ==============================
        # 5. Atualizar pedido
        # ==============================
        
        url_qrcode = fiscal.get('qrcode_url')

        valores_update = {
            'x_fiscal_status': fiscal.get('status'),
            'x_fiscal_mensagem': fiscal.get('mensagem'),
            'x_fiscal_chave': fiscal.get('chave_nfe'),
            'x_fiscal_protocolo': fiscal.get('protocolo'),
            'x_fiscal_numero': fiscal.get('numero_nota'),
            'x_fiscal_serie': fiscal.get('serie'),
            'x_fiscal_url_consulta': fiscal.get('url_consulta'),
            'x_fiscal_offline': fiscal.get('is_contingencia', False),
            'x_fiscal_qrcode_url': url_qrcode,
        }

        if url_qrcode:
            qrcode_b64 = self.gerar_qrcode_base64(url_qrcode)
            if qrcode_b64:
                valores_update['x_fiscal_qrcode_b64'] = qrcode_b64

        pedido.write(valores_update)


        _logger.info('Pedido %s atualizado com sucesso', resposta_id)

        # ==============================
        # 6. Retorno para o middleware
        # ==============================
        return request.make_response(
            json.dumps({
                'status': 'recebido',
                'documento_id': resposta_id,

            }),
            headers=[('Content-Type', 'application/json')]
        )
    
    def gerar_qrcode_base64(self, texto):

        if not qrcode:
            _logger.error("Biblioteca qrcode não instalada")
            return False

        try:
            qr = qrcode.QRCode(
                version=1,
                error_correction=qrcode.constants.ERROR_CORRECT_L,
                box_size=4,
                border=2,
            )

            qr.add_data(texto)
            qr.make(fit=True)

            img = qr.make_image(fill_color="black", back_color="white")

            buffer = BytesIO()
            img.save(buffer, format="PNG")

            # ⚠️ BASE64 PURO — SEM data:image/png;base64
            return base64.b64encode(buffer.getvalue()).decode()

        except Exception as e:
            _logger.error("Erro ao gerar QR Code: %s", e)
            return False
