/** @odoo-module */
import { ClosePosPopup } from "@point_of_sale/app/navbar/closing_popup/closing_popup";
import { patch } from "@web/core/utils/patch";
import { renderToElement } from "@web/core/utils/render";
import { parseFloat } from "@web/views/fields/parsers";

// Débito técnico I3: CSS compartilhado do fechamento de caixa extraído para
// static/src/css/fechamento.css (carregado como asset do POS).
// Esta const é mantida temporariamente porque o fallback de impressão
// (_printFallback) abre uma window nova via window.open() que não herda os
// assets do bundle — por isso precisa do CSS inline no <head> do popup.
// TODO: extrair para arquivo CSS compartilhado quando o fallback suportar
// carregar assets externos na window nova.
const RECEIPT_CSS = `
    .pos-receipt {
        font-family: 'Inconsolata', 'Courier New', monospace;
        font-size: 12px;
        line-height: 1.3;
        width: 72mm;
        margin: 0 auto;
        padding: 1mm 3mm;
    }
    .danfe-header { text-align: center; margin-bottom: 8px; }
    .emitente-nome { font-weight: bold; font-size: 13px; margin-bottom: 3px; }
    .emitente-dados { font-size: 10px; line-height: 1.2; }
    .emitente-endereco { font-size: 10px; line-height: 1.3; margin-top: 3px; }
    .danfe-tipo { text-align: center; font-weight: bold; font-size: 11px; margin: 8px 0; line-height: 1.4; }
    .danfe-separador { border-top: 1px dashed #000; margin: 5px 0; }
    .totais-section { margin: 8px 0; }
    .pagamento-titulo { font-weight: bold; text-align: center; margin-bottom: 4px; }
    .fiscal-section { margin-top: 10px; text-align: center; }

    /* Linha com label + valor (estilo cupom tradicional) */
    .fechamento-linha {
        display: flex;
        justify-content: space-between;
        align-items: baseline;
        margin: 1px 0;
        font-size: 11px;
    }
    .fechamento-linha span:first-child {
        white-space: nowrap;
        overflow: hidden;
    }
    .fechamento-linha .total-valor {
        white-space: nowrap;
        text-align: right;
        font-weight: normal;
    }
    /* Linha de total em destaque (negrito + borda superior) */
    .fechamento-linha-total {
        display: flex;
        justify-content: space-between;
        align-items: baseline;
        font-weight: bold;
        font-size: 12px;
        margin-top: 4px;
        padding-top: 3px;
        border-top: 1px solid #000;
    }
    .fechamento-linha-total .total-valor {
        text-align: right;
        font-weight: bold;
    }
    /* Linha de assinatura */
    .assinatura-area {
        margin-top: 30px;
        text-align: center;
    }
    .assinatura-linha {
        border-top: 1px solid #000;
        margin-top: 40px;
        padding-top: 3px;
        font-size: 10px;
        text-align: center;
    }

    @page { size: 72mm auto; margin: 0 2mm; }
    @media print {
        .pos-receipt { width: 70mm !important; font-size: 12px !important; padding: 0 2mm !important; margin: 0 auto !important; }
    }
`;

patch(ClosePosPopup.prototype, {
    async showFechamento() {
        console.log("[FECHAMENTO] Coletando dados do fechamento...");

        try {
            // 1. RPC: pega os dados do backend
            const dados = await this.env.services.orm.call(
                "pos.session",
                "get_fechamento_data",
                [[this.pos.session.id]]
            );

            // 2. Lê os valores "Counted" que o operador digitou no popup
            //    e mescla com os dados do backend (saldo detalhado)
            const countedPayments = this._getCountedValues();
            for (const saldo of dados.saldo_detalhado) {
                const counted = countedPayments[saldo.nome];
                if (counted !== undefined) {
                    saldo.informado = counted;
                    saldo.diferenca = counted - saldo.calculado;
                }
            }

            console.log("[FECHAMENTO] Dados finais:", dados);

            // 3. Renderiza o template XML num elemento DOM
            const report = renderToElement("meu_modulo.FechamentoReceipt", {
                data: dados,
                formatCurrency: this.env.utils.formatCurrency,
            });

            // 4. Tenta impressora térmica; se não tiver, fallback pra window.print
            const printer = this.hardwareProxy.printer;
            if (printer) {
                const { successful, message } = await printer.printReceipt(report);
                if (!successful) {
                    console.warn("[FECHAMENTO] Impressora falhou, usando window.print");
                    this._printFallback(report);
                }
            } else {
                console.log("[FECHAMENTO] Sem impressora, usando window.print");
                this._printFallback(report);
            }
        } catch (error) {
            console.error("[FECHAMENTO] Erro:", error);
        }
    },

    /**
     * Lê os valores "Counted" que o operador digitou no ClosePosPopup.
     * Retorna um dict { nome_metodo: valor_informado }.
     */
    _getCountedValues() {
        const result = {};
        const payments = this.state.payments;

        // Cash (default_cash_details)
        const cashDetails = this.props.default_cash_details;
        if (cashDetails && payments[cashDetails.id]) {
            const countedStr = payments[cashDetails.id].counted || "0";
            if (this.env.utils.isValidFloat(countedStr)) {
                result[cashDetails.name] = parseFloat(countedStr);
            }
        }

        // Non-cash (bank methods que têm campo counted)
        for (const pm of this.props.non_cash_payment_methods) {
            if (payments[pm.id] && this.env.utils.isValidFloat(payments[pm.id].counted)) {
                result[pm.name] = parseFloat(payments[pm.id].counted);
            }
        }

        return result;
    },

    _printFallback(el) {
        // Abre janela nova com o mesmo CSS do DANFE — formato cupom térmico
        const win = window.open('', '_blank', 'width=400,height=600');
        if (!win) {
            console.error("[FECHAMENTO] Popup bloqueado pelo browser");
            return;
        }
        win.document.write(`
            <html>
            <head>
                <title>Fechamento de Caixa</title>
                <style>${RECEIPT_CSS}</style>
            </head>
            <body>${el.outerHTML}</body>
            </html>
        `);
        win.document.close();
        win.focus();
        setTimeout(() => {
            win.print();
            win.close();
        }, 250);
    },
});