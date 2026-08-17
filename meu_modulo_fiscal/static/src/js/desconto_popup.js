/** @odoo-module */
import { PaymentScreen } from "@point_of_sale/app/screens/payment_screen/payment_screen";
import { patch } from "@web/core/utils/patch";
import { useService } from "@web/core/utils/hooks";
import { showValorPopup } from "./valor_popup_helper";

patch(PaymentScreen.prototype, {
    setup() {
        super.setup();
        this.dialog = useService("dialog");
    },

    async clickDescontoButton() {
        const order = this.pos.get_order();
        // I9: lógica extraída para helper compartilhado (valor_popup_helper.js)
        showValorPopup(this.dialog, this.env, order, "x_discount_value", "Valor do Desconto (R$)");
    }
});