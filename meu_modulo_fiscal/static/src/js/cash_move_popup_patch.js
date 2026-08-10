/** @odoo-module */
// Patch do CashMovePopup para imprimir um recibo customizado em português
// quando a operação é uma SANGRIA (type='out'). Suprimentos (type='in')
// seguem o fluxo nativo intacto (DEC-001).
//
// Estratégia: o confirm() nativo imprime o CashMoveReceipt inline, sem um
// método auxiliar que possa ser sobrescrito isoladamente. Então o patch:
//   - delega type='in' para super.confirm() — zero duplicação no caminho nativo
//   - replica a lógica nativa APENAS para type='out', trocando o print pelo
//     SangriaReceipt (danfe-header do módulo, decisão do grill)
// Consequência documentada (DEC-001): se o Odoo mudar a assinatura de
// confirm(), este caminho 'out' precisa ser revisto na migração.
// Revisão adversarial (doubt-driven): this._super não existe no patch() do
// Odoo 18 — usar `super.confirm(...)` (JS super keyword).
import { _t } from "@web/core/l10n/translation";
import { parseFloat } from "@web/views/fields/parsers";
import { patch } from "@web/core/utils/patch";
import { CashMovePopup } from "@point_of_sale/app/navbar/cash_move_popup/cash_move_popup";
import { SangriaReceipt } from "./sangria_receipt";

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
        await this.printer.print(SangriaReceipt, {
            reason,
            formattedAmount,
            empresa: {
                nome: this.pos.company.name || "",
                cnpj: this.pos.company.x_cnpj || "",
                endereco_linha1: this.pos.company.x_endereco_linha1 || "",
                endereco_linha2: this.pos.company.x_endereco_linha2 || "",
            },
            date: new Date().toLocaleString(),
        });

        this.props.close();
        this.notification.add(
            _t("Successfully made a cash out of %s.", formattedAmount),
            3000
        );
    },
});
