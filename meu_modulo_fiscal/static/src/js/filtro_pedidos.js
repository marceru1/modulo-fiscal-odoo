/** @odoo-module */

/**
 * Filtros e janela do dia na lista de pedidos pagos do POS (tab "Pago").
 *
 *   1. Chips de tipo de pagamento, gerados a partir dos métodos da sessão.
 *   2. Search field "Valor" (novo) — o "Data / Hora" reutiliza o field DATE
 *      existente, apenas com label mais explícita.
 *   3. Só vendas do dia corrido local (spec pago-vendas-do-dia, DEC-001/003):
 *      janela injetada no domain do backend E aplicada na lista exibida.
 *
 * Fonte (Odoo 18.0, verificado em addons/point_of_sale/...):
 *   - ticket_screen.js:601 _getSearchFields() devolve um objeto literal NOVO a
 *     cada chamada — mutar o retorno de super é seguro e preserva a ordem de
 *     inserção (o SearchBar monta o dropdown com [...searchFields.keys()]).
 *   - ticket_screen.js:688 o guard `searchField.modelField` já descarta campos
 *     com modelField null do domínio do backend — por isso AMOUNT não gera
 *     query server-side sem precisar de nenhuma alteração aqui.
 *   - ticket_screen.js:378 no branch SYNCED o core já devolve a lista paginada
 *     (slice de 30); o filtro de chips e a janela do dia rodam por cima.
 *   - ticket_screen.js:613-631 o field DATE converte o termo local para UTC
 *     com `parseDateTime(...).toUTC().toFormat("yyyy-MM-dd HH:mm:ss")` — a
 *     janela do dia usa a mesma conversão (luxon, fuso do browser).
 */
import { TicketScreen } from "@point_of_sale/app/screens/ticket_screen/ticket_screen";
import { patch } from "@web/core/utils/patch";
import { _t } from "@web/core/l10n/translation";
import { DateTime } from "luxon";
import { parseUTCString } from "@point_of_sale/utils";
import { fuzzyLookup } from "@web/core/utils/search";
import { ConnectionLostError } from "@web/core/network/rpc";

// Mesmo limite do fetch do core (ticket_screen.js:715) — o scroll carrega
// mais um bloco desse tamanho.
const PAGINA = 30;
// Distância (px) do fim da lista que dispara o próximo bloco.
const LIMIAR_SCROLL = 300;

patch(TicketScreen.prototype, {
    setup() {
        super.setup(...arguments);
        // Set de IDs de pos.payment.method selecionados. O useState do Owl
        // torna Set reativo (has/add/delete/size são observados), então
        // alternar um chip re-renderiza a lista sem trabalho extra.
        this.state.activePaymentMethodIds = new Set();
        // Controle do scroll infinito (fora do useState: não pinta nada).
        this._pagoCarregando = false;
        this._pagoDominioEsgotado = null;
    },

    // ── Janela do dia (DEC-001) ──────────────────────────────────────────
    /**
     * Início do dia local e início do dia seguinte (janela half-open).
     * Recalculado a cada chamada: a virada da meia-noite entra no próximo
     * render/fetch sem timer dedicado.
     */
    _pagoJanelaDoDia() {
        const inicio = DateTime.now().startOf("day");
        return { inicio, fim: inicio.plus({ days: 1 }) };
    },

    /** Formata um DateTime no mesmo padrão UTC que o field DATE usa. */
    _pagoParaDominio(dt) {
        return dt.toUTC().toFormat("yyyy-MM-dd HH:mm:ss");
    },

    /** date_order (UTC) dentro do dia local vigente? */
    _pagoDentroDoDia(order) {
        const { inicio, fim } = this._pagoJanelaDoDia();
        const dt = parseUTCString(order.date_order);
        return dt.isValid && dt >= inicio && dt < fim;
    },

    _getSearchFields() {
        const fields = super._getSearchFields(...arguments);

        // Busca por hora: reutiliza o field DATE do core (que já tem o
        // formatSearch que manda "HH:MM" ao backend). Só o label muda, para
        // o operador saber que pode digitar a hora, não apenas a data.
        fields.DATE.displayName = _t("Data / Hora");

        // Filtro por valor: puramente client-side. modelField null mantém o
        // campo fora de _computeSyncedOrdersDomain() — o match é feito pelo
        // fuzzyLookup do core sobre o valor já formatado (ex: "R$ 85,50").
        fields.AMOUNT = {
            repr: (order) => this.env.utils.formatCurrency(order.get_total_with_tax()),
            displayName: _t("Valor"),
            modelField: null,
        };

        return fields;
    },

    /**
     * Domain do fetch de pedidos pagos: o do core (busca) + a janela do dia.
     *
     * Vale para listagem E busca (DEC-003): qualquer campo do SearchBar que
     * gere query server-side continua AND-ado com a janela, então nenhum
     * campo encontra pedido de outro dia. Campo puramente client-side
     * (AMOUNT) devolve domain [] no super e recebe só a janela.
     *
     * A chave usada pelo core para o offset (JSON.stringify(domain)) muda
     * quando o dia vira — de graça, o offset reinicia (DEC-001).
     */
    _computeSyncedOrdersDomain() {
        const domain = super._computeSyncedOrdersDomain(...arguments);
        if (this.state.filter !== "SYNCED") {
            return domain;
        }
        const { inicio, fim } = this._pagoJanelaDoDia();
        return [
            ...domain,
            ["date_order", ">=", this._pagoParaDominio(inicio)],
            ["date_order", "<", this._pagoParaDominio(fim)],
        ];
    },

    /** Métodos de pagamento disponíveis na sessão atual (chips). */
    getAvailablePaymentMethods() {
        return this.pos.models["pos.payment.method"].getAll();
    },

    /** Alterna um chip. Um pedido pode ter mais de um método (pedido misto). */
    onTogglePaymentChip(methodId) {
        const active = this.state.activePaymentMethodIds;
        if (active.has(methodId)) {
            active.delete(methodId);
        } else {
            active.add(methodId);
        }
    },

    getFilteredOrderList() {
        // Demais tabs: lógica do core intacta (status, busca, paginação).
        if (this.state.filter !== "SYNCED") {
            return super.getFilteredOrderList(...arguments);
        }

        // Tab "Pago": o slice de página do core (ticket_screen.js:378-382)
        // é substituído pelo corte incremental — a lista cresce de 30 em 30
        // conforme o scroll, em vez de trocar de página.
        return this._pagoListaVisivel();
    },

    /**
     * Lista do tab "Pago": pedidos do dia, busca, ordenação, chips e o corte
     * incremental. Repete a composição do branch SYNCED do core
     * (ticket_screen.js:347-349, 369-382) porque o slice de página sai daqui.
     */
    _pagoListaVisivel() {
        let orders = this.pos.models["pos.order"].filter(
            (order) => order.finalized && order.uiState.displayed
        );

        // Complemento client-side do DEC-001: o domain já restringe o fetch,
        // mas o cache local guarda pedidos de sessões passadas e a sessão pode
        // atravessar a meia-noite — a lista exibida também é cortada.
        orders = orders.filter((order) => this._pagoDentroDoDia(order));

        // Busca: mesma semântica do core (fuzzyLookup sobre o repr do campo).
        const { searchTerm, fieldName } = this.state.search;
        if (searchTerm) {
            const campo = this._getSearchFields()[fieldName];
            if (campo) {
                orders = fuzzyLookup(searchTerm, orders, campo.repr);
            }
        }

        orders = this._pagoOrdenar(orders);

        // Chips: OR dentro do campo de pagamento (pedido misto aparece em
        // todos os chips que ele usa), AND com os demais filtros.
        const active = this.state.activePaymentMethodIds;
        if (active.size > 0) {
            orders = orders.filter((order) =>
                order.payment_ids.some((payment) => active.has(payment.payment_method_id.id))
            );
        }

        // Corte incremental: a página visível é o número de blocos já
        // carregados. Para quando o total do domínio foi alcançado (o próprio
        // slice não passa do tamanho da lista).
        return orders.slice(0, this.state.page * PAGINA);
    },

    /**
     * Ordena como o sortOrders do core (ticket_screen.js:364-385): date_order
     * e, no empate, o número do pedido em `name`.
     */
    _pagoOrdenar(orders) {
        return orders.sort((a, b) => {
            const dateA = parseUTCString(a.date_order);
            const dateB = parseUTCString(b.date_order);
            if (a.date_order !== b.date_order) {
                return dateB - dateA;
            }
            const nameA = parseInt(a.name.replace(/\D/g, "")) || 0;
            const nameB = parseInt(b.name.replace(/\D/g, "")) || 0;
            return nameB - nameA;
        });
    },

    // ── Scroll infinito (DEC-004/DEC-005) ────────────────────────────────
    /**
     * Handler do `t-on-scroll` no container da lista. Perto do fim dispara
     * mais um bloco; nunca busca com a lista já esgotada, com fetch em
     * andamento ou antes do primeiro fetch.
     */
    async onPagoScroll(event) {
        if (this.state.filter !== "SYNCED" || this._pagoCarregando) {
            return;
        }
        const alvo = event && event.target;
        if (!alvo) {
            return;
        }
        const pertoDoFim =
            alvo.scrollTop + alvo.clientHeight >= alvo.scrollHeight - LIMIAR_SCROLL;
        if (!pertoDoFim) {
            return;
        }
        if (this._pagoDominioEsgotado === JSON.stringify(this._computeSyncedOrdersDomain())) {
            return;
        }

        this._pagoCarregando = true;
        try {
            await this._fetchSyncedOrders();
        } finally {
            this._pagoCarregando = false;
        }
    },

    /**
     * Fetch de pedidos pagos do core (ticket_screen.js:702-741), com duas
     * diferenças: falha por conexão perdida para silenciosamente no cache
     * (DEC-004) e a página visível avança com o offset acumulado.
     */
    async _fetchSyncedOrders() {
        const screenState = this.pos.ticketScreenState;
        const domain = this._computeSyncedOrdersDomain();
        const chave = JSON.stringify(domain);
        const offset = screenState.offsetByDomain[chave] || 0;

        let resposta;
        try {
            resposta = await this.pos.data.call("pos.order", "search_paid_order_ids", [], {
                config_id: this.pos.config.id,
                domain,
                limit: PAGINA,
                offset,
            });
        } catch (error) {
            if (error instanceof ConnectionLostError) {
                // Offline: mantém o que já está carregado, sem erro e sem
                // spinner. O próximo scroll tenta de novo quando houver rede.
                return;
            }
            throw error;
        }

        const { ordersInfo, totalCount } = resposta;
        const idsParaLer = ordersInfo
            .filter(([id, modificadoEm]) => {
                const order = this.pos.models["pos.order"].get(id);
                if (order && parseUTCString(modificadoEm) > parseUTCString(order.date_order)) {
                    return true;
                }
                return !order;
            })
            .map(([id]) => id);

        if (idsParaLer.length > 0) {
            try {
                await this.pos.data.read("pos.order", Array.from(new Set(idsParaLer)));
            } catch (error) {
                if (error instanceof ConnectionLostError) {
                    return;
                }
                throw error;
            }
        }

        const novoOffset = offset + ordersInfo.length;
        screenState.offsetByDomain[chave] = novoOffset;
        screenState.totalCount = totalCount;
        this.state.page = Math.max(1, Math.ceil(novoOffset / PAGINA));
        // Esgotado: alcançou o total do domínio ou o servidor não devolveu
        // nada novo — para de buscar até o domínio mudar (busca/dia/ordem).
        this._pagoDominioEsgotado =
            novoOffset >= totalCount || ordersInfo.length === 0 ? chave : null;
    },
});
