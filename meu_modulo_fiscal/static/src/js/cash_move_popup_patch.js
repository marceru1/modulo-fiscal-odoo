/** @odoo-module */
// Patch do CashMovePopup para imprimir um recibo customizado em português
// quando a operação é uma SANGRIA (type='out'). Suprimentos (type='in')
// seguem o fluxo nativo intacto (DEC-001).
//
// Estratégia: o confirm() nativo imprime o CashMoveReceipt inline, sem um
// método auxiliar que possa ser sobrescrito isoladamente. Então o patch:
//   - delega type='in' para super.confirm() — zero duplicação no caminho nativo
//   - replica a lógica nativa APENAS para type='out', trocando o print pelo
//     SangriaReceipt (danfe-header do módulo, decisão do grill), mas usando
//     o MESMO mecanismo de impressão do módulo (renderToElement +
//     hardwareProxy.printReceipt + printFallback) — o caminho nativo
//     this.printer.print(Component, props) não imprime neste ambiente
//     (ver comentário no confirm()).
//   Fix 2026-08-10: o v1 usava this.printer.print(SangriaReceipt, props)
//     (printer SERVICE) copiando o nativo — sem webPrintFallback ele retorna
//     undefined silenciosamente quando não há dispositivo (printer_service.js
//     printHtml:29-30). Mesma falha do CashMoveReceipt nativo, que a spec já
//     apontava ("a impressão não está acontecendo no ambiente atual").
// Consequência documentada (DEC-001): se o Odoo mudar a assinatura de
// confirm(), este caminho 'out' precisa ser revisto na migração.
// Revisão adversarial (doubt-driven): this._super não existe no patch() do
// Odoo 18 — usar `super.confirm(...)` (JS super keyword).
import { _t } from "@web/core/l10n/translation";
import { parseFloat } from "@web/views/fields/parsers";
import { patch } from "@web/core/utils/patch";
import { renderToElement } from "@web/core/utils/render";
import { CashMovePopup } from "@point_of_sale/app/navbar/cash_move_popup/cash_move_popup";
import { printFallback } from "./receipt_print_helper";

patch(CashMovePopup.prototype, {
    async confirm() {
        // Suprimentos (type='in'): comportamento nativo inalterado.
        // `super.confirm` (JS super keyword), não `_super` — o patch() do
        // Odoo 18 encadeia o método original via prototype (ver print_fix.js).
        if (this.state.type !== "out") {
            return super.confirm(...arguments);
        }

        // Sangria (type='out'): mesma lógica do nativo, mas o recibo sai no
        // layout em português com assinatura (SangriaReceipt).
        const amount = parseFloat(this.state.amount);
        const formattedAmount = this.env.utils.formatCurrency(amount);
        if (!amount) {
            this.notification.add(_t("Cash in/out of %s is ignored.", formattedAmount));
            return this.props.close();
        }

        const reason = this.state.reason.trim();
        await this.pos.data.call(
            "pos.session",
            "try_cash_in_out",
            this._prepare_try_cash_in_out_payload("out", amount, reason, {
                formattedAmount,
                translatedType: _t("out"),
            }),
            {},
            true
        );
        await this.pos.logEmployeeMessage(
            `${_t("Cash")} ${_t("out")} - ${_t("Amount")}: ${formattedAmount}`,
            "CASH_DRAWER_ACTION"
        );
        // Imprime o recibo no MESMO mecanismo do comprovante e do fechamento:
        // renderToElement + hardwareProxy.printReceipt + printFallback.
        // O caminho this.printer.print(Component, props) (printer SERVICE,
        // usado pelo CashMoveReceipt nativo) não imprime neste ambiente:
        // printHtml() retorna undefined silenciosamente quando não há
        // dispositivo e webPrintFallback é false (printer_service.js:29-30).
        //
        // O try/catch aqui NÃO contradiz o ticket 03 ("não adicionar try/catch
        // redundante"): a sangria já foi persistida acima (try_cash_in_out) e o
        // try/catch garante que uma falha de impressora nunca impeça o popup
        // de fechar — mesmo intuito do comprovante (recebimento_button.js
        // envolve _printComprovante em try/catch).
        try {
            const report = renderToElement("meu_modulo_fiscal.SangriaReceipt", {
                props: {
                    empresa: {
                        nome: this.pos.company.name || "",
                        cnpj: this.pos.company.x_cnpj || "",
                        endereco_linha1: this.pos.company.x_endereco_linha1 || "",
                        endereco_linha2: this.pos.company.x_endereco_linha2 || "",
                    },
                    formattedAmount,
                    reason,
                    date: new Date().toLocaleString(),
                },
            });
            const printer = this.hardwareProxy.printer;
            if (printer) {
                const { successful } = await printer.printReceipt(report);
                if (!successful) {
                    console.warn("[SANGRIA] Impressora falhou, usando window.print");
                    printFallback(report, "Sangria de Caixa");
                }
            } else {
                console.log("[SANGRIA] Sem impressora, usando window.print");
                printFallback(report, "Sangria de Caixa");
            }
        } catch (error) {
            console.error("[SANGRIA] Erro ao imprimir recibo:", error);
        }

        this.props.close();
        this.notification.add(
            _t("Successfully made a cash out of %s.", formattedAmount),
            3000
        );
    },
});
