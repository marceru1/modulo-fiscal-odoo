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
    x_amount_other_value = fields.Float(
        string="Outras Despesas (vOutro)",
        digits=(16, 2),
        help="Outras despesas acessórias cobradas na venda — mapeia para vOutro do XML SEFAZ.",
    )
    x_discount_value = fields.Float(
        string="Desconto (R$)",
        digits=(16, 2),
        help="Desconto em valor fixo aplicado na venda — mapeia para vDesc do XML SEFAZ.",
    )

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
            'x_amount_other_value', 'x_discount_value',
        ]
        for campo in campos_para_sincronizar:
            if campo in ui_order:
                vals[campo] = ui_order.get(campo)
                
        if 'x_confirmacao_venda' in ui_order:
            vals['x_confirmacao_venda'] = bool(ui_order.get('x_confirmacao_venda'))

        if 'x_fiscal_offline' in ui_order:
            vals['x_fiscal_offline'] = bool(ui_order.get('x_fiscal_offline'))

        return vals

    def _compute_prices(self):
        """
        Sobrescreve o cálculo de preços para embutir o acréscimo
        no amount_total e atualizar a diferença de pagamento.
        Também subtrai o desconto fixo (x_discount_value) do amount_total.
        """
        super()._compute_prices()
        for order in self:
            if order.x_amount_other_value:
                order.amount_total += order.x_amount_other_value
            if order.x_discount_value:
                order.amount_total -= order.x_discount_value

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

        # Identifica o produto de desconto global (pos_discount) para filtrar do payload.
        # No padrão SEFAZ, desconto é vDesc (campo de total), não item fiscal.
        discount_product_id = self.config_id.discount_product_id.id if self.config_id.discount_product_id else None
        dados_dos_produtos = []
        desconto_global = 0.0
        item_num = 0
        for line in self.lines:
            product = line.product_id

            # Filtra linha de desconto global — não é item fiscal (vDesc, não item)
            if discount_product_id and product.id == discount_product_id:
                desconto_global += abs(line.price_subtotal_incl)
                continue

            item_num += 1
            valor_bruto = line.price_unit * line.qty
            valor_liq = line.price_subtotal_incl
            desconto = max(0.0, valor_bruto - valor_liq)

            item = {
                'numero_item': item_num,
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
                'x_amount_other_value': self.x_amount_other_value,
                'desconto_global': self.x_discount_value,
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
            'x_amount_other_value',
            'x_discount_value',
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

    def get_fechamento_data(self):
        """
        Coleta todos os dados necessários para o relatório de fechamento
        de caixa impresso na impressora térmica do PDV.

        Reaproveita a lógica do get_closing_control_data do core e adiciona:
        - Dados da empresa (razão social, CNPJ, IE, endereço)
        - Usuário e datas de abertura/fechamento
        - Fundo de caixa
        - Vendas agrupadas por método de pagamento
        - Sangrias (cash in/out) com motivo e valor
        - Saldo de movimentação (entradas - saídas)
        - Saldo detalhado por método (calculado, informado=0, diferença)

        Returns:
            dict: Estrutura completa para renderizar o template FechamentoReceipt.
        """
        self.ensure_one()
        company = self.config_id.company_id

        # Reaproveita os dados que o core já calcula
        closing_data = self.get_closing_control_data()

        # === EMPRESA ===
        empresa = {
            'nome': company.name or '',
            'cnpj': (company.x_cnpj or '').strip(),
            'ie': (company.x_ie or '').strip(),
            'endereco_linha1': (company.x_endereco_linha1 or '').strip(),
            'endereco_linha2': (company.x_endereco_linha2 or '').strip(),
            'telefone': company.phone or '',
        }

        # === USUÁRIO E DATAS ===
        identificacao = {
            'usuario': self.user_id.name or '',
            'data_abertura': (self.start_at or '').strftime('%d/%m/%Y %H:%M:%S') if self.start_at else '',
            'data_fechamento': (self.stop_at or '').strftime('%d/%m/%Y %H:%M:%S') if self.stop_at else '',
            'fundo_caixa': self.cash_register_balance_start or 0.0,
        }

        # === VENDAS POR MÉTODO ===
        metodos_pagamento = []

        # Cash (do default_cash_details)
        cash_details = closing_data.get('default_cash_details', {})
        if cash_details:
            metodos_pagamento.append({
                'nome': cash_details.get('name', 'Dinheiro'),
                'valor': cash_details.get('payment_amount', 0.0),
            })

        # Non-cash (cartões, pix, etc)
        for pm in closing_data.get('non_cash_payment_methods', []):
            metodos_pagamento.append({
                'nome': pm.get('name', ''),
                'valor': pm.get('amount', 0.0),
            })

        total_vendas = sum(m['valor'] for m in metodos_pagamento)

        # === SANGRIAS (Cash In/Out) ===
        sangrias = []
        for move in cash_details.get('moves', []):
            sangrias.append({
                'motivo': move.get('name', ''),
                'valor': abs(move.get('amount', 0.0)),
            })
        total_sangrias = sum(s['valor'] for s in sangrias)

        # === SALDO DE MOVIMENTAÇÃO ===
        entradas = total_vendas + (identificacao['fundo_caixa'] or 0.0)
        saidas = total_sangrias
        saldo_caixa = entradas - saidas

        # === SALDO DETALHADO POR MÉTODO ===
        # Calculado/Sistema = valor do sistema
        # Informado = 0 (operador preenche na hora — por enquanto 0)
        # Diferença = informado - calculado = -calculado (por enquanto)
        saldo_detalhado = []
        for metodo in metodos_pagamento:
            valor_sistema = metodo['valor']
            saldo_detalhado.append({
                'nome': metodo['nome'],
                'calculado': valor_sistema,
                'informado': 0.0,
                'diferenca': 0.0 - valor_sistema,
            })

        return {
            'empresa': empresa,
            'identificacao': identificacao,
            'metodos_pagamento': metodos_pagamento,
            'total_vendas': total_vendas,
            'sangrias': sangrias,
            'total_sangrias': total_sangrias,
            'saldo_movimentacao': {
                'entradas': entradas,
                'saidas': saidas,
                'saldo': saldo_caixa,
            },
            'saldo_detalhado': saldo_detalhado,
        }
