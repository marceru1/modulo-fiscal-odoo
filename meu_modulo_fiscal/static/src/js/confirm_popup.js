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
        this.ui = useService("ui");
        this.orm = useService("orm");
    },

    
    async validateOrder(isForceValidate) {
        console.log("Cliquei em validar, aguardando confirmação...");

        // popup de Confirmação
        const result = await makeAwaitable(this.dialog, SelectionPopup, {
            title: _t("Confirmar venda?"),
            list: [
                { id: 1, label: _t("Sim"), item: true },
                { id: 0, label: _t("Não"), item: false },
            ],
        });

        const order = this.pos.get_order();
        order.x_confirmacao_venda = result;

        // coleta de e-mail
        if (result === true) {
            const email_cliente = await makeAwaitable(this.dialog, TextInputPopup, {
                title: "Informe o E-mail",
                placeholder: "Digite o e-mail do cliente",
                startingValue: "",
            });
            if (email_cliente) {
                order.x_email_cliente = email_cliente;
            }
        }

        // envia para o backend
        await super.validateOrder(isForceValidate);

        // aguarda o retorno fiscal caso teanha marcado sim
        if (result === true) {
            
            this.ui.block();
            console.log("🔄 Aguardando retorno fiscal...");

            const posReference = order.pos_reference || order.name;
            let status = false;

            // loop de 15 segundos
            for (let i = 0; i < 10; i++) {
                try {
                
                    const searchResult = await this.env.services.orm.searchRead(
                        "pos.order",
                        [["pos_reference", "=", posReference]],
                        [
                            "x_fiscal_status", 
                            "x_fiscal_mensagem",
                            "x_fiscal_chave",
                            "x_fiscal_numero",
                            "x_fiscal_serie",
                            "x_fiscal_protocolo",
                            "x_fiscal_qrcode_url",
                            "x_fiscal_qrcode_b64", // Importante vir o Base64
                            "x_fiscal_offline"
                        ]
                    );

                    if (searchResult.length && searchResult[0].x_fiscal_status) {
                        const dados = searchResult[0];
                        status = dados.x_fiscal_status;
                        
                        console.log("✅ Status fiscal recebido:", status);
                        
                        // atualiza o objeto pra impressao
                        order.x_fiscal_status = dados.x_fiscal_status;
                        order.x_fiscal_mensagem = dados.x_fiscal_mensagem;
                        order.x_fiscal_chave = dados.x_fiscal_chave;
                        order.x_fiscal_numero = dados.x_fiscal_numero;
                        order.x_fiscal_serie = dados.x_fiscal_serie;
                        order.x_fiscal_protocolo = dados.x_fiscal_protocolo;
                        order.x_fiscal_qrcode_url = dados.x_fiscal_qrcode_url;
                        order.x_fiscal_qrcode_b64 = dados.x_fiscal_qrcode_b64;
                        order.x_fiscal_offline = dados.x_fiscal_offline;
                         console.log("==== CONTINGENCIA popup?", order.x_fiscal_offline);
                        break; // sai do loop
                    }
                } catch (error) {
                    console.error("Erro ao consultar status:", error);
                }

                await new Promise(r => setTimeout(r, 1000));
            }

            if (!status) {
                console.log("❌ Timeout: Status fiscal não chegou a tempo.");
        
                order.x_fiscal_status = 'erro';
                order.x_fiscal_mensagem = 'Tempo limite excedido na comunicação.';
            }

            this.ui.unblock();
        } else {
            console.log("⏩ Venda não fiscal: Pulando verificação.");
        }
    }
});