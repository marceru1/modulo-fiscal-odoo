import unicodedata
from odoo import models, fields, api

class ProductTemplate(models.Model):
    _inherit = 'product.template'

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
