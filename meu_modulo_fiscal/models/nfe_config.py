# -*- coding: utf-8 -*-
"""Configuração fiscal da NF-e modelo 55, por empresa (tickets 02 e 03).

Modelo próprio (não ``res.company``) por dois motivos:
  - a escrita em ``res.company`` é permissão administrativa ampla; o
    Responsável fiscal não deve ganhar isso para preencher dados fiscais;
  - a configuração é um registro por empresa, com record rule por
    ``company_ids`` do usuário.

CNPJ e IE são REUTILIZADOS de ``res.company`` (``x_cnpj``/``x_ie``, já
existentes na NFC-e) — aqui só exibidos, nunca duplicados. ``x_ambiente_fiscal``
e os ``x_csc_*`` da NFC-e não são tocados: a NF-e tem ambiente próprio, cujo
default é homologação (spec, decisão 4).
"""

from odoo import _, api, fields, models
from odoo.exceptions import ValidationError

from .campos_fiscais import CST_PIS_COFINS, ICMS_CST_CSOSN_SELECTION, ORIGEM_SELECTION

# Códigos IBGE das UFs. Lista intencionalmente separada da usada em
# res.company.x_uf_codigo: aquele campo alimenta a chave da NFC-e no PDV e não
# pode ser tocado por esta feature (spec, decisão 7).
UF_IBGE_SELECTION = [
    ('11', 'RO - Rondônia'), ('12', 'AC - Acre'), ('13', 'AM - Amazonas'),
    ('14', 'RR - Roraima'), ('15', 'PA - Pará'), ('16', 'AP - Amapá'),
    ('17', 'TO - Tocantins'), ('21', 'MA - Maranhão'), ('22', 'PI - Piauí'),
    ('23', 'CE - Ceará'), ('24', 'RN - Rio Grande do Norte'), ('25', 'PB - Paraíba'),
    ('26', 'PE - Pernambuco'), ('27', 'AL - Alagoas'), ('28', 'SE - Sergipe'),
    ('29', 'BA - Bahia'), ('31', 'MG - Minas Gerais'), ('32', 'ES - Espírito Santo'),
    ('33', 'RJ - Rio de Janeiro'), ('35', 'SP - São Paulo'), ('41', 'PR - Paraná'),
    ('42', 'SC - Santa Catarina'), ('43', 'RS - Rio Grande do Sul'),
    ('50', 'MS - Mato Grosso do Sul'), ('51', 'MT - Mato Grosso'),
    ('52', 'GO - Goiás'), ('53', 'DF - Distrito Federal'),
]


class NfeConfig(models.Model):
    _name = 'nfe.config'
    _description = 'Configuração fiscal da NF-e modelo 55'
    _rec_name = 'company_id'
    _order = 'company_id'

    company_id = fields.Many2one(
        'res.company',
        string="Empresa",
        required=True,
        default=lambda self: self.env.company,
        ondelete='cascade',
        index=True,
    )
    cnpj = fields.Char(related='company_id.x_cnpj', string="CNPJ", readonly=True)
    ie = fields.Char(related='company_id.x_ie', string="Inscrição Estadual (IE)", readonly=True)

    # ── Identificação fiscal ─────────────────────────────────────────────────
    crt = fields.Selection(
        selection=[
            ('1', '1 - Simples Nacional'),
            ('2', '2 - Simples Nacional (excesso de sublimite de receita bruta)'),
            ('3', '3 - Regime Normal'),
        ],
        string="CRT",
        help="Código de Regime Tributário da empresa. Confirme o regime com o contador.",
    )
    ibge_municipio = fields.Char(
        string="Código IBGE do município",
        size=7,
        help="Código IBGE do município do estabelecimento emitente (7 dígitos).",
    )
    ambiente = fields.Selection(
        selection=[
            ('homologacao', 'Homologação (Testes)'),
            ('producao', 'Produção'),
        ],
        string="Ambiente NF-e",
        default='homologacao',
        required=True,
        help="Ambiente da NF-e modelo 55. Independente do ambiente da NFC-e do PDV.",
    )
    serie = fields.Integer(
        string="Série pretendida",
        default=5,
        help="Série da NF-e. Referência: 5 para operações na mesma UF e 6 para "
             "UF diferente. A numeração definitiva é controlada pelo middleware.",
    )

    # ── Endereço fiscal do emitente ──────────────────────────────────────────
    logradouro = fields.Char(string="Logradouro")
    numero = fields.Char(string="Número")
    bairro = fields.Char(string="Bairro")
    complemento = fields.Char(string="Complemento")
    municipio = fields.Char(string="Município")
    uf = fields.Selection(UF_IBGE_SELECTION, string="UF")
    cep = fields.Char(string="CEP")

    # ── Operação de transferência (ticket 03) ────────────────────────────────
    # Valores iniciais são a referência vista no vídeo (CFOP 5152, CSOSN 102,
    # PIS/COFINS 07) e valem como SUGESTÃO: a configuração nasce com
    # ``conferida = False`` e depende do responsável fiscal + contador.
    natureza_operacao = fields.Char(
        string="Natureza da operação",
        default="Transferência de mercadoria",
    )
    finalidade = fields.Selection(
        selection=[
            ('1', '1 - Normal'),
            ('2', '2 - Complementar'),
            ('3', '3 - Ajuste'),
            ('4', '4 - Devolução de mercadoria'),
        ],
        string="Finalidade",
        default='1',
    )
    cfop = fields.Char(
        string="CFOP",
        default='5152',
        help="Operação estadual (mesma UF), série 5. Referência: 5152. "
             "Confirme com o contador.",
    )
    icms_cst_csosn = fields.Selection(
        ICMS_CST_CSOSN_SELECTION,
        string="ICMS (CST/CSOSN)",
        default='102',
    )
    origem = fields.Selection(
        ORIGEM_SELECTION,
        string="Origem da mercadoria",
        default='0',
    )
    pis_cst = fields.Selection(CST_PIS_COFINS, string="CST PIS", default='07')
    cofins_cst = fields.Selection(CST_PIS_COFINS, string="CST COFINS", default='07')
    conferida = fields.Boolean(
        string="Conferida",
        default=False,
        copy=False,
        help="Marcada pelo Responsável fiscal depois de conferir a operação "
             "com o contador. Qualquer alteração tributária desmarca.",
    )

    # Campos cuja alteração desmarca a conferência (spec, decisão 4).
    CAMPOS_TRIBUTARIOS = (
        'natureza_operacao', 'finalidade', 'cfop',
        'icms_cst_csosn', 'origem', 'pis_cst', 'cofins_cst',
    )

    _sql_constraints = [
        ('company_uniq', 'unique(company_id)',
         'Já existe uma configuração de NF-e para esta empresa.'),
    ]

    # ── Validações de formato ────────────────────────────────────────────────
    @api.constrains('ibge_municipio')
    def _check_ibge_municipio(self):
        for config in self:
            if config.ibge_municipio and not config.ibge_municipio.isdigit():
                raise ValidationError(_("O código IBGE do município deve conter apenas dígitos."))

    @api.constrains('cfop')
    def _check_cfop(self):
        for config in self:
            if config.cfop and (len(config.cfop) != 4 or not config.cfop.isdigit()):
                raise ValidationError(_("O CFOP deve ter 4 dígitos numéricos."))

    # ── Conferência ──────────────────────────────────────────────────────────
    def write(self, vals):
        """Alterar dado tributário desmarca a conferência anterior.

        A cópia de ``vals`` evita mutar o dict do chamador. Marcar
        ``conferida`` EXPLICITAMENTE no mesmo write vence: o responsável
        fiscal está confirmando justamente os valores novos (é o caso do
        form: ajusta o campo e marca "Conferida" antes de salvar).
        """
        if 'conferida' not in vals and any(campo in vals for campo in self.CAMPOS_TRIBUTARIOS):
            vals = dict(vals, conferida=False)
        return super().write(vals)

    # ── Sugestões iniciais (nunca parse) ─────────────────────────────────────
    @api.onchange('company_id')
    def _onchange_company_id_uf(self):
        """Sugere a UF a partir do cadastro da empresa quando ainda estiver vazia.

        Não sugere logradouro a partir de ``x_endereco_linha1``: o texto livre
        da NFC-e mistura logradouro e número ("Av. 7 DE SETEMBRO, 767") e
        gravar isso como logradouro colocaria o número no campo errado. Sem
        parse de texto: o responsável fiscal preenche os campos estruturados.
        """
        for config in self:
            if config.company_id and not config.uf:
                config.uf = config.company_id.x_uf_codigo
