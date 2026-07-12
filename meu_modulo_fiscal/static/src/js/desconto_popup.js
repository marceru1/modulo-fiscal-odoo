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
     * Acionado quando o botão "Desconto" é clicado na tela de pagamento (PaymentScreen).
     * Invoca um Modal Numérico (NumberPopup) nativo do Odoo para capturar o valor.
     *
     * #9: usa this.env.utils.parseValidFloat para suportar o formato brasileiro (vírgula).
     * #10: usa this.pos.get_order() — consistente com cpf_popup.js.
     * #11: validação explícita de NaN antes de limpar o valor negativo.
     */
    async clickDescontoButton() {
        // #10: padrão do cpf_popup.js
        const order = this.pos.get_order();
        const currentDesconto = order.x_discount_value || 0.0;

        this.dialog.add(NumberPopup, {
            title: "Valor do Desconto (R$)",
            startingValue: currentDesconto ? currentDesconto.toString() : "",
            getPayload: (num) => {
                // #9: parseValidFloat suporta vírgula decimal (formato BR) nativamente
                const val = this.env.utils.parseValidFloat(num ?? "0");

                // #11: validação explícita de NaN
                const cleanVal = isNaN(val) ? 0.0 : Math.max(0, val);

                // #FIX: update() pula campos customizados (x_*) que não estão nas
                // model field definitions do JS — o valor vai pra baseData mas
                // não é setado no record reativo, então taxTotals nunca vê o desconto.
                // Atribuição direta seta a propriedade no proxy reativo do Owl,
                // disparando reavaliação do getter taxTotals (mesmo padrão do cpf_popup.js).
                order.x_discount_value = cleanVal;
            },
        });
    }
});
