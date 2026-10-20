/** @odoo-module **/

import { Component, onWillStart, useState } from "@odoo/owl";
import { deserializeDateTime } from "@web/core/l10n/dates";
import { _t } from "@web/core/l10n/translation";
import { registry } from "@web/core/registry";
import { useService } from "@web/core/utils/hooks";
import { formatDateTime, formatMonetary } from "@web/views/fields/formatters";

const TAG = "meu_modulo_fiscal.consulta_vendas_caixa_dia";

// A client action é remontada quando o usuário volta do detalhe da venda.
// Guardar a seleção fora do componente preserva caixa/data nesse retorno.
let selecaoAtual = null;

export class ConsultaVendasCaixaDia extends Component {
    static template = "meu_modulo_fiscal.ConsultaVendasCaixaDia";
    static props = ["*"];

    setup() {
        this.orm = useService("orm");
        this.action = useService("action");
        this.state = useState({
            caixas: [],
            configId: selecaoAtual?.configId ?? false,
            data: selecaoAtual?.data ?? "",
            carregando: false,
            erro: "",
            resultado: null,
        });
        onWillStart(() => this.carregarCaixas());
    }

    async carregarCaixas() {
        try {
            this.state.caixas = await this.orm.searchRead(
                "pos.config",
                [],
                ["name"],
                { order: "name" }
            );
            // A seleção anterior pode apontar para caixa removido ou sem acesso.
            const selecionado = this.state.caixas.some(
                (caixa) => caixa.id === this.state.configId
            );
            if (!selecionado) {
                this.state.configId = false;
            }
        } catch (error) {
            this.state.erro = this.mensagemErro(error);
        }
    }

    get podeConsultar() {
        return Boolean(this.state.configId && this.state.data) && !this.state.carregando;
    }

    get mensagemInicial() {
        if (!this.state.configId) {
            return _t("Selecione um caixa e uma data para consultar as vendas");
        }
        if (!this.state.data) {
            return _t("Selecione uma data para consultar as vendas");
        }
        return _t("Clique em Consultar para carregar as vendas do dia");
    }

    onConfigChange(ev) {
        this.state.configId = ev.target.value ? Number(ev.target.value) : false;
        this.alterouFiltros();
    }

    onDataChange(ev) {
        this.state.data = ev.target.value;
        this.alterouFiltros();
    }

    alterouFiltros() {
        // Resultado antigo nunca fica visível como se fosse da nova seleção.
        this.state.resultado = null;
        this.state.erro = "";
        selecaoAtual = { configId: this.state.configId, data: this.state.data };
    }

    async consultar() {
        if (!this.podeConsultar) {
            return;
        }
        this.state.carregando = true;
        this.state.erro = "";
        this.state.resultado = null;
        try {
            this.state.resultado = await this.orm.call(
                "pos.order",
                "get_vendas_caixa_dia",
                [this.state.configId, this.state.data]
            );
            selecaoAtual = { configId: this.state.configId, data: this.state.data };
        } catch (error) {
            // Mantém a seleção para o usuário tentar de novo.
            this.state.erro = this.mensagemErro(error);
        } finally {
            this.state.carregando = false;
        }
    }

    async abrirVenda(venda) {
        await this.action.doAction({
            type: "ir.actions.act_window",
            name: venda.cupom || _t("Venda"),
            res_model: "pos.order",
            res_id: venda.id,
            views: [[false, "form"]],
            target: "current",
            flags: { create: false, edit: false, delete: false },
        });
    }

    formatarDataHora(valor) {
        return valor ? formatDateTime(deserializeDateTime(valor)) : "";
    }

    formatarValor(valor, currencyId) {
        return formatMonetary(valor, { currencyId });
    }

    formatarData(data) {
        if (!data) {
            return "";
        }
        const [ano, mes, dia] = data.split("-");
        return `${dia}/${mes}/${ano}`;
    }

    mensagemErro(error) {
        return error?.data?.message || error?.message
            || _t("Não foi possível consultar as vendas.");
    }
}

registry.category("actions").add(TAG, ConsultaVendasCaixaDia);
