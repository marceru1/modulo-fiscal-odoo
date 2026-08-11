/** @odoo-module */
import { ClosePosPopup } from "@point_of_sale/app/navbar/closing_popup/closing_popup";
import { patch } from "@web/core/utils/patch";
import { renderToElement } from "@web/core/utils/render";
import { parseFloat } from "@web/views/fields/parsers";
import { printFallback } from "./receipt_print_helper";

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
                    printFallback(report, "Fechamento de Caixa");
                }
            } else {
                console.log("[FECHAMENTO] Sem impressora, usando window.print");
                printFallback(report, "Fechamento de Caixa");
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

        // Non-cash (bank + pay_later): usa o valor calculado do sistema.
        // Os inputs "Counted" foram removidos do popup (fechamento_simplificar.xml),
        // então o operador não digita mais esses valores. O pm.amount é o valor
        // real das transações — INFORMADO = CALCULADO, DIFERENÇA = 0 no relatório.
        for (const pm of this.props.non_cash_payment_methods) {
            result[pm.name] = pm.amount ?? 0;
        }

        return result;
    },
});