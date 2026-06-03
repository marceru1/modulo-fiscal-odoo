import json
import requests
from odoo import models, api, fields
import logging
import os

_logger = logging.getLogger(__name__)

BASE_URL = os.environ.get('MIDDLEWARE_URL', 'http://127.0.0.1:8000')
API_LARAVEL_URL = f"{BASE_URL}/api/odoo/webhook"
# Shared secret sent in X-Webhook-Token for the middleware security layer.
# Must match ODOO_WEBHOOK_SECRET set in the middleware .env.
# Leave empty if the middleware is on an internal-only network (no public domain).
WEBHOOK_SECRET = os.environ.get('MIDDLEWARE_WEBHOOK_SECRET', '')

class PosOrder(models.Model):
    """
    Extensão do modelo central de Vendas do PDV (pos.order).
    Responsável por armazenar meta-dados da NFC-e e despachar
    via Webhook para o Middleware Laravel.
    """
    _inherit = 'pos.order'

    # ==========================================================
    # DADOS CAPTURADOS DO CONSUMIDOR NA TELA DO CAIXA
    # ==========================================================
    x_cpf_nota = fields.Char(string="CPF na nota", help="CPF informado pelo cliente para a via do consumidor.")
    x_email_cliente = fields.Char(string="E-mail do cliente", help="Para envio do XML/Danfe contigenciado.")
    x_confirmacao_venda = fields.Boolean(string="Venda enviada?", help="Flag que dita se o PDV já sincronizou a criação offline dessa venda.")

    # ==========================================================
    # RETORNO FISCAL DO MIDDLEWARE (FOCUS NFE)
    # ==========================================================
    x_fiscal_status = fields.Char(string='Status Fiscal', help="Status Sefaz (autorizado, rejeitado, processando)")
    x_fiscal_mensagem = fields.Text(string='Mensagem Fiscal', help="Motivo da rejeição ou mensagem sucesso Sefaz")
    x_fiscal_chave = fields.Char(string='Chave de Acesso', help="Chave de 44 dígitos da NFC-e")
    x_fiscal_protocolo = fields.Char(string='Protocolo', help="Protocolo de Autorização de Uso")
    x_fiscal_numero = fields.Char(string='Número da NFCe', help="Número sequencial do documento fiscal")
    x_fiscal_serie = fields.Char(string='Série', help="Série do documento fiscal emissor")
    
    x_fiscal_qrcode_url = fields.Char(string='URL do QR Code', help="Link direto oficial para o QR Code da Sefaz")
    x_fiscal_qrcode_b64 = fields.Text(string='QR Code Base64', help='QR Code fiscal gerado offline convertido em base64')
    
    x_fiscal_url_consulta = fields.Char(string='URL de Consulta', help="URL SEFAZ para consultar a chave na web")
    x_fiscal_url_pdf = fields.Char(string='Link do PDF (Danfe)', help="Download do Cupom fiscal gerado")
    x_fiscal_url_xml = fields.Char(string='Link do XML', help="Download do XML de emissão oficial")

    # ==========================================================
    # CONTROLE DE CONTINGÊNCIA E OFFLINE
    # ==========================================================
    x_fiscal_offline = fields.Boolean(string='Emitido em Contingência?', default=False, help="Marca se essa NFC-e foi emitida pelo Odoo PDV Offline Mode")
    x_contingencia_payload = fields.Text(string='Payload Contingência Offline', default='', help="Dados JSON gerados offline (numero, serie, codigo_unico)")

    @api.model
    def _order_fields(self, ui_order):
        """
        Interpreta e intercepta os dados disparados do Browser pelo Odoo JS (Owl) 
        antes que o Odoo os salve no Python/Postgres.

        IMPORTANTE: Todos os campos fiscais da contingência offline precisam ser
        sincronizados aqui. Sem isso, x_fiscal_numero fica NULL no banco e o seed
        de numeração retorna 0 ao abrir novo browser (causa raiz do ERROR-010).
        """
        vals = super(PosOrder, self)._order_fields(ui_order)
        
        campos_para_sincronizar = [
            'x_cpf_nota', 'x_email_cliente', 'x_contingencia_payload',
            'x_fiscal_numero', 'x_fiscal_serie', 'x_fiscal_status',
            'x_fiscal_chave', 'x_fiscal_mensagem',
            'x_fiscal_qrcode_url', 'x_fiscal_qrcode_b64',
        ]
        for campo in campos_para_sincronizar:
            if campo in ui_order:
                vals[campo] = ui_order.get(campo)
                
        if 'x_confirmacao_venda' in ui_order:
            vals['x_confirmacao_venda'] = bool(ui_order.get('x_confirmacao_venda'))

        if 'x_fiscal_offline' in ui_order:
            vals['x_fiscal_offline'] = bool(ui_order.get('x_fiscal_offline'))

        return vals

    @api.model_create_multi
    def create(self, vals_list):
        """
        Após criar o(s) pedido(s), atualiza o high-water mark de contingência
        no pos.config correspondente. Garante que o seed nunca fique atrás
        do último número realmente emitido, mesmo se o localStorage for limpo.

        DEC-011 | ERROR-010
        """
        orders = super().create(vals_list)

        for order in orders:
            if not order.x_fiscal_offline or not order.x_fiscal_numero:
                continue
            try:
                numero = int(order.x_fiscal_numero)
            except (ValueError, TypeError):
                continue

            config = order.session_id.config_id
            if config and numero > (config.x_contingencia_ultimo_numero or 0):
                config.sudo().write({'x_contingencia_ultimo_numero': numero})
                _logger.info(
                    '[CONTINGENCIA-HWM] pos.config %d | Série %s | High-water mark → %d',
                    config.id, order.x_fiscal_serie, numero
                )

        return orders

    def _prepare_nfce_payload(self):
        """
        Monta o dicionário de dados da venda para enviar ao Middleware.
        """
        pagamentos = [{
            'tipo': p.payment_method_id.name,
            'valor': p.amount,
        } for p in self.payment_ids]

        dados_dos_produtos = []
        for i, line in enumerate(self.lines, start=1):
            product = line.product_id
            valor_bruto = line.price_unit * line.qty
            valor_liq = line.price_subtotal_incl 
            desconto = max(0.0, valor_bruto - valor_liq)

            item = {
                'numero_item': i,
                'codigo_produto': product.default_code or str(product.id),
                'descricao': product.name,
                'codigo_barras': product.barcode or 'SEM GTIN',
                'codigo_ncm': product.x_ncm_id.code if product.x_ncm_id else '', 
                'cfop': product.x_cfop, 
                'quantidade_comercial': line.qty,
                'quantidade_tributavel': line.qty,
                'unidade_comercial': line.product_uom_id.name,
                'unidade_tributavel': line.product_uom_id.name,
                'valor_unitario_comercial': line.price_unit,
                'valor_unitario_tributavel': line.price_unit,
                'valor_bruto': valor_bruto,
                'icms_origem': product.x_origem,
                'icms_situacao_tributaria': product.x_icms,
                'pis_situacao_tributaria': product.x_pis,
                'cofins_situacao_tributaria': product.x_cofins,
            }
            if desconto > 0:
                item['valor_desconto'] = desconto

            dados_dos_produtos.append(item)

        return {
            'venda': {
                'id_odoo': self.name,
                'data': self.date_order,
                'total': self.amount_total,
                'numero_caixa': self.user_id.name,
                'numero_ordem': self.pos_reference,
            },
            'cliente': {
                'nome': 'CONSUMIDOR FINAL',
                'cpf': self.x_cpf_nota or None,
                # 'email': self.x_email_cliente or None,  # REMOVIDO: Email não é mais coletado no PDV
            },
            'produtos': dados_dos_produtos,
            'pagamentos': pagamentos,
            'fiscal': {
                'estado': self.company_id.state_id.code or 'AM',
                'cnpj_emitente': self.company_id.vat or '',
                'modelo': '65',
            },
            'confirmacao_venda': bool(self.x_confirmacao_venda), 
            'contingencia': {
                'ativa': bool(self.x_fiscal_offline),
                'payload': self.x_contingencia_payload or None,
            },
        }

    def action_pos_order_paid(self):
        """
        Sobrescreve a ação de pagamento finalizado disparando o webhook.
        """
        res = super(PosOrder, self).action_pos_order_paid()

        for order in self:
            if not order.x_confirmacao_venda:
                _logger.info(f'[ODOO -> MIDDLEWARE] Venda {order.pos_reference} finalizada sem NFC-e (não fiscal).')
                continue

            try:
                payload = order._prepare_nfce_payload()
                json_payload = json.dumps(payload, default=str)
            
                headers = {
                    'Content-Type': 'application/json',
                    'Accept': 'application/json',
                }

                if WEBHOOK_SECRET:
                    headers['X-Webhook-Token'] = WEBHOOK_SECRET

                response = requests.post(API_LARAVEL_URL, data=json_payload, headers=headers, timeout=5)

                if 200 <= response.status_code < 300:
                    _logger.info(f"[MIDDLEWARE-WEBHOOK] Sucesso. Pedido despachado: {order.name}.")
                else:
                    _logger.warning(
                        f"[MIDDLEWARE-WEBHOOK] Erro ({response.status_code}) ao despachar pedido {order.name}. "
                        f"Resposta: {response.text[:2000]}"
                    )
                    
            except requests.exceptions.Timeout:
                _logger.error(f"[MIDDLEWARE-WEBHOOK] Timeout (5s) excedido para {order.name}.")
            except requests.exceptions.RequestException as e:
                _logger.error(f"[MIDDLEWARE-WEBHOOK] Falha crítica de conexão para {order.name}: {e}.")
            except Exception as e:
                _logger.error(f"[MIDDLEWARE-WEBHOOK] Erro interno ao empacotar {order.name}: {e}.")
        
        return res

class PosConfig(models.Model):
    """Extensão do pos.config para persistir o contador de contingência (DEC-011)."""
    _inherit = 'pos.config'


    x_fiscal_payment_method_ids = fields.Many2many(
        'pos.payment.method',
        'pos_config_fiscal_payment_rel',
        'config_id',
        'payment_method_id',
        string='Formas de pagamento fiscais',
        help='Formas de pagamento que vao disparar emissao de nfce'
    )

    x_contingencia_ultimo_numero = fields.Integer(
        string='Último Nº Contingência',
        default=0,
        help='High-water mark: maior número de NFC-e emitido em contingência '
             'nesta série. Atualizado automaticamente a cada sync de venda offline. '
             'Nunca decrementar manualmente.'
    )

    def get_ultimo_numero_contingencia(self):
        """
        RPC público para o JS consultar o contador atualizado em tempo real.
        Chamado antes de cada emissão offline como última linha de defesa
        contra duplicidade de numeração.

        Returns:
            int: Maior número já emitido para a série deste caixa.
        """
        self.ensure_one()
        # Série de contingência OFFLINE: 700 + ID do caixa (separada da série online 600+ID)
        # DEC-012: séries online (6xx) e offline (7xx) são namespaces distintos
        serie = str(700 + self.id)

        # Dupla verificação: high-water mark do config + scan de segurança no pos.order
        hwm = self.x_contingencia_ultimo_numero or 0

        ultimo_do_banco = 0
        pedidos = self.env['pos.order'].sudo().search(
            [('x_fiscal_serie', '=', serie)],
            order='id desc',
            limit=50
        )
        for pedido in pedidos:
            try:
                n = int(pedido.x_fiscal_numero or 0)
                if n > ultimo_do_banco:
                    ultimo_do_banco = n
            except (ValueError, TypeError):
                continue

        resultado = max(hwm, ultimo_do_banco)

        # Se o scan achou um número maior, corrige o high-water mark
        if resultado > hwm:
            self.sudo().write({'x_contingencia_ultimo_numero': resultado})

        _logger.info(
            '[CONTINGENCIA-RPC] config_id=%d | série=%s | hwm=%d | scan=%d | resultado=%d',
            self.id, serie, hwm, ultimo_do_banco, resultado
        )
        return resultado


class PosSession(models.Model):
    _inherit = 'pos.session'

    def _loader_params_pos_order(self):
        params = super()._loader_params_pos_order()
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
            'x_contingencia_payload',
        ])
        return params

    def _load_pos_data(self, data):
        """
        Injeta o 'seed' de numeração de contingência no payload de abertura da sessão.

        Usa o high-water mark persistido no pos.config (DEC-011) como fonte primária,
        com scan de segurança no pos.order como fallback. Isso garante que mesmo
        orders cujo x_fiscal_numero foi escrito pelo callback do middleware (e não
        pelo _order_fields) sejam contabilizadas.

        DEC-010 | DEC-011 | ERROR-008 | ERROR-010
        """
        result = super()._load_pos_data(data)

        config = self.config_id
        # Série de contingência OFFLINE: 700 + ID do caixa (separada da série online 600+ID)
        # DEC-012: séries online (6xx) e offline (7xx) são namespaces distintos
        serie_contingencia = str(700 + config.id)

        # Fonte primária: high-water mark do pos.config (atualizado a cada sync)
        hwm = config.x_contingencia_ultimo_numero or 0

        # Fonte secundária: scan do pos.order (captura updates feitos pelo callback
        # do middleware que não passam pelo create/write do POS)
        ultimos_pedidos = self.env['pos.order'].sudo().search(
            [('x_fiscal_serie', '=', serie_contingencia)],
            order='id desc',
            limit=50
        )

        ultimo_do_scan = 0
        for pedido in ultimos_pedidos:
            try:
                n = int(pedido.x_fiscal_numero or 0)
                if n > ultimo_do_scan:
                    ultimo_do_scan = n
            except (ValueError, TypeError):
                continue

        ultimo_numero = max(hwm, ultimo_do_scan)

        # Corrige drift se o scan achou número maior que o high-water mark
        if ultimo_numero > hwm:
            config.sudo().write({'x_contingencia_ultimo_numero': ultimo_numero})

        result['data'][0]['_ultimo_numero_contingencia'] = ultimo_numero
        result['data'][0]['_serie_contingencia'] = serie_contingencia

        _logger.info(
            '[CONTINGENCIA-SEED] Caixa ID=%d | Série=%s | HWM=%d | Scan=%d | Seed final=%d',
            config.id, serie_contingencia, hwm, ultimo_do_scan, ultimo_numero
        )

        for session in result['data']:
            if session['id'] == self.id:
                session['_fiscal_payment_method_ids'] = self.config_id.x_fiscal_payment_method_ids.ids

        return result
