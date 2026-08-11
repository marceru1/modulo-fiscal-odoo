{
    'name': "Módulo Fiscal Brasil - NFC-e",
    'version': '1.0',
    'summary': 'Adiciona controle tributário (NCM, CFOP, PIS/COFINS) aos produtos e integra o PDV com Middleware de NFC-e (Focus NFe).',
    'description': '<p>Adiciona controle tributário e integra com Middleware NFC-e.</p>',
    'author': 'Marcelo',
    'category': 'Sales/Point of Sale',
    'depends': [
        'product',
        'point_of_sale',
        'hr',
    ],
    'data': [
        'data/br.ncm.csv',
        'security/ir.model.access.csv',
        'views/campos_fiscais_views.xml',
        'views/res_company_views.xml',
        'views/res_config_settings_views.xml',
        'views/hr_employee_prazo_views.xml',
        'views/account_move_hide_outstanding.xml',
        'views/pos_session_fechamento_views.xml',
    ],
    'assets': {
        'point_of_sale._assets_pos': [
            'meu_modulo_fiscal/static/src/lib/qrious.js',
            'meu_modulo_fiscal/static/src/js/fiscal_contingencia.js',
            'meu_modulo_fiscal/static/src/js/confirm_popup.js',
            'meu_modulo_fiscal/static/src/js/auto_invoice_pay_later.js',
            'meu_modulo_fiscal/static/src/js/export_data.js',
            'meu_modulo_fiscal/static/src/js/cpf_popup.js', 
 
            'meu_modulo_fiscal/static/src/js/pos_menu_cleanup.js',
            'meu_modulo_fiscal/static/src/xml/cpf_button.xml',
            'meu_modulo_fiscal/static/src/xml/order_receipt.xml',
            'meu_modulo_fiscal/static/src/css/order_receipt.css',
            # I3: CSS compartilhado do fechamento de caixa (antes duplicado em 3 lugares)
            'meu_modulo_fiscal/static/src/css/fechamento.css',
            'meu_modulo_fiscal/static/src/xml/acrescimo_button.xml',
            # I9: helper compartilhado entre acrescimo_popup.js e desconto_popup.js
            'meu_modulo_fiscal/static/src/js/valor_popup_helper.js',
            'meu_modulo_fiscal/static/src/js/acrescimo_popup.js',
            'meu_modulo_fiscal/static/src/xml/desconto_button.xml',
            'meu_modulo_fiscal/static/src/js/desconto_popup.js',
            'meu_modulo_fiscal/static/src/js/print_fix.js',
            # I3: helper compartilhado de impressão térmica (fallback window.print)
            'meu_modulo_fiscal/static/src/js/receipt_print_helper.js',
            # recibo-sangria-impresso: template antes do patch (patch usa renderToElement)
            'meu_modulo_fiscal/static/src/xml/sangria_receipt.xml',
            'meu_modulo_fiscal/static/src/js/cash_move_popup_patch.js',
            'meu_modulo_fiscal/static/src/js/fechamento_button.js',
            'meu_modulo_fiscal/static/src/xml/fechamento_button.xml',
            # simplificar-fechamento: remove inputs "Counted" de bank/PIX do popup
            'meu_modulo_fiscal/static/src/xml/fechamento_simplificar.xml',
            'meu_modulo_fiscal/static/src/xml/fechamento_receipt.xml',
            'meu_modulo_fiscal/static/src/xml/comprovante_parcial_receipt.xml',
            'meu_modulo_fiscal/static/src/js/recebimento_button.js',
            'meu_modulo_fiscal/static/src/xml/recebimento_button.xml',

        ],
        'web.assets_web': [
            'meu_modulo_fiscal/static/src/js/user_menu_cleanup.js',
        ],
    },
    'installable': True,
    'application': False,
    'license': 'OPL-1',
}