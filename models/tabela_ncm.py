from odoo import models, fields

class Ncm(models.Model):
    # prepara o ncm pra ser um many2one e ter codigos ja pre definidos
    _name = 'br.ncm'
    _description = 'Tabela de NCM'
    _rec_name = 'code' 

    code = fields.Char("Código", required=True)
    name = fields.Char("Descrição", required=True)