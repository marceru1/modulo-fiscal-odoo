/** @odoo-module */
import { useService } from "@web/core/utils/hooks";
import { makeAwaitable } from "@point_of_sale/app/store/make_awaitable_dialog";
import { _t } from "@web/core/l10n/translation";
import { PaymentScreen } from "@point_of_sale/app/screens/payment_screen/payment_screen";
import { patch } from "@web/core/utils/patch";
import { SelectionPopup } from "@point_of_sale/app/utils/input_popups/selection_popup";
import { TextInputPopup } from "@point_of_sale/app/utils/input_popups/text_input_popup";
import { emitirContingencia } from "./fiscal_contingencia";

patch(PaymentScreen.prototype, {
    setup() {
        super.setup();
        this.dialog = useService("dialog");
        this.ui = useService("ui");
        this.orm = useService("orm");
        // Sincroniza o localStorage com o seed do banco logo na abertura do caixa.
        // Garante que PC novo ou cache limpo nunca recomece do número 1. (DEC-010)
        this._sincronizarSeedContingencia();
    },

    /**
     * Calibra o localStorage com o último número emitido registrado no backend.
     * Executado uma vez na abertura de cada sessão POS (evento sempre online).
     * Se o localStorage já está à frente (caixa gerou notas offline), não faz nada.
     */
    _sincronizarSeedContingencia() {
        try {
            const session = this.pos.session;
            const seedBackend = session._ultimo_numero_contingencia || 0;
            const serieSeed = session._serie_contingencia;
            const cnpj = (this.pos.company.x_cnpj || '').replace(/\D/g, '').padEnd(14, '0');

            if (!serieSeed || !cnpj) return;

            const STORAGE_KEY = `nfce_seq_${cnpj}_s${serieSeed}`;
            const state = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{"ultimo": 0}');

            if (seedBackend > state.ultimo) {
                localStorage.setItem(STORAGE_KEY, JSON.stringify({ ultimo: seedBackend }));
                console.log(`✅ [CONTINGENCIA-SEED] Calibrado: ${state.ultimo} → ${seedBackend} (série ${serieSeed})`);
            } else {
                console.log(`ℹ️ [CONTINGENCIA-SEED] localStorage OK (local=${state.ultimo} ≥ banco=${seedBackend})`);
            }
        } catch (e) {
            console.warn('[CONTINGENCIA-SEED] Falha ao sincronizar seed:', e);
        }
    },

    async _awaitFiscalReturn(order) {
        this.ui.block();
        console.log("🔄 Aguardando retorno fiscal...");

        const posReference = order.pos_reference || order.name;
        let statusAcquired = false;

        // Loop de tentativas (aumentado para lidar com latência VPS)
        for (let i = 0; i < 15; i++) {
            try {
                // CORREÇÃO CRÍTICA: Usar this.env.services.orm em vez de this.orm
                // Pois após o super.validateOrder a tela muda e destrói a referência local do orm.
                const searchResult = await this.env.services.orm.searchRead(
                    "pos.order",
                    [["pos_reference", "=", posReference]],
                    [
                        "x_fiscal_status", "x_fiscal_mensagem", "x_fiscal_chave",
                        "x_fiscal_numero", "x_fiscal_serie", "x_fiscal_protocolo",
                        "x_fiscal_qrcode_url", "x_fiscal_qrcode_b64", "x_fiscal_offline"
                    ]
                );

                if (searchResult.length && searchResult[0].x_fiscal_status) {
                    const dados = searchResult[0];
                    statusAcquired = true;
                    
                    console.log("✅ Status fiscal recebido:", dados.x_fiscal_status);
                    
                    // Otimização: Object.assign substitui a repetição manual e é reativo para o Odoo 18
                    Object.assign(order, {
                        x_fiscal_status: dados.x_fiscal_status,
                        x_fiscal_mensagem: dados.x_fiscal_mensagem,
                        x_fiscal_chave: dados.x_fiscal_chave,
                        x_fiscal_numero: dados.x_fiscal_numero,
                        x_fiscal_serie: dados.x_fiscal_serie,
                        x_fiscal_protocolo: dados.x_fiscal_protocolo,
                        x_fiscal_qrcode_url: dados.x_fiscal_qrcode_url,
                        x_fiscal_qrcode_b64: dados.x_fiscal_qrcode_b64,
                        x_fiscal_offline: dados.x_fiscal_offline,
                    });
                    break;
                }
            } catch (error) {
                console.error("Erro ao consultar status:", error);
            }
            await new Promise(r => setTimeout(r, 1000));
        }

        if (!statusAcquired) {
            console.log("❌ Timeout: Status fiscal não chegou a tempo.");
            Object.assign(order, {
                x_fiscal_status: 'erro',
                x_fiscal_mensagem: 'Tempo limite excedido na comunicação.'
            });
        }
        this.ui.unblock();
    },

    async validateOrder(isForceValidate) {
        console.log("Cliquei em validar, aguardando confirmação...");

        // Popup de Confirmação
        const result = await makeAwaitable(this.dialog, SelectionPopup, {
            title: _t("Confirmar venda?"),
            list: [
                { id: 1, label: _t("Sim"), item: true },
                { id: 0, label: _t("Não"), item: false },
            ],
        });

        const order = this.pos.get_order();
        order.x_confirmacao_venda = result;

        // Coleta de E-mail
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

        // ============================================
        // CONTINGÊNCIA IMEDIATA (Offline)
        // ============================================
        if (result === true && !navigator.onLine) {
            console.log("Detectado modo offline! Emitindo em contingência.");
            // Usa o seed do banco (injetado pelo Python na abertura da sessão) como piso.
            const seedFromSession = this.pos.session._ultimo_numero_contingencia || 0;
            const dados = await emitirContingencia(order, this.pos.company, this.pos.config.id, seedFromSession, this.env.services.orm);

            
            Object.assign(order, {
                x_fiscal_offline: true,
                x_fiscal_status: 'contingencia',
                x_fiscal_mensagem: 'EMITIDA EM CONTINGÊNCIA - Pendente Autorização',
                x_fiscal_chave: dados.chaveAcesso,
                x_fiscal_numero: dados.numero,
                x_fiscal_serie: dados.serie,
                x_fiscal_qrcode_url: dados.qrcodeUrl,
                x_fiscal_qrcode_b64: dados.qrcodeB64,
                x_contingencia_payload: JSON.stringify({
                    numero: dados.numero,
                    serie: dados.serie,
                    codigo_unico: dados.codigoUnico,
                    data_emissao: dados.dataEmissao,
                    chave_acesso: dados.chaveAcesso,
                })
            });
            
            // Envio nativo e avança de tela
            await super.validateOrder(isForceValidate);
            return;
        }

        // ============================================
        // FLUXO NORMAL (Online)
        // ============================================
        
        // Envio nativo pro Python (dispara webhook no backend).
        // A lógica de esperar a SEFAZ agora roda dentro de `afterOrderValidation`
        // para garantir que trava a impressão automática até a resposta chegar.
        await super.validateOrder(isForceValidate);
    },

    /**
     * Intercepta o pós-validação (momento em que o Odoo decide mudar de tela e imprimir).
     * Ao aguardar a resposta aqui, garantimos que a nota impressa já tem a chave da SEFAZ,
     * mesmo que a opção "Imprimir Recibo Automaticamente" esteja ativa.
     */
    async afterOrderValidation() {
        const order = this.pos.get_order();
        
        // Se foi confirmado e estamos online, segura o fluxo até a SEFAZ responder
        if (order && order.x_confirmacao_venda === true && navigator.onLine) {
            await this._awaitFiscalReturn(order);
        } else if (order && order.x_confirmacao_venda === false) {
            console.log("⏩ Venda não fiscal: Pulando verificação.");
        }

        // Agora sim libera o Odoo para ir pra ReceiptScreen e imprimir
        await super.afterOrderValidation(...arguments);
    }
});