/** @odoo-module */
import { ClosePosPopup } from "@point_of_sale/app/navbar/closing_popup/closing_popup";
import { PosStore } from "@point_of_sale/app/store/pos_store";
import { patch } from "@web/core/utils/patch";
import { renderToElement } from "@web/core/utils/render";
import { parseFloat } from "@web/views/fields/parsers";
import { _t } from "@web/core/l10n/translation";
import { printFallback } from "./receipt_print_helper";
import {
    calcularDadosOffline,
    initFechamentoOffline,
    obterEstado,
    obterReplay,
    tirarSnapshot,
} from "./fechamento_offline_runtime";

function ehErroDeRede(error) {
    if (!error) {
        return false;
    }
    const nome = error.name || (error.constructor && error.constructor.name);
    return nome === "ConnectionLostError";
}

// ── PosStore: snapshot no boot + popup com dados locais quando offline ────
patch(PosStore.prototype, {
    // Snapshot tirado no boot (com rede). É a base do delta local; sem ele o
    // fechamento offline fica indisponível, mas o PDV segue funcionando.
    async afterProcessServerData() {
        const resultado = await super.afterProcessServerData(...arguments);
        try {
            await tirarSnapshot(this);
        } catch (error) {
            console.warn("[FECHAMENTO] Snapshot inicial indisponível:", error);
        }
        return resultado;
    },

    // Offline (ou RPC falhando por rede): monta o `info` do popup com o
    // cálculo local (snapshot + delta). Online segue o nativo, inalterado.
    async getClosePosInfo() {
        const estado = initFechamentoOffline(this);
        if (this.data.network.offline) {
            return this._fechamentoInfoOffline();
        }
        try {
            const info = await super.getClosePosInfo(...arguments);
            // Fechamento online: descarta qualquer estado offline anterior.
            estado.modoOffline = false;
            estado.dadosOffline = null;
            return info;
        } catch (error) {
            if (!ehErroDeRede(error)) {
                throw error;
            }
            return this._fechamentoInfoOffline();
        }
    },

    _fechamentoInfoOffline() {
        const info = calcularDadosOffline(this);
        if (!info) {
            this.notification.add(
                _t("Sem dados de fechamento salvos. Conecte a rede para abrir o fechamento."),
                { type: "danger" }
            );
        }
        return info;
    },
});

// ── ClosePosPopup: trava do dinheiro + confirmação offline ────────────────
patch(ClosePosPopup.prototype, {
    // lock-dinheiro-pos-impressao: o operador deve confirmar o valor do
    // dinheiro antes de imprimir/fechar. State em memória apenas (DEC-002) —
    // reabrir o popup reseta e exige nova confirmação.
    // Sem cash_control não há valor de dinheiro a confirmar → já "confirmado",
    // para não travar os botões de uma sessão sem controle de caixa.
    getInitialState() {
        const state = super.getInitialState(...arguments);
        state.valor_confirmado = !this.pos.config.cash_control;
        return state;
    },

    // Trava o valor confirmado. Sem RPC, sem persistência (DEC-002).
    // A trava visual (pe-none + opacity-50) é aplicada via t-att-class
    // no template XML (XPath //div[contains(@class, 'mt-1')]).
    confirmValorDinheiro() {
        this.state.valor_confirmado = true;
    },

    // Fechar caixa ONLINE sai do POS: o fluxo nativo do core termina em
    // location.reload(). Recarregar /pos/ui sem sessão aberta faz o controller
    // pos_web criar OUTRA pos.session na hora — e no dia seguinte o operador
    // abre o caixa com a sessão de ontem. Quando o backend confirma o
    // fechamento, trocamos a URL para a home do Odoo antes do reload do core.
    //
    // OFFLINE: não chama nenhum RPC de fechamento. Grava a pendência
    // (fechamento deferido) e imprime o relatório "Gerado offline".
    async closeSession() {
        const estado = obterEstado();
        if (estado && estado.modoOffline) {
            return this._confirmarFechamentoOffline(estado);
        }

        const dataService = this.pos.data;
        const originalCall = dataService.call;
        dataService.call = async (...args) => {
            const response = await originalCall.apply(dataService, args);
            if (
                args[0] === "pos.session" &&
                args[1] === "close_session_from_ui" &&
                response &&
                response.successful
            ) {
                window.history.replaceState(null, "", "/odoo");
            }
            return response;
        };
        try {
            return await super.closeSession(...arguments);
        } finally {
            // Restaura mesmo se o core lançar (ex.: ConnectionLostError).
            dataService.call = originalCall;
        }
    },

    // Confirma o fechamento offline (DEC-011): recusa com venda em andamento,
    // grava a pendência e imprime o relatório uma única vez.
    async _confirmarFechamentoOffline(estado) {
        const rascunho = this.pos.models["pos.order"].find(
            (ordem) =>
                !ordem.finalized &&
                ordem.state !== "cancel" &&
                ordem.get_orderlines().length > 0
        );
        if (rascunho) {
            this.env.services.notification.add(
                _t("Finalize ou cancele a venda em andamento antes de fechar o caixa."),
                { type: "danger" }
            );
            return;
        }

        const cashControl = Boolean(this.pos.config.cash_control);
        const cashId = this.props.default_cash_details && this.props.default_cash_details.id;
        let dinheiroContado = 0;
        if (cashControl && cashId != null) {
            const informado =
                (this.state.payments[cashId] && this.state.payments[cashId].counted) || "0";
            dinheiroContado = this.env.utils.isValidFloat(informado) ? parseFloat(informado) : 0;
        }

        const diferencasBancarias = this.props.non_cash_payment_methods
            .filter((pm) => pm.type === "bank")
            .map((pm) => [pm.id, this.getDifference(pm.id)]);

        obterReplay(this.pos).criarPendencia({
            dinheiro_contado: dinheiroContado,
            notas: this.state.notes,
            diferencas_bancarias: diferencasBancarias,
            relatorio: this._aplicarContagem(estado.dadosOffline.fechamento),
            confirmado_em: new Date().toLocaleString(),
        });

        // Relatório impresso UMA vez, agora, com o horário local da confirmação.
        await this._imprimirFechamento(estado.dadosOffline.fechamento, true);

        this.props.close();
        this.env.services.notification.add(
            _t("Fechamento registrado offline. Será enviado quando a rede voltar."),
            4000
        );
    },

    async showFechamento() {
        const estado = obterEstado();
        if (estado && estado.modoOffline && estado.dadosOffline) {
            return await this._imprimirFechamento(estado.dadosOffline.fechamento, true);
        }

        console.log("[FECHAMENTO] Coletando dados do fechamento...");
        try {
            // RPC: pega os dados do backend
            const dados = await this.env.services.orm.call(
                "pos.session",
                "get_fechamento_data",
                [[this.pos.session.id]]
            );
            return await this._imprimirFechamento(dados, false);
        } catch (error) {
            console.error("[FECHAMENTO] Erro:", error);
        }
    },

    /**
     * Mescla os valores "Counted" do popup no saldo detalhado e imprime.
     * `offline` adiciona a linha "Gerado offline" no rodapé do recibo.
     * Clona os dados: reimprimir não pode acumular diferenças.
     */
    async _imprimirFechamento(dados, offline) {
        const dadosFinais = this._aplicarContagem(dados);

        console.log("[FECHAMENTO] Dados finais:", dadosFinais);

        // Renderiza o template XML num elemento DOM
        const report = renderToElement("meu_modulo.FechamentoReceipt", {
            data: dadosFinais,
            formatCurrency: this.env.utils.formatCurrency,
            offline: Boolean(offline),
        });

        // Tenta impressora térmica; se não tiver, fallback pra window.print
        const printer = this.hardwareProxy.printer;
        if (printer) {
            const { successful, message } = await printer.printReceipt(report);
            if (!successful) {
                console.warn("[FECHAMENTO] Impressora falhou, usando window.print");
                printFallback(report, "Fechamento de Caixa");
            }
        } else {
            console.log("[FECHAMENTO] Sem impressora, usando window.print");
            printFallback(report, "Fechamento de Caixa");
        }
        return report;
    },

    /** Aplica os valores informados no popup sobre uma cópia do relatório. */
    _aplicarContagem(dados) {
        const copia = JSON.parse(JSON.stringify(dados));
        const countedPayments = this._getCountedValues();
        for (const saldo of copia.saldo_detalhado || []) {
            const counted = countedPayments[saldo.nome];
            if (counted !== undefined) {
                saldo.informado = counted;
                saldo.diferenca = counted - saldo.calculado;
            }
        }
        return copia;
    },

    /**
     * Lê os valores "Counted" que o operador digitou no ClosePosPopup.
     * Retorna um dict { nome_metodo: valor_informado }.
     */
    _getCountedValues() {
        const result = {};
        const payments = this.state.payments;

        // Cash (default_cash_details)
        const cashDetails = this.props.default_cash_details;
        if (cashDetails && payments[cashDetails.id]) {
            const countedStr = payments[cashDetails.id].counted || "0";
            if (this.env.utils.isValidFloat(countedStr)) {
                result[cashDetails.name] = parseFloat(countedStr);
            }
        }

        // Non-cash (bank + pay_later): usa o valor calculado do sistema.
        // Os inputs "Counted" foram removidos do popup (fechamento_simplificar.xml),
        // então o operador não digita mais esses valores. O pm.amount é o valor
        // real das transações — INFORMADO = CALCULADO, DIFERENÇA = 0 no relatório.
        for (const pm of this.props.non_cash_payment_methods) {
            result[pm.name] = pm.amount ?? 0;
        }

        return result;
    },
});
