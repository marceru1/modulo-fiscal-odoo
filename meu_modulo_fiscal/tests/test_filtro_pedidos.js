/**
 * Teste unitário (Node puro, sem Odoo) das features da TicketScreen do POS:
 *
 *   - filtro-pedidos-pagos-pos: chips de tipo de pagamento, search field
 *     "Valor" e label "Data / Hora".
 *   - pago-vendas-do-dia: janela do dia no domain/busca (DEC-001/DEC-003).
 *
 * O Odoo não roda localmente, então este teste:
 *   1. Lê static/src/js/filtro_pedidos.js e extrai o objeto literal passado a
 *      patch(TicketScreen.prototype, {...}).
 *   2. Monta esse objeto com um protótipo mockado que faz o papel de `super`
 *      (Object.setPrototypeOf) — assim `super._getSearchFields()` e
 *      `super.getFilteredOrderList()` resolvem para os mocks da base.
 *   3. Executa os métodos com um `this` mockado e valida o contrato da spec.
 *
 * As dependências importadas pelo patch (_t, DateTime, parseUTCString,
 * fuzzyLookup, ConnectionLostError) são injetadas na extração: o luxon vem do
 * build vendorizado do próprio Odoo (addons/web/static/lib/luxon/luxon.js),
 * então a conversão de fuso é a real.
 *
 * Rodar: node meu_modulo_fiscal/tests/test_filtro_pedidos.js
 */
const fs = require("fs");
const path = require("path");
const assert = require("assert");

const MODULE_ROOT = path.join(__dirname, "..");
const JS_PATH = path.join(MODULE_ROOT, "static", "src", "js", "filtro_pedidos.js");
const LUXON_PATH = path.join(
    MODULE_ROOT,
    "..",
    "..",
    "addons",
    "web",
    "static",
    "lib",
    "luxon",
    "luxon.js"
);

const source = fs.readFileSync(JS_PATH, "utf8");

// Constantes de módulo usadas dentro do patch: lidas do próprio arquivo para
// o teste não repetir (e não divergir de) o valor real.
function lerConstante(nome) {
    const m = source.match(new RegExp(`const ${nome} = (\\d+);`));
    assert(m, `constante ${nome} não encontrada em filtro_pedidos.js`);
    return Number(m[1]);
}
const PAGINA = lerConstante("PAGINA");
const LIMIAR_SCROLL = lerConstante("LIMIAR_SCROLL");

// ── Luxon vendorizado do Odoo (mesmo build que o browser carrega) ─────────
const luxonSrc = fs.readFileSync(LUXON_PATH, "utf8");
const { DateTime } = new Function(`${luxonSrc}\nreturn luxon;`)();

// ── Extração do objeto literal passado a patch() ──────────────────────────
// Balanceia chaves/parênteses/colchetes ignorando o conteúdo de strings,
// para não capturar cedo caso apareça um `}` literal dentro de uma string.
function extractBalanced(src, openIdx) {
    const openers = "{([";
    const closers = "})]";
    let depth = 0;
    let quote = null;
    for (let i = openIdx; i < src.length; i++) {
        const ch = src[i];
        if (quote) {
            if (ch === "\\") {
                i++;
            } else if (ch === quote) {
                quote = null;
            }
            continue;
        }
        if (ch === '"' || ch === "'" || ch === "`") {
            quote = ch;
            continue;
        }
        if (openers.includes(ch)) {
            depth++;
        } else if (closers.includes(ch)) {
            depth--;
            if (depth === 0) {
                return src.slice(openIdx, i + 1);
            }
        }
    }
    throw new Error("Objeto do patch não balanceado em filtro_pedidos.js");
}

const PATCH_MARKER = "patch(TicketScreen.prototype,";
const markerIdx = source.indexOf(PATCH_MARKER);
assert(markerIdx !== -1, `Não encontrou "${PATCH_MARKER}" em filtro_pedidos.js`);
const objLiteral = extractBalanced(source, source.indexOf("{", markerIdx));

// ── Dependências injetadas (free variables do arquivo) ────────────────────
// `_t` identidade: o contrato importa, não a tradução.
const _t = (s) => s;

// Relógio controlável: "hoje" é sempre o dia em que `agora` aponta. Os testes
// de rollover trocam a data e reconstroem o objeto do patch.
function carregarPatch(agora) {
    const DateTimeFake = { now: () => agora };
    const parseUTCString = (s) => DateTime.fromFormat(s, "yyyy-MM-dd HH:mm:ss", { zone: "utc" });
    // fuzzyLookup do core (@web/core/utils/search): substring case-insensitive
    // sobre o repr de cada pedido, preservando a ordem recebida.
    const fuzzyLookup = (term, orders, repr) => {
        const needle = String(term).toLowerCase();
        return orders.filter((o) => String(repr(o)).toLowerCase().includes(needle));
    };
    class ConnectionLostError extends Error {}
    const obj = new Function(
        "_t",
        "DateTime",
        "parseUTCString",
        "fuzzyLookup",
        "ConnectionLostError",
        "PAGINA",
        "LIMIAR_SCROLL",
        `return (${objLiteral});`
    )(_t, DateTimeFake, parseUTCString, fuzzyLookup, ConnectionLostError, PAGINA, LIMIAR_SCROLL);
    obj.__ConnectionLostError = ConnectionLostError;
    return obj;
}

// ── Mock da base (o que `super` enxerga) ──────────────────────────────────
const DATE_BASE = {
    repr: (order) => order.date_order,
    displayName: "Date",
    modelField: "date_order",
    formatSearch: (searchTerm) => searchTerm,
};

const baseMock = {
    setup() {
        this.__superSetupCalled = true;
        this.state = { filter: null };
    },
    _getSearchFields() {
        return {
            TRACKING_NUMBER: { repr: (o) => o.tracking_number, displayName: "Order Number", modelField: "tracking_number" },
            RECEIPT_NUMBER: { repr: (o) => o.pos_reference, displayName: "Receipt Number", modelField: "pos_reference" },
            DATE: { ...DATE_BASE },
        };
    },
    _computeSyncedOrdersDomain() {
        const { fieldName, searchTerm } = this.state.search;
        if (!searchTerm) {
            return [];
        }
        const field = this._getSearchFields()[fieldName];
        if (field && field.modelField) {
            const term = field.formatSearch ? field.formatSearch(searchTerm) : searchTerm;
            return [[field.modelField, "ilike", `%${term}%`]];
        }
        return [];
    },
    getFilteredOrderList() {
        this.__superOrderListCalled = true;
        return this.__baseOrders;
    },
};

// ── Helpers ───────────────────────────────────────────────────────────────
const formatCurrency = (v) => "R$ " + v.toFixed(2).replace(".", ",");

// 13/11/2026, 10:00 em Manaus (UTC-4) — o "agora" default dos testes.
const AGORA = DateTime.fromISO("2026-11-13T10:00:00", { zone: "America/Manaus" });

function makeOrder(id, methodIds, { total = 10, dateOrder = "2026-11-13 14:30:00", name = "POS/0001" } = {}) {
    return {
        id,
        name,
        // O branch SYNCED do core filtra por finalized && uiState.displayed.
        finalized: true,
        uiState: { displayed: true },
        payment_ids: methodIds.map((mid) => ({ payment_method_id: { id: mid, name: "PM" + mid } })),
        get_total_with_tax: () => total,
        date_order: dateOrder,
    };
}

function makeThis({ activeIds = [], filter = "SYNCED", searchTerm = "", fieldName = "RECEIPT_NUMBER", patchObj } = {}) {
    const obj = patchObj || carregarPatch(AGORA);
    Object.setPrototypeOf(obj, baseMock);
    // `this` precisa enxergar os helpers do próprio patch (janela do dia etc.)
    // e, via patch → baseMock, o `super`. Object.create mantém essa cadeia.
    const ctx = Object.create(obj);
    Object.assign(ctx, {
        state: {
            filter,
            page: 1,
            search: { searchTerm, fieldName },
            activePaymentMethodIds: new Set(activeIds),
        },
        env: { utils: { formatCurrency } },
        pos: {
            models: {
                "pos.payment.method": {
                    getAll: () => [
                        { id: 1, name: "Dinheiro" },
                        { id: 2, name: "Pix" },
                        { id: 3, name: "Cartão" },
                    ],
                },
                "pos.order": {
                    getAll: () => ctx.__baseOrders,
                    // O patch no SYNCED lê a coleção direto (o core fatiaria
                    // por página) — a coleção de teste é a mesma lista.
                    filter: (fn) => ctx.__baseOrders.filter(fn),
                    get: (id) => ctx.__baseOrders.find((o) => o.id === id),
                },
            },
            ticketScreenState: { offsetByDomain: {}, totalCount: 0 },
            config: { id: 1 },
            data: {
                call: async () => ({ ordersInfo: [], totalCount: 0 }),
                read: async () => [],
            },
        },
        __baseOrders: [],
        __modelOrders: [],
        __patch: obj,
    });
    return ctx;
}

// Janela do dia 13/11/2026 em Manaus → UTC.
const INICIO_UTC = "2026-11-13 04:00:00";
const FIM_UTC = "2026-11-14 04:00:00";

// ── Grupo A: _getSearchFields() ───────────────────────────────────────────

// A1: campo AMOUNT adicionado, client-side only (modelField null)
{
    const ctx = makeThis();
    const fields = ctx.__patch._getSearchFields.call(ctx);
    assert(fields.AMOUNT, "AMOUNT deve existir em _getSearchFields()");
    assert.strictEqual(fields.AMOUNT.modelField, null, "AMOUNT.modelField deve ser null (sem query backend)");
    assert.strictEqual(fields.AMOUNT.displayName, "Valor", "AMOUNT.displayName deve ser 'Valor'");
    console.log("✓ A1: AMOUNT adicionado com modelField: null");
}

// A2: repr de AMOUNT usa formatCurrency(get_total_with_tax())
{
    const ctx = makeThis();
    const fields = ctx.__patch._getSearchFields.call(ctx);
    assert.strictEqual(
        fields.AMOUNT.repr(makeOrder(1, [2], { total: 85.5 })),
        "R$ 85,50",
        "AMOUNT.repr deve formatar o total com formatCurrency"
    );
    console.log("✓ A2: AMOUNT.repr formata o total");
}

// A3: DATE mantém modelField/formatSearch (é o que faz a busca por hora
//     chegar ao backend) e ganha o label "Data / Hora"
{
    const ctx = makeThis();
    const fields = ctx.__patch._getSearchFields.call(ctx);
    assert.strictEqual(fields.DATE.displayName, "Data / Hora", "DATE.displayName deve ser 'Data / Hora'");
    assert.strictEqual(fields.DATE.modelField, "date_order", "DATE.modelField deve continuar 'date_order'");
    assert.strictEqual(typeof fields.DATE.formatSearch, "function", "DATE.formatSearch deve ser preservado");
    console.log("✓ A3: DATE vira 'Data / Hora' sem perder modelField/formatSearch");
}

// A4: campos da base são preservados (super é chamado, não substituído)
{
    const ctx = makeThis();
    const fields = ctx.__patch._getSearchFields.call(ctx);
    assert.strictEqual(fields.TRACKING_NUMBER.modelField, "tracking_number", "TRACKING_NUMBER intacto");
    assert.strictEqual(fields.RECEIPT_NUMBER.modelField, "pos_reference", "RECEIPT_NUMBER intacto");
    console.log("✓ A4: campos da base preservados");
}

// A5: AMOUNT entra por último — o SearchBar usa a ordem de inserção
{
    const ctx = makeThis();
    const fields = ctx.__patch._getSearchFields.call(ctx);
    const keys = Object.keys(fields);
    assert.strictEqual(keys[keys.length - 1], "AMOUNT", "AMOUNT deve ser a última chave");
    console.log("✓ A5: AMOUNT é a última chave do dropdown");
}

// ── Grupo B: getAvailablePaymentMethods() ─────────────────────────────────
{
    const ctx = makeThis();
    const methods = ctx.__patch.getAvailablePaymentMethods.call(ctx);
    assert.deepStrictEqual(
        methods.map((m) => m.name),
        ["Dinheiro", "Pix", "Cartão"],
        "getAvailablePaymentMethods deve refletir pos.models['pos.payment.method'].getAll()"
    );
    console.log("✓ B1: getAvailablePaymentMethods retorna os métodos da sessão");
}

// ── Grupo C: onTogglePaymentChip() ────────────────────────────────────────
{
    const ctx = makeThis();
    ctx.__patch.onTogglePaymentChip.call(ctx, 2);
    assert(ctx.state.activePaymentMethodIds.has(2), "chip ausente deve ser adicionado");
    console.log("✓ C1: toggle adiciona chip");
}
{
    const ctx = makeThis({ activeIds: [2] });
    ctx.__patch.onTogglePaymentChip.call(ctx, 2);
    assert(!ctx.state.activePaymentMethodIds.has(2), "chip presente deve ser removido");
    console.log("✓ C2: toggle remove chip ativo");
}

// ── Grupo D: getFilteredOrderList() — chips + janela do dia ───────────────
{
    const ctx = makeThis();
    ctx.__baseOrders = [makeOrder(1, [1]), makeOrder(2, [2])];
    const result = ctx.__patch.getFilteredOrderList.call(ctx);
    assert.deepStrictEqual(result.map((o) => o.id), [1, 2], "mesmo date_order/nome → ordem estável do cache");
    assert(!ctx.__superOrderListCalled, "no SYNCED o slice de página do core é substituído");
    console.log("✓ D1: SYNCED compõe a lista sem o slice do core");
}
{
    const ctx = makeThis({ activeIds: [2] });
    ctx.__baseOrders = [makeOrder(1, [1]), makeOrder(2, [2]), makeOrder(3, [3])];
    const result = ctx.__patch.getFilteredOrderList.call(ctx);
    assert.deepStrictEqual(result.map((o) => o.id), [2], "só o pedido com Pix deve sobrar");
    console.log("✓ D2: chip Pix filtra a lista");
}
{
    const mixed = makeOrder(9, [1, 2]);
    for (const chip of [1, 2]) {
        const ctx = makeThis({ activeIds: [chip] });
        ctx.__baseOrders = [mixed, makeOrder(3, [3])];
        const result = ctx.__patch.getFilteredOrderList.call(ctx);
        assert.deepStrictEqual(result.map((o) => o.id), [9], `pedido misto deve aparecer no chip ${chip}`);
    }
    console.log("✓ D3: pedido misto aparece em ambos os chips");
}
{
    const ctx = makeThis({ activeIds: [1, 3] });
    ctx.__baseOrders = [makeOrder(1, [1]), makeOrder(2, [2]), makeOrder(3, [3])];
    const result = ctx.__patch.getFilteredOrderList.call(ctx);
    assert.deepStrictEqual(result.map((o) => o.id), [1, 3], "dois chips = união");
    console.log("✓ D4: dois chips → união (OR)");
}
{
    const ctx = makeThis({ activeIds: [2] });
    ctx.__baseOrders = [makeOrder(1, []), makeOrder(2, [2])];
    const result = ctx.__patch.getFilteredOrderList.call(ctx);
    assert.deepStrictEqual(result.map((o) => o.id), [2], "pedido sem pagamento não deve passar");
    console.log("✓ D5: pedido sem payment_ids é excluído");
}
{
    const ctx = makeThis({ activeIds: [2], filter: "ACTIVE_ORDERS" });
    ctx.__baseOrders = [makeOrder(1, [1]), makeOrder(2, [2])];
    const result = ctx.__patch.getFilteredOrderList.call(ctx);
    assert.deepStrictEqual(result.map((o) => o.id), [1, 2], "fora de SYNCED não deve filtrar");
    console.log("✓ D6: filtro de chips só vale no tab Pago (SYNCED)");
}
{
    const ctx = makeThis({ activeIds: [2] });
    ctx.__baseOrders = [makeOrder(2, [2]), makeOrder(5, [1])];
    const result = ctx.__patch.getFilteredOrderList.call(ctx);
    assert.deepStrictEqual(result.map((o) => o.id), [2], "AND entre super e chips");
    console.log("✓ D7: AND entre filtro de chips e filtros do super");
}

// D8: pedido de OUTRO dia que veio do cache (super devolveu) não aparece.
//     date_order é UTC e o dia é o local (Manaus, UTC-4): 03:00 UTC de 13/11
//     ainda é 12/11 23:00 no caixa → fora.
{
    const ctx = makeThis();
    ctx.__baseOrders = [
        makeOrder(1, [1], { dateOrder: "2026-11-13 03:59:59" }), // 12/11 23:59 local
        makeOrder(2, [1], { dateOrder: "2026-11-13 04:00:00" }), // 13/11 00:00 local
        makeOrder(3, [1], { dateOrder: "2026-11-14 03:59:59" }), // 13/11 23:59 local
        makeOrder(4, [1], { dateOrder: "2026-11-14 04:00:00" }), // 14/11 00:00 local
    ];
    const result = ctx.__patch.getFilteredOrderList.call(ctx);
    // desc: a venda mais recente do dia (id 3) primeiro.
    assert.deepStrictEqual(result.map((o) => o.id), [3, 2], "só o dia corrido local (00:00–23:59) aparece");
    console.log("✓ D8: lista exibe só vendas do dia local");
}

// D9: fora do SYNCED a janela do dia NÃO é aplicada (demais tabs intactos)
{
    const ctx = makeThis({ filter: "ACTIVE_ORDERS" });
    ctx.__baseOrders = [makeOrder(1, [1], { dateOrder: "2026-11-10 14:00:00" })];
    const result = ctx.__patch.getFilteredOrderList.call(ctx);
    assert.deepStrictEqual(result.map((o) => o.id), [1], "outros tabs mantêm a lista do core");
    console.log("✓ D9: janela do dia só no tab Pago (SYNCED)");
}

// ── Grupo E: _computeSyncedOrdersDomain() — janela do dia ──────────────────
{
    const ctx = makeThis();
    const domain = ctx.__patch._computeSyncedOrdersDomain.call(ctx);
    assert.deepStrictEqual(
        domain,
        [
            ["date_order", ">=", INICIO_UTC],
            ["date_order", "<", FIM_UTC],
        ],
        "sem termo de busca o domain deve ser só a janela do dia em UTC"
    );
    console.log("✓ E1: domain sem busca = janela do dia local→UTC");
}

// E2: busca por recibo/data-hora (campo com modelField) mantém o ilike E a janela
{
    const ctx = makeThis({ searchTerm: "2026-11-13", fieldName: "DATE" });
    const domain = ctx.__patch._computeSyncedOrdersDomain.call(ctx);
    assert.deepStrictEqual(
        domain,
        [
            ["date_order", "ilike", "%2026-11-13%"],
            ["date_order", ">=", INICIO_UTC],
            ["date_order", "<", FIM_UTC],
        ],
        "busca por data/hora preserva o ilike do core e restringe ao dia"
    );
    console.log("✓ E2: busca por data/hora continua restrita ao dia");
}

// E3: busca por recibo (pos_reference) + janela
{
    const ctx = makeThis({ searchTerm: "POS/0007", fieldName: "RECEIPT_NUMBER" });
    const domain = ctx.__patch._computeSyncedOrdersDomain.call(ctx);
    assert.deepStrictEqual(domain, [
        ["pos_reference", "ilike", "%POS/0007%"],
        ["date_order", ">=", INICIO_UTC],
        ["date_order", "<", FIM_UTC],
    ]);
    console.log("✓ E3: busca por recibo continua restrita ao dia");
}

// E4: busca por VALOR (AMOUNT, modelField null) não gera query — só a janela
{
    const ctx = makeThis({ searchTerm: "85,50", fieldName: "AMOUNT" });
    const domain = ctx.__patch._computeSyncedOrdersDomain.call(ctx);
    assert.deepStrictEqual(domain, [
        ["date_order", ">=", INICIO_UTC],
        ["date_order", "<", FIM_UTC],
    ]);
    console.log("✓ E4: busca por valor é client-side (só a janela vai ao backend)");
}

// E5: busca por portador do cartão (CARDHOLDER_NAME) + janela
{
    const ctx = makeThis({ searchTerm: "JOAO", fieldName: "CARDHOLDER_NAME" });
    // o mock da base não tem o campo; injeta o do core (payment_ids.cardholder_name)
    const original = ctx.__patch._getSearchFields;
    ctx.__patch._getSearchFields = function () {
        const fields = original.call(this);
        fields.CARDHOLDER_NAME = {
            repr: (o) => o.cardholder_name,
            displayName: "Cardholder Name",
            modelField: "payment_ids.cardholder_name",
        };
        return fields;
    };
    const domain = ctx.__patch._computeSyncedOrdersDomain.call(ctx);
    ctx.__patch._getSearchFields = original;
    assert.deepStrictEqual(domain, [
        ["payment_ids.cardholder_name", "ilike", "%JOAO%"],
        ["date_order", ">=", INICIO_UTC],
        ["date_order", "<", FIM_UTC],
    ]);
    console.log("✓ E5: busca por portador continua restrita ao dia");
}

// E6: fora do SYNCED o domain não ganha janela (chamado só no SYNCED, mas a
//     guarda evita efeito colateral se algum outro fluxo chamar)
{
    const ctx = makeThis({ filter: "ACTIVE_ORDERS" });
    const domain = ctx.__patch._computeSyncedOrdersDomain.call(ctx);
    assert.deepStrictEqual(domain, []);
    console.log("✓ E6: janela só no tab Pago");
}

// ── Grupo F: rollover de meia-noite (DEC-001) ─────────────────────────────
{
    const amanha = DateTime.fromISO("2026-11-14T00:05:00", { zone: "America/Manaus" });
    const patchAmanha = carregarPatch(amanha);
    const ctx = makeThis({ patchObj: patchAmanha });
    ctx.__baseOrders = [
        makeOrder(1, [1], { dateOrder: "2026-11-13 14:00:00" }), // ontem
        makeOrder(2, [1], { dateOrder: "2026-11-14 04:30:00" }), // hoje 00:30 local
    ];
    const result = patchAmanha.getFilteredOrderList.call(ctx);
    assert.deepStrictEqual(result.map((o) => o.id), [2], "virada do dia: pedidos de ontem somem");

    const domain = patchAmanha._computeSyncedOrdersDomain.call(ctx);
    assert.strictEqual(domain[0][2], "2026-11-14 04:00:00", "início da janela vira para o dia novo");
    assert.strictEqual(domain[1][2], "2026-11-15 04:00:00", "fim da janela vira para o dia novo");
    console.log("✓ F1: rollover recalcula a janela e some com ontem");
}

// F2: a chave do domain (offsetByDomain) muda na virada — offset reinicia
{
    const hoje = carregarPatch(AGORA);
    const amanha = carregarPatch(DateTime.fromISO("2026-11-14T00:05:00", { zone: "America/Manaus" }));
    const ctxHoje = makeThis({ patchObj: hoje });
    const ctxAmanha = makeThis({ patchObj: amanha });
    const chaveHoje = JSON.stringify(hoje._computeSyncedOrdersDomain.call(ctxHoje));
    const chaveAmanha = JSON.stringify(amanha._computeSyncedOrdersDomain.call(ctxAmanha));
    assert.notStrictEqual(chaveHoje, chaveAmanha, "a chave do domínio precisa mudar na virada do dia");
    console.log("✓ F2: chave do domínio muda na virada (offset reinicia)");
}

// ── Grupo G: setup() ──────────────────────────────────────────────────────
{
    const ctx = makeThis();
    ctx.__patch.setup.call(ctx);
    assert(ctx.__superSetupCalled, "setup() deve chamar super.setup()");
    assert(ctx.state.activePaymentMethodIds instanceof Set, "activePaymentMethodIds deve ser um Set");
    assert.strictEqual(ctx.state.activePaymentMethodIds.size, 0, "Set deve começar vazio");
    assert.strictEqual(ctx._pagoCarregando, false, "flag de fetch começa limpa");
    assert.strictEqual(ctx._pagoDominioEsgotado, null, "nenhum domínio esgotado no início");
    console.log("✓ G1: setup() inicializa chips e controle do scroll");
}

// ── Helpers do scroll ─────────────────────────────────────────────────────
/** N pedidos do dia 13/11 (12:00..12:59), com name/date únicos. */
function pedidosDoDia(qtd) {
    return Array.from({ length: qtd }, (_, i) =>
        makeOrder(i + 1, [1], {
            dateOrder: `2026-11-13 12:${String(i).padStart(2, "0")}:00`,
            name: `POS/${String(i + 1).padStart(4, "0")}`,
        })
    );
}

/** "Perto do fim": scrollTop + clientHeight >= scrollHeight - 300. */
const PERTO_DO_FIM = { target: { scrollTop: 700, clientHeight: 300, scrollHeight: 1000 } };
const LONGE_DO_FIM = { target: { scrollTop: 0, clientHeight: 300, scrollHeight: 2000 } };

/** pos.data.call que devolve a página pedida da lista fake. */
function comFetch(ctx) {
    ctx.__chamadas = [];
    ctx.pos.data.call = async (modelo, metodo, args, kwargs) => {
        ctx.__chamadas.push({ modelo, metodo, kwargs });
        const inicio = kwargs.offset;
        const pagina = ctx.__baseOrders.slice(inicio, inicio + kwargs.limit);
        return {
            ordersInfo: pagina.map((o) => [o.id, o.date_order]),
            totalCount: ctx.__baseOrders.length,
        };
    };
    ctx.pos.data.read = async () => [];
    return ctx;
}

// ── Grupo H: corte incremental (DEC-005) ──────────────────────────────────
{
    const ctx = makeThis();
    ctx.__baseOrders = pedidosDoDia(45);
    assert.strictEqual(
        ctx.__patch.getFilteredOrderList.call(ctx).length,
        30,
        "primeiro bloco = 30 (não a lista inteira)"
    );
    ctx.state.page = 2;
    assert.strictEqual(
        ctx.__patch.getFilteredOrderList.call(ctx).length,
        45,
        "segundo bloco = +30 (45 no total)"
    );
    ctx.state.page = 3;
    assert.strictEqual(
        ctx.__patch.getFilteredOrderList.call(ctx).length,
        45,
        "não passa do total do domínio"
    );
    console.log("✓ H1: lista cresce em blocos de 30, sem passar do total");
}

// ── Grupo I: scroll e fetch (DEC-004/DEC-005) ─────────────────────────────
(async () => {
    // I1: primeiro fetch (offset 0, limit 30, domain com a janela do dia) e
    //     scroll perto do fim busca o próximo bloco
    {
        const ctx = comFetch(makeThis());
        ctx.__baseOrders = pedidosDoDia(45);

        await ctx.__patch._fetchSyncedOrders.call(ctx);
        assert.strictEqual(ctx.__chamadas.length, 1, "primeiro fetch");
        const primeira = ctx.__chamadas[0].kwargs;
        assert.strictEqual(primeira.limit, 30, "fetch do core: 30 por vez");
        assert.strictEqual(primeira.offset, 0, "primeiro offset é 0");
        assert.deepStrictEqual(
            primeira.domain,
            ctx.__patch._computeSyncedOrdersDomain.call(ctx),
            "o fetch usa o domain com a janela do dia"
        );
        assert.strictEqual(ctx.state.page, 1, "primeiro bloco visível");

        await ctx.__patch.onPagoScroll.call(ctx, PERTO_DO_FIM);
        assert.strictEqual(ctx.__chamadas.length, 2, "scroll perto do fim busca mais 30");
        assert.strictEqual(ctx.__chamadas[1].kwargs.offset, 30, "offset avança em 30");
        assert.strictEqual(ctx.state.page, 2, "a lista cresce um bloco");
        assert.strictEqual(ctx.__patch.getFilteredOrderList.call(ctx).length, 45);
        console.log("✓ I1: scroll infinito busca +30 e a lista cresce");
    }

    // I2: longe do fim não busca
    {
        const ctx = comFetch(makeThis());
        ctx.__baseOrders = pedidosDoDia(45);
        await ctx.__patch._fetchSyncedOrders.call(ctx);
        await ctx.__patch.onPagoScroll.call(ctx, LONGE_DO_FIM);
        assert.strictEqual(ctx.__chamadas.length, 1, "longe do fim não busca");
        console.log("✓ I2: fetch só perto do fim");
    }

    // I3: já há fetch em andamento → não dispara outro
    {
        const ctx = comFetch(makeThis());
        ctx.__baseOrders = pedidosDoDia(45);
        ctx._pagoCarregando = true;
        await ctx.__patch.onPagoScroll.call(ctx, PERTO_DO_FIM);
        assert.strictEqual(ctx.__chamadas.length, 0, "não duplica fetch concorrente");
        ctx._pagoCarregando = false;
        console.log("✓ I3: guarda de fetch concorrente");
    }

    // I4: domínio já esgotado → não busca de novo
    {
        const ctx = comFetch(makeThis());
        ctx.__baseOrders = pedidosDoDia(3);
        await ctx.__patch._fetchSyncedOrders.call(ctx);
        assert.strictEqual(ctx._pagoDominioEsgotado, JSON.stringify(ctx.__patch._computeSyncedOrdersDomain.call(ctx)));
        await ctx.__patch.onPagoScroll.call(ctx, PERTO_DO_FIM);
        assert.strictEqual(ctx.__chamadas.length, 1, "total alcançado → para de buscar");
        console.log("✓ I4: para quando o total do domínio foi alcançado");
    }

    // I5: offline (ConnectionLostError) → para quieto no cache, sem erro
    {
        const ctx = comFetch(makeThis());
        ctx.__baseOrders = pedidosDoDia(45);
        await ctx.__patch._fetchSyncedOrders.call(ctx);
        const offsetAntes = JSON.stringify(ctx.pos.ticketScreenState.offsetByDomain);
        const paginaAntes = ctx.state.page;

        ctx.pos.data.call = async () => {
            throw new ctx.__patch.__ConnectionLostError("sem rede");
        };
        await assert.doesNotReject(
            ctx.__patch.onPagoScroll.call(ctx, PERTO_DO_FIM),
            "perda de conexão não pode virar erro na tela"
        );
        assert.strictEqual(ctx._pagoCarregando, false, "flag de loading limpa");
        assert.strictEqual(JSON.stringify(ctx.pos.ticketScreenState.offsetByDomain), offsetAntes, "offset não avança offline");
        assert.strictEqual(ctx.state.page, paginaAntes, "lista fica estável");
        assert.strictEqual(ctx.__patch.getFilteredOrderList.call(ctx).length, 30, "mostra o que já estava carregado");
        console.log("✓ I5: offline para silenciosamente, lista estável");
    }

    // I6: erro que NÃO é de conexão continua visível (não engolimos bug)
    {
        const ctx = comFetch(makeThis());
        ctx.pos.data.call = async () => {
            throw new Error("boom");
        };
        await assert.rejects(
            ctx.__patch._fetchSyncedOrders.call(ctx),
            /boom/,
            "erro real não pode ser silenciado"
        );
        console.log("✓ I6: erro não-offline propaga");
    }

    // I7: fora do SYNCED o scroll não busca nada
    {
        const ctx = comFetch(makeThis({ filter: "ACTIVE_ORDERS" }));
        ctx.__baseOrders = pedidosDoDia(45);
        await ctx.__patch.onPagoScroll.call(ctx, PERTO_DO_FIM);
        assert.strictEqual(ctx.__chamadas.length, 0, "scroll só vale no tab Pago");
        console.log("✓ I7: scroll sem efeito nos demais tabs");
    }

    // I8: a leitura de pedidos fora do cache acontece ANTES do offset avançar
    {
        const ctx = comFetch(makeThis());
        ctx.__baseOrders = []; // nada em cache
        ctx.pos.data.call = async () => ({
            ordersInfo: [[777, "2026-11-13 12:00:00"]],
            totalCount: 1,
        });
        let lidos = null;
        ctx.pos.data.read = async (modelo, ids) => {
            lidos = ids;
            return [];
        };
        await ctx.__patch._fetchSyncedOrders.call(ctx);
        assert.deepStrictEqual(lidos, [777], "pedido novo é lido do servidor");
        console.log("✓ I8: pedidos fora do cache são lidos");
    }

    console.log("\nTodos os testes passaram ✓");
})().catch((error) => {
    console.error(error);
    process.exit(1);
});
