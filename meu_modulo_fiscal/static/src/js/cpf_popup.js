/** @odoo-module */
import { patch } from "@web/core/utils/patch";
import { useService } from "@web/core/utils/hooks";
import { CpfInputPopup } from "./cpf_input_popup";

patch(PaymentScreen.prototype, {
    
    setup() {
        super.setup();
        this.dialog = useService("dialog");
    },

    /**
     * Acionado quando o botão "CPF / Nota" é clicado na tela de pagamento (PaymentScreen).
     * Invoca um Modal (TextInputPopup) nativo do Odoo para capturar inputs rápidos.
     */
    async clickCpfButton() {
        this.dialog.add(CpfInputPopup, {
            title: "Informe o CPF",
            placeholder: "Digite apenas números",
            getPayload: (cpf) => {
                // Remove pontuações ou traços indesejados antes de mandar pro Odoo Python
                const cpf_clean = cpf.replace(/\D/g, "");
                
                const order = this.pos.get_order();
                order.x_cpf_nota = cpf_clean;
                
            },

        });
    }
});