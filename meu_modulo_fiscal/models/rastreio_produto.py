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
   inventário" marcada quando o tipo resolvido é Bem/consumível (``consu``) e
   o chamador não informou valor nem default de contexto (DEC-001). O que vem
   do contexto/``ir.default``/default do campo sempre vence.

2. ``create`` — o ORM não aplica ``default_get`` na criação programática e
   ``_add_precomputed_values`` (odoo/models.py:5143-5179) completaria o campo
   com o default do core (False). A guarda aditiva abaixo grava o valor
   coerente com o tipo informado; tipos diferentes de Bem continuam False,
   como no core. Valor explícito no ``vals`` nunca é sobrescrito.
"""

from odoo import api, models

TIPO_BEM = 'consu'


class ProductTemplate(models.Model):
    _inherit = 'product.template'

    @api.model
    def default_get(self, fields_list):
        res = super().default_get(fields_list)
        if 'is_storable' not in fields_list or 'is_storable' in res:
            # O chamador já mandou valor (inclusive default_is_storable no
            # contexto) ou o core resolveu um default: não sobrescrever.
            return res
        if self._tipo_padrao(res) == TIPO_BEM:
            res['is_storable'] = True
        return res

    @api.model_create_multi
    def create(self, vals_list):
        # Copia os dicts: não mutar os do chamador (copy/importação/outros
        # módulos podem reutilizar o mesmo vals).
        vals_list = [dict(vals) for vals in vals_list]
        for vals in vals_list:
            if 'is_storable' in vals:
                continue
            tipo = vals.get('type') or self._fields['type'].default
            vals['is_storable'] = tipo == TIPO_BEM
        return super().create(vals_list)

    def _tipo_padrao(self, defaults):
        """Tipo resolvido como no ``default_get``: valor → contexto → default."""
        return (
            defaults.get('type')
            or self.env.context.get('default_type')
            or self._fields['type'].default
        )
