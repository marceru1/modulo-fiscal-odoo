from odoo import http
from odoo.http import request, Response
import logging
import json

_logger = logging.getLogger(__name__)

# I8: limites de tamanho dos campos do webhook (defesa em profundidade).
# Valores maiores que o esperado indicam payload malformado ou abuso.
_MAXLEN_DOCUMENTO_ID = 50
_MAXLEN_CHAVE_NFE = 44
_MAXLEN_SERIE = 10
_MAXLEN_NUMERO_NOTA = 20
_MAXLEN_PROTOCOLO = 20
_MAXLEN_URL_CONSULTA = 500
_MAXLEN_QRCODE_URL = 500


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
            # I8: validação de token — compara header X-Webhook-Token com o
            # secret configurado em ir.config_parameter. Se o secret estiver
            # configurado e não bater, retorna 403 antes de processar o payload.
            expected_secret = request.env['ir.config_parameter'].sudo().get_param(
                'meu_modulo_fiscal.webhook_secret'
            )
            if expected_secret:
                received_token = request.httprequest.headers.get('X-Webhook-Token', '')
                if received_token != expected_secret:
                    _logger.warning(
                        '[API ODOO] Webhook rejeitado: token inválido (X-Webhook-Token não confere).'
                    )
                    return self._response_json(
                        {'status': 'erro', 'mensagem': 'token_invalido'}, 403
                    )

            # Interpreta o Body Payload
            dados = request.get_json_data()
            if not dados:
                dados = {}
            
            _logger.info('[API ODOO] Webhook de Retorno Fiscal (Callback) Recebido do Middleware.')

            documento_id = dados.get('documento_id')
            fiscal = dados.get('fiscal', {})

            # I8: valida que fiscal é dict (defesa contra payload malformado)
            if not isinstance(fiscal, dict):
                return self._response_json(
                    {'status': 'erro', 'mensagem': 'campo fiscal deve ser um objeto'}, 400
                )

            # I8: valida documento_id — string não vazia, máximo 50 chars
            if not documento_id or not isinstance(documento_id, str):
                return self._response_json(
                    {'status': 'erro', 'mensagem': 'documento_id não informado ou inválido no payload'}, 400
                )
            if len(documento_id) > _MAXLEN_DOCUMENTO_ID:
                return self._response_json(
                    {'status': 'erro', 'mensagem': 'documento_id excede o tamanho máximo de %d caracteres' % _MAXLEN_DOCUMENTO_ID}, 400
                )

            # I8: valida tamanhos dos campos do sub-objeto fiscal (defesa em profundidade)
            campo_tamanhos = {
                'chave_nfe': _MAXLEN_CHAVE_NFE,
                'serie': _MAXLEN_SERIE,
                'numero_nota': _MAXLEN_NUMERO_NOTA,
                'protocolo': _MAXLEN_PROTOCOLO,
                'url_consulta': _MAXLEN_URL_CONSULTA,
                'qrcode_url': _MAXLEN_QRCODE_URL,
            }
            for campo, max_len in campo_tamanhos.items():
                valor = fiscal.get(campo, '')
                if valor and isinstance(valor, str) and len(valor) > max_len:
                    return self._response_json(
                        {'status': 'erro', 'mensagem': 'campo %s excede o tamanho máximo de %d caracteres' % (campo, max_len)}, 400
                    )

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

            # Atualiza o high-water mark no pos.config (DEC-011 / ERROR-010)
            # Garante que o contador de contingência reflete orders autorizadas pelo middleware.
            numero_str = valores.get('x_fiscal_numero', '')
            serie_str = valores.get('x_fiscal_serie', '')
            if numero_str and serie_str and pedido.session_id:
                try:
                    numero_int = int(numero_str)
                    config = pedido.session_id.config_id
                    if config and numero_int > (config.x_contingencia_ultimo_numero or 0):
                        config.sudo().write({'x_contingencia_ultimo_numero': numero_int})
                        _logger.info(
                            '[CONTINGENCIA-HWM-CALLBACK] pos.config %d | série %s | HWM → %d',
                            config.id, serie_str, numero_int
                        )
                except (ValueError, TypeError):
                    pass
            
            # Flush garante que o SearchRead que roda no Browser (JS) com Polling
            # ache a linha atualizada na mesa do caixa, sem quebrar o gerenciamento
            # de transação do Odoo (substitui o cr.commit() manual).
            request.env.flush_all()

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