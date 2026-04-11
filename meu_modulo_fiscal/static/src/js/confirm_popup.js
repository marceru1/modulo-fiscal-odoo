/** @odoo-module */
import { useService } from "@web/core/utils/hooks";
import { makeAwaitable } from "@point_of_sale/app/store/make_awaitable_dialog";
import { _t } from "@web/core/l10n/translation";
import { PaymentScreen } from "@point_of_sale/app/screens/payment_screen/payment_screen";
import { patch } from "@web/core/utils/patch";
import { SelectionPopup } from "@point_of_sale/app/utils/input_popups/selection_popup";
import { TextInputPopup } from "@point_of_sale/app/utils/input_popups/text_input_popup";

/**
 * Polling assíncrono pelo status fiscal no Banco de Dados.
 * Função standalone (fora do componente) para evitar erros de ciclo de vida.
 * Roda em background sem bloquear a UI do caixa.
 *
 * @param {Object} order      - Objeto do pedido POS local
 * @param {string} posRef     - Referência do pedido para busca no BD
 * @param {Object} ormService - this.env.services.orm capturado antes da destruição
 */
async function _pollFiscalStatus(order, posRef, ormService) {
    const MAX_TENTATIVAS = 20;
    const DELAY_MS = 1500;

    for (let i = 0; i < MAX_TENTATIVAS; i++) {
        await new Promise(r => setTimeout(r, DELAY_MS));

        try {
            const rows = await ormService.searchRead(
                "pos.order",
                ["|",
                    ["pos_reference", "=", posRef],
                    ["name", "=", posRef]
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

            if (rows.length && rows[0].x_fiscal_status) {
                const d = rows[0];
                order.x_fiscal_status    = d.x_fiscal_status;
                order.x_fiscal_mensagem  = d.x_fiscal_mensagem;
                order.x_fiscal_chave     = d.x_fiscal_chave;
                order.x_fiscal_numero    = d.x_fiscal_numero;
                order.x_fiscal_serie     = d.x_fiscal_serie;
                order.x_fiscal_protocolo = d.x_fiscal_protocolo;
                order.x_fiscal_qrcode_url = d.x_fiscal_qrcode_url;
                order.x_fiscal_qrcode_b64 = d.x_fiscal_qrcode_b64;
                order.x_fiscal_offline   = d.x_fiscal_offline;
                console.info(`[PDV-FISCAL] ✅ NFC-e ${d.x_fiscal_status} para ${posRef}`);
                return;
            }

        } catch (err) {
            console.error("[PDV-FISCAL] Erro ao consultar status fiscal:", err);
            return; // interrompe se o serviço falhar
        }
    }

    // Timeout
    console.warn(`[PDV-FISCAL] ⚠️ Timeout aguardando NFC-e para ${posRef}.`);
    order.x_fiscal_status = "erro";
    order.x_fiscal_mensagem = "Tempo esgotado. A NFC-e pode ter sido emitida. Verifique o Backoffice.";
}

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
     * IMPORTANTE: o ormService é capturado via this.env.services.orm (serviço bruto)
     * ANTES de super.validateOrder() destruir o componente PaymentScreen ao navegar
     * para a tela de recibo. O useService proxy lança "Component is destroyed" após isso.
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
            const email = await makeAwaitable(this.dialog, TextInputPopup, {
                title: _t("E-mail do Cliente (Opcional)"),
                placeholder: _t("danfe@exemplo.com.br"),
                startingValue: "",
            });
            if (email) {
                order.x_email_cliente = email;
            }
        }

        // 3. Captura serviço ORM bruto e referência do pedido ANTES da navegação
        const ormService = this.env.services.orm;
        const posRef = result === true ? (order.pos_reference || order.name) : null;

        // 4. Executa a validação original do Odoo (dispara Webhooks Python, navega pro recibo)
        await super.validateOrder(isForceValidate);

        // 5. Polling em background sem bloquear a UI
        if (result === true && posRef) {
            _pollFiscalStatus(order, posRef, ormService);
        }
    },
});