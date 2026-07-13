/** @odoo-module */
import { PaymentScreen } from "@point_of_sale/app/screens/payment_screen/payment_screen";
import { patch } from "@web/core/utils/patch";
import { useService } from "@web/core/utils/hooks";
import { NumberPopup } from "@point_of_sale/app/utils/input_popups/number_popup";

patch(PaymentScreen.prototype, {
    
    setup() {
        super.setup();
        this.dialog = useService("dialog");
    },

    /**
     * Limpa todas as linhas de pagamento do pedido atual.
     * Chamado antes de aplicar acréscimo/desconto para evitar
     * valores residuais de troco quando o operador seleciona
     * a forma de pagamento antes de aplicar acréscimo/desconto.
     */
    _clearPaymentLines() {
        const order = this.pos.get_order();
        const lines = [...(order.payment_ids || [])];
        for (const line of lines) {
            line.delete();
        }
    },

    async clickAcrescimoButton() {
        const order = this.pos.get_order();
        const currentAcrescimo = order.x_amount_other_value || 0.0;

        // Se já tem linhas de pagamento, limpa antes de aplicar o acréscimo
        if (order.payment_ids && order.payment_ids.length > 0) {
            this._clearPaymentLines();
        }

        this.dialog.add(NumberPopup, {
            title: "Valor do Acréscimo",
            startingValue: currentAcrescimo ? currentAcrescimo.toString() : "",
            getPayload: (num) => {
                const val = this.env.utils.parseValidFloat(num ?? "0");
                const cleanVal = isNaN(val) ? 0.0 : Math.max(0, val);
                order.x_amount_other_value = cleanVal;
            },
        });
    }
});