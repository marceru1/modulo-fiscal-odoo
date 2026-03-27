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
        """Gera código de barras de 13 dígitos para o template (delega às variantes)."""
        for rec in self:
            for variant in rec.product_variant_ids:
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
        """Gera código EAN-13 baseado no ID do produto preenchido com zeros."""
        for rec in self:
            # 1. Usa o ID do produto (variante) preenchido com zeros até 12 dígitos
            base_code = str(rec.id).zfill(12)

            # 2. Calcula o Dígito Verificador EAN-13
            if len(base_code) == 12 and base_code.isdigit():
                odd = sum(int(base_code[i]) for i in range(0, 12, 2))
                even = sum(int(base_code[i]) for i in range(1, 12, 2)) * 3
                check_digit = (10 - ((odd + even) % 10)) % 10
                
                rec.barcode = f"{base_code}{check_digit}"
