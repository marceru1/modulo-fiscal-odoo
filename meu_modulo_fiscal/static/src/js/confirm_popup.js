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

    /**
     * Validação e submissão de Pagamento
     * Intercepta a finalização padrão do Odoo PDV para capturar 
     * campos fiscais adicionais (Flag de Emissão e E-mail do Cliente) 
     * e implementar um Polling assíncrono (Loop de Espera) pelo retorno do Middleware Laravel.
     */
    async validateOrder(isForceValidate) {
        
        // 1. Pergunta se deseja emitir a NFC-e ou apenas registrar venda interna
        const result = await makeAwaitable(this.dialog, SelectionPopup, {
            title: _t("Confirmar Venda e Emitir NFC-e?"),
            list: [
                { id: 1, label: _t("Sim, Emitir Agora"), item: true },
                { id: 0, label: _t("Não, Apenas Venda Interna"), item: false },
            ],
        });

        const order = this.pos.get_order();
        order.x_confirmacao_venda = result;

        // 2. Se for emitir nfce, captura opcionalmente o E-mail para Danfe Eletrônico
        if (result === true) {
            const email_cliente = await makeAwaitable(this.dialog, TextInputPopup, {
                title: _t("E-mail do Cliente (Opcional)"),
                placeholder: _t("danfe@exemplo.com.br"),
                startingValue: "",
            });
            if (email_cliente) {
                order.x_email_cliente = email_cliente;
            }
        }

        // 3. Executa a validação original do Odoo (dispara os Webhooks criados no Python)
        await super.validateOrder(isForceValidate);

        // 4. Mecanismo de Polling Temporário (Max 10 Segundos)
        // Se escolheu emitir, congela a tela com Block() e fica conferindo no Postgres (ORM SearchRead)
        // se o Webhook Controller do Laravel já despachou a Chave de Acesso e QR Code de Volta.
        if (result === true) {
            this.ui.block();

            const posReference = order.pos_reference || order.name;
            let status = false;

            // Loop de 10 tentativas com delay de 1 segundo entre elas
            for (let i = 0; i < 10; i++) {
                try {
                    const searchResult = await this.orm.searchRead(
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
                            "x_fiscal_qrcode_b64",
                            "x_fiscal_offline"
                        ]
                    );

                    // Se encontrou dados preenchidos pelo Laravel na Tabela, quebra o loop
                    if (searchResult.length && searchResult[0].x_fiscal_status) {
                        const dados = searchResult[0];
                        status = dados.x_fiscal_status;
                        
                        // Atualiza a Order local em memória com os dados do Banco 
                        // para que a Próxima Tela (Recibo) consiga desenhar o QR Code.
                        order.x_fiscal_status = dados.x_fiscal_status;
                        order.x_fiscal_mensagem = dados.x_fiscal_mensagem;
                        order.x_fiscal_chave = dados.x_fiscal_chave;
                        order.x_fiscal_numero = dados.x_fiscal_numero;
                        order.x_fiscal_serie = dados.x_fiscal_serie;
                        order.x_fiscal_protocolo = dados.x_fiscal_protocolo;
                        order.x_fiscal_qrcode_url = dados.x_fiscal_qrcode_url;
                        order.x_fiscal_qrcode_b64 = dados.x_fiscal_qrcode_b64;
                        order.x_fiscal_offline = dados.x_fiscal_offline;
                        break;
                    }
                } catch (error) {
                    console.error("[PDV-FISCAL] Erro ao consultar status da nota:", error);
                }

                await new Promise(r => setTimeout(r, 1000));
            }

            // Timeout (Contingência Visual): O Odoo não vai esperar mais que 10s pra não irritar o cliente
            if (!status) {
                order.x_fiscal_status = 'erro';
                order.x_fiscal_mensagem = 'Tempo de resposta Sefaz/Middleware excedido. Verifique o Backoffice.';
            }

            // Tela de recibo liberada
            this.ui.unblock();
        }
    }
});