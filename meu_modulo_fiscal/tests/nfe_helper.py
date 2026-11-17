# -*- coding: utf-8 -*-
"""Cenário compartilhado dos testes da NF-e modelo 55.

Uma transferência interna concluída, com filial destinatária, é o ponto de
partida de todo o fluxo (elegibilidade, preparo, custo, divergência).
Os helpers são ``classmethod`` para poderem ser usados no ``setUpClass``.
"""


class NfeTransferMixin:
    @classmethod
    def _nfe_preparar_cenario(cls):
        cls.filial = cls.env['res.company'].create({'name': 'Filial NF-e Teste'})
        cls.produto = cls.env['product.product'].create({
            'name': 'Produto Transferência NF-e',
            'is_storable': True,
        })
        cls.tipo_interno = cls.env.ref('stock.picking_type_internal')
        cls.tipo_recebimento = cls.env.ref('stock.picking_type_in')
        cls.tipo_entrega = cls.env.ref('stock.picking_type_out')

    @classmethod
    def _criar_transferencia(cls, tipo=None, quantidade=10.0, realizada=None,
                             filial=None, produto=None, uom=None, validar=True):
        """Cria (e opcionalmente conclui) a transferência da filial."""
        tipo = tipo or cls.tipo_interno
        produto = produto or cls.produto
        uom = uom or produto.uom_id
        picking = cls.env['stock.picking'].create({
            'picking_type_id': tipo.id,
            'location_id': tipo.default_location_src_id.id,
            'location_dest_id': tipo.default_location_dest_id.id,
            'x_nfe_filial_id': (filial or cls.filial).id,
        })
        cls.env['stock.move'].create({
            'name': produto.name,
            'product_id': produto.id,
            'product_uom_qty': quantidade,
            'product_uom': uom.id,
            # stock.move.company_id tem default env.company (stock_move.py:41-44);
            # a transferência pode ser de OUTRA empresa emitente.
            'company_id': picking.company_id.id,
            'location_id': picking.location_id.id,
            'location_dest_id': picking.location_dest_id.id,
            'picking_id': picking.id,
        })
        picking.action_confirm()
        if not validar:
            return picking
        for move in picking.move_ids:
            move.quantity = quantidade if realizada is None else realizada
        # skip_backorder: sem o wizard, a parte pendente vira backorder —
        # exatamente o cenário "parcial 8 de 10" da spec.
        picking.with_context(skip_backorder=True).button_validate()
        return picking

    @classmethod
    def _concluir_transferencia(cls, picking):
        picking.action_confirm()
        for move in picking.move_ids:
            move.quantity = move.product_uom_qty
        picking.with_context(skip_backorder=True).button_validate()
        return picking

    @classmethod
    def _nfe_config_completa(cls, empresa=None, **overrides):
        """Configuração fiscal completa (endereço + operação conferida)."""
        vals = dict(
            company_id=(empresa or cls.env.company).id,
            crt='1',
            ibge_municipio='1302702',
            ambiente='homologacao',
            serie=5,
            logradouro='Av. 7 de Setembro',
            numero='767',
            bairro='Centro',
            complemento='Sala 2',
            municipio='Itacoatiara',
            uf='13',
            cep='69100000',
            natureza_operacao='Transferência para filial',
            cfop='5152',
            icms_cst_csosn='102',
            origem='0',
            pis_cst='07',
            cofins_cst='07',
            conferida=True,
        )
        vals.update(overrides)
        return cls.env['nfe.config'].create(vals)

    @classmethod
    def _nfe_preparar_nota_valida(cls, **kw):
        """Cenário completo: emitente e filial configurados → nota validável."""
        cls._nfe_config_completa()
        cls._nfe_config_completa(cls.filial)
        cls.env.company.write({'x_cnpj': '26343314000180', 'x_ie': '053917464'})
        cls.filial.write({'x_cnpj': '11222333000144', 'x_ie': '999888777'})
        cls.produto.with_company(cls.env.company).standard_price = 10.0
        cls.produto.x_ncm_id = cls.env['br.ncm'].search([], limit=1)
        picking = cls._criar_transferencia(**kw)
        return cls.env['nfe.documento']._nfe_obter_ou_criar(picking)
