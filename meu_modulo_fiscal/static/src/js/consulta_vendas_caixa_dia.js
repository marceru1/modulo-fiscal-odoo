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

/** Singular/plural de um rótulo ("1 dia" / "2 dias"). */
export function plural(quantidade, singular, pluralTexto) {
    return quantidade === 1 ? singular : pluralTexto;
}

export class ConsultaVendasCaixaDia extends Component {
    static template = "meu_modulo_fiscal.ConsultaVendasCaixaDia";
    static props = ["*"];

    setup() {
        this.orm = useService("orm");
        this.action = useService("action");
        this.state = useState({
            caixas: [],
            metodos: [],
            configIds: [...(selecaoAtual?.configIds ?? [])],
            metodosIds: [...(selecaoAtual?.metodosIds ?? [])],
            dias: [...(selecaoAtual?.dias ?? [])],
            mesVisivel: mesInicial(selecaoAtual?.dias),
            carregandoCaixas: true,
            carregandoMetodos: true,
            erroCaixas: "",
            erroMetodos: "",
            carregando: false,
            erro: "",
            aviso: "",
            resultado: null,
        });
        onWillStart(() => this.carregarOpcoes());
    }

    async carregarOpcoes() {
        await Promise.all([this.carregarCaixas(), this.carregarMetodos()]);
    }

    async carregarMetodos() {
        this.state.carregandoMetodos = true;
        this.state.erroMetodos = "";
        try {
            this.state.metodos = await this.orm.searchRead(
                "pos.payment.method",
                [],
                ["name"],
                { order: "name" }
            );
            // O filtro é opcional: só descarta métodos que sumiram do cadastro.
            const disponiveis = this.state.metodos.map((metodo) => metodo.id);
            this.state.metodosIds = this.state.metodosIds.filter((id) =>
                disponiveis.includes(id)
            );
        } catch (error) {
            // A seleção fica preservada; consultar com filtro incompleto não.
            this.state.erroMetodos = this.mensagemErro(error);
        } finally {
            this.state.carregandoMetodos = false;
        }
    }

    async carregarCaixas() {
        this.state.carregandoCaixas = true;
        this.state.erroCaixas = "";
        try {
            this.state.caixas = await this.orm.searchRead(
                "pos.config",
                [],
                ["name"],
                { order: "name" }
            );
            // A seleção anterior pode apontar para caixas removidos ou sem acesso.
            const disponiveis = this.state.caixas.map((caixa) => caixa.id);
            this.state.configIds = this.state.configIds.filter((id) =>
                disponiveis.includes(id)
            );
        } catch (error) {
            this.state.erroCaixas = this.mensagemErro(error);
        } finally {
            this.state.carregandoCaixas = false;
        }
    }

    get podeConsultar() {
        return Boolean(this.state.configIds.length && this.state.dias.length)
            && !this.state.carregando
            && !this.state.carregandoCaixas
            && !this.state.carregandoMetodos
            && !this.state.erroCaixas
            && !this.state.erroMetodos;
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
        if (!this.state.configIds.length) {
            return _t("Marque um ou mais caixas e ao menos um dia para consultar as vendas");
        }
        if (!this.state.dias.length) {
            return _t("Selecione ao menos um dia para consultar as vendas");
        }
        return _t("Clique em Consultar para carregar as vendas dos dias selecionados");
    }

    /** Motivo visível ao lado de Consultar — nunca depender só de tooltip. */
    get motivoBloqueio() {
        if (this.state.carregando) {
            return "";
        }
        if (this.state.erroCaixas) {
            return _t("Não foi possível carregar os caixas. Tente carregar novamente.");
        }
        if (this.state.erroMetodos) {
            return _t("Não foi possível carregar as formas de pagamento. Tente carregar novamente.");
        }
        if (this.state.carregandoCaixas || this.state.carregandoMetodos) {
            return _t("Aguarde o carregamento das opções.");
        }
        if (!this.state.caixas.length) {
            return _t("Nenhum caixa disponível para seu usuário.");
        }
        if (!this.state.configIds.length) {
            return _t("Selecione ao menos um caixa.");
        }
        if (!this.state.dias.length) {
            return _t("Selecione ao menos um dia.");
        }
        return "";
    }

    /** Resumo compacto da seleção: "2 caixas · 5 dias · Sem filtro de pagamento". */
    get resumoSelecao() {
        const caixas = plural(
            this.state.configIds.length, _t("caixa"), _t("caixas")
        );
        const dias = plural(this.state.dias.length, _t("dia"), _t("dias"));
        return [
            `${this.state.configIds.length} ${caixas}`,
            `${this.state.dias.length} ${dias}`,
            this.resumoPagamento(),
        ].join(" · ");
    }

    /** Estado do filtro opcional no resumo: sem filtro, nomes ou contagem. */
    resumoPagamento() {
        const ids = this.state.metodosIds;
        if (!ids.length) {
            return _t("Sem filtro de pagamento");
        }
        const nomes = this.state.metodos
            .filter((metodo) => ids.includes(metodo.id))
            .map((metodo) => metodo.name);
        if (!nomes.length) {
            return _t("%s formas selecionadas", ids.length);
        }
        if (nomes.length <= 2) {
            return _t("Pagamento: %s", this.listar(nomes));
        }
        return _t("%s formas selecionadas", nomes.length);
    }

    toggleMetodo(metodoId) {
        if (this.state.carregando) {
            return;
        }
        const indice = this.state.metodosIds.indexOf(metodoId);
        if (indice >= 0) {
            this.state.metodosIds.splice(indice, 1);
        } else {
            this.state.metodosIds.push(metodoId);
        }
        this.alterouFiltros();
    }

    toggleCaixa(caixaId) {
        if (this.state.carregando) {
            return;
        }
        const indice = this.state.configIds.indexOf(caixaId);
        if (indice >= 0) {
            this.state.configIds.splice(indice, 1);
        } else {
            this.state.configIds.push(caixaId);
        }
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
        if (!this.state.configIds.length || this.state.carregando) {
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
        selecaoAtual = {
            configIds: [...this.state.configIds],
            metodosIds: [...this.state.metodosIds],
            dias: [...this.state.dias],
        };
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
                [this.state.configIds, this.state.dias, this.state.metodosIds]
            );
            selecaoAtual = {
                configIds: [...this.state.configIds],
                metodosIds: [...this.state.metodosIds],
                dias: [...this.state.dias],
            };
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

    /** Nomes de caixas/formas no cabeçalho: "Caixa 2 + Biju". */
    formatarNomes(itens) {
        return (itens || []).map((item) => item.nome).join(" + ");
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
