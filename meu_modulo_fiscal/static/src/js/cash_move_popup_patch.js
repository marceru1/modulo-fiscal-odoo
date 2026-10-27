/** @odoo-module */
// Patch do CashMovePopup para:
//   1. imprimir um recibo customizado em português quando a operação é uma
//      SANGRIA (type='out'); suprimentos (type='in') seguem o fluxo nativo;
//   2. desviar sangria E suprimento para uma OUTBOX PERSISTIDA quando o PDV
//      está offline (spec fechamento-offline-fila — DEC-002). A fila genérica
//      do data_service é em memória e sumiria no refresh; a outbox sobrevive.
//
// Estratégia do recibo (inalterada):
//   - delega type='in' para super.confirm() — zero duplicação no caminho nativo
//   - replica a lógica nativa APENAS para type='out', trocando o print pelo
//     SangriaReceipt (danfe-header do módulo, decisão do grill), mas usando
//     o MESMO mecanismo de impressão do módulo (renderToElement +
//     hardwareProxy.printReceipt + printFallback) — o caminho nativo
//     this.printer.print(Component, props) não imprime neste ambiente
//     (ver comentário no confirm()).
//   Fix 2026-08-10: o v1 usava this.printer.print(SangriaReceipt, props)
//     (printer SERVICE) copiando o nativo — sem webPrintFallback ele retorna
//     undefined silenciosamente quando não há dispositivo (printer_service.js
//     printHtml:29-30). Mesma falha do CashMoveReceipt nativo, que a spec já
//     apontava ("a impressão não está acontecendo no ambiente atual").
// Consequência documentada (DEC-001): se o Odoo mudar a assinatura de
// confirm(), este caminho 'out' precisa ser revisto na migração.
// Revisão adversarial (doubt-driven): this._super não existe no patch() do
// Odoo 18 — usar `super.confirm(...)` (JS super keyword).
//
// Offline (ticket 03):
//   - sangria/suprimento online continuam indo direto ao servidor. Depois do
//     sucesso, o movimento entra no espelho local com synced=true e o snapshot
//     é refrescado (gancho consumido pelo ticket 05).
//   - offline: grava na outbox + espelho e NÃO chama o data_service (nada cai
//     na fila em memória do core, sem envio duplicado). O recibo da sangria
//     continua saindo.
//   - o RPC da sangria usa queue=false para podermos capturar ConnectionLostError
//     e desviar para a outbox quando a rede cai no meio da chamada.
//   - suprimento online segue via super.confirm() (comportamento nativo); só o
//     caso offline é interceptado, como pede o ticket. Se a rede cair no meio
//     da chamada nativa, ela cai na fila em memória do core (risco pré-existente).
import { _t } from "@web/core/l10n/translation";
import { parseFloat } from "@web/views/fields/parsers";
import { patch } from "@web/core/utils/patch";
import { renderToElement } from "@web/core/utils/render";
import { CashMovePopup } from "@point_of_sale/app/navbar/cash_move_popup/cash_move_popup";
import { printFallback } from "./receipt_print_helper";
import { solicitarRefreshSnapshot } from "./fechamento_outbox";
import { obterOutbox } from "./fechamento_offline_runtime";

patch(CashMovePopup.prototype, {
    async confirm() {
        const amount = parseFloat(this.state.amount);
        const formattedAmount = this.env.utils.formatCurrency(amount);
        if (!amount) {
            this.notification.add(_t("Cash in/out of %s is ignored.", formattedAmount));
            return this.props.close();
        }

        const type = this.state.type;
        const reason = this.state.reason.trim();

        // 1. Offline já conhecido: outbox persistida, sem tocar no data_service.
        if (this.pos.data.network.offline) {
            return await this._confirmarMovimentoOffline(type, amount, reason, formattedAmount);
        }

        // 2. Suprimento ONLINE: caminho nativo inalterado. Depois do sucesso,
        //    alimenta o espelho local (o snapshot ainda não o contém).
        if (type !== "out") {
            const resultado = await super.confirm(...arguments);
            if (!this.pos.data.network.offline) {
                this._espelharMovimentoOnline("in", amount, reason);
            }
            return resultado;
        }

        // 3. Sangria ONLINE: mesma lógica do nativo, com o recibo do módulo.
        //    queue=false (último arg) para capturar queda de rede e usar a outbox.
        try {
            await this.pos.data.call(
                "pos.session",
                "try_cash_in_out",
                this._prepare_try_cash_in_out_payload("out", amount, reason, {
                    formattedAmount,
                    translatedType: _t("out"),
                }),
                {},
                false
            );
        } catch (error) {
            if (!this._ehErroDeRede(error)) {
                console.error("[SANGRIA] Erro ao registrar movimentação:", error);
                throw error;
            }
            return await this._confirmarMovimentoOffline("out", amount, reason, formattedAmount);
        }

        await this.pos.logEmployeeMessage(
            `${_t("Cash")} ${_t("out")} - ${_t("Amount")}: ${formattedAmount}`,
            "CASH_DRAWER_ACTION"
        );
        this._espelharMovimentoOnline("out", amount, reason);
        await this._imprimirSangria(reason, formattedAmount);

        this.props.close();
        this.notification.add(
            _t("Successfully made a cash out of %s.", formattedAmount),
            3000
        );
    },

    /** True para ConnectionLostError (nome estável entre bundles). */
    _ehErroDeRede(error) {
        if (!error) {
            return false;
        }
        const nome = error.name || (error.constructor && error.constructor.name);
        return nome === "ConnectionLostError";
    },

    /**
     * Outbox da sessão — instância ÚNICA, do runtime (fix round 1).
     * O mutex de drenagem vive na instância; criar outra aqui sobre o mesmo
     * localStorage poderia duplicar um movimento numa drenagem concorrente.
     * Este patch só adiciona/espelha (nunca drena).
     */
    _fechamentoOutbox() {
        return obterOutbox(this.pos);
    },

    /** Offline: grava na outbox persistida e no espelho; imprime a sangria. */
    async _confirmarMovimentoOffline(type, amount, reason, formattedAmount) {
        const item = this._fechamentoOutbox().adicionar({
            tipo: type,
            valor: amount,
            motivo: reason,
            quando: new Date().toLocaleString(),
        });
        console.log("[SANGRIA] Movimento offline gravado na outbox:", item.uuid);

        if (type === "out") {
            await this._imprimirSangria(reason, formattedAmount);
        }
        this.props.close();
        this.notification.add(
            type === "out"
                ? _t("Sangria de %s registrada offline. Será enviada quando a rede voltar.", formattedAmount)
                : _t("Suprimento de %s registrado offline. Será enviado quando a rede voltar.", formattedAmount),
            4000
        );
        return item;
    },

    /** Online confirmado: espelha (synced=true) e pede refresh do snapshot. */
    _espelharMovimentoOnline(type, amount, reason) {
        try {
            this._fechamentoOutbox().espelharOnline({
                tipo: type,
                valor: amount,
                motivo: reason,
                quando: new Date().toLocaleString(),
            });
            solicitarRefreshSnapshot();
        } catch (error) {
            // Espelho é best-effort: nunca pode quebrar um movimento já feito.
            console.warn("[SANGRIA] Falha ao espelhar movimento online:", error);
        }
    },

    /**
     * Imprime o recibo da sangria no MESMO mecanismo do comprovante e do
     * fechamento: renderToElement + hardwareProxy.printReceipt + printFallback.
     * O caminho this.printer.print(Component, props) (printer SERVICE, usado
     * pelo CashMoveReceipt nativo) não imprime neste ambiente: printHtml()
     * retorna undefined silenciosamente quando não há dispositivo e
     * webPrintFallback é false (printer_service.js:29-30).
     *
     * O try/catch aqui NÃO contradiz o ticket 03 ("não adicionar try/catch
     * redundante"): a sangria já foi persistida (servidor ou outbox) e o
     * try/catch garante que uma falha de impressora nunca impeça o popup de
     * fechar — mesmo intuito do comprovante (recebimento_button.js envolve
     * _printComprovante em try/catch).
     */
    async _imprimirSangria(reason, formattedAmount) {
        try {
            const report = renderToElement("meu_modulo_fiscal.SangriaReceipt", {
                props: {
                    empresa: {
                        nome: this.pos.company.name || "",
                        cnpj: this.pos.company.x_cnpj || "",
                        endereco_linha1: this.pos.company.x_endereco_linha1 || "",
                        endereco_linha2: this.pos.company.x_endereco_linha2 || "",
                    },
                    formattedAmount,
                    reason,
                    date: new Date().toLocaleString(),
                },
            });
            const printer = this.hardwareProxy.printer;
            if (printer) {
                const { successful } = await printer.printReceipt(report);
                if (!successful) {
                    console.warn("[SANGRIA] Impressora falhou, usando window.print");
                    printFallback(report, "Sangria de Caixa");
                }
            } else {
                console.log("[SANGRIA] Sem impressora, usando window.print");
                printFallback(report, "Sangria de Caixa");
            }
        } catch (error) {
            console.error("[SANGRIA] Erro ao imprimir recibo:", error);
        }
    },
});
