import json
import requests
from odoo import models, api, fields
from datetime import datetime
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
    # HELPERS DE CONFIGURAÇÃO (I7)
    # Lê parâmetros em runtime via ir.config_parameter em vez das
    # constantes globais cacheadas na importação do módulo.
    # ==========================================================
    @api.model
    def _get_middleware_url(self):
        """Devolve a URL base do middleware lida em runtime.

        Prefere ir.config_parameter; faz fallback para a constante
        global BASE_URL (lida de os.environ) para não quebrar installs
        existentes que ainda não migraram.
        """
        param = self.env['ir.config_parameter'].sudo().get_param(
            'meu_modulo_fiscal.middleware_url'
        )
        return param or BASE_URL

    @api.model
    def _get_webhook_secret(self):
        """Devolve o shared secret do webhook lido em runtime.

        Prefere ir.config_parameter; faz fallback para a constante
        global WEBHOOK_SECRET (lida de os.environ) para não quebrar
        installs existentes.
        """
        param = self.env['ir.config_parameter'].sudo().get_param(
            'meu_modulo_fiscal.webhook_secret'
        )
        if param is not None and param != '':
            return param
        return WEBHOOK_SECRET

    @api.model
    def _get_webhook_timeout(self):
        """Devolve o timeout (em segundos) do webhook lido em runtime.

        Prefere ir.config_parameter; faz fallback para 5 (valor histórico
        hardcoded) para não quebrar installs existentes que ainda não migraram.
        """
        param = self.env['ir.config_parameter'].sudo().get_param(
            'meu_modulo_fiscal.webhook_timeout'
        )
        try:
            return float(param) if param is not None and param != '' else 5
        except (ValueError, TypeError):
            return 5

    # ==========================================================
    # HELPER DE FUNCIONÁRIO (I10)
    # Busca o hr.employee vinculado a um res.partner.
    # ==========================================================
    @api.model
    def _find_employee_for_partner(self, partner_id):
        """Devolve o hr.employee vinculado ao partner_id, ou recordset vazio.

        Busca pelo contato de trabalho (work_contact_id) ou pelo partner
        do usuário (user_id.partner_id). Usado por _register_prazo_movimentacoes
        e create_recebimento para evitar a duplicação da busca.

        Args:
            partner_id (int): ID do res.partner.

        Returns:
            hr.employee recordset (limit=1): vazio se não houver vínculo.
        """
        if not partner_id:
            return self.env['hr.employee']
        return self.env['hr.employee'].search([
            '|',
            ('work_contact_id', '=', partner_id),
            ('user_id.partner_id', '=', partner_id),
        ], limit=1)

    # ==========================================================
    # DADOS CAPTURADOS DO CONSUMIDOR NA TELA DO CAIXA
    # ==========================================================
    x_cpf_nota = fields.Char(string="CPF na nota", help="CPF informado pelo cliente para a via do consumidor.")
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
            'x_cpf_nota', 'x_contingencia_payload',
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

    def _register_prazo_movimentacoes(self):
        """
        Para cada pedido do recordset, verifica se há pagamentos pay_later
        vinculados a um funcionário (hr.employee) e registra a movimentação
        correspondente em x.prazo.movimentacao.

        - Valor positivo → tipo='compra'  (funcionário comprou a prazo)
        - Valor negativo → tipo='pagamento' (recebimento: funcionário pagou no PDV)

        Clientes que não são funcionários são ignorados silenciosamente.
        Duplicatas são evitadas verificando pos_reference antes de inserir.
        """
        for order in self:
            partner = order.partner_id
            if not partner:
                continue

            # Encontra o funcionário vinculado ao parceiro (I10: helper extraído)
            employee = self._find_employee_for_partner(partner.id)
            if not employee:
                continue  # Não é funcionário — ignora

            for payment in order.payment_ids:
                if payment.payment_method_id.type != 'pay_later':
                    continue

                amount = payment.amount
                if amount == 0:
                    continue

                # Evita duplicatas: verifica se já existe movimentação para este pedido
                ref = order.pos_reference or order.name
                existing = self.env['x.prazo.movimentacao'].search(
                    [('pos_reference', '=', ref)], limit=1
                )
                if existing:
                    continue

                tipo = 'compra' if amount > 0 else 'pagamento'
                self.env['x.prazo.movimentacao'].create({
                    'employee_id': employee.id,
                    'partner_id': partner.id,
                    'data': order.date_order or fields.Datetime.now(),
                    'valor': abs(amount),
                    'tipo': tipo,
                    'pos_reference': ref,
                    'session_id': order.session_id.id if order.session_id else False,
                })
                _logger.info(
                    '[PRAZO] Movimentação %s registrada | Funcionário: %s | Valor: %.2f | Pedido: %s',
                    tipo, employee.name, abs(amount), ref
                )

    @api.model_create_multi
    def create(self, vals_list):
        """
        Após criar o(s) pedido(s), atualiza o high-water mark de contingência
        no pos.config correspondente. Garante que o seed nunca fique atrás
        do último número realmente emitido, mesmo se o localStorage for limpo.

        Também registra movimentações A Prazo para pagamentos pay_later
        vinculados a funcionários (Task 9).

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

        orders._register_prazo_movimentacoes()

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
        # Duplicação intencional: mesma lógica de filtro existe em export_data.js
        # export_for_printing (frontend) e aqui (backend) — ver skill brazilian-fiscal-nfe.
        # A duplicação é aceitável porque o backend alimenta o webhook (Focus NFe) e o
        # frontend monta o DANFE impresso — contextos distintos, sem shared runtime.
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
                'numero_caixa': self.session_id.config_id.id,
                'numero_ordem': self.pos_reference,
                'x_amount_other_value': self.x_amount_other_value,
                'desconto_global': self.x_discount_value,
            },
            'cliente': {
                'nome': 'CONSUMIDOR FINAL',
                'cpf': self.x_cpf_nota or None,
            },
            'produtos': dados_dos_produtos,
            'pagamentos': pagamentos,
            'fiscal': {
                'estado': self.company_id.state_id.code or 'AM',
                'cnpj_emitente': self.company_id.vat or '',
                # TODO: tornar configurável se suportar NF-e (55) no futuro
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

                # I7: lê URL e secret em runtime via ir.config_parameter,
                # com fallback para as constantes globais (compat retrógrada).
                middleware_url = order._get_middleware_url()
                api_url = f"{middleware_url}/api/odoo/webhook"
                webhook_secret = order._get_webhook_secret()

                headers = {
                    'Content-Type': 'application/json',
                    'Accept': 'application/json',
                }

                if webhook_secret:
                    headers['X-Webhook-Token'] = webhook_secret

                # N10: timeout configurável via ir.config_parameter (default 5s)
                webhook_timeout = order._get_webhook_timeout()
                response = requests.post(api_url, data=json_payload, headers=headers, timeout=webhook_timeout)

                if 200 <= response.status_code < 300:
                    _logger.info(f"[MIDDLEWARE-WEBHOOK] Sucesso. Pedido despachado: {order.name}.")
                else:
                    _logger.warning(
                        f"[MIDDLEWARE-WEBHOOK] Erro ({response.status_code}) ao despachar pedido {order.name}. "
                        f"Resposta: {response.text[:2000]}"
                    )
                    
            except requests.exceptions.Timeout:
                _logger.error(f"[MIDDLEWARE-WEBHOOK] Timeout excedido para {order.name}.")
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

    def _get_max_numero_contingencia(self, serie):
        """
        Helper compartilhado (I6) que devolve o maior número de NFC-e emitido
        em contingência para uma série, cruzando duas fontes:

          1. High-water mark persistido no pos.config (x_contingencia_ultimo_numero)
          2. Scan de segurança nos pos.order da série (captura updates feitos pelo
             callback do middleware que não passam pelo create/write do POS)

        Se o scan achar um número maior que o HWM, o HWM é corrigido em-place.

        Args:
            serie (str): série de contingência (ex: "700" + config_id).

        Returns:
            tuple[int, int, int]: (resultado, hwm, scan) — resultado=max(hwm, scan).
                Devolve hwm e scan separadamente para logging detalhado nos callers.
        """
        self.ensure_one()
        # Fonte primária: high-water mark do pos.config (atualizado a cada sync)
        hwm = self.x_contingencia_ultimo_numero or 0

        # Fonte secundária: scan do pos.order (captura updates feitos pelo callback
        # do middleware que não passam pelo create/write do POS)
        pedidos = self.env['pos.order'].sudo().search(
            [('x_fiscal_serie', '=', serie)],
            order='id desc',
            limit=50
        )
        scan = 0
        for pedido in pedidos:
            try:
                n = int(pedido.x_fiscal_numero or 0)
                if n > scan:
                    scan = n
            except (ValueError, TypeError):
                continue

        resultado = max(hwm, scan)

        # Corrige drift se o scan achou número maior que o high-water mark
        if resultado > hwm:
            self.sudo().write({'x_contingencia_ultimo_numero': resultado})

        return resultado, hwm, scan

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

        # I6: scan delegado ao helper compartilhado _get_max_numero_contingencia
        resultado, hwm, scan = self._get_max_numero_contingencia(serie)

        _logger.info(
            '[CONTINGENCIA-RPC] config_id=%d | série=%s | hwm=%d | scan=%d | resultado=%d',
            self.id, serie, hwm, scan, resultado
        )
        return resultado


class PosSession(models.Model):
    _inherit = 'pos.session'

    # ==========================================================
    # HELPER DE FUNCIONÁRIO (I10)
    # Espelha o helper de PosOrder para que create_recebimento possa
    # buscar hr.employee por partner sem duplicar a busca.
    # ==========================================================
    @api.model
    def _find_employee_for_partner(self, partner_id):
        """Devolve o hr.employee vinculado ao partner_id, ou recordset vazio.

        Busca pelo contato de trabalho (work_contact_id) ou pelo partner
        do usuário (user_id.partner_id). Usado por create_recebimento.

        Args:
            partner_id (int): ID do res.partner.

        Returns:
            hr.employee recordset (limit=1): vazio se não houver vínculo.
        """
        if not partner_id:
            return self.env['hr.employee']
        return self.env['hr.employee'].search([
            '|',
            ('work_contact_id', '=', partner_id),
            ('user_id.partner_id', '=', partner_id),
        ], limit=1)

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

        # I6: scan delegado ao helper compartilhado _get_max_numero_contingencia.
        # Antes o scan era duplicado aqui e em get_ultimo_numero_contingencia.
        ultimo_numero, hwm, ultimo_do_scan = config._get_max_numero_contingencia(serie_contingencia)

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
            'data_abertura': self.start_at.strftime('%d/%m/%Y %H:%M:%S') if self.start_at else '',
            'data_fechamento': self.stop_at.strftime('%d/%m/%Y %H:%M:%S') if self.stop_at else datetime.now().strftime('%d/%m/%Y %H:%M:%S'),
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

        # === VENDAS A PRAZO, SANGRIAS/SUPRIMENTOS, RECEBIMENTOS (helpers) ===
        orders = self._get_closed_orders()
        qtd_vendas = len(orders)
        identificacao['qtd_vendas'] = qtd_vendas
        identificacao['qtd_cupons'] = qtd_vendas
        vendas_prazo, total_vendas_prazo = self._get_vendas_prazo(orders)
        sangrias, suprimentos, total_sangrias, total_suprimentos = self._get_sangrias_suprimentos(cash_details)
        recebimentos, total_recebimentos, recebimentos_por_metodo = self._get_recebimentos()
        saldo_detalhado = self._calc_saldo_detalhado(metodos_pagamento, recebimentos_por_metodo)

        # === SALDO DE MOVIMENTAÇÃO ===
        entradas = total_vendas + (identificacao['fundo_caixa'] or 0.0) + total_suprimentos + total_recebimentos
        saidas = total_sangrias
        saldo_caixa = entradas - saidas

        return {
            'empresa': empresa,
            'identificacao': identificacao,
            'metodos_pagamento': metodos_pagamento,
            'total_vendas': total_vendas,
            'vendas_prazo': vendas_prazo,
            'total_vendas_prazo': total_vendas_prazo,
            'sangrias': sangrias,
            'total_sangrias': total_sangrias,
            'suprimentos': suprimentos,
            'total_suprimentos': total_suprimentos,
            'recebimentos': recebimentos,
            'total_recebimentos': total_recebimentos,
            'saldo_movimentacao': {
                'entradas': entradas,
                'saidas': saidas,
                'saldo': saldo_caixa,
            },
            'saldo_detalhado': saldo_detalhado,
        }

    def _get_vendas_prazo(self, orders):
        """Coleta as vendas a prazo (pay_later) da sessão.

        O core filtra pay_later do closing_control_data, então buscamos
        direto nos pedidos.

        Args:
            orders: recordset de pos.order já fechadas da sessão.

        Returns:
            tuple(list[dict], float): lista de vendas a prazo e total.
        """
        vendas_prazo = []
        prazo_payments = orders.payment_ids.filtered(
            lambda p: p.payment_method_id.type == 'pay_later'
        )
        for payment in prazo_payments:
            order = payment.pos_order_id
            partner = order.partner_id
            vendas_prazo.append({
                'cliente': partner.name if partner and partner.name != 'Public' else 'CONSUMIDOR',
                'data': order.date_order.strftime('%d/%m/%Y %H:%M') if order.date_order else '',
                'valor': payment.amount,
            })
        total_vendas_prazo = sum(v['valor'] for v in vendas_prazo)
        return vendas_prazo, total_vendas_prazo

    def _get_sangrias_suprimentos(self, cash_details):
        """Extrai sangrias e suprimentos (cash in/out) dos detalhes de caixa.

        payment_ref vem como "POS/00012-out-motivo" — extraímos só o motivo.

        Args:
            cash_details: dict com os detalhes de dinheiro (default_cash_details).

        Returns:
            tuple(list, list, float, float): sangrias, suprimentos,
            total_sangrias, total_suprimentos.
        """
        sangrias = []
        suprimentos = []
        for move in cash_details.get('moves', []):
            ref = move.get('name', '')
            amount = move.get('amount', 0.0)
            # Remove o prefixo da sessão (ex: "POS/00012-")
            prefix = (self.name or '') + '-'
            if ref.startswith(prefix):
                resto = ref[len(prefix):]  # "out-motivo" ou "in-motivo"
                partes = resto.split('-', 1)
                motivo = partes[1] if len(partes) > 1 else resto
            else:
                motivo = ref
            if amount < 0:
                sangrias.append({'motivo': motivo, 'valor': abs(amount)})
            else:
                suprimentos.append({'motivo': motivo, 'valor': abs(amount)})
        total_sangrias = sum(s['valor'] for s in sangrias)
        total_suprimentos = sum(s['valor'] for s in suprimentos)
        return sangrias, suprimentos, total_sangrias, total_suprimentos

    def _get_recebimentos(self):
        """Coleta os recebimentos (account.payment inbound) criados pelo
        botão Recebimento no PDV.

        Returns:
            tuple(list[dict], float, dict[str, float]): lista de recebimentos,
            total e breakdown por método de pagamento (nome → soma). O dict
            ``recebimentos_por_metodo`` alimenta o SALDO DETALHADO (DEC-005).
        """
        recebimentos = []
        recebimentos_por_metodo = {}
        for payment in self.bank_payment_ids.filtered(
            lambda p: p.payment_type == 'inbound' and p.partner_type == 'customer'
                      and p.memo and 'Recebimento PDV' in p.memo
        ):
            # Lazy-safe: pagamentos antigos sem x_payment_method_id caem em '—'
            forma_pagamento = payment.x_payment_method_id.name or '—'
            recebimentos.append({
                'cliente': payment.partner_id.name or '',
                'data': payment.date.strftime('%d/%m/%Y %H:%M') if payment.date else '',
                'valor': payment.amount,
                'memo': payment.memo or '',
                'forma_pagamento': forma_pagamento,
            })
            recebimentos_por_metodo[forma_pagamento] = (
                recebimentos_por_metodo.get(forma_pagamento, 0.0) + payment.amount
            )
        total_recebimentos = sum(r['valor'] for r in recebimentos)
        return recebimentos, total_recebimentos, recebimentos_por_metodo

    def _calc_saldo_detalhado(self, metodos_pagamento, recebimentos_por_metodo=None):
        """Calcula o saldo detalhado por método de pagamento.

        Calculado/Sistema = vendas + recebimentos por método.
        Informado = 0 (operador preenche na hora — por enquanto 0).
        Diferença = informado - calculado = -calculado (por enquanto).

        Args:
            metodos_pagamento: lista de dicts com 'nome' e 'valor'.
            recebimentos_por_metodo: dict nome do método → soma dos
                recebimentos (default {}).

        Returns:
            list[dict]: saldo detalhado por método.
        """
        recebimentos_por_metodo = recebimentos_por_metodo or {}
        vendas_por_metodo = {}
        for metodo in metodos_pagamento:
            nome = metodo['nome']
            vendas_por_metodo[nome] = vendas_por_metodo.get(nome, 0.0) + metodo['valor']

        # DEC-006: união dos métodos de vendas e de recebimentos. Preserva a
        # ordem de metodos_pagamento (cash primeiro) e anexa métodos que só
        # aparecem em recebimentos (ex: só PIX em recebimentos, sem venda PIX).
        nomes = list(vendas_por_metodo) + [
            n for n in recebimentos_por_metodo if n not in vendas_por_metodo
        ]

        saldo_detalhado = []
        for nome in nomes:
            calculado = vendas_por_metodo.get(nome, 0.0) + recebimentos_por_metodo.get(nome, 0.0)
            saldo_detalhado.append({
                'nome': nome,
                'calculado': calculado,
                'informado': 0.0,
                'diferenca': 0.0 - calculado,
            })
        return saldo_detalhado

    def action_print_fechamento(self):
        """Retorna uma action do tipo ``ir.actions.client`` que abre a URL
        do controller de reimpressão do fechamento numa nova janela.
        Usado pelo botão "Imprimir Fechamento" na form view de pos.session.
        """
        self.ensure_one()
        url = '/pos/fechamento/%d' % self.id
        return {
            'type': 'ir.actions.act_url',
            'url': url,
            'target': 'new',
        }

    def create_recebimento(self, invoice_id, amount=None, payment_method_name='', payment_method_id=None):
        """Cria um recebimento (account.payment inbound) para uma fatura
        especifica, reconciliando automaticamente o pagamento com a fatura.
        Usado pelo botao Recebimento no PDV.

        Args:
            invoice_id: int - ID da fatura (account.move) a ser quitada
            amount: float - valor a receber (opcional). Se None, usa o
                valor residual da fatura (comportamento legado).
            payment_method_name: str - nome do metodo de pagamento exibido
                no comprovante (DEC-001). Fallback legado quando
                ``payment_method_id`` nao e informado.
            payment_method_id: int - ID do pos.payment.method escolhido no
                PDV (DEC-001). Tem prioridade sobre ``payment_method_name``:
                o backend resolve o nome via ORM e persiste o Many2one no
                account.payment. Se invalido/inexistente, cai no fallback
                (nao quebra o recebimento).

        Returns:
            dict with success/message. Em caso de sucesso, inclui a chave
            ``comprovante`` (DEC-004) com os dados para impressao termica:
            fatura, valor_pago, forma_pagamento, data_hora, numero_pdv e
            operador.
        """
        invoice = self.env['account.move'].browse(invoice_id)
        if not invoice.exists():
            return {'success': False, 'message': 'Fatura nao encontrada'}

        if invoice.state != 'posted':
            return {'success': False, 'message': 'Fatura nao esta confirmada (state=%s)' % invoice.state}

        if invoice.payment_state not in ('not_paid', 'partial'):
            return {'success': False, 'message': 'Fatura ja foi quitada (payment_state=%s)' % invoice.payment_state}

        # Se amount nao foi passado, usa o residual (compatibilidade retrograda)
        if amount is None:
            amount = invoice.amount_residual

        # Valida o amount
        if amount <= 0:
            return {'success': False, 'message': 'Valor invalido (%.2f). O valor deve ser maior que zero.' % amount}

        if amount < 1.0:
            return {'success': False, 'message': 'Valor minimo de R$ 1,00'}

        if amount > invoice.amount_residual + 0.001:
            return {
                'success': False,
                'message': 'Valor superior ao saldo da fatura (R$ %.2f)' % invoice.amount_residual,
            }

        # DEC-001: resolve o metodo de pagamento. payment_method_id (int) tem
        # prioridade; payment_method_name (str) e o fallback legado. Um id
        # inexistente cai no fallback sem quebrar o recebimento.
        # Nota: se o frontend passar ambos (payment_method_name + id invalido),
        # o nome legado vence silenciosamente — intencional, coberto por
        # test_payment_method_id_invalido.
        payment_method = self.env['pos.payment.method'].browse(payment_method_id) if payment_method_id else self.env['pos.payment.method']
        if payment_method.exists():
            payment_method_name = payment_method.name

        partner = invoice.partner_id
        partner_id = partner.id

        # Monta o memo: diferenciado para pagamento parcial
        is_partial = amount < invoice.amount_residual - 0.001
        if is_partial:
            memo = 'Recebimento PDV - Fatura %s - Parcial R$ %.2f' % (invoice.name, amount)
        else:
            memo = 'Recebimento PDV - Fatura %s' % invoice.name

        # Cria o pagamento de entrada (inbound) pelo valor informado
        payment = self.env['account.payment'].create({
            'payment_type': 'inbound',
            'partner_type': 'customer',
            'partner_id': partner_id,
            'amount': amount,
            'date': fields.Date.context_today(self),
            'memo': memo,
            'pos_session_id': self.id,
            'x_payment_method_id': payment_method.id if payment_method.exists() else False,
        })
        payment.action_post()

        _logger.info(
            '[RECEBIMENTO-PDV] Pagamento criado | Fatura: %s | Parceiro: %s (ID=%d) | Valor: %.2f | Payment ID=%d',
            invoice.name, partner.name, partner_id, amount, payment.id
        )

        # Reconcilia o pagamento com a fatura via linhas a receber
        # No Odoo 18, as linhas contábeis do pagamento ficam em payment.move_id.line_ids
        payment_move = payment.move_id
        payment_line = payment_move.line_ids.filtered(
            lambda l: l.account_id.account_type == 'asset_receivable'
        )
        invoice_line = invoice.line_ids.filtered(
            lambda l: l.account_id.account_type == 'asset_receivable' and not l.reconciled
        )
        if payment_line and invoice_line:
            (payment_line + invoice_line).reconcile()
            _logger.info(
                '[RECEBIMENTO-PDV] Reconciliacao realizada | Fatura: %s | Payment ID=%d',
                invoice.name, payment.id
            )
        else:
            _logger.warning(
                '[RECEBIMENTO-PDV] Nao foi possivel reconciliar | Fatura: %s | '
                'payment_line=%s | invoice_line=%s',
                invoice.name, bool(payment_line), bool(invoice_line)
            )

        # Le o saldo residual APOS reconciliacao (DEC-003)
        residual_pos = invoice.amount_residual

        # Registra movimentacao se o parceiro for funcionario (I10: helper extraído)
        # Usa o saldo residual pos-reconciliacao (DEC-003)
        employee = self._find_employee_for_partner(partner_id)
        if employee:
            self.env['x.prazo.movimentacao'].create({
                'employee_id': employee.id,
                'partner_id': partner_id,
                'data': fields.Datetime.now(),
                'valor': residual_pos,
                'tipo': 'pagamento',
            })
            _logger.info(
                '[RECEBIMENTO-PDV] Movimentacao registrada | Funcionario: %s | Valor residual: %.2f',
                employee.name, residual_pos
            )

        # DEC-004: dados do comprovante de pagamento p/ impressao termica.
        # Nao inclui saldo restante (fora do escopo da feature).
        return {
            'success': True,
            'message': 'Recebido R$ %.2f | Saldo restante: R$ %.2f | Fatura %s' % (
                amount, residual_pos, invoice.name
            ),
            'comprovante': {
                'fatura': invoice.name,
                'valor_pago': amount,
                'forma_pagamento': payment_method_name,
                'data_hora': fields.Datetime.now().strftime('%d/%m/%Y %H:%M:%S'),
                'numero_pdv': self.config_id.id,
                'operador': self.user_id.name,
            },
        }
