/** @odoo-module */
// UI do estado "fechamento pendente" (spec fechamento-offline-fila, ticket 06
// — DEC-006). Expõe um estado reativo no PosStore que alimenta o banner da
// navbar e bloqueia novas vendas enquanto a pendência existir.
//
// O estado vem da pendência PERSISTIDA (fechamento_replay.js), então sobrevive
// a refresh. As fases do banner são derivadas do último passo concluído; o
// ticket 07 atualiza o estado a cada passo do replay.

import { PosStore } from "@point_of_sale/app/store/pos_store";
import { patch } from "@web/core/utils/patch";
import { _t } from "@web/core/l10n/translation";
import { contarVendasNaoEnviadas, obterReplay } from "./fechamento_offline_runtime";

const FASE_POR_PASSO = {
    1: "enviando sangrias e suprimentos…",
    2: "enviando pedidos…",
    3: "gravando o dinheiro contado…",
    4: "mudando o caixa para fechamento…",
    5: "fechando…",
};

patch(PosStore.prototype, {
    async afterProcessServerData() {
        const resultado = await super.afterProcessServerData(...arguments);
        // Boot com pendência da sessão atual: o POS já sobe em modo pendente.
        this._atualizarFechamentoPendente();
        return resultado;
    },

    /** Relê a pendência persistida e publica no estado reativo. */
    _atualizarFechamentoPendente() {
        const pendencia = obterReplay(this).lerPendencia();
        this.fechamentoPendente = pendencia
            ? {
                  status: pendencia.status,
                  passo: Number.isInteger(pendencia.passo) ? pendencia.passo : -1,
                  mensagem: pendencia.mensagem || "",
              }
            : null;
    },

    get fechamentoPendenteAtivo() {
        return Boolean(this.fechamentoPendente);
    },

    get fechamentoPendenteErro() {
        return Boolean(
            this.fechamentoPendente && this.fechamentoPendente.status === "erro_negocio"
        );
    },

    get fechamentoPendenteQuantidade() {
        return contarVendasNaoEnviadas(this);
    },

    get fechamentoPendenteTexto() {
        if (!this.fechamentoPendente) {
            return "";
        }
        if (this.fechamentoPendenteErro) {
            return _t("Fechamento recusado pelo servidor — chame o gerente");
        }
        if (this.fechamentoPendente.status === "executando") {
            return (
                FASE_POR_PASSO[this.fechamentoPendente.passo + 1] || _t("fechando…")
            );
        }
        return _t("Fechamento pendente — aguardando rede (%s pedidos na fila)", this.fechamentoPendenteQuantidade);
    },

    // Vendas bloqueadas: não adiciona item e não vai para o pagamento. A tela
    // de produtos, os pedidos/tickets e a reimpressão continuam navegáveis.
    // addLineToOrder é o ponto mais alto: addLineToCurrentOrder e o clique no
    // produto passam por ele (inclusive o "novo pedido" vazio, que sem itens
    // não chega ao pagamento).
    async addLineToOrder() {
        if (this.fechamentoPendenteAtivo) {
            this.notification.add(
                _t("Fechamento pendente: não é possível adicionar itens a uma venda."),
                { type: "warning" }
            );
            return;
        }
        return super.addLineToOrder(...arguments);
    },

    async pay() {
        if (this.fechamentoPendenteAtivo) {
            this.notification.add(
                _t("Fechamento pendente: não é possível iniciar um pagamento."),
                { type: "warning" }
            );
            return;
        }
        return super.pay(...arguments);
    },
});
