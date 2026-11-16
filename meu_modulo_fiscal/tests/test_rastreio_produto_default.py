# -*- coding: utf-8 -*-
"""Testes da feature rastreio-produto — ticket 01 (DEC-001).

Seam primário (Python TransactionCase): valores padrão do ``product.template``
e criação via ORM. O campo ``is_storable`` pertence ao ``stock`` e NÃO é
redeclarado pelo módulo:

    addons/stock/models/product.py:699-701
        is_storable = fields.Boolean(
            'Track Inventory', store=True, compute='compute_is_storable',
            readonly=False, default=False, precompute=True, ...)

    addons/stock/models/product.py:763-765
        @api.depends('type')
        def compute_is_storable(self):
            self.filtered(lambda t: t.type != 'consu' and t.is_storable).is_storable = False

Contratos travados:
  - produto novo do tipo Bem (``consu``) → ``is_storable`` True;
  - default explícito no contexto (``default_is_storable=False``) vence;
  - serviço/combo criado via ORM sem ``is_storable`` → False (core);
  - troca de tipo para serviço zera ``is_storable`` (compute do core);
  - duplicar preserva o valor do original (``is_storable`` tem ``copy=True``);
  - produto existente não é tocado (sem retroatividade).
"""

from odoo.tests import TransactionCase


class TestRastreioProdutoDefault(TransactionCase):
    """Seam 1 da spec: defaults e criação do ``product.template``."""

    # ── helpers ─────────────────────────────────────────────────────────────
    def _criar_combo_choice(self, produto):
        """Um ``product.combo`` válido exige ao menos 1 item (constraint do core)."""
        return self.env['product.combo'].create({
            'name': 'Combo teste',
            'combo_item_ids': [(0, 0, {'product_id': produto.product_variant_id.id})],
        })

    # ── defaults do formulário ──────────────────────────────────────────────
    def test_default_novo_bem_marcado(self):
        defaults = self.env['product.template'].default_get(['type', 'is_storable'])

        self.assertEqual(defaults.get('type'), 'consu',
                         'Sem contexto, o tipo padrão do template é Bem/consumível')
        self.assertIs(defaults.get('is_storable'), True,
                      'Produto novo do tipo Bem deve abrir com "Rastrear inventário" marcada')

    def test_default_contexto_explicito_vence(self):
        defaults = (
            self.env['product.template']
            .with_context(default_is_storable=False)
            .default_get(['type', 'is_storable'])
        )

        self.assertIs(defaults.get('is_storable'), False,
                      'default_is_storable no contexto nunca pode ser sobrescrito pela feature')

    def test_default_tipo_servico_no_contexto_nao_marca(self):
        defaults = (
            self.env['product.template']
            .with_context(default_type='service')
            .default_get(['is_storable'])
        )

        # O core SEMPRE inclui o default do campo em res (is_storable tem
        # default=False no stock e field.default é um callable truthy —
        # odoo/models.py:1671-1674). O contrato é não virar True.
        self.assertIs(defaults.get('is_storable'), False,
                      'Tipo padrão diferente de Bem não pode receber o default da feature')

    def test_default_so_is_storable_resolve_tipo_padrao_do_campo(self):
        # Regressão (suíte runtime): sem 'type' no fields_list, o tipo precisa
        # ser resolvido pelo callable do default do campo ('consu'), não pela
        # comparação do atributo com a string.
        defaults = self.env['product.template'].default_get(['is_storable'])

        self.assertIs(defaults.get('is_storable'), True,
                      'Sem type pedido, o tipo padrão resolvido é Bem → default marcado')

    def test_default_ir_default_do_chamador_vence(self):
        # Origem explícita (ir.default) vence o default da feature, mesmo False.
        self.env['ir.default'].set('product.template', 'is_storable', False)

        defaults = self.env['product.template'].default_get(['type', 'is_storable'])

        self.assertIs(defaults.get('is_storable'), False,
                      'ir.default explícito nunca pode ser sobrescrito pela feature')

    def test_default_nao_incluido_quando_campo_nao_pedido(self):
        defaults = self.env['product.template'].default_get(['name'])

        self.assertNotIn('is_storable', defaults,
                         'default_get não inventa campos fora do fields_list')

    # ── criação via ORM ─────────────────────────────────────────────────────
    def test_create_bem_sem_is_storable_nasce_rastreado(self):
        tmpl = self.env['product.template'].create({'name': 'Bem sem flag'})

        self.assertEqual(tmpl.type, 'consu')
        self.assertTrue(tmpl.is_storable,
                        'DEC-001: criação programática de Bem sem is_storable nasce rastreada')

    def test_create_bem_is_storable_false_explicito_preservado(self):
        tmpl = self.env['product.template'].create({
            'name': 'Bem sem rastreio',
            'is_storable': False,
        })

        self.assertFalse(tmpl.is_storable,
                         'Valor explícito no create é do chamador e não pode ser sobrescrito')

    def test_create_servico_sem_is_storable_fica_false(self):
        tmpl = self.env['product.template'].create({
            'name': 'Serviço teste',
            'type': 'service',
        })

        self.assertFalse(tmpl.is_storable,
                         'Serviço criado sem is_storable mantém o comportamento do core')

    def test_create_respeita_contexto_default_is_storable(self):
        # Contrato "o que veio do chamador vence" também no create: a guarda
        # não pode sobrescrever default_is_storable do contexto.
        tmpl = (
            self.env['product.template']
            .with_context(default_is_storable=False)
            .create({'name': 'Bem desmarcado por contexto'})
        )

        self.assertFalse(tmpl.is_storable,
                         'default_is_storable=False no contexto vence o default da feature')

    def test_create_servico_por_contexto_default_type(self):
        # O tipo resolvido via contexto também governa a guarda do create
        # (o ORM aplica default_type em _add_missing_default_values).
        tmpl = (
            self.env['product.template']
            .with_context(default_type='service')
            .create({'name': 'Serviço por contexto'})
        )

        self.assertEqual(tmpl.type, 'service')
        self.assertFalse(tmpl.is_storable,
                         'Tipo resolvido por default_type no contexto não pode nascer rastreado')

    def test_create_combo_sem_is_storable_fica_false(self):
        base = self.env['product.template'].create({'name': 'Produto base do combo'})
        combo = self._criar_combo_choice(base)

        tmpl = self.env['product.template'].create({
            'name': 'Combo teste',
            'type': 'combo',
            'combo_ids': [(6, 0, combo.ids)],
        })

        self.assertFalse(tmpl.is_storable,
                         'Combo criado sem is_storable mantém o comportamento do core')

    # ── comportamento do core preservado ────────────────────────────────────
    def test_troca_tipo_para_servico_zera(self):
        tmpl = self.env['product.template'].create({'name': 'Vira serviço'})
        self.assertTrue(tmpl.is_storable)

        tmpl.type = 'service'

        self.assertFalse(tmpl.is_storable,
                         'compute_is_storable do core zera ao sair de Bem (stock/models/product.py:763-765)')

    def test_duplicar_preserva_o_valor(self):
        rastreado = self.env['product.template'].create({'name': 'Rastreado'})
        nao_rastreado = self.env['product.template'].create({
            'name': 'Não rastreado',
            'is_storable': False,
        })

        self.assertTrue(rastreado.copy().is_storable,
                        'Duplicar produto rastreado preserva is_storable=True')
        self.assertFalse(nao_rastreado.copy().is_storable,
                         'Duplicar produto não rastreado preserva is_storable=False')

    def test_produto_existente_nao_muda(self):
        tmpl = self.env['product.template'].create({
            'name': 'Produto antigo',
            'is_storable': False,
        })

        # O default é calculado para OUTRO registro; não pode tocar o existente.
        self.env['product.template'].default_get(['type', 'is_storable'])

        self.assertFalse(tmpl.is_storable,
                         'Feature não é retroativa: produto existente mantém o valor')
