# -*- coding: utf-8 -*-
"""Rastreio padrão de produto novo (feature rastreio-produto, DEC-001).

O campo ``is_storable`` é do módulo ``stock`` e já chega pronto ao ``create``:

    addons/stock/models/product.py:699-701
        is_storable = fields.Boolean(
            'Track Inventory', store=True, compute='compute_is_storable',
            readonly=False, default=False, precompute=True, ...)

Por isso este módulo NÃO redeclara o campo. A extensão é aditiva em dois
pontos:

1. ``default_get`` — faz o form de produto novo abrir com "Rastrear
   inventário" marcada quando o tipo resolvido é Bem/consumível (``consu``).
   Contexto (``default_is_storable``) e ``ir.default`` do chamador vencem; o
   default do CAMPO (False, do stock) não vence — o core o inclui em ``res``
   mesmo sem ninguém pedir (``odoo/models.py:1671-1674``; ``field.default`` é
   sempre um callable, ``odoo/fields.py:510-513``). Por isso a checagem é por
   origem explícita (contexto / ``ir.default``), nunca por presença da chave.

2. ``create`` — o ORM não chama ``default_get`` diretamente no create, mas
   ``_add_missing_default_values`` (``odoo/models.py:1896-1940``) aplica
   contexto/``ir.default`` apenas para campos AUSENTES do ``vals``. Quando
   essas origens já resolvem ``is_storable``, não tocamos no ``vals`` e
   deixamos o ORM aplicar. Caso contrário, preenchemos com o default da
   feature conforme o tipo resolvido (o ORM usaria o default do campo, False).
   Valor explícito no ``vals`` nunca é sobrescrito.
"""

from odoo import api, models

TIPO_BEM = 'consu'


class ProductTemplate(models.Model):
    _inherit = 'product.template'

    @api.model
    def default_get(self, fields_list):
        res = super().default_get(fields_list)
        if 'is_storable' not in fields_list:
            return res
        # Origem explícita do chamador vence (contexto e ir.default). Não usar
        # "is_storable in res": o core já colocou o default do campo (False).
        if 'default_is_storable' in self.env.context:
            return res
        if 'is_storable' in self.env['ir.default']._get_model_defaults(self._name):
            return res
        if self._tipo_padrao(res) == TIPO_BEM:
            res['is_storable'] = True
        return res

    @api.model_create_multi
    def create(self, vals_list):
        # _add_missing_default_values só aplica contexto/ir.default a campos
        # ausentes: se essas origens resolvem is_storable, deixamos o ORM agir.
        origem_do_chamador = (
            'default_is_storable' in self.env.context
            or 'is_storable' in self.env['ir.default']._get_model_defaults(self._name)
        )
        # Copia os dicts: não mutar os do chamador (copy/importação/outros
        # módulos podem reutilizar o mesmo vals).
        vals_list = [dict(vals) for vals in vals_list]
        if not origem_do_chamador:
            for vals in vals_list:
                if 'is_storable' not in vals:
                    vals['is_storable'] = self._tipo_padrao(vals) == TIPO_BEM
        return super().create(vals_list)

    def _tipo_padrao(self, defaults):
        """Tipo resolvido com a precedência do ``default_get`` do ORM:
        valor já resolvido → contexto → ``ir.default`` → default do campo.

        ``field.default`` é SEMPRE um callable (``odoo/fields.py:510-513``) e
        precisa ser chamado com o model; comparar o atributo com ``'consu'``
        daria False silenciosamente (bug pego na suíte runtime).
        """
        tipo = defaults.get('type')
        if tipo:
            return tipo
        tipo = self.env.context.get('default_type')
        if tipo:
            return tipo
        tipo = self.env['ir.default']._get_model_defaults(self._name).get('type')
        if tipo:
            return tipo
        default_do_campo = self._fields['type'].default
        return default_do_campo(self) if default_do_campo else None
