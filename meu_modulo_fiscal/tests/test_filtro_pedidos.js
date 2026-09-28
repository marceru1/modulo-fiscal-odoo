/**
 * Teste unitário (Node puro, sem Odoo) da feature filtro-pedidos-pagos-pos:
 * filtros client-side na TicketScreen do POS — chips de tipo de pagamento,
 * search field "Valor" e label "Data / Hora".
 *
 * O Odoo não roda localmente, então este teste:
 *   1. Lê static/src/js/filtro_pedidos.js e extrai o objeto literal passado a
 *      patch(TicketScreen.prototype, {...}).
 *   2. Monta esse objeto com um protótipo mockado que faz o papel de `super`
 *      (Object.setPrototypeOf) — assim `super._getSearchFields()` e
 *      `super.getFilteredOrderList()` resolvem para os mocks da base.
 *   3. Executa os métodos com um `this` mockado e valida o contrato da spec.
 *
 * Seams da spec: getFilteredOrderList() (comportamento observável na lista
 * renderizada) e _getSearchFields() (dropdown do SearchBar).
 *
 * Rodar: node meu_modulo_fiscal/tests/test_filtro_pedidos.js
 */
const fs = require("fs");
const path = require("path");
const assert = require("assert");

const JS_PATH = path.join(__dirname, "..", "static", "src", "js", "filtro_pedidos.js");
const source = fs.readFileSync(JS_PATH, "utf8");

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

// `_t` é free variable no arquivo (vem de @web/core/l10n/translation).
// Injetamos uma identidade — o que importa é o contrato, não a tradução.
const _t = (s) => s;
const patchObj = new Function("_t", `return (${objLiteral});`)(_t);

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
    getFilteredOrderList() {
        this.__superOrderListCalled = true;
        return this.__baseOrders;
    },
};
Object.setPrototypeOf(patchObj, baseMock);

// ── Helpers ───────────────────────────────────────────────────────────────
const formatCurrency = (v) => "R$ " + v.toFixed(2).replace(".", ",");

function makeOrder(id, methodIds, total = 10) {
    return {
        id,
        payment_ids: methodIds.map((mid) => ({ payment_method_id: { id: mid, name: "PM" + mid } })),
        get_total_with_tax: () => total,
        date_order: "2026-09-28 14:30:00",
    };
}

function makeThis({ activeIds = [], filter = "SYNCED" } = {}) {
    const ctx = {
        state: { filter, activePaymentMethodIds: new Set(activeIds) },
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
            },
        },
        __baseOrders: [],
    };
    return ctx;
}

// ── Grupo A: _getSearchFields() ───────────────────────────────────────────

// A1: campo AMOUNT adicionado, client-side only (modelField null)
{
    const ctx = makeThis();
    const fields = patchObj._getSearchFields.call(ctx);
    assert(fields.AMOUNT, "AMOUNT deve existir em _getSearchFields()");
    assert.strictEqual(fields.AMOUNT.modelField, null, "AMOUNT.modelField deve ser null (sem query backend)");
    assert.strictEqual(fields.AMOUNT.displayName, "Valor", "AMOUNT.displayName deve ser 'Valor'");
    console.log("✓ A1: AMOUNT adicionado com modelField: null");
}

// A2: repr de AMOUNT usa formatCurrency(get_total_with_tax())
{
    const ctx = makeThis();
    const fields = patchObj._getSearchFields.call(ctx);
    assert.strictEqual(
        fields.AMOUNT.repr(makeOrder(1, [2], 85.5)),
        "R$ 85,50",
        "AMOUNT.repr deve formatar o total com formatCurrency"
    );
    console.log("✓ A2: AMOUNT.repr formata o total");
}

// A3: DATE mantém modelField/formatSearch (é o que faz a busca por hora
//     chegar ao backend) e ganha o label "Data / Hora"
{
    const ctx = makeThis();
    const fields = patchObj._getSearchFields.call(ctx);
    assert.strictEqual(fields.DATE.displayName, "Data / Hora", "DATE.displayName deve ser 'Data / Hora'");
    assert.strictEqual(fields.DATE.modelField, "date_order", "DATE.modelField deve continuar 'date_order'");
    assert.strictEqual(typeof fields.DATE.formatSearch, "function", "DATE.formatSearch deve ser preservado");
    console.log("✓ A3: DATE vira 'Data / Hora' sem perder modelField/formatSearch");
}

// A4: campos da base são preservados (super é chamado, não substituído)
{
    const ctx = makeThis();
    const fields = patchObj._getSearchFields.call(ctx);
    for (const key of ["TRACKING_NUMBER", "RECEIPT_NUMBER", "DATE", "PARTNER"]) {
        if (key === "PARTNER") continue; // não está no mock da base
        assert(fields[key], `${key} deve ser preservado de super._getSearchFields()`);
    }
    assert.strictEqual(fields.TRACKING_NUMBER.modelField, "tracking_number", "TRACKING_NUMBER intacto");
    console.log("✓ A4: campos da base preservados");
}

// A5: AMOUNT entra por último — o SearchBar usa a ordem de inserção
//     (searchFieldsList = [...config.searchFields.keys()])
{
    const ctx = makeThis();
    const fields = patchObj._getSearchFields.call(ctx);
    const keys = Object.keys(fields);
    assert.strictEqual(keys[keys.length - 1], "AMOUNT", "AMOUNT deve ser a última chave");
    console.log("✓ A5: AMOUNT é a última chave do dropdown");
}

// ── Grupo B: getAvailablePaymentMethods() ─────────────────────────────────
{
    const ctx = makeThis();
    const methods = patchObj.getAvailablePaymentMethods.call(ctx);
    assert.deepStrictEqual(
        methods.map((m) => m.name),
        ["Dinheiro", "Pix", "Cartão"],
        "getAvailablePaymentMethods deve refletir pos.models['pos.payment.method'].getAll()"
    );
    console.log("✓ B1: getAvailablePaymentMethods retorna os métodos da sessão");
}

// ── Grupo C: onTogglePaymentChip() ────────────────────────────────────────

// C1: adiciona quando ausente
{
    const ctx = makeThis();
    patchObj.onTogglePaymentChip.call(ctx, 2);
    assert(ctx.state.activePaymentMethodIds.has(2), "chip ausente deve ser adicionado");
    console.log("✓ C1: toggle adiciona chip");
}

// C2: remove quando presente (toggle)
{
    const ctx = makeThis({ activeIds: [2] });
    patchObj.onTogglePaymentChip.call(ctx, 2);
    assert(!ctx.state.activePaymentMethodIds.has(2), "chip presente deve ser removido");
    console.log("✓ C2: toggle remove chip ativo");
}

// ── Grupo D: getFilteredOrderList() ───────────────────────────────────────

// D1: sem chip selecionado → passthrough do super
{
    const ctx = makeThis();
    ctx.__baseOrders = [makeOrder(1, [1]), makeOrder(2, [2])];
    const result = patchObj.getFilteredOrderList.call(ctx);
    assert.deepStrictEqual(result.map((o) => o.id), [1, 2], "sem chip não deve filtrar");
    assert(ctx.__superOrderListCalled, "super.getFilteredOrderList() deve ser chamado");
    console.log("✓ D1: sem chip → passthrough (super chamado)");
}

// D2: chip ativo filtra por payment_method_id
{
    const ctx = makeThis({ activeIds: [2] });
    ctx.__baseOrders = [makeOrder(1, [1]), makeOrder(2, [2]), makeOrder(3, [3])];
    const result = patchObj.getFilteredOrderList.call(ctx);
    assert.deepStrictEqual(result.map((o) => o.id), [2], "só o pedido com Pix deve sobrar");
    console.log("✓ D2: chip Pix filtra a lista");
}

// D3: pedido misto (Pix+Dinheiro) aparece nos DOIS chips (OR dentro do campo)
{
    const mixed = makeOrder(9, [1, 2]);
    for (const chip of [1, 2]) {
        const ctx = makeThis({ activeIds: [chip] });
        ctx.__baseOrders = [mixed, makeOrder(3, [3])];
        const result = patchObj.getFilteredOrderList.call(ctx);
        assert.deepStrictEqual(
            result.map((o) => o.id),
            [9],
            `pedido misto deve aparecer no chip ${chip}`
        );
    }
    console.log("✓ D3: pedido misto aparece em ambos os chips");
}

// D4: múltiplos chips na mesma busca continuam OR (não viram AND)
{
    const ctx = makeThis({ activeIds: [1, 3] });
    ctx.__baseOrders = [makeOrder(1, [1]), makeOrder(2, [2]), makeOrder(3, [3])];
    const result = patchObj.getFilteredOrderList.call(ctx);
    assert.deepStrictEqual(result.map((o) => o.id), [1, 3], "dois chips = união");
    console.log("✓ D4: dois chips → união (OR)");
}

// D5: pedido sem payment_ids é excluído quando há chip ativo
{
    const ctx = makeThis({ activeIds: [2] });
    ctx.__baseOrders = [makeOrder(1, []), makeOrder(2, [2])];
    const result = patchObj.getFilteredOrderList.call(ctx);
    assert.deepStrictEqual(result.map((o) => o.id), [2], "pedido sem pagamento não deve passar");
    console.log("✓ D5: pedido sem payment_ids é excluído");
}

// D6: fora do tab "Pago" (filter !== SYNCED) o filtro NÃO se aplica —
//     os chips ficam invisíveis ali, então um filtro ativo seria um filtro
//     fantasma sem indicação visual para o operador.
{
    const ctx = makeThis({ activeIds: [2], filter: "ACTIVE_ORDERS" });
    ctx.__baseOrders = [makeOrder(1, [1]), makeOrder(2, [2])];
    const result = patchObj.getFilteredOrderList.call(ctx);
    assert.deepStrictEqual(result.map((o) => o.id), [1, 2], "fora de SYNCED não deve filtrar");
    console.log("✓ D6: filtro de chips só vale no tab Pago (SYNCED)");
}

// D7: filtro de chips preserva o resultado combinado do super (AND com
//     os outros filtros — valor, hora, recibo), não o substitui
{
    const ctx = makeThis({ activeIds: [2] });
    // simula o super já tendo aplicado fuzzyLookup + paginação
    ctx.__baseOrders = [makeOrder(2, [2]), makeOrder(5, [1])];
    const result = patchObj.getFilteredOrderList.call(ctx);
    assert.deepStrictEqual(result.map((o) => o.id), [2], "AND entre super e chips");
    console.log("✓ D7: AND entre filtro de chips e filtros do super");
}

// ── Grupo E: setup() ──────────────────────────────────────────────────────
{
    const ctx = makeThis();
    patchObj.setup.call(ctx);
    assert(ctx.__superSetupCalled, "setup() deve chamar super.setup()");
    assert(ctx.state.activePaymentMethodIds instanceof Set, "activePaymentMethodIds deve ser um Set");
    assert.strictEqual(ctx.state.activePaymentMethodIds.size, 0, "Set deve começar vazio");
    console.log("✓ E1: setup() inicializa activePaymentMethodIds vazio");
}

console.log("\nTodos os testes passaram ✓");
