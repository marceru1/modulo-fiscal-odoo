from odoo import models, fields

class Ncm(models.Model):
    #basicamente prepara o ncm pra ser um many2one e ter coisas ja pre definidas
    # pra nao precisar ficar digitando e ter o erro de errar alguma informacao
    _name = 'br.ncm'
    _description = 'Tabela de NCM'
    _rec_name = 'code' 

    code = fields.Char("Código", required=True)
    name = fields.Char("Descrição", required=True)