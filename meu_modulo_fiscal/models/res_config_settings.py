from odoo import fields, models

class ResConfigSettings(models.TransientModel):
    _inherit = 'res.config.settings'

    pos_x_fiscal_payment_method_ids = fields.Many2many(
        related='pos_config_id.x_fiscal_payment_method_ids',
        readonly=False,
    )

    # I7: parâmetros do middleware lidos em runtime via ir.config_parameter.
    # Substituem o cache estático de os.environ do pos_order.py.
    middleware_url = fields.Char(
        string='URL do Middleware',
        config_parameter='meu_modulo_fiscal.middleware_url',
        help='URL base do Middleware Laravel (ex: http://127.0.0.1:8000). '
             'Lida em runtime via ir.config_parameter — não exige restart do Odoo.',
    )
    webhook_secret = fields.Char(
        string='Webhook Secret',
        config_parameter='meu_modulo_fiscal.webhook_secret',
        help='Shared secret enviado no header X-Webhook-Token. '
             'Deixe vazio se o middleware estiver em rede interna.',
    )
    # N10: timeout configurável do webhook (default 5s, valor histórico hardcoded)
    webhook_timeout = fields.Float(
        string='Timeout do Webhook (segundos)',
        config_parameter='meu_modulo_fiscal.webhook_timeout',
        help='Tempo máximo (em segundos) para aguardar resposta do Middleware '
             'ao despachar uma venda via webhook. Default: 5 segundos.',
    )
