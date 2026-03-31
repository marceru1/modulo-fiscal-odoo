from odoo import http
from odoo.http import request, Response
import logging
import json

_logger = logging.getLogger(__name__)

class FiscalWebhookController(http.Controller):
    """
    Controller exposto pelo Odoo para atuar no sentido inverso (Inbound) do ecossistema.
    Se o 'models/pos_order.py' fala com o Laravel, este Controller "ouve" o Laravel.
    Ele é o Endpoint encarregado de destrinchar o Callback assíncrono que traz a Chave de Acesso e QR Code gerados no Focus.
    """

    @http.route(
        '/api/retorno-fiscal',
        type='http',  
        auth='public',
        methods=['POST'],
        csrf=False
    )
    def retorno_fiscal(self, **kw):
        """
        Recebe o Webhook POST do Middleware contendo o JSON com o status final da emissão Sefaz.
        Rota exposta publicamente na API do ERP (Requer proteção de IP/Token em produção de fato).
        """
        
        try:
            # Interpreta o Body Payload
            dados = request.get_json_data()
            if not dados:
                dados = {}
            
            _logger.info('[API ODOO] Webhook de Retorno Fiscal (Callback) Recebido do Middleware.')

            documento_id = dados.get('documento_id')
            fiscal = dados.get('fiscal', {})

            # Validação primária de rastreio
            if not documento_id:
                return self._response_json({'status': 'erro', 'mensagem': 'documento_id não informado no payload'}, 400)

            # Busca no Postgres o objeto Pedido original do PDV (pos.order) usando a string do pos_reference
            pedido = request.env['pos.order'].sudo().search([
                ('pos_reference', '=', documento_id)
            ], limit=1)

            # Se o Webhook do Laravel chegar ANTES do Odoo persistir o fechamento de caixa, dá 404 pro Laravel retentar.
            if not pedido:
                _logger.error(f'[API ODOO] Pedido {documento_id} não encontrado na Base de Dados. Atraso de Sincronização ou Inexistente.')
                return self._response_json({
                    'status': 'erro', 
                    'mensagem': 'pedido_nao_encontrado',
                    'documento_id': documento_id
                }, 404)

            # Se o QR estiver offline (Contingência), ele vem no Payload e precisa atualizar vazio ou Base64  
            qrcode_b64 = fiscal.get('qrcode_b64', '')
            
            # Mapeamento do Dicionário de Injeção
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

            # Aciona o ORM para escrever os metadados devolvidos direto no Pedido Odoo
            pedido.write(valores)
            
            # Força o Commit (Flush) no Postgres pra garantir que o `SearchRead` que roda lá Browser (JS) com Polling ache a linha atualizada na mesa do caixa.
            request.env.cr.commit()

            return self._response_json({
                'status': 'sucesso',
                'documento_id': documento_id,
                'fiscal_status': valores['x_fiscal_status'],
                'contingencia?': valores['x_fiscal_offline']
            })

        except Exception as e:
            _logger.error(f'[API ODOO] Erro Interno ao absorver webhook do middleware: {str(e)}', exc_info=True)
            return self._response_json({'status': 'erro', 'mensagem': str(e)}, 500)

    def _response_json(self, data, status=200):
        """Helper para Odoo fabricar o Objeto Python em formato Response JSON na rota controller."""
        return request.make_response(
            json.dumps(data),
            headers=[('Content-Type', 'application/json')],
            status=status
        )