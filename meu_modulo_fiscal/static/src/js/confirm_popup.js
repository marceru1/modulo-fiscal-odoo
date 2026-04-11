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
        this.orm = useService("orm");
    },

    /**
     * Validação e submissão de Pagamento.
     * Intercepta a finalização do PDV para capturar campos fiscais adicionais
     * e iniciar o polling assíncrono pelo retorno do Middleware Laravel.
     *
     * IMPORTANTE: Não usamos ui.block()/unblock() pois o Odoo 18 já gerencia
     * internamente múltiplos block/unblock durante o super.validateOrder(),
     * e adicionar mais um par desbalanceia o contador interno → tela travada.
     * 
     * Solução: Polling em background sem bloquear a UI. O recibo aparece
     * imediatamente como "SEM VALOR FISCAL" e atualiza o objeto order em
     * memória quando a NFC-e for autorizada (para reimpressão correta).
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

        // 2. Se for emitir NFC-e, captura opcionalmente o E-mail para DANFE Eletrônico
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

        // 3. Executa a validação original do Odoo (dispara Webhooks Python, navega pro recibo)
        await super.validateOrder(isForceValidate);

        // 4. Polling em background — SEM bloquear a UI
        // O recibo já aparece na tela. Este loop atualiza o objeto `order` em memória
        // para que uma reimpressão mostre os dados fiscais corretos.
        if (result === true) {
            const posReference = order.pos_reference || order.name;
            this._pollFiscalStatus(order, posReference);
        }
    },

    /**
     * Polling assíncrono pelo status fiscal no Banco de Dados.
     * Roda em background sem bloquear a UI do caixa.
     * Atualiza o objeto order em memória quando a NFC-e for processada.
     *
     * @param {Object} order - Objeto do pedido POS local
     * @param {string} posReference - Referência do pedido para busca no BD
     */
    async _pollFiscalStatus(order, posReference) {
        const MAX_TENTATIVAS = 20;
        const DELAY_MS = 1500;

        for (let i = 0; i < MAX_TENTATIVAS; i++) {
            await new Promise(r => setTimeout(r, DELAY_MS));

            try {
                const searchResult = await this.orm.searchRead(
                    "pos.order",
                    ["|",
                        ["pos_reference", "=", posReference],
                        ["name", "=", posReference]
                    ],
                    [
                        "x_fiscal_status",
                        "x_fiscal_mensagem",
                        "x_fiscal_chave",
                        "x_fiscal_numero",
                        "x_fiscal_serie",
                        "x_fiscal_protocolo",
                        "x_fiscal_qrcode_url",
                        "x_fiscal_qrcode_b64",
                        "x_fiscal_offline",
                    ]
                );

                if (searchResult.length && searchResult[0].x_fiscal_status) {
                    const dados = searchResult[0];
                    // Atualiza o objeto order em memória
                    order.x_fiscal_status    = dados.x_fiscal_status;
                    order.x_fiscal_mensagem  = dados.x_fiscal_mensagem;
                    order.x_fiscal_chave     = dados.x_fiscal_chave;
                    order.x_fiscal_numero    = dados.x_fiscal_numero;
                    order.x_fiscal_serie     = dados.x_fiscal_serie;
                    order.x_fiscal_protocolo = dados.x_fiscal_protocolo;
                    order.x_fiscal_qrcode_url = dados.x_fiscal_qrcode_url;
                    order.x_fiscal_qrcode_b64 = dados.x_fiscal_qrcode_b64;
                    order.x_fiscal_offline   = dados.x_fiscal_offline;

                    console.info(`[PDV-FISCAL] ✅ NFC-e ${dados.x_fiscal_status} para ${posReference}`);
                    return;
                }

            } catch (error) {
                console.error("[PDV-FISCAL] Erro ao consultar status fiscal:", error);
            }
        }

        // Timeout após MAX_TENTATIVAS × DELAY_MS ms (30s)
        console.warn(`[PDV-FISCAL] ⚠️ Timeout aguardando NFC-e para ${posReference}. Verifique o backoffice.`);
        order.x_fiscal_status = "erro";
        order.x_fiscal_mensagem = "Tempo esgotado. A NFC-e pode ter sido emitida. Verifique o Backoffice.";
    }
});