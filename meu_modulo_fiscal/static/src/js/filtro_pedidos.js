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
 *   - ticket_screen.js:378 no branch SYNCED o core devolve a lista fatiada por
 *     página; no tab Pago esse corte é substituído pelo corte incremental.
 *   - ticket_screen.js:613-631 o field DATE converte o termo local para UTC
 *     com `parseDateTime(...).toUTC().toFormat("yyyy-MM-dd HH:mm:ss")` — a
 *     janela do dia usa a mesma conversão (luxon, fuso do browser).
 *   - ticket_screen.js:1327-1335 (py) o `config_id` só entra no domain quando
 *     o domain recebido é vazio; como a janela do dia nunca é vazia, o filtro
 *     da loja é re-adicionado aqui explicitamente.
 *
 * Luxon NÃO é um módulo do Odoo: o core usa o global (`const { DateTime } =
 * luxon;` em web/core/l10n/dates.js:6). Um `import ... from "luxon"` deixaria
 * este arquivo sem módulo definido — o patch não rodaria.
 */
import { TicketScreen } from "@point_of_sale/app/screens/ticket_screen/ticket_screen";
import { patch } from "@web/core/utils/patch";
import { _t } from "@web/core/l10n/translation";
import { parseUTCString } from "@point_of_sale/utils";
import { fuzzyLookup } from "@web/core/utils/search";
import { ConnectionLostError } from "@web/core/network/rpc";
import { onMounted, onPatched, useRef } from "@odoo/owl";

const { DateTime } = luxon;

// Mesmo limite do fetch do core (ticket_screen.js:715) — o scroll carrega
// mais um bloco desse tamanho.
const PAGINA = 30;
// Distância (px) do fim da lista que dispara o próximo bloco.
const LIMIAR_SCROLL = 300;
// Janela de silêncio após uma falha de conexão: evita uma rajada de RPCs
// falhando a cada evento de scroll (DEC-004: nenhuma chamada extra offline).
const ESPERA_OFFLINE = 3000;

patch(TicketScreen.prototype, {
    setup() {
        super.setup(...arguments);
        // Set de IDs de pos.payment.method selecionados. O useState do Owl
        // torna Set reativo (has/add/delete/size são observados), então
        // alternar um chip re-renderiza a lista sem trabalho extra.
        this.state.activePaymentMethodIds = new Set();
        // Ordenação do tab Pago (DEC-006): false = "Mais próximas" (padrão,
        // igual ao core), true = "Mais antigas". Reativo: o toggle re-renderiza.
        this.state.pagoOrdenacaoAsc = false;
        // Controle do scroll infinito (fora do useState: não pinta nada).
        this._pagoCarregando = false;
        this._pagoDominioEsgotado = null;
        this._pagoOfflineAte = null;
        this._pagoGeracao = 0;
        // Offset acumulado por (domain, ordenação) DESTA instância da tela.
        // Deliberadamente não usa `ticketScreenState.offsetByDomain`: aquele
        // mapa vive na sessão do POS e vaza entre aberturas da tela (entrar de
        // novo com offset antigo pularia os primeiros blocos).
        this._pagoOffsets = new Map();
        // Container rolável da lista. Em Owl 2 o componente NÃO tem `this.el`:
        // a referência ao nó vem do `t-ref` (owl.js:6160 useRef). O atributo
        // é injetado no div.orders do core pela herança do template.
        this._pagoOrdersRef = useRef("pagoOrders");
        // Lista curta demais para rolar (filtro/chips escondendo linhas) não
        // emite scroll — depois de cada render completa até ter rolagem ou
        // esgotar o domínio.
        onMounted(() => this._pagoPreencherLista());
        onPatched(() => this._pagoPreencherLista());
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

    /**
     * date_order (UTC) dentro do dia local vigente?
     * Recebe a janela pronta quando o chamador já a calculou (evita criar um
     * DateTime por pedido num filtro O(n) a cada render).
     */
    _pagoDentroDoDia(order, janela = this._pagoJanelaDoDia()) {
        const dt = parseUTCString(order.date_order);
        return dt.isValid && dt >= janela.inicio && dt < janela.fim;
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
        let domain = super._computeSyncedOrdersDomain(...arguments);
        if (this.state.filter !== "SYNCED") {
            return domain;
        }

        // Termo só com data no campo DATE: o ilike do core compara contra a
        // data UTC e perde vendas do fim do dia local (21h em Manaus já é o
        // dia seguinte em UTC). O match fica no cliente, sobre a data já
        // localizada pela repr do campo; o servidor devolve o dia inteiro.
        const { searchTerm, fieldName } = this.state.search;
        if (fieldName === "DATE" && searchTerm && !searchTerm.includes(":")) {
            domain = [];
        }

        const { inicio, fim } = this._pagoJanelaDoDia();
        return [
            // O core só filtra a loja quando o domain recebido é vazio
            // (pos_order.py:1330-1334). Como abaixo a janela nunca é vazia,
            // o filtro é re-adicionado aqui — sem ele a lista traria vendas
            // de outros caixas da mesma moeda.
            ["config_id", "=", this.pos.config.id],
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
        // atravessar a meia-noite — a lista exibida também é cortada. A janela
        // é calculada UMA vez: o corte é O(n) sobre o cache.
        const janela = this._pagoJanelaDoDia();
        orders = orders.filter((order) => this._pagoDentroDoDia(order, janela));

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
     * Pedido de outro dia não pode ser reimpresso/estornado pelo PDV (user
     * story 6): mesmo que tenha ficado selecionado na virada da meia-noite ou
     * tenha saído da lista por um chip, ele deixa de ser "o pedido selecionado"
     * no tab Pago.
     */
    getSelectedOrder() {
        const order = super.getSelectedOrder(...arguments);
        if (order && this.state.filter === "SYNCED" && !this._pagoDentroDoDia(order)) {
            return null;
        }
        return order;
    },

    /**
     * Clique em pedido de outro dia (linha que sobrou de ontem na virada, antes
     * do próximo render) não seleciona. Sem esta guarda o core quebraria:
     * `onClickOrder` chama `getSelectedOrder().get_orderlines()`
     * (ticket_screen.js:136) e o override de `getSelectedOrder` devolve null.
     */
    onClickOrder(clickedOrder) {
        if (
            this.state.filter === "SYNCED" &&
            clickedOrder &&
            !this._pagoDentroDoDia(clickedOrder)
        ) {
            return;
        }
        return super.onClickOrder(...arguments);
    },

    /**
     * Busca nova recomeça a lista: o domain pode até repetir o mesmo texto (ex:
     * campo DATE só com data, que é filtrado no cliente), mas o carregamento
     * não pode continuar do offset antigo.
     */
    async onSearch(search) {
        this._pagoOffsets.clear();
        this._pagoDominioEsgotado = null;
        return super.onSearch(...arguments);
    },

    /**
     * Ordena como o sortOrders do core (ticket_screen.js:364-385): date_order
     * e, no empate, o número do pedido em `name`. Ascendente quando o toggle
     * está em "Mais antigas" — a mesma direção que o servidor pagina.
     */
    _pagoOrdenar(orders) {
        const ascendente = Boolean(this.state.pagoOrdenacaoAsc);
        return orders.sort((a, b) => {
            const dateA = parseUTCString(a.date_order);
            const dateB = parseUTCString(b.date_order);
            if (a.date_order !== b.date_order) {
                return ascendente ? dateA - dateB : dateB - dateA;
            }
            const nameA = parseInt(a.name.replace(/\D/g, "")) || 0;
            const nameB = parseInt(b.name.replace(/\D/g, "")) || 0;
            return ascendente ? nameA - nameB : nameB - nameA;
        });
    },

    /**
     * Toggle "Mais próximas" / "Mais antigas" (DEC-006).
     *
     * Trocar a ordem não mistura janelas: o offset do domínio corrente é
     * zerado e a lista visível recomeça no primeiro bloco; o fetch seguinte
     * já pede ao servidor a ordem nova, então em "Mais antigas" o offset
     * pagina a partir do início do dia.
     */
    async setPagoOrdenacao(asc) {
        const ascendente = Boolean(asc);
        if (this.state.pagoOrdenacaoAsc === ascendente) {
            return;
        }
        const paginaAnterior = this.state.page;
        this.state.pagoOrdenacaoAsc = ascendente;
        this.state.page = 1;
        this._pagoDominioEsgotado = null;
        // DEC-006: offsets de qualquer ordenação anterior não valem.
        this._pagoOffsets.clear();
        const carregou = await this._fetchSyncedOrders();
        if (carregou === false) {
            // Offline (DEC-004): mantém o mesmo bloco já visível — a lista só
            // aparece reordenada, sem erro e sem encolher.
            this.state.page = paginaAnterior;
        }
    },

    // ── Scroll infinito (DEC-004/DEC-005) ────────────────────────────────
    /** Chave do offset/paginação: domínio (dia+busca) + ordenação. */
    _pagoChaveDoDominio(domain) {
        return JSON.stringify([
            domain || this._computeSyncedOrdersDomain(),
            Boolean(this.state.pagoOrdenacaoAsc),
        ]);
    },

    /**
     * Handler do `t-on-scroll` no container da lista. Perto do fim dispara
     * mais um bloco; nunca busca com a lista já esgotada, com fetch em
     * andamento, durante a janela de silêncio offline ou antes do primeiro
     * fetch.
     */
    async onPagoScroll(event) {
        if (this.state.filter !== "SYNCED" || this._pagoCarregando) {
            return;
        }
        if (this._pagoOfflineAte && Date.now() < this._pagoOfflineAte) {
            return;
        }
        // Browser já sabe que está sem rede (data_service.js:63-65): nem tenta.
        if (this.pos.data.network && this.pos.data.network.offline) {
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
        if (this._pagoDominioEsgotado === this._pagoChaveDoDominio()) {
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
     * Completa a lista quando ela não é alta o bastante para rolar (filtro ou
     * chips esconderam as linhas carregadas): sem rolagem não há evento de
     * scroll, e o operador nunca alcançaria o resto do dia. Para quando a
     * página visível cobre o total do domínio ou quando há rolagem.
     */
    _pagoPreencherLista() {
        if (this.state.filter !== "SYNCED" || this._pagoCarregando) {
            return;
        }
        const total = this.pos.ticketScreenState.totalCount || 0;
        if (!total || this.state.page * PAGINA >= total) {
            return;
        }
        const el = this._pagoOrdersRef && this._pagoOrdersRef.el;
        if (!el) {
            return;
        }
        if (el.scrollHeight > el.clientHeight + LIMIAR_SCROLL) {
            return;
        }
        this.onPagoScroll({ target: el });
    },

    /**
     * Chamada do fetch com tolerância à ordem do deploy: assets JS regeneram
     * sozinhos, mas o Python só muda com restart. Se o browser pegar o JS novo
     * antes do restart, o servidor rejeita o kwarg `order`. Na ordem padrão
     * (desc) a chamada é refeita sem ele — a lista funciona com o default do
     * core até reiniciar. Em "Mais antigas" o erro sobe: sem `order` o
     * servidor paginaria na direção errada.
     */
    async _pagoBuscarPedidos(kwargs) {
        try {
            return await this.pos.data.call("pos.order", "search_paid_order_ids", [], kwargs);
        } catch (error) {
            if (
                this.state.pagoOrdenacaoAsc ||
                error instanceof ConnectionLostError ||
                !kwargs.order
            ) {
                throw error;
            }
            const semOrdem = { ...kwargs };
            delete semOrdem.order;
            console.warn(
                "[PAGO] servidor não aceitou o parâmetro order; usando a ordem do core " +
                    "(reinicie o Odoo) —",
                error
            );
            return await this.pos.data.call("pos.order", "search_paid_order_ids", [], semOrdem);
        }
    },

    /**
     * Fetch de pedidos pagos do core (ticket_screen.js:702-741), com as
     * diferenças do tab Pago: offset próprio por (domínio, ordenação), ordem
     * explícita pedida ao servidor, página visível derivada do offset e falha
     * por conexão perdida em silêncio (DEC-004). Devolve `false` só quando a
     * falha foi de conexão (para o toggle não encolher a lista offline).
     */
    async _fetchSyncedOrders() {
        // Demais tabs: core intacto (paginação explícita, erros do core).
        if (this.state.filter !== "SYNCED") {
            return super._fetchSyncedOrders(...arguments);
        }

        const domain = this._computeSyncedOrdersDomain();
        const chave = this._pagoChaveDoDominio(domain);
        const offset = this._pagoOffsets.get(chave) || 0;
        // Descarta a resposta de um fetch que perdeu a corrida para outro
        // (scroll vs troca de ordenação/busca): sem isso, um resultado antigo
        // sobrescreveria offset/página do domínio novo.
        const geracao = ++this._pagoGeracao;

        const kwargs = {
            config_id: this.pos.config.id,
            domain,
            limit: PAGINA,
            offset,
            // DEC-002: o servidor pagina na MESMA direção da lista local.
            // Explicitar desc por date_order (e não o create_date desc do
            // default do core) mantém página e ordenação coerentes — pedidos
            // offline sincronizados depois têm create_date fora da ordem.
            order: this.state.pagoOrdenacaoAsc ? "date_order asc" : "date_order desc",
        };

        let resposta;
        try {
            resposta = await this._pagoBuscarPedidos(kwargs);
        } catch (error) {
            if (error instanceof ConnectionLostError) {
                // Offline: mantém o que já está carregado, sem erro e sem
                // spinner; a janela de silêncio evita uma rajada de RPCs.
                this._pagoOfflineAte = Date.now() + ESPERA_OFFLINE;
                return false;
            }
            throw error;
        }
        if (geracao !== this._pagoGeracao) {
            return;
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
                    this._pagoOfflineAte = Date.now() + ESPERA_OFFLINE;
                    return false;
                }
                throw error;
            }
            if (geracao !== this._pagoGeracao) {
                return;
            }
        }

        const novoOffset = offset + ordersInfo.length;
        this._pagoOffsets.set(chave, novoOffset);
        // totalCount continua no estado do core (getNbrPages do tab Pago fica
        // oculto, mas o valor é usado pelo auto-preenchimento acima).
        this.pos.ticketScreenState.totalCount = totalCount;
        // Nunca diminui a página visível: uma continuação que começa do zero
        // (ex: volta de offline, todos os ids já em cache) não pode encolher
        // a lista; busca e troca de ordenação resetam `page` explicitamente.
        this.state.page = Math.max(this.state.page, Math.ceil(novoOffset / PAGINA));
        // Esgotado: alcançou o total do domínio ou o servidor não devolveu
        // nada novo — para de buscar até o domínio mudar (busca/dia/ordem).
        this._pagoDominioEsgotado =
            novoOffset >= totalCount || ordersInfo.length === 0 ? chave : null;
        this._pagoOfflineAte = null;
        return true;
    },
});
