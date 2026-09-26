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
        'stock',
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
        'views/web_login_cleanup.xml',
    ],
    'assets': {
        'point_of_sale._assets_pos': [
            'meu_modulo_fiscal/static/src/lib/qrious.js',
            'meu_modulo_fiscal/static/src/js/fiscal_contingencia.js',
            'meu_modulo_fiscal/static/src/js/confirm_popup.js',
            'meu_modulo_fiscal/static/src/js/auto_invoice_pay_later.js',
            'meu_modulo_fiscal/static/src/js/export_data.js',

            'meu_modulo_fiscal/static/src/js/pos_menu_cleanup.js',
            'meu_modulo_fiscal/static/src/xml/payment_buttons_cleanup.xml',
            'meu_modulo_fiscal/static/src/xml/order_receipt.xml',
            'meu_modulo_fiscal/static/src/css/order_receipt.css',
            # I11: iguala altura Cliente/Acréscimo/Desconto na PaymentScreen
            'meu_modulo_fiscal/static/src/css/payment_screen.css',
            # I3: CSS compartilhado do fechamento de caixa (antes duplicado em 3 lugares)
            'meu_modulo_fiscal/static/src/css/fechamento.css',
            'meu_modulo_fiscal/static/src/xml/acrescimo_button.xml',
            # I9: helper compartilhado entre acrescimo_popup.js e desconto_popup.js
            'meu_modulo_fiscal/static/src/js/valor_popup_helper.js',
            'meu_modulo_fiscal/static/src/js/acrescimo_popup.js',
            'meu_modulo_fiscal/static/src/xml/desconto_button.xml',
            'meu_modulo_fiscal/static/src/js/desconto_popup.js',
            'meu_modulo_fiscal/static/src/js/print_fix.js',
            # validacao-cpf-popup: popup de CPF com validação client-side (bloqueia
            # Apply/ENTER com CPF inválido — evita rejeição da SEFAZ via Focus NFe)
            'meu_modulo_fiscal/static/src/js/cpf_input_popup.js',
            'meu_modulo_fiscal/static/src/xml/cpf_input_popup.xml',
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
            # Logo Grupo 20+ na navbar do POS (override point_of_sale.Navbar)
            'meu_modulo_fiscal/static/src/xml/pos_navbar_logo.xml',

        ],
        'web.assets_web': [
            'meu_modulo_fiscal/static/src/js/user_menu_cleanup.js',
        ],
        # impressao-transferencia-interna: print dialog A4 do delivery slip
        # (stock.picking internal/incoming) em vez de download de PDF.
        'web.assets_backend': [
            'meu_modulo_fiscal/static/src/js/picking_print_helper.js',
        ],
    },
    'installable': True,
    'application': False,
    'license': 'OPL-1',
}