from odoo import models, fields, api

class ProductTemplate(models.Model):
    """
    Extende o modelo de Produto (Template Pai) do Odoo.
    Adiciona visualização de variantes estilo "badges" e geração em lote de código EAN.
    """
    _inherit = 'product.template'

    # sanitize=False necessário para renderizar <span class="badge"> no compute
    x_variant_badges = fields.Html(string="Variantes", compute='_compute_variant_badges', sanitize=False)

    @api.depends('attribute_line_ids', 'attribute_line_ids.value_ids')
    def _compute_variant_badges(self):
        """
        Gera o HTML com 'badges' do Bootstrap para exibição rica das variantes no Kanban/Tree form.
        Exemplo: [Tamanho: P, M, G] [Cor: Azul, Preto]
        """
        for rec in self:
            badges = []
            for line in rec.attribute_line_ids:
                valores = ', '.join(line.value_ids.mapped('name'))
                badge_html = f'<span class="badge rounded-pill text-bg-secondary me-1 fw-normal px-2 py-1" style="font-size: 0.75rem;">{line.attribute_id.name}: {valores}</span>'
                badges.append(badge_html)
            rec.x_variant_badges = ''.join(badges)

    def action_generate_barcode(self):
        """
        Action (Botão): Aciona a geração de código EAN-13 de forma encadeada 
        para todas as sub-variantes vindas deste produto.
        """
        for rec in self:
            for variant in rec.product_variant_ids:
                variant.action_generate_barcode()

class ProductProduct(models.Model):
    """
    Extende o modelo de Variantes (Item filho) do Odoo.
    Gerencia a geração do código de barras EAN-13 baseado no ID interno no Postgres.
    """
    _inherit = 'product.product'

    # sanitize=False necessário para renderizar <span class="badge"> no compute
    x_variant_badges = fields.Html(string="Valores da Variante", compute='_compute_variant_badges_product', sanitize=False)

    @api.depends('product_template_attribute_value_ids')
    def _compute_variant_badges_product(self):
        """
        Exibe a variante individual na forma de 'badges'. Diferente do Template, 
        aqui exibe apenas as características específicas desta própria variante para a Listagem de Variantes.
        """
        for rec in self:
            badges = []
            for ptav in rec.product_template_attribute_value_ids:
                badge_html = f'<span class="badge rounded-pill text-bg-secondary me-1 fw-normal px-2 py-1" style="font-size: 0.75rem;">{ptav.attribute_id.name}: {ptav.name}</span>'
                badges.append(badge_html)
            rec.x_variant_badges = ''.join(badges)

    def action_generate_barcode(self):
        """
        Action (Botão): Gera um código EAN-13 rastreável e único para esta variante.
        Utiliza o ID do banco de dados convertido em 12 caracteres preenchidos
        com '0's à esquerda e calcula logicamente o dígito validador na 13ª posição.
        """
        for rec in self:
            # Preenche o ID numérico com zeros até completar a Base de 12 dígitos do EAN
            base_code = str(rec.id).zfill(12)

            # Algoritmo de soma de dígitos (Ímpar/Par) obrigatório para gerar o Checksum do EAN-13
            if len(base_code) == 12 and base_code.isdigit():
                odd = sum(int(base_code[i]) for i in range(0, 12, 2))
                even = sum(int(base_code[i]) for i in range(1, 12, 2)) * 3
                check_digit = (10 - ((odd + even) % 10)) % 10
                
                rec.barcode = f"{base_code}{check_digit}"

