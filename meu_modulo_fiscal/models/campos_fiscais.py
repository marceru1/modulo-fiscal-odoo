import unicodedata
from odoo import models, fields, api

CST_PIS_COFINS = [
    ('01', '01 - Operação Tributável (Alíquota Básica)'),
    ('04', '04 - Operação Tributável Monofásica (Revenda Alíquota Zero)'),
    ('06', '06 - Operação Tributável a Alíquota Zero'),
    ('07', '07 - Operação Isenta da Contribuição'),
    ('08', '08 - Operação sem Incidência da Contribuição'),
    ('49', '49 - Outras Operações de Saída'),
    ('99', '99 - Outras Operações'),
]

class ProductTemplate(models.Model):
    _inherit = 'product.template'

    # Campos fiscais obrigatórios
    x_departamento = fields.Selection(
        [('0', '0 - teste00'), ('1', '0 - teste01'), ('2', '0 - teste02'), ('3', '0 - teste03')],
        string="Departamento", default='0'
    )

    x_fornecedor = fields.Selection(
        [('0', '0 - teste00'), ('1', '0 - teste01'), ('2', '0 - teste02'), ('3', '0 - teste03')],
        string="Fornecedor", default='0'
    )

    x_tipo = fields.Selection(
        [
            ('00', '00 - Mercadoria para Revenda'), ('01', '01 - Matéria-Prima'),
            ('02', '02 - Embalagem'), ('03', '03 - Produto em Processo'),
            ('04', '04 - Produto Acabado'), ('05', '05 - Subproduto'),
            ('06', '06 - Produto Intermediário'), ('07', '07 - Material de Uso e Consumo'),
            ('08', '08 - Ativo Imobilizado'), ('09', '09 - Serviços'),
            ('10', '10 - Outros insumos'), ('99', '99 - Outras'),
        ],
        string="Tipo de Item (SPED)", default='00', help="Classificação do produto conforme tabela SPED Fiscal"
    )

    x_genero = fields.Selection(
        [('0', '0 - teste00'), ('1', '0 - teste01'), ('2', '0 - teste02'), ('3', '0 - teste03')],
        string="Gênero do Item", default='0'
    )

    x_ncm_id = fields.Many2one(
        'br.ncm', string='Código NCM', required=True,
        help="Nomenclatura Comum do Mercosul - obrigatório para emissão de NFCe/NFe"
    )

    x_ncm_descricao = fields.Char(
        string="Descrição NCM", related="x_ncm_id.name", readonly=True, store=True
    )

    x_origem = fields.Selection(
        [
            ('0', '0 - Nacional, exceto códigos 3, 4, 5 e 8'), ('1', '1 - Importação direta'),
            ('2', '2 - Estrangeira adquirida no mercado interno'), ('3', '3 - Nacional, conteúdo importado >40% e ≤70%'),
            ('4', '4 - Nacional conforme PPB'), ('5', '5 - Nacional, conteúdo importado ≤40%'),
            ('6', '6 - Importação direta sem similar nacional'), ('7', '7 - Estrangeira adquirida sem similar nacional'),
            ('8', '8 - Nacional, conteúdo importado >70%'),
        ],
        string="Origem (NF-e)", required=True, default='0', help="Origem da mercadoria conforme tabela do SPED"
    )

    x_cfop = fields.Selection(
        [
            ('5101', '5.101 - Venda de produção do estabelecimento'),
            ('5102', '5.102 - Venda de mercadoria adquirida ou recebida de terceiros'),
            ('5103', '5.103 - Venda de produção do estabelecimento efetuada fora do estabelecimento'),
        ],
        string="CFOP", required=True, default='5102', help="Código Fiscal de Operações e Prestações"
    )

    x_icms = fields.Selection(
        [
            ('00', '00 - Tributada integralmente'), ('20', '20 - Com redução de base de cálculo'),
            ('40', '40 - Isenta'), ('41', '41 - Não tributada'),
            ('60', '60 - ICMS cobrado anteriormente por substituição tributária'),
            ('102', '102 - Tributada pelo Simples Nacional sem permissão de crédito'),
        ],
        string="ICMS (CST/CSOSN)", default='00', help="Código de Situação Tributária do ICMS"
    )

    x_pis = fields.Selection(CST_PIS_COFINS, string="PIS", default='07', help="Código de Situação Tributária do PIS")
    x_cofins = fields.Selection(CST_PIS_COFINS, string="COFINS", default='07', help="Código de Situação Tributária do COFINS")

    x_variant_badges = fields.Html(string="Variantes", compute='_compute_variant_badges', sanitize=False)

    @api.depends('attribute_line_ids', 'attribute_line_ids.value_ids')
    def _compute_variant_badges(self):
        for rec in self:
            badges = []
            for line in rec.attribute_line_ids:
                valores = ', '.join(line.value_ids.mapped('name'))
                badge_html = f'<span class="badge rounded-pill text-bg-secondary me-1 fw-normal px-2 py-1" style="font-size: 0.75rem;">{line.attribute_id.name}: {valores}</span>'
                badges.append(badge_html)
            rec.x_variant_badges = ''.join(badges)

    def action_generate_barcode(self):
        """Gera código de barras de 13 dígitos para o template (delega à variante única)."""
        from odoo.exceptions import UserError
        for rec in self:
            if rec.product_variant_count != 1:
                raise UserError("Este produto possui mais de uma variante. Gere o código de barras diretamente na variante.")
            variant = rec.product_variant_ids[:1]
            variant.action_generate_barcode()

class ProductProduct(models.Model):
    _inherit = 'product.product'

    x_variant_badges = fields.Html(string="Valores da Variante", compute='_compute_variant_badges_product', sanitize=False)

    @api.depends('product_template_attribute_value_ids')
    def _compute_variant_badges_product(self):
        for rec in self:
            badges = []
            for ptav in rec.product_template_attribute_value_ids:
                badge_html = f'<span class="badge rounded-pill text-bg-secondary me-1 fw-normal px-2 py-1" style="font-size: 0.75rem;">{ptav.attribute_id.name}: {ptav.name}</span>'
                badges.append(badge_html)
            rec.x_variant_badges = ''.join(badges)

    def action_generate_barcode(self):
        """Gera código EAN-13 de forma simplificada e direta para a variante."""
        for rec in self:
            # 1. Pega o ID do template (4 dígitos)
            base_code = str(rec.product_tmpl_id.id % 10000).zfill(4)

            # 2. Varre os atributos da variante UMA ÚNICA VEZ
            attrs = {}
            for ptav in rec.product_template_attribute_value_ids:
                # Tira os acentos e deixa minúsculo (ex: "Gênero" vira "genero")
                clean_name = ''.join(c for c in unicodedata.normalize('NFD', ptav.attribute_id.name.lower()) if unicodedata.category(c) != 'Mn')
                attrs[clean_name.strip()] = str(ptav.product_attribute_value_id.id % 100).zfill(2)

            # 3. Adiciona os valores na ordem exata (se não achar o atributo na variante, preenche com '00')
            for attr in ['tamanho', 'setor', 'genero', 'tipo de produto']:
                base_code += attrs.get(attr, '00')

            # 4. Calcula o Dígito Verificador EAN-13 e atribui ao código de barras
            if len(base_code) == 12 and base_code.isdigit():
                odd = sum(int(base_code[i]) for i in range(0, 12, 2))
                even = sum(int(base_code[i]) for i in range(1, 12, 2)) * 3
                check_digit = (10 - ((odd + even) % 10)) % 10
                
                rec.barcode = f"{base_code}{check_digit}"