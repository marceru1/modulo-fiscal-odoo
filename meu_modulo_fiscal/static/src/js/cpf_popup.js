/** @odoo-module */
import { ControlButtons } from "@point_of_sale/app/screens/product_screen/control_buttons/control_buttons";
import { patch } from "@web/core/utils/patch";
import { useService } from "@web/core/utils/hooks";
import { TextInputPopup } from "@point_of_sale/app/utils/input_popups/text_input_popup";

patch(ControlButtons.prototype, {
    
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
                console.log("CPF digitado:", cpf);

                const cpf_clean = cpf.replace(/\D/g, "");//regex pra tirar ponto, virgula e zas
                console.log("CPF digitado:", cpf_clean);
                
                const order = this.pos.get_order();
                order.x_cpf_nota = cpf_clean;
                console.log("deu certo aparentemente");
        
            },

            // fecha o popup
            close: () => {},
        });
    }
});