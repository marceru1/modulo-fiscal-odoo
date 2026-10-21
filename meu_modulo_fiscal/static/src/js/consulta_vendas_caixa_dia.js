/** @odoo-module **/

import { Component, onWillStart, useState } from "@odoo/owl";
import { deserializeDateTime } from "@web/core/l10n/dates";
import { _t } from "@web/core/l10n/translation";
import { registry } from "@web/core/registry";
import { useService } from "@web/core/utils/hooks";
import { formatDateTime, formatMonetary } from "@web/views/fields/formatters";

const TAG = "meu_modulo_fiscal.consulta_vendas_caixa_dia";

// Máximo de dias avulsos por consulta (mesma guarda do método server-side).
export const LIMITE_DIAS = 31;

// A client action é remontada quando o usuário volta do detalhe da venda.
// Guardar a seleção fora do componente preserva caixa/dias nesse retorno.
let selecaoAtual = null;

/** Mês exibido no calendário: o do último dia marcado ou o mês corrente. */
export function mesInicial(dias) {
    const referencia = dias && dias.length ? dias[dias.length - 1] : null;
    if (referencia) {
        const [ano, mes] = referencia.split("-").map(Number);
        return { ano, mes };
    }
    const agora = new Date();
    return { ano: agora.getFullYear(), mes: agora.getMonth() + 1 };
}

/** Rótulo do mês ("Outubro 2026") no locale do navegador. */
export function rotuloMes(ano, mes) {
    const rotulo = new Date(ano, mes - 1, 1).toLocaleDateString(undefined, {
        month: "long",
        year: "numeric",
    });
    return rotulo.charAt(0).toUpperCase() + rotulo.slice(1);
}

/** Células do grid do mês: `null` nas posições vazias, uma célula por dia. */
export function celulasDoMes(ano, mes, diasMarcados) {
    const marcados = diasMarcados || [];
    const celulas = new Array(new Date(ano, mes - 1, 1).getDay()).fill(null);
    const diasNoMes = new Date(ano, mes, 0).getDate();
    for (let dia = 1; dia <= diasNoMes; dia++) {
        const data = `${ano}-${String(mes).padStart(2, "0")}-${String(dia).padStart(2, "0")}`;
        celulas.push({ dia, data, marcado: marcados.includes(data) });
    }
    while (celulas.length % 7) {
        celulas.push(null);
    }
    return celulas;
}

/** A guarda do limite de 31 dias também existe no cliente (o servidor
 *  valida de novo): um dia já marcado sempre pode ser desmarcado. */
export function podeMarcarDia(diasMarcados, data) {
    return diasMarcados.includes(data) || diasMarcados.length < LIMITE_DIAS;
}

export class ConsultaVendasCaixaDia extends Component {
    static template = "meu_modulo_fiscal.ConsultaVendasCaixaDia";
    static props = ["*"];

    setup() {
        this.orm = useService("orm");
        this.action = useService("action");
        this.state = useState({
            caixas: [],
            configId: selecaoAtual?.configId ?? false,
            dias: [...(selecaoAtual?.dias ?? [])],
            mesVisivel: mesInicial(selecaoAtual?.dias),
            carregando: false,
            erro: "",
            aviso: "",
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
        return Boolean(this.state.configId && this.state.dias.length) && !this.state.carregando;
    }

    get rotuloMesVisivel() {
        return rotuloMes(this.state.mesVisivel.ano, this.state.mesVisivel.mes);
    }

    get linhasDoMes() {
        const celulas = celulasDoMes(
            this.state.mesVisivel.ano,
            this.state.mesVisivel.mes,
            this.state.dias
        );
        const linhas = [];
        for (let inicio = 0; inicio < celulas.length; inicio += 7) {
            linhas.push(celulas.slice(inicio, inicio + 7));
        }
        return linhas;
    }

    get mensagemInicial() {
        if (!this.state.configId) {
            return _t("Selecione um caixa e ao menos um dia para consultar as vendas");
        }
        if (!this.state.dias.length) {
            return _t("Selecione ao menos um dia para consultar as vendas");
        }
        return _t("Clique em Consultar para carregar as vendas dos dias selecionados");
    }

    onConfigChange(ev) {
        this.state.configId = ev.target.value ? Number(ev.target.value) : false;
        this.alterouFiltros();
    }

    mudarMes(delta) {
        const { ano, mes } = this.state.mesVisivel;
        const referencia = new Date(ano, mes - 1 + delta, 1);
        this.state.mesVisivel = {
            ano: referencia.getFullYear(),
            mes: referencia.getMonth() + 1,
        };
    }

    toggleDia(data) {
        if (!this.state.configId || this.state.carregando) {
            return;
        }
        const indice = this.state.dias.indexOf(data);
        if (indice >= 0) {
            this.state.dias.splice(indice, 1);
        } else if (!podeMarcarDia(this.state.dias, data)) {
            this.state.aviso = _t("Selecione no máximo 31 dias por consulta.");
            return;
        } else {
            this.state.dias.push(data);
            this.state.dias.sort();
        }
        this.state.aviso = "";
        this.alterouFiltros();
    }

    limparDias() {
        if (this.state.carregando) {
            return;
        }
        this.state.dias = [];
        this.state.aviso = "";
        this.alterouFiltros();
    }

    alterouFiltros() {
        // Resultado antigo nunca fica visível como se fosse da nova seleção.
        this.state.resultado = null;
        this.state.erro = "";
        selecaoAtual = { configId: this.state.configId, dias: [...this.state.dias] };
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
                [this.state.configId, this.state.dias]
            );
            selecaoAtual = { configId: this.state.configId, dias: [...this.state.dias] };
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

    listar(itens) {
        if (itens.length <= 1) {
            return itens[0] ?? "";
        }
        return `${itens.slice(0, -1).join(", ")} e ${itens[itens.length - 1]}`;
    }

    formatarData(data) {
        if (!data) {
            return "";
        }
        const [ano, mes, dia] = data.split("-");
        return `${dia}/${mes}/${ano}`;
    }

    /** Dias marcados no cabeçalho: "15, 20 e 24/10/2026" quando todos são do
     *  mesmo mês; senão as datas completas ("20/10/2026 e 05/11/2026"). */
    formatarDias(datas) {
        if (!datas || !datas.length) {
            return "";
        }
        const ordenadas = [...datas].sort();
        const partes = ordenadas.map((data) => data.split("-"));
        const [ano, mes] = partes[0];
        const mesmoMes = partes.every(([umAno, umMes]) => umAno === ano && umMes === mes);
        if (mesmoMes && partes.length > 1) {
            return `${this.listar(partes.map((parte) => parte[2]))}/${mes}/${ano}`;
        }
        return this.listar(ordenadas.map((data) => this.formatarData(data)));
    }

    rotuloCupons(quantidade) {
        return quantidade === 1 ? _t("cupom") : _t("cupons");
    }

    rotuloDevolucoes(quantidade) {
        return quantidade === 1 ? _t("devolução") : _t("devoluções");
    }

    mensagemErro(error) {
        return error?.data?.message || error?.message
            || _t("Não foi possível consultar as vendas.");
    }
}

registry.category("actions").add(TAG, ConsultaVendasCaixaDia);
