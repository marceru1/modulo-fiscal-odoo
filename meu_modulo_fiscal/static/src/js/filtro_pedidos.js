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

patch(TicketScreen.prototype, {
    setup() {
        super.setup(...arguments);
        // Set de IDs de pos.payment.method selecionados. O useState do Owl
        // torna Set reativo (has/add/delete/size são observados), então
        // alternar um chip re-renderiza a lista sem trabalho extra.
        this.state.activePaymentMethodIds = new Set();
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
        // Preserva toda a lógica do core (filtro de status, busca por recibo/
        // data/valor via fuzzyLookup e a paginação do tab SYNCED).
        const orders = super.getFilteredOrderList(...arguments);

        // Fora do tab "Pago" nada muda: os chips e a janela do dia só são
        // renderizados/calculados ali. Filtrar em outro tab esconderia
        // pedidos sem nenhuma indicação visual ao operador (filtro fantasma).
        if (this.state.filter !== "SYNCED") {
            return orders;
        }

        // Complemento client-side do DEC-001: o domain já restringe o fetch,
        // mas o cache local guarda pedidos de sessões passadas e a sessão pode
        // atravessar a meia-noite — a lista exibida também é cortada.
        const doDia = orders.filter((order) => this._pagoDentroDoDia(order));

        const active = this.state.activePaymentMethodIds;
        if (active.size === 0) {
            return doDia;
        }

        // OR dentro do campo de pagamento (pedido misto aparece em todos os
        // chips que ele usa); AND com os demais filtros, que já foram
        // aplicados pelo super acima.
        return doDia.filter((order) =>
            order.payment_ids.some((payment) => active.has(payment.payment_method_id.id))
        );
    },
});
