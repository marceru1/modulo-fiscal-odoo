/** @odoo-module **/

import { Component, onWillStart, useEffect, useState } from "@odoo/owl";
import { deserializeDateTime, today } from "@web/core/l10n/dates";
import { _t } from "@web/core/l10n/translation";
import { registry } from "@web/core/registry";
import { user } from "@web/core/user";
import { useService } from "@web/core/utils/hooks";
import { formatDateTime, formatMonetary } from "@web/views/fields/formatters";

const TAG = "meu_modulo_fiscal.consulta_vendas_caixa_dia";

// Máximo de dias avulsos por consulta (mesma guarda do método server-side).
export const LIMITE_DIAS = 31;

// Quantos chips de dia aparecem antes de "Ver os N dias".
export const CHIPS_VISIVEIS = 6;

// Idioma de fallback quando o usuário não tem idioma configurado no Odoo.
export const IDIOMA_FALLBACK = "pt-BR";

// A client action é remontada quando o usuário volta do detalhe da venda.
// Guardar a seleção fora do componente preserva caixa/dias nesse retorno.
let selecaoAtual = null;

function duasCasas(valor) {
    return String(valor).padStart(2, "0");
}

function capitalizar(texto) {
    return texto.charAt(0).toUpperCase() + texto.slice(1);
}

/** Soma dias em uma data ISO sem depender do fuso do navegador. */
export function somarDias(dataISO, dias) {
    const [ano, mes, dia] = dataISO.split("-").map(Number);
    const referencia = new Date(Date.UTC(ano, mes - 1, dia + dias));
    return referencia.toISOString().slice(0, 10);
}

/** Soma meses ajustando o dia ao último dia do mês de destino (31/01 + 1 mês). */
export function somarMeses(dataISO, meses) {
    const [ano, mes, dia] = dataISO.split("-").map(Number);
    const indice = mes - 1 + meses;
    const alvoAno = ano + Math.floor(indice / 12);
    const alvoMes = ((indice % 12) + 12) % 12 + 1;
    const ultimoDia = new Date(Date.UTC(alvoAno, alvoMes, 0)).getUTCDate();
    return `${alvoAno}-${duasCasas(alvoMes)}-${duasCasas(Math.min(dia, ultimoDia))}`;
}

/** Domingo da semana visual do dia informado (calendário começa no domingo). */
export function inicioDaSemana(dataISO) {
    const [ano, mes, dia] = dataISO.split("-").map(Number);
    const diaDaSemana = new Date(Date.UTC(ano, mes - 1, dia)).getUTCDay();
    return somarDias(dataISO, -diaDaSemana);
}

/** Sábado da semana visual do dia informado. */
export function fimDaSemana(dataISO) {
    return somarDias(inicioDaSemana(dataISO), 6);
}

/** Idioma configurado no Odoo (user.lang), com fallback pt-BR. */
export function idiomaOdoo(lang) {
    return (lang || IDIOMA_FALLBACK).replace(/_/g, "-");
}

/** Mês exibido no calendário: o do último dia marcado ou o mês de hoje. */
export function mesInicial(dias, hojeISO) {
    const ordenados = [...(dias || [])].sort();
    const referencia = ordenados.length ? ordenados[ordenados.length - 1] : hojeISO;
    const [ano, mes] = referencia.split("-").map(Number);
    return { ano, mes };
}

/** Rótulo do mês ("Outubro de 2026") no idioma configurado no Odoo. */
export function rotuloMes(ano, mes, idioma) {
    const rotulo = new Date(Date.UTC(ano, mes - 1, 1)).toLocaleDateString(
        idioma || IDIOMA_FALLBACK,
        { month: "long", year: "numeric", timeZone: "UTC" }
    );
    return capitalizar(rotulo);
}

/** Nomes curtos dos dias da semana ("Dom", "Seg"...) no idioma do Odoo. */
export function rotulosSemana(idioma) {
    const formato = new Intl.DateTimeFormat(idioma || IDIOMA_FALLBACK, {
        weekday: "short",
        timeZone: "UTC",
    });
    // 01/03/2026 é domingo — serve de base para os sete rótulos.
    return Array.from({ length: 7 }, (_, indice) =>
        capitalizar(
            formato
                .format(new Date(Date.UTC(2026, 2, 1 + indice)))
                .replace(/\.$/, "")
        )
    );
}

/** Data completa para leitores de tela: "8 de outubro de 2026". */
export function nomeCompletoData(dataISO, idioma) {
    const [ano, mes, dia] = dataISO.split("-").map(Number);
    return new Intl.DateTimeFormat(idioma || IDIOMA_FALLBACK, {
        day: "numeric",
        month: "long",
        year: "numeric",
        timeZone: "UTC",
    }).format(new Date(Date.UTC(ano, mes - 1, dia)));
}

/** Nome completo da ação de remover um chip. */
export function rotuloRemoverDia(dataISO, idioma, prefixo) {
    return `${prefixo || "Remover"} ${nomeCompletoData(dataISO, idioma)}`;
}

/** Células do grid do mês: `null` nas posições vazias, uma célula por dia. */
export function celulasDoMes(ano, mes, diasMarcados, hojeISO) {
    const marcados = diasMarcados || [];
    const celulas = new Array(new Date(ano, mes - 1, 1).getDay()).fill(null);
    const diasNoMes = new Date(ano, mes, 0).getDate();
    for (let dia = 1; dia <= diasNoMes; dia++) {
        const data = `${ano}-${duasCasas(mes)}-${duasCasas(dia)}`;
        celulas.push({
            dia,
            data,
            marcado: marcados.includes(data),
            hoje: data === hojeISO,
        });
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
        const hojeISO = today().toISODate();
        const mes = mesInicial(selecaoAtual?.dias, hojeISO);
        const diasSelecionados = [...(selecaoAtual?.dias ?? [])].sort();
        this.state = useState({
            caixas: [],
            metodos: [],
            configIds: [...(selecaoAtual?.configIds ?? [])],
            metodosIds: [...(selecaoAtual?.metodosIds ?? [])],
            dias: diasSelecionados,
            mesVisivel: mes,
            // Foco do teclado no calendário — não é seleção.
            focoData: diasSelecionados.length
                ? diasSelecionados[diasSelecionados.length - 1]
                : `${mes.ano}-${duasCasas(mes.mes)}-01`,
            hoje: hojeISO,
            mostrarTodosChips: false,
            carregandoCaixas: true,
            carregandoMetodos: true,
            erroCaixas: "",
            erroMetodos: "",
            carregando: false,
            erro: "",
            aviso: "",
            resultado: null,
        });
        // Depois de mover o foco pelo teclado ou remover um chip, o Owl já
        // renderizou: aplica o foco no elemento correspondente.
        this._focoPendente = null;
        useEffect(() => {
            if (!this._focoPendente) {
                return;
            }
            const seletor = this._focoPendente;
            this._focoPendente = null;
            const alvo = this.el?.querySelector(seletor)
                || this.el?.querySelector(
                    `.o_consulta_dia[data-data="${this.focoVisivel}"]`
                );
            alvo?.focus();
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

    get idioma() {
        return idiomaOdoo(user.lang);
    }

    get rotuloMesVisivel() {
        return rotuloMes(
            this.state.mesVisivel.ano, this.state.mesVisivel.mes, this.idioma
        );
    }

    get rotulosSemana() {
        return rotulosSemana(this.idioma);
    }

    get linhasDoMes() {
        const celulas = celulasDoMes(
            this.state.mesVisivel.ano,
            this.state.mesVisivel.mes,
            this.state.dias,
            this.state.hoje
        );
        const linhas = [];
        for (let inicio = 0; inicio < celulas.length; inicio += 7) {
            linhas.push(celulas.slice(inicio, inicio + 7));
        }
        return linhas;
    }

    get calendarioHabilitado() {
        return Boolean(this.state.configIds.length) && !this.state.carregando;
    }

    /** Célula que recebe o Tab na grade (roving tabindex). */
    get focoVisivel() {
        const { ano, mes } = this.state.mesVisivel;
        const prefixo = `${ano}-${duasCasas(mes)}-`;
        if (this.state.focoData && this.state.focoData.startsWith(prefixo)) {
            return this.state.focoData;
        }
        return `${prefixo}01`;
    }

    get mensagemCalendarioDesabilitado() {
        return this.state.configIds.length
            ? ""
            : _t("Selecione um caixa para escolher os dias.");
    }

    get contadorDias() {
        return _t(
            "%s de %s dias selecionados", this.state.dias.length, LIMITE_DIAS
        );
    }

    /** Chips visíveis: seleções grandes começam recolhidas, com acesso a todas. */
    get diasVisiveis() {
        if (
            this.state.mostrarTodosChips
            || this.state.dias.length <= CHIPS_VISIVEIS
        ) {
            return this.state.dias;
        }
        return this.state.dias.slice(0, CHIPS_VISIVEIS);
    }

    get temChipsOcultos() {
        return this.state.dias.length > CHIPS_VISIVEIS;
    }

    get rotuloVerChips() {
        return this.state.mostrarTodosChips
            ? _t("Mostrar menos")
            : _t("Ver os %s dias", this.state.dias.length);
    }

    get anosDistintos() {
        const anos = new Set(this.state.dias.map((dia) => dia.slice(0, 4)));
        return anos.size > 1;
    }

    alternarChips() {
        this.state.mostrarTodosChips = !this.state.mostrarTodosChips;
    }

    nomeCompletoData(data) {
        return nomeCompletoData(data, this.idioma);
    }

    rotuloRemoverDia(data) {
        return rotuloRemoverDia(data, this.idioma, _t("Remover"));
    }

    /** Chip curto (08/10); o ano aparece quando a seleção atravessa anos. */
    formatarDataCurta(data) {
        const [ano, mes, dia] = data.split("-");
        return this.anosDistintos ? `${dia}/${mes}/${ano}` : `${dia}/${mes}`;
    }

    mudarMes(delta) {
        const destino = somarMeses(this.focoVisivel, delta);
        this.state.focoData = destino;
        const [ano, mes] = destino.split("-").map(Number);
        this.state.mesVisivel = { ano, mes };
    }

    /** Move só o foco — nunca marca nem apaga dias. */
    moverFoco(data) {
        this.state.focoData = data;
        const [ano, mes] = data.split("-").map(Number);
        this.state.mesVisivel = { ano, mes };
        this._focoPendente = `.o_consulta_dia[data-data="${data}"]`;
    }

    alternarDiaFocado() {
        this.toggleDia(this.focoVisivel);
    }

    /** Teclado da grade (adaptação multisseleção do APG Grid Pattern). */
    onCalendarioKeydown(ev) {
        if (!this.calendarioHabilitado) {
            return;
        }
        let destino = null;
        switch (ev.key) {
            case "ArrowLeft":
                destino = somarDias(this.focoVisivel, -1);
                break;
            case "ArrowRight":
                destino = somarDias(this.focoVisivel, 1);
                break;
            case "ArrowUp":
                destino = somarDias(this.focoVisivel, -7);
                break;
            case "ArrowDown":
                destino = somarDias(this.focoVisivel, 7);
                break;
            case "Home":
                destino = inicioDaSemana(this.focoVisivel);
                break;
            case "End":
                destino = fimDaSemana(this.focoVisivel);
                break;
            case "PageUp":
                destino = somarMeses(this.focoVisivel, -1);
                break;
            case "PageDown":
                destino = somarMeses(this.focoVisivel, 1);
                break;
            case " ":
            case "Enter":
                ev.preventDefault();
                this.alternarDiaFocado();
                return;
            default:
                return;
        }
        ev.preventDefault();
        this.moverFoco(destino);
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

    /** Explica o estado do filtro sem deixar "vazio" ambíguo. */
    get mensagemFiltroPagamento() {
        return this.state.metodosIds.length
            ? _t("Cupons com pelo menos uma das formas marcadas.")
            : _t("Sem filtro: qualquer forma de pagamento.");
    }

    /** Desmarca todos os métodos — o caminho explícito para "sem filtro". */
    removerFiltroPagamento() {
        if (this.state.carregando) {
            return;
        }
        this.state.metodosIds = [];
        this.alterouFiltros();
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

    toggleDia(data) {
        if (!this.state.configIds.length || this.state.carregando) {
            return;
        }
        this.state.focoData = data;
        const indice = this.state.dias.indexOf(data);
        if (indice >= 0) {
            this.state.dias.splice(indice, 1);
        } else if (!podeMarcarDia(this.state.dias, data)) {
            this.state.aviso = _t(
                "Você já selecionou %s dias. Remova um dia para adicionar outro.",
                LIMITE_DIAS
            );
            return;
        } else {
            this.state.dias.push(data);
            this.state.dias.sort();
        }
        this.state.aviso = "";
        this.alterouFiltros();
    }

    removerDia(data) {
        const indice = this.state.dias.indexOf(data);
        this.toggleDia(data);
        if (this.state.dias.length) {
            // Foco vai para o próximo chip; se não houver, para o grupo de dias.
            const alvo = Math.min(indice, this.state.dias.length - 1);
            this._focoPendente = `.o_consulta_chip_remover[data-indice="${alvo}"]`;
        } else {
            this._focoPendente = `.o_consulta_dia[data-data="${this.focoVisivel}"]`;
        }
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
