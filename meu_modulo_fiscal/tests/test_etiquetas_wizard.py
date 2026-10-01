# -*- coding: utf-8 -*-
"""Testes da feature etiquetas-produto-impressao.

Seam 1 (primário, Python puro): ``product.label.layout._prepare_report_data()``
e o contrato de dados consumido pelos relatórios QWeb.

Seam 2 (integração): renderização real do PDF — requer wkhtmltopdf, por isso
roda só em ``post_install``.
"""
from odoo.exceptions import UserError
from odoo.tests import TransactionCase, tagged


class EtiquetasTestMixin:
    """Fixtures compartilhadas: um produto com EAN/Referência e um sem."""

    def _setup_produtos(self):
        self.tmpl_completo = self.env['product.template'].create({
            'name': 'Anel de Prata',
            'default_code': 'ANEL-001',
            'list_price': 49.9,
        })
        self.variant_completo = self.tmpl_completo.product_variant_id
        self.variant_completo.action_generate_barcode()

        self.tmpl_simples = self.env['product.template'].create({
            'name': 'Colar de Ouro',
            'list_price': 199.0,
        })
        self.variant_simples = self.tmpl_simples.product_variant_id

    def _make_wizard(self, label_format, linhas):
        """``linhas``: iterável de pares ``(product.template, quantidade)``."""
        return self.env['product.label.layout'].create({
            'x_label_format': label_format,
            'x_line_ids': [
                (0, 0, {'product_id': tmpl.id, 'quantity': qty})
                for tmpl, qty in linhas
            ],
        })


class TestEtiquetasWizard(EtiquetasTestMixin, TransactionCase):
    """Seam 1: o wizard monta o payload do relatório a partir das linhas."""

    def setUp(self):
        super().setUp()
        self._setup_produtos()

    # ── xml_id por formato ───────────────────────────────────────────────────
    def test_prepare_report_data_bijuteria(self):
        wizard = self._make_wizard('bijuteria', [(self.tmpl_completo, 5), (self.tmpl_simples, 2)])

        xml_id, data = wizard._prepare_report_data()

        self.assertEqual(xml_id, 'meu_modulo_fiscal.action_report_etiqueta_bijuteria')
        self.assertEqual(data['active_model'], 'product.product')
        self.assertEqual(data['layout_wizard'], wizard.id)
        # Requisito da feature: quantidade POR PRODUTO, não um valor global repetido.
        self.assertEqual(data['quantity_by_product'], {
            self.variant_completo.id: 5,
            self.variant_simples.id: 2,
        })

    def test_prepare_report_data_confeccao(self):
        wizard = self._make_wizard('confeccao', [(self.tmpl_simples, 7)])

        xml_id, data = wizard._prepare_report_data()

        self.assertEqual(xml_id, 'meu_modulo_fiscal.action_report_etiqueta_confeccao')
        self.assertEqual(data['quantity_by_product'], {self.variant_simples.id: 7})

    def test_process_returns_report_action(self):
        wizard = self._make_wizard('bijuteria', [(self.tmpl_completo, 1)])

        action = wizard.process()

        self.assertEqual(action['type'], 'ir.actions.report')
        self.assertEqual(action['report_name'], 'meu_modulo_fiscal.report_etiqueta_bijuteria')
        self.assertTrue(action['close_on_report_download'])

    # ── casos de borda ───────────────────────────────────────────────────────
    def test_prepare_report_data_requires_products(self):
        wizard = self.env['product.label.layout'].create({'x_label_format': 'bijuteria'})

        with self.assertRaises(UserError):
            wizard._prepare_report_data()

    def test_quantity_must_be_positive(self):
        with self.assertRaises(UserError):
            self._make_wizard('bijuteria', [(self.tmpl_completo, 0)])

    def test_produto_sem_barcode_e_sem_referencia_nao_quebra(self):
        """Um produto com ``default_code``/EAN e um sem — ambos passam no seam 1."""
        self.assertTrue(self.variant_completo.barcode)
        self.assertTrue(self.tmpl_completo.default_code)
        self.assertFalse(self.variant_simples.barcode)
        self.assertFalse(self.tmpl_simples.default_code)

        wizard = self._make_wizard('confeccao', [(self.tmpl_completo, 3), (self.tmpl_simples, 4)])

        _, data = wizard._prepare_report_data()

        self.assertEqual(data['quantity_by_product'], {
            self.variant_completo.id: 3,
            self.variant_simples.id: 4,
        })

    def test_mesmo_produto_em_duas_linhas_soma(self):
        wizard = self._make_wizard('bijuteria', [(self.tmpl_completo, 2), (self.tmpl_completo, 3)])

        _, data = wizard._prepare_report_data()

        self.assertEqual(data['quantity_by_product'], {self.variant_completo.id: 5})

    # ── regressão: fluxos nativos do core (estoque/MRP) intactos ─────────────
    def test_fluxo_do_core_intacto_sem_x_label_format(self):
        """Estoque/MRP criam o wizard sem ``x_label_format`` — o core deve mandar."""
        wizard = self.env['product.label.layout'].create({
            'print_format': 'dymo',
            'product_tmpl_ids': [(6, 0, self.tmpl_completo.ids)],
        })

        xml_id, data = wizard._prepare_report_data()

        self.assertEqual(xml_id, 'product.report_product_template_label_dymo')
        self.assertEqual(data['active_model'], 'product.template')


class TestEtiquetasReportValues(EtiquetasTestMixin, TransactionCase):
    """Contrato do modelo de relatório: resolve os IDs do ``data`` em registros."""

    def setUp(self):
        super().setUp()
        self._setup_produtos()

    def test_get_report_values_resolve_produtos_e_quantidades(self):
        wizard = self._make_wizard('bijuteria', [(self.tmpl_completo, 5), (self.tmpl_simples, 2)])
        _, data = wizard._prepare_report_data()

        values = self.env['report.meu_modulo_fiscal.report_etiqueta_bijuteria']._get_report_values(None, data)

        quantity = values['quantity']
        self.assertEqual(len(quantity), 2)
        # O template itera ``quantity.items()`` → {produto: [(barcode, qtd)]}.
        por_produto = {}
        for product, entries in quantity.items():
            for barcode, qty in entries:
                por_produto[product.id] = (barcode, qty)
        self.assertEqual(por_produto[self.variant_completo.id], (self.variant_completo.barcode, 5))
        self.assertEqual(por_produto[self.variant_simples.id], (False, 2))

    def test_get_report_values_ignora_produto_inexistente(self):
        wizard = self._make_wizard('bijuteria', [(self.tmpl_completo, 1)])
        _, data = wizard._prepare_report_data()
        data['quantity_by_product'][999999] = 1

        values = self.env['report.meu_modulo_fiscal.report_etiqueta_bijuteria']._get_report_values(None, data)

        self.assertEqual(len(values['quantity']), 1)


@tagged('post_install', '-at_install')
class TestEtiquetasPdfSmoke(EtiquetasTestMixin, TransactionCase):
    """Seam 2: renderização real do PDF (requer wkhtmltopdf no container)."""

    def setUp(self):
        super().setUp()
        self._setup_produtos()

    def _render(self, label_format, report_xml_id):
        wizard = self._make_wizard(label_format, [(self.tmpl_completo, 2), (self.tmpl_simples, 1)])
        _, data = wizard._prepare_report_data()
        report = self.env.ref(report_xml_id)
        # `force_report_rendering` é obrigatório: em modo de teste o core
        # (_pre_render_qweb_pdf) pula o wkhtmltopdf e cai em _render_qweb_html,
        # devolvendo HTML em vez de PDF — sem esta context a asserção de %PDF
        # nunca passa. Ver ir_actions_report.py:1008.
        return report.with_context(force_report_rendering=True)._render_qweb_pdf(report.id, data=data)[0]

    def test_render_bijuteria_pdf(self):
        pdf = self._render('bijuteria', 'meu_modulo_fiscal.action_report_etiqueta_bijuteria')
        self.assertTrue(pdf.startswith(b'%PDF'))

    def test_render_confeccao_pdf(self):
        pdf = self._render('confeccao', 'meu_modulo_fiscal.action_report_etiqueta_confeccao')
        self.assertTrue(pdf.startswith(b'%PDF'))
