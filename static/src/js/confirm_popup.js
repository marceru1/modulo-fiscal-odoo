/** @odoo-module */
import { useService } from "@web/core/utils/hooks";
import { makeAwaitable } from "@point_of_sale/app/store/make_awaitable_dialog";
import { _t } from "@web/core/l10n/translation";
import { PaymentScreen } from "@point_of_sale/app/screens/payment_screen/payment_screen";
import { patch } from "@web/core/utils/patch";
import { SelectionPopup } from "@point_of_sale/app/utils/input_popups/selection_popup";
import { TextInputPopup } from "@point_of_sale/app/utils/input_popups/text_input_popup";
patch(PaymentScreen.prototype, {
    setup() {
        super.setup();
        this.dialog = useService("dialog");
    },

    async validateOrder(isForceValidate) {
        console.log("Cliquei em validar, aguardando confirmação...");

        //aqui ele vai "parar" de rodar e subir o popup pra confirmar a venda
        const result = await makeAwaitable(this.dialog, SelectionPopup, {
            title: _t("Confirmar venda?"),
            list: [
                {
                    id: 1, label: _t("Sim"),item: true, // Se escolher sim, retorna true     
                },
                {
                    id: 0, label: _t("Não"),  item: false, // Se escolher nao, retorna false
                },
            ],
        });

        //aqui pega o order que ta em caminho
        const order = this.pos.get_order();
        order.x_confirmacao_venda = result;


        //se 'true' ele abre uma aba pra adicionar o email do cliente

        if (result === true) {
            // receber o email informado
            const email_cliente = await makeAwaitable(this.dialog, TextInputPopup, {
            title: "Informe o E-mail",
            placeholder: "Digite o e-mail do cliente",
            startingValue: "",
        });
            if(email_cliente) {
                order.x_email_cliente = email_cliente;
            }
    }
            
       
       await super.validateOrder(isForceValidate);
        
        
    }
});