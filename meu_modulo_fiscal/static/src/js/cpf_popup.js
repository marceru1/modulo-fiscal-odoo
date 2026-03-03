/** @odoo-module */
import { PaymentScreen } from "@point_of_sale/app/screens/payment_screen/payment_screen";
import { patch } from "@web/core/utils/patch";
import { useService } from "@web/core/utils/hooks";
import { TextInputPopup } from "@point_of_sale/app/utils/input_popups/text_input_popup";

patch(PaymentScreen.prototype, {
    
    setup() {
        super.setup();
        this.dialog = useService("dialog");
    },

    async clickCpfButton() {
        
        //abre o popup pra inserir o cpf
        this.dialog.add(TextInputPopup, {
            title: "Informe o CPF",
            placeholder: "Digite apenas números",
            startingValue: "",
            rows: 1,

            // receber o cpf informado
            getPayload: (cpf) => {

                const cpf_clean = cpf.replace(/\D/g, "");//regex pra tirar ponto, virgula e zas
                
                const order = this.pos.get_order();
                order.x_cpf_nota = cpf_clean;
                
            },


        });
    }
});