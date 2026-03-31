from odoo import models, fields

class Ncm(models.Model):
    """
    Modelo (Tabela) autônomo para cadastro unificado de códigos NCM
    (Nomenclatura Comum do Mercosul).
    
    Permite que o cadastro de produtos utilize um Many2one (relação relacional)
    para o NCM em vez de um campo texto livre, garantindo integridade de dados
    e prevenindo códigos fiscais inválidos durante a emissão.
    """
    _name = "br.ncm"
    _description = "Tabela de NCM (Mercosul)"
    
    # Campo padrão de exibição em dropdowns e buscas do Odoo
    _rec_name = "code" 

    code = fields.Char(string="Código NCM", required=True, help="Sequência numérica de 8 dígitos do NCM")
    name = fields.Char(string="Descrição Oficial", required=True, help="Descrição resumida do item pela Receita")

