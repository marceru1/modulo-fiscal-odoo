from odoo import models, fields
# Adiciona esses itens como colunas no banco de dados

CST_PIS_COFINS = [
    ('01', '01 - Operação Tributável (Alíquota Básica)'), # Cuidado: Exige alíquota
    ('04', '04 - Operação Tributável Monofásica (Revenda Alíquota Zero)'), # Bebidas, Autopeças, Perfumaria
    ('06', '06 - Operação Tributável a Alíquota Zero'),
    ('07', '07 - Operação Isenta da Contribuição'), # SEU PADRÃO (Simples Nacional)
    ('08', '08 - Operação sem Incidência da Contribuição'),
    ('49', '49 - Outras Operações de Saída'),
    ('99', '99 - Outras Operações'),
]


class ProductTemplate(models.Model):
    _inherit = 'product.template'

    x_departamento = fields.Selection(
        [
            ('0', '0 - teste00'),
            ('1', '0 - teste01'),
            ('2', '0 - teste02'),
            ('3', '0 - teste03'),
        ],
        string="Departamento",
        default='0'
    )

    x_fornecedor = fields.Selection(
        [
            ('0', '0 - teste00'),
            ('1', '0 - teste01'),
            ('2', '0 - teste02'),
            ('3', '0 - teste03'),
        ],
        string="Fornecedor",
        default='0'
    )

    x_tipo = fields.Selection(
        [
            ('00', '00 - Mercadoria para Revenda'),
            ('01', '01 - Matéria-Prima'),
            ('02', '02 - Embalagem'),
            ('03', '03 - Produto em Processo'),
            ('04', '04 - Produto Acabado'),
            ('05', '05 - Subproduto'),
            ('06', '06 - Produto Intermediário'),
            ('07', '07 - Material de Uso e Consumo'),
            ('08', '08 - Ativo Imobilizado'),
            ('09', '09 - Serviços'),
            ('10', '10 - Outros insumos'),
            ('99', '99 - Outras'),
        ],
        string="Tipo de Item (SPED)",
        default='00'
    )

    x_genero = fields.Selection(
        [
            ('0', '0 - teste00'),
            ('1', '0 - teste01'),
            ('2', '0 - teste02'),
            ('3', '0 - teste03'),
        ],
        string="Gênero do Item",
        default='0'
    )

    x_ncm_id = fields.Many2one(
        'br.ncm',
        string='Código NCM',
        required=True
    )

    x_ncm_descricao = fields.Char(
        string="Descrição NCM",
        related="x_ncm_id.name",
        readonly=True,
        store=True
    )

    x_origem = fields.Selection(
        [
            ('0', '0 - Nacional, exceto códigos 3, 4, 5 e 8'),
            ('1', '1 - Importação direta'),
            ('2', '2 - Estrangeira adquirida no mercado interno'),
            ('3', '3 - Nacional, conteúdo importado >40% e ≤70%'),
            ('4', '4 - Nacional conforme PPB'),
            ('5', '5 - Nacional, conteúdo importado ≤40%'),
            ('6', '6 - Importação direta sem similar nacional'),
            ('7', '7 - Estrangeira adquirida sem similar nacional'),
            ('8', '8 - Nacional, conteúdo importado >70%'),
        ],
        string="Origem (NF-e)",
        required=True,
        default='0'
    )

    x_cfop = fields.Selection(
        [
            ('5101', '5.101 - Venda de produção do estabelecimento'),
            ('5102', '5.102 - Venda de mercadoria adquirida ou recebida de terceiros'),
            ('5103', '5.103 - Venda de produção do estabelecimento efetuada fora do estabelecimento'),
        ],
        string="CFOP",
        required=True,
        default='5102'
    )

    x_icms = fields.Selection(
        [
            ('00', '00 - Tributada integralmente'),
            ('20', '20 - Com redução de base de cálculo'),
            ('40', '40 - Isenta'),
            ('41', '41 - Não tributada'),
            ('60', '60 - ICMS cobrado anteriormente por substituição tributária'),
            ('102', '102 - Tributada pelo Simples Nacional sem permissão de crédito'),
        ],
        string="ICMS (CST/CSOSN)",
        default='00'
    )

    x_pis = fields.Selection(
        CST_PIS_COFINS,
        string="PIS",
        default='07'
    )

    x_cofins = fields.Selection(
        CST_PIS_COFINS,
        string="COFINS",
        default='07'
    )
