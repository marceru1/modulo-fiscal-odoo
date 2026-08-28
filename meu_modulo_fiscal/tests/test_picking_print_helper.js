/**
 * Teste unitário (Node puro, sem Odoo) da feature
 * impressao-transferencia-interna: interceptar o delivery slip
 * (stock.report_deliveryslip) e abrir print dialog em vez de download.
 *
 * O Odoo não roda localmente, então este teste:
 *   1. Extrai o corpo do handler registrado em "ir.actions.report handlers"
 *      e o corpo de _openPickingPrintDialog de picking_print_helper.js.
 *   2. Executa com mocks de action/env/window — valida o contrato:
 *        - Não-delivery-slip → fall through (undefined)
 *        - Delivery slip outgoing → fall through (undefined)
 *        - Delivery slip internal/incoming → print dialog (true)
 *        - RPC falha → fall through (undefined)
 *        - Popup bloqueado → notificação + true
 *
 * Seam da spec: registry "ir.actions.report handlers" (API real do T01).
 *
 * Rodar: node meu_modulo_fiscal/tests/test_picking_print_helper.js
 */
const fs = require("fs");
const path = require("path");
const assert = require("assert");

const MODULE_ROOT = path.join(__dirname, "..");
const JS_PATH = path.join(MODULE_ROOT, "static", "src", "js", "picking_print_helper.js");
const source = fs.readFileSync(JS_PATH, "utf8");

// ── Extração por casamento de chaves (mais robusto que regex) ──────────────
function extractBodyAfter(marker) {
    const start = source.indexOf(marker);
    assert(start !== -1, `Marcador não encontrado: ${marker}`);
    const bodyStart = start + marker.length;
    let depth = 1;
    let i = bodyStart;
    while (i < source.length && depth > 0) {
        if (source[i] === "{") depth++;
        else if (source[i] === "}") depth--;
        i++;
    }
    assert(depth === 0, `Chaves não balanceadas após: ${marker}`);
    return source.slice(bodyStart, i - 1); // sem o `}` final
}

const HANDLER_MARKER = "async (action, options, env) => {";
const handlerBody = extractBodyAfter(HANDLER_MARKER);

const OPEN_MARKER = "async function _openPickingPrintDialog(action, env) {";
const openBody = extractBodyAfter(OPEN_MARKER);

// ── Mocks ────────────────────────────────────────────────────────────────────
const DELIVERY_SLIP_REPORT_NAME = "stock.report_deliveryslip";
const PRINT_TYPES = new Set(["internal", "incoming"]);

function makeEnv({ records, readError, notificationCalls }) {
    return {
        services: {
            user: { context: { lang: "pt_BR" } },
            orm: {
                read: async (model, ids, fields) => {
                    if (readError) throw readError;
                    return records;
                },
            },
            notification: {
                add: (msg, opts) => notificationCalls.push({ msg, opts }),
            },
        },
        _t: (s) => s,
    };
}

// handler: injeta as consts do módulo + mock de _openPickingPrintDialog
function buildHandler(openPrintDialogMock) {
    return new Function(
        "DELIVERY_SLIP_REPORT_NAME",
        "PRINT_TYPES",
        "_openPickingPrintDialog",
        `return async function(action, options, env) { ${handlerBody} }`
    )(DELIVERY_SLIP_REPORT_NAME, PRINT_TYPES, openPrintDialogMock);
}

// _openPickingPrintDialog: injeta getReportUrl + window
function buildOpenPrintDialog({ getReportUrl, window }) {
    return new Function(
        "getReportUrl",
        "window",
        `return async function(action, env) { ${openBody} }`
    )(getReportUrl, window);
}

// ── Caso 1: report não é o delivery slip → fall through ─────────────────────
async function main() {
{
    const openMock = () => {
        throw new Error("Não deveria abrir print dialog");
    };
    const handler = buildHandler(openMock);
    const env = makeEnv({ records: [] });

    const result = await handler(
        { report_name: "stock.report_picking", report_type: "qweb-pdf", context: { active_ids: [1] } },
        {},
        env
    );

    assert.strictEqual(result, undefined, "Report não-delivery deve cair no default");
    console.log("✓ Caso 1: report não-delivery → fall through");
}

// ── Caso 2: delivery slip sem active_ids → fall through ────────────────────
{
    const openMock = () => {
        throw new Error("Não deveria abrir print dialog");
    };
    const handler = buildHandler(openMock);
    const env = makeEnv({ records: [] });

    const result = await handler(
        { report_name: DELIVERY_SLIP_REPORT_NAME, report_type: "qweb-pdf", context: {} },
        {},
        env
    );

    assert.strictEqual(result, undefined, "Sem active_ids deve cair no default");
    console.log("✓ Caso 2: delivery slip sem active_ids → fall through");
}

// ── Caso 3: delivery slip outgoing → fall through (T3) ─────────────────────
{
    const openMock = () => {
        throw new Error("Outgoing não pode abrir print dialog");
    };
    const handler = buildHandler(openMock);
    const env = makeEnv({ records: [{ id: 1, picking_type_code: "outgoing" }] });

    const result = await handler(
        { report_name: DELIVERY_SLIP_REPORT_NAME, report_type: "qweb-pdf", context: { active_ids: [1] } },
        {},
        env
    );

    assert.strictEqual(result, undefined, "Outgoing deve cair no default (download)");
    console.log("✓ Caso 3: delivery slip outgoing → fall through (T3)");
}

// ── Caso 4: delivery slip internal → print dialog (T1) ─────────────────────
{
    let opened = false;
    const openMock = async (action, env) => {
        opened = true;
        return true;
    };
    const handler = buildHandler(openMock);
    const env = makeEnv({ records: [{ id: 1, picking_type_code: "internal" }] });

    const result = await handler(
        { report_name: DELIVERY_SLIP_REPORT_NAME, report_type: "qweb-pdf", context: { active_ids: [1] } },
        {},
        env
    );

    assert.strictEqual(result, true, "Internal deve interceptar (true)");
    assert.strictEqual(opened, true, "Print dialog deve ser aberto");
    console.log("✓ Caso 4: delivery slip internal → print dialog (T1)");
}

// ── Caso 5: delivery slip incoming → print dialog (T2) ─────────────────────
{
    let opened = false;
    const openMock = async (action, env) => {
        opened = true;
        return true;
    };
    const handler = buildHandler(openMock);
    const env = makeEnv({ records: [{ id: 1, picking_type_code: "incoming" }] });

    const result = await handler(
        { report_name: DELIVERY_SLIP_REPORT_NAME, report_type: "qweb-pdf", context: { active_ids: [1] } },
        {},
        env
    );

    assert.strictEqual(result, true, "Incoming deve interceptar (true)");
    assert.strictEqual(opened, true, "Print dialog deve ser aberto");
    console.log("✓ Caso 5: delivery slip incoming → print dialog (T2)");
}

// ── Caso 6: RPC falha (offline) → fall through ──────────────────────────────
{
    const openMock = () => {
        throw new Error("Não deveria abrir print dialog");
    };
    const handler = buildHandler(openMock);
    const env = makeEnv({ records: [], readError: new Error("offline") });

    const result = await handler(
        { report_name: DELIVERY_SLIP_REPORT_NAME, report_type: "qweb-pdf", context: { active_ids: [1] } },
        {},
        env
    );

    assert.strictEqual(result, undefined, "RPC falhou deve cair no default");
    console.log("✓ Caso 6: RPC offline → fall through");
}

// ── Caso 7: popup bloqueado → notificação + true (T7) ──────────────────────
{
    const notificationCalls = [];
    const env = makeEnv({ records: [], notificationCalls });
    const openPrintDialog = buildOpenPrintDialog({
        getReportUrl: (action, type) => `/report/${type}/${action.report_name}/1`,
        window: { open: () => null }, // popup bloqueado
    });

    const result = await openPrintDialog(
        { report_name: DELIVERY_SLIP_REPORT_NAME, context: { active_ids: [1] } },
        env
    );

    assert.strictEqual(result, true, "Mesmo com popup bloqueado, intercepta (true)");
    assert.strictEqual(notificationCalls.length, 1, "Deve exibir notificação");
    assert.strictEqual(notificationCalls[0].opts.type, "warning");
    assert(
        notificationCalls[0].msg.includes("Popup bloqueado"),
        "Mensagem deve mencionar popup bloqueado"
    );
    console.log("✓ Caso 7: popup bloqueado → notificação + true (T7)");
}

// ── Caso 8: popup abre → win.onload setado + true ──────────────────────────
{
    let onloadSet = false;
    const win = {
        set onload(fn) {
            onloadSet = true;
            this._onload = fn;
        },
        get onload() {
            return this._onload;
        },
        print: () => {},
    };
    const env = makeEnv({ records: [] });
    const openPrintDialog = buildOpenPrintDialog({
        getReportUrl: (action, type) => `/report/${type}/${action.report_name}/1`,
        window: { open: () => win },
    });

    const result = await openPrintDialog(
        { report_name: DELIVERY_SLIP_REPORT_NAME, context: { active_ids: [1] } },
        env
    );

    assert.strictEqual(result, true, "Deve interceptar (true)");
    assert.strictEqual(onloadSet, true, "win.onload deve ser registrado");
    console.log("✓ Caso 8: popup abre → win.onload + true");
}

// ── Integração: JS e Python apontam pro mesmo report (T04) ─────────────────
{
    const pyTestPath = path.join(MODULE_ROOT, "tests", "test_stock_picking_print.py");
    const pyTest = fs.readFileSync(pyTestPath, "utf8");
    const pyReportName = pyTest.match(/report_name['"]\],\s*'([^']+)'/);
    assert(
        pyReportName && pyReportName[1] === DELIVERY_SLIP_REPORT_NAME,
        `Python test deve usar report_name ${DELIVERY_SLIP_REPORT_NAME} (achou ${pyReportName?.[1]})`
    );
    console.log("✓ Integração: JS e Python concordam no report_name (T04)");
}

console.log("\nTodos os testes passaram ✓");
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
