/** @odoo-module */
// Componente Owl do recibo de sangria de caixa (feature recibo-sangria-impresso).
//
// DEC-002 (spec) previa reutilizar o ReceiptHeader nativo, mas o grill com o
// usuario decidiu usar o danfe-header do modulo (que renderiza endereco e CNPJ
// da empresa, o que o ReceiptHeader nativo nao faz). Por isso o componente nao
// importa ReceiptHeader nem declara components — o cabecalho vive no template.
import { Component } from "@odoo/owl";

export class SangriaReceipt extends Component {
    static template = "meu_modulo_fiscal.SangriaReceipt";
    static props = {
        empresa: Object,
        formattedAmount: String,
        reason: String,
        date: String,
    };
}
