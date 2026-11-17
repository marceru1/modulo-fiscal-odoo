# -*- coding: utf-8 -*-
"""NF-e modelo 55: documento fiscal próprio, originado na transferência.

NUNCA ``account.move``: o crediário usa a fatura nativa e este fluxo é outro
documento (spec, decisão 3). O vínculo com a transferência é obrigatório e
único — um picking gera no máximo uma nota (DEC-004).

Idempotência: o clique repetido é resolvido por um ``unique(picking_id)`` no
banco, com ``savepoint`` + ``IntegrityError`` para o caso de dois usuários
criarem ao mesmo tempo (o segundo cai no registro do primeiro). Não há
``with_for_update`` porque o registro ainda não existe quando a corrida
começa — o lock não teria o que travar.

Dados do documento são SNAPSHOT: preenchidos na primeira preparação e não
recalculados ao reabrir (tickets 05 e 07 completam os valores).
"""

from psycopg2 import IntegrityError

from odoo import _, api, fields, models
from odoo.exceptions import AccessError, UserError

from .campos_fiscais import CST_PIS_COFINS, ICMS_CST_CSOSN_SELECTION, ORIGEM_SELECTION
from .nfe_config import AMBIENTE_SELECTION, CRT_SELECTION, UF_IBGE_SELECTION

NFE_STATE_SELECTION = [
    ('rascunho', 'Rascunho'),
    ('validada', 'Validada'),
]

GRUPO_RESPONSAVEL_FISCAL = 'meu_modulo_fiscal.group_nfe_responsavel_fiscal'


class NfeDocumento(models.Model):
    _name = 'nfe.documento'
    _description = 'NF-e modelo 55 originada em transferência'
    _order = 'id desc'

    name = fields.Char(
        string="Referência",
        default=lambda self: self._nfe_proxima_referencia(),
        copy=False,
        readonly=True,
        index=True,
    )
    picking_id = fields.Many2one(
        'stock.picking',
        string="Transferência",
        required=True,
        ondelete='restrict',
        index=True,
        readonly=True,
    )
    # Emitente = empresa responsável pela movimentação (picking_type.company_id);
    # NUNCA a empresa ativa na interface nem o campo Empresa do picking.
    company_id = fields.Many2one(
        'res.company',
        string="Emitente",
        related='picking_id.company_id',
        store=True,
        readonly=True,
        index=True,
    )
    filial_id = fields.Many2one('res.company', string="Filial destinatária", readonly=True)
    state = fields.Selection(
        NFE_STATE_SELECTION,
        string="Situação",
        default='rascunho',
        required=True,
        readonly=True,
    )

    # ── Snapshot fiscal do emitente (config da empresa, ticket 07) ───────────
    emitente_cnpj = fields.Char(string="CNPJ do emitente")
    emitente_ie = fields.Char(string="IE do emitente")
    emitente_crt = fields.Selection(CRT_SELECTION, string="CRT do emitente")
    emitente_ibge_municipio = fields.Char(string="IBGE do município (emitente)")
    emitente_logradouro = fields.Char(string="Logradouro (emitente)")
    emitente_numero = fields.Char(string="Número (emitente)")
    emitente_bairro = fields.Char(string="Bairro (emitente)")
    emitente_complemento = fields.Char(string="Complemento (emitente)")
    emitente_municipio = fields.Char(string="Município (emitente)")
    emitente_uf = fields.Selection(UF_IBGE_SELECTION, string="UF (emitente)")
    emitente_cep = fields.Char(string="CEP (emitente)")
    ambiente = fields.Selection(AMBIENTE_SELECTION, string="Ambiente")
    serie = fields.Integer(string="Série")

    # ── Snapshot fiscal da destinatária (config da filial, ticket 07) ────────
    destinataria_cnpj = fields.Char(string="CNPJ da destinatária")
    destinataria_ie = fields.Char(string="IE da destinatária")
    destinataria_crt = fields.Selection(CRT_SELECTION, string="CRT da destinatária")
    destinataria_ibge_municipio = fields.Char(string="IBGE do município (destinatária)")
    destinataria_logradouro = fields.Char(string="Logradouro (destinatária)")
    destinataria_numero = fields.Char(string="Número (destinatária)")
    destinataria_bairro = fields.Char(string="Bairro (destinatária)")
    destinataria_complemento = fields.Char(string="Complemento (destinatária)")
    destinataria_municipio = fields.Char(string="Município (destinatária)")
    destinataria_uf = fields.Selection(UF_IBGE_SELECTION, string="UF (destinatária)")
    destinataria_cep = fields.Char(string="CEP (destinatária)")

    # ── Dados complementares ─────────────────────────────────────────────────
    modalidade_frete = fields.Selection(
        selection=[
            ('0', '0 - Emitente'),
            ('1', '1 - Destinatária'),
            ('2', '2 - Terceiros'),
            ('3', '3 - Próprio, por conta do remetente'),
            ('4', '4 - Próprio, por conta da destinatária'),
            ('9', '9 - Sem ocorrência de transporte'),
        ],
        string="Modalidade do frete",
        default='9',
    )
    transportadora = fields.Char(string="Transportadora")
    forma_pagamento = fields.Selection(
        selection=[('sem_pagamento', 'Sem pagamento')],
        string="Forma de pagamento",
        default='sem_pagamento',
        required=True,
    )
    valor_pagamento = fields.Monetary(
        string="Valor do pagamento",
        default=0.0,
        currency_field='currency_id',
    )
    informacoes_adicionais = fields.Text(string="Informações adicionais")
    pendencias = fields.Text(
        string="Pendências",
        readonly=True,
        help="Resultado da última conferência local (Validar NF-e). "
             "Pendência mantém a nota em Rascunho.",
    )

    data_movimentacao = fields.Datetime(string="Data da movimentação", readonly=True)
    data_preparacao = fields.Datetime(
        string="Data de preparação",
        default=fields.Datetime.now,
        readonly=True,
    )
    currency_id = fields.Many2one(
        'res.currency',
        string="Moeda",
        related='company_id.currency_id',
    )
    total_produtos = fields.Monetary(
        string="Total dos produtos",
        compute='_compute_total_produtos',
        store=True,
        currency_field='currency_id',
    )
    linha_ids = fields.One2many(
        'nfe.documento.linha',
        'documento_id',
        string="Produtos",
        readonly=True,
    )

    _sql_constraints = [
        ('picking_uniq', 'unique(picking_id)',
         'Já existe uma NF-e para esta transferência.'),
    ]

    # Dados fiscais e de endereço: somente o Responsável fiscal corrige
    # (spec, decisões 4 e 7). O snapshot vem da configuração na preparação.
    CAMPOS_FISCAIS = (
        'emitente_cnpj', 'emitente_ie', 'emitente_crt', 'emitente_ibge_municipio',
        'emitente_logradouro', 'emitente_numero', 'emitente_bairro',
        'emitente_complemento', 'emitente_municipio', 'emitente_uf', 'emitente_cep',
        'destinataria_cnpj', 'destinataria_ie', 'destinataria_crt',
        'destinataria_ibge_municipio', 'destinataria_logradouro',
        'destinataria_numero', 'destinataria_bairro', 'destinataria_complemento',
        'destinataria_municipio', 'destinataria_uf', 'destinataria_cep',
        'ambiente', 'serie',
    )

    pode_editar_fiscal = fields.Boolean(compute='_compute_pode_editar_fiscal')

    @api.depends_context('uid')
    def _compute_pode_editar_fiscal(self):
        pode = self.env.user.has_group(GRUPO_RESPONSAVEL_FISCAL)
        for documento in self:
            documento.pode_editar_fiscal = pode

    def write(self, vals):
        fiscal = any(campo in vals for campo in self.CAMPOS_FISCAIS)
        if fiscal:
            if not self.env.user.has_group(GRUPO_RESPONSAVEL_FISCAL):
                raise AccessError(
                    _("Apenas o Responsável fiscal pode ajustar dados fiscais da NF-e.")
                )
            # Correção fiscal em nota Validada exige nova validação
            # (spec, decisão 6): volta para Rascunho.
            if any(documento.state == 'validada' for documento in self):
                vals = dict(vals, state='rascunho', pendencias=False)
        return super().write(vals)

    # ── Validação local (ticket 08) ──────────────────────────────────────────
    def nfe_validar(self):
        """Botão **Validar NF-e**: confere a nota e move Rascunho → Validada.

        Com qualquer pendência a nota CONTINUA em Rascunho e a lista fica
        gravada no campo Pendências (visível na nota). A validação é local:
        não é autorização fiscal.
        """
        self.ensure_one()
        pendencias = self._nfe_pendencias()
        if pendencias:
            # Pendência mantém (ou devolve) a nota em Rascunho: nota com
            # pendência não pode estar Validada.
            self.write({
                'state': 'rascunho',
                'pendencias': "\n".join(pendencias),
            })
            # Recarrega o form para o operador ver as pendências gravadas.
            return self._nfe_acao_reabrir()
        self.write({'state': 'validada', 'pendencias': False})
        return True

    def _nfe_acao_reabrir(self):
        return {
            'type': 'ir.actions.act_window',
            'name': _("NF-e"),
            'res_model': 'nfe.documento',
            'res_id': self.id,
            'view_mode': 'form',
            'target': 'current',
        }

    def _nfe_pendencias(self):
        """Lista de pendências por campo e por item (texto, uma por linha)."""
        self.ensure_one()
        pendencias = []

        # Origem: mesma checagem do servidor usada pelo botão de preparo.
        try:
            self.picking_id.nfe_verificar_elegibilidade()
        except UserError as erro:
            pendencias.extend(
                "Transferência: %s" % linha for linha in str(erro).splitlines()
            )

        pendencias.extend(self._nfe_pendencias_empresa('emitente', "Emitente"))
        pendencias.extend(self._nfe_pendencias_empresa('destinataria', "Destinatária"))

        config = self._nfe_config_da_empresa(self.company_id)
        if not config:
            pendencias.append(
                "Configuração fiscal da empresa ausente (Faturamento → NF-e → Configurações fiscais)."
            )
        elif not config.conferida:
            pendencias.append(
                "Configuração fiscal da operação não conferida pelo Responsável fiscal."
            )

        if not self.ambiente:
            pendencias.append("Ambiente da NF-e ausente.")
        if not self.serie:
            pendencias.append("Série da NF-e ausente.")

        if not self.linha_ids:
            pendencias.append("Nota sem itens.")
        for linha in self.linha_ids:
            pendencias.extend(linha._nfe_pendencias())

        return pendencias

    def _nfe_pendencias_empresa(self, prefixo, rotulo):
        campos = (
            ('cnpj', "CNPJ"),
            ('ie', "Inscrição Estadual"),
            ('crt', "CRT"),
            ('ibge_municipio', "código IBGE do município"),
            ('logradouro', "logradouro"),
            ('numero', "número"),
            ('bairro', "bairro"),
            ('municipio', "município"),
            ('uf', "UF"),
            ('cep', "CEP"),
        )
        return [
            "%s: %s ausente." % (rotulo, nome)
            for sufixo, nome in campos
            if not self['%s_%s' % (prefixo, sufixo)]
        ]

    @api.depends('linha_ids.total_linha')
    def _compute_total_produtos(self):
        for documento in self:
            documento.total_produtos = sum(documento.linha_ids.mapped('total_linha'))

    # ── Referência ───────────────────────────────────────────────────────────
    @api.model
    def _nfe_proxima_referencia(self):
        """Identidade estável do documento (futuro uso no middleware).

        Sequência de referência do Odoo; a numeração fiscal real será do
        middleware. Sem número fictício de NF-e aqui.
        """
        return self.env['ir.sequence'].next_by_code('nfe.documento') or _("NFE/Nova")

    # ── Criação idempotente ──────────────────────────────────────────────────
    @api.model
    def _nfe_obter_ou_criar(self, picking):
        """Retorna a nota da transferência, criando na primeira chamada."""
        documento = self.search([('picking_id', '=', picking.id)], limit=1)
        if documento:
            return documento
        try:
            with self.env.cr.savepoint():
                documento = self.create(self._nfe_vals_do_picking(picking))
        except IntegrityError:
            # Outro clique criou a nota entre o search e o insert: o
            # savepoint desfez o insert (nada duplicado) e o registro do
            # vencedor é reaproveitado.
            self.env.invalidate_all()
            documento = self.search([('picking_id', '=', picking.id)], limit=1)
            if not documento:
                raise
        # O picking pode ter o vínculo em cache (computed não armazenado).
        picking.invalidate_recordset(['x_nfe_documento_id', 'x_nfe_documento_state'])
        return documento

    @api.model
    def _nfe_vals_do_picking(self, picking):
        config = self._nfe_config_da_empresa(picking.company_id)
        vals = {
            'picking_id': picking.id,
            'filial_id': picking.x_nfe_filial_id.id,
            'data_movimentacao': picking.date_done,
            'linha_ids': [
                (0, 0, self._nfe_linha_vals(move, config))
                for move in picking._nfe_moves_realizados()
            ],
        }
        vals.update(self._nfe_vals_emitente(picking, config))
        vals.update(self._nfe_vals_destinataria(picking))
        return vals

    @api.model
    def _nfe_config_da_empresa(self, empresa):
        """Configuração NF-e da empresa, lida com ``sudo``.

        A configuração é do Responsável fiscal e a empresa DESTINATÁRIA pode
        não estar entre as empresas permitidas do usuário que prepara a nota.
        O ``sudo`` serve apenas para copiar os dados fiscais necessários para
        o snapshot — nada além disso é exposto.
        """
        if not empresa:
            return self.env['nfe.config']
        return self.env['nfe.config'].sudo().search(
            [('company_id', '=', empresa.id)], limit=1
        )

    @api.model
    def _nfe_vals_emitente(self, picking, config):
        empresa = picking.company_id
        return {
            'emitente_cnpj': empresa.x_cnpj,
            'emitente_ie': empresa.x_ie,
            'emitente_crt': config.crt,
            'emitente_ibge_municipio': config.ibge_municipio,
            'emitente_logradouro': config.logradouro,
            'emitente_numero': config.numero,
            'emitente_bairro': config.bairro,
            'emitente_complemento': config.complemento,
            'emitente_municipio': config.municipio,
            'emitente_uf': config.uf,
            'emitente_cep': config.cep,
            'ambiente': config.ambiente,
            'serie': config.serie,
        }

    @api.model
    def _nfe_vals_destinataria(self, picking):
        empresa = picking.x_nfe_filial_id
        config = self._nfe_config_da_empresa(empresa)
        return {
            'destinataria_cnpj': empresa.x_cnpj,
            'destinataria_ie': empresa.x_ie,
            'destinataria_crt': config.crt,
            'destinataria_ibge_municipio': config.ibge_municipio,
            'destinataria_logradouro': config.logradouro,
            'destinataria_numero': config.numero,
            'destinataria_bairro': config.bairro,
            'destinataria_complemento': config.complemento,
            'destinataria_municipio': config.municipio,
            'destinataria_uf': config.uf,
            'destinataria_cep': config.cep,
        }

    @api.model
    def _nfe_linha_vals(self, move, config=None):
        """Item de origem: produto, unidade, quantidade REALIZADA, custo e
        dados fiscais capturados da configuração de transferência.

        ``stock.move.quantity`` é a quantidade feita (soma das move lines),
        então uma transferência parcial de 8 entre 10 vale 8.

        Tudo é capturado AQUI, uma única vez, na primeira preparação: a nota
        não recalcula ao reabrir nem quando cadastro/config mudam. O CFOP
        comercial do produto NUNCA é sobrescrito — o CFOP da nota vem da
        configuração da operação.
        """
        if config is None:
            config = self._nfe_config_da_empresa(move.picking_id.company_id)
        produto = move.product_id
        return {
            'move_id': move.id,
            'product_id': produto.id,
            'uom_id': move.product_uom.id,
            'quantidade': move.quantity,
            'custo_unitario': self._nfe_custo_unitario(move),
            'descricao': produto.display_name,
            'ncm': produto.x_ncm_id.code,
            'origem': config.origem,
            'cfop': config.cfop,
            'icms_cst_csosn': config.icms_cst_csosn,
            'pis_cst': config.pis_cst,
            'cofins_cst': config.cofins_cst,
        }

    @api.model
    def _nfe_custo_unitario(self, move):
        """Custo do produto na empresa REMETENTE, na unidade da linha.

        ``standard_price`` é ``company_dependent`` e resolve pelo
        ``env.company`` (``odoo/models.py:2999-3003``): ``with_company`` põe a
        empresa da movimentação nesse lugar, então a empresa ativa na
        interface nunca influencia o valor.

        ``uom._compute_price`` (``addons/uom/models/uom_uom.py:243``) converte
        o preço da unidade de cadastro para a unidade do movimento; mesma
        unidade (ou categoria diferente) devolve o preço inalterado.

        Não é custo histórico por camada/lote: é o custo vigente da remetente
        no momento da preparação (spec, decisão 2).
        """
        produto = move.product_id.with_company(move.picking_id.company_id)
        return produto.uom_id._compute_price(produto.standard_price, move.product_uom)


class NfeDocumentoLinha(models.Model):
    _name = 'nfe.documento.linha'
    _description = 'Item da NF-e modelo 55'
    _order = 'documento_id, id'

    documento_id = fields.Many2one(
        'nfe.documento',
        string="NF-e",
        required=True,
        ondelete='cascade',
        index=True,
    )
    move_id = fields.Many2one(
        'stock.move',
        string="Movimento de origem",
        ondelete='restrict',
        readonly=True,
    )
    product_id = fields.Many2one('product.product', string="Produto", required=True, readonly=True)
    uom_id = fields.Many2one('uom.uom', string="Unidade", required=True, readonly=True)
    quantidade = fields.Float(
        string="Quantidade realizada",
        digits='Product Unit of Measure',
        readonly=True,
    )
    currency_id = fields.Many2one(
        'res.currency',
        string="Moeda",
        related='documento_id.currency_id',
    )
    custo_unitario = fields.Float(
        string="Custo unitário",
        digits='Product Price',
        readonly=True,
        help="Custo do produto na empresa remetente, na unidade da linha, "
             "capturado na primeira preparação.",
    )
    total_linha = fields.Monetary(
        string="Total",
        compute='_compute_total_linha',
        store=True,
        currency_field='currency_id',
    )

    # ── Snapshot fiscal do item (ticket 07) ──────────────────────────────────
    # Editáveis apenas pelo Responsável fiscal, em Rascunho (view + write).
    descricao = fields.Char(string="Descrição")
    ncm = fields.Char(string="NCM")
    origem = fields.Selection(ORIGEM_SELECTION, string="Origem")
    cfop = fields.Char(string="CFOP")
    icms_cst_csosn = fields.Selection(ICMS_CST_CSOSN_SELECTION, string="ICMS (CST/CSOSN)")
    pis_cst = fields.Selection(CST_PIS_COFINS, string="CST PIS")
    cofins_cst = fields.Selection(CST_PIS_COFINS, string="CST COFINS")

    CAMPOS_FISCAIS = (
        'descricao', 'ncm', 'origem', 'cfop', 'icms_cst_csosn', 'pis_cst', 'cofins_cst',
    )

    pode_editar_fiscal = fields.Boolean(compute='_compute_pode_editar_fiscal')

    @api.depends('documento_id')
    def _compute_pode_editar_fiscal(self):
        for linha in self:
            linha.pode_editar_fiscal = linha.documento_id.pode_editar_fiscal

    def write(self, vals):
        fiscal = any(campo in vals for campo in self.CAMPOS_FISCAIS)
        if fiscal and not self.env.user.has_group(GRUPO_RESPONSAVEL_FISCAL):
            raise AccessError(
                _("Apenas o Responsável fiscal pode ajustar dados fiscais dos itens da NF-e.")
            )
        resultado = super().write(vals)
        if fiscal:
            # Ajuste tributário por item em nota Validada exige nova validação.
            self.documento_id.filtered(lambda doc: doc.state == 'validada').write({
                'state': 'rascunho',
                'pendencias': False,
            })
        return resultado

    def _nfe_pendencias(self):
        """Pendências deste item, prefixadas pelo produto."""
        self.ensure_one()
        rotulo = self.descricao or (
            self.product_id.display_name if self.product_id else "item sem produto"
        )
        faltando = []
        if not self.product_id:
            faltando.append("produto")
        if not self.uom_id:
            faltando.append("unidade")
        if not self.quantidade:
            faltando.append("quantidade realizada")
        if self.custo_unitario <= 0:
            faltando.append("custo unitário")
        if not self.ncm:
            faltando.append("NCM")
        if not self.cfop:
            faltando.append("CFOP")
        if not self.origem:
            faltando.append("origem")
        if not self.icms_cst_csosn:
            faltando.append("ICMS (CST/CSOSN)")
        if not self.pis_cst:
            faltando.append("CST PIS")
        if not self.cofins_cst:
            faltando.append("CST COFINS")
        return [
            "Produto %s: %s ausente." % (rotulo, nome) for nome in faltando
        ]

    @api.depends('quantidade', 'custo_unitario', 'currency_id')
    def _compute_total_linha(self):
        """Quantidade × custo arredondado pela moeda da empresa emitente.

        O custo unitário NÃO é arredondado: arredondar antes de multiplicar
        desvia o total em centavos (ex.: 3,333 × 3 = 9,999 → 10,00).
        """
        for linha in self:
            linha.total_linha = linha.currency_id.round(
                linha.quantidade * linha.custo_unitario
            )
