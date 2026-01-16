{
    'name': "Meu Módulo Fiscal",
    'version': '1.0',
    'summary': 'Adiciona atributos fiscais aos produtos',
    'author': 'Marcelo',
    'category': 'Uncategorized',
    'depends': [
        'product',
        'point_of_sale',
    ],
    'data': [
        'data/br.ncm.csv',
        'security/ir.model.access.csv',
        'views/campos_fiscais_views.xml',
    ],
    'assets': {
        'point_of_sale._assets_pos': [
            'meu_modulo_fiscal/static/src/js/confirm_popup.js',
            'meu_modulo_fiscal/static/src/js/export_data.js',
            'meu_modulo_fiscal/static/src/js/cpf_popup.js', 
            'meu_modulo_fiscal/static/src/js/order_receipt.js', 
            'meu_modulo_fiscal/static/src/xml/cpf_button.xml',
            'meu_modulo_fiscal/static/src/xml/order_receipt.xml',
            'meu_modulo_fiscal/static/src/css/order_receipt.css',

            
        ],
    },
    'installable': True,
    'application': False,
}