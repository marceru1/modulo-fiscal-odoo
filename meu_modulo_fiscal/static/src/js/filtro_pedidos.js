/** @odoo-module */

/**
 * Filtros client-side na lista de pedidos pagos do POS (tab "Pago").
 *
 * Dois filtros, ambos em memória sobre os pedidos já carregados — nenhuma
 * chamada extra ao backend, sem risco para o fluxo offline/contingência:
 *
 *   1. Chips de tipo de pagamento, gerados a partir dos métodos da sessão.
 *   2. Search field "Valor" (novo) — o "Data / Hora" reutiliza o field DATE
 *      existente, apenas com label mais explícita.
 *
 * Fonte (Odoo 18.0, verificado em addons/point_of_sale/...):
 *   - ticket_screen.js:601 _getSearchFields() devolve um objeto literal NOVO a
 *     cada chamada — mutar o retorno de super é seguro e preserva a ordem de
 *     inserção (o SearchBar monta o dropdown com [...searchFields.keys()]).
 *   - ticket_screen.js:688 o guard `searchField.modelField` já descarta campos
 *     com modelField null do domínio do backend — por isso AMOUNT não gera
 *     query server-side sem precisar de nenhuma alteração aqui.
 *   - ticket_screen.js:378 no branch SYNCED o core já devolve a lista paginada
 *     (slice de 30), então o filtro de chips roda sobre a página atual.
 */
import { TicketScreen } from "@point_of_sale/app/screens/ticket_screen/ticket_screen";
import { patch } from "@web/core/utils/patch";
import { _t } from "@web/core/l10n/translation";

patch(TicketScreen.prototype, {
    setup() {
        super.setup(...arguments);
        // Set de IDs de pos.payment.method selecionados. O useState do Owl
        // torna Set reativo (has/add/delete/size são observados), então
        // alternar um chip re-renderiza a lista sem trabalho extra.
        this.state.activePaymentMethodIds = new Set();
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

        const active = this.state.activePaymentMethodIds;

        // Só filtra no tab "Pago": é o único onde os chips são renderizados.
        // Filtrar em outro tab esconderia pedidos sem nenhuma indicação visual
        // ao operador (filtro fantasma).
        if (active.size === 0 || this.state.filter !== "SYNCED") {
            return orders;
        }

        // OR dentro do campo de pagamento (pedido misto aparece em todos os
        // chips que ele usa); AND com os demais filtros, que já foram
        // aplicados pelo super acima.
        return orders.filter((order) =>
            order.payment_ids.some((payment) => active.has(payment.payment_method_id.id))
        );
    },
});
