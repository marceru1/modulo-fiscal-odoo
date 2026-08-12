/**
 * Teste de consistência (Node puro, sem Odoo) da feature
 * sangria-reduzir-dinheiro (RF-01/RF-02/RF-03).
 *
 * O Odoo não roda localmente, então este teste verifica o CONTRATO entre os
 * dois templates que renderizam o fechamento de caixa:
 *   - static/src/xml/fechamento_receipt.xml  → FechamentoReceipt (popup POS)
 *   - views/pos_session_fechamento_views.xml  → FechamentoReport (backend)
 *
 * Ambos devem exibir a seção "DINHEIRO EM CAIXA" com:
 *   - DINHEIRO = data.dinheiro_liquido (vendas em dinheiro − sangrias)
 *   - SANGRIAS = data.total_sangrias, SOMENTE se total_sangrias > 0
 *
 * Isso trava o AC-02 (popup e relatório consistentes) e o AC-03 (linha de
 * sangria separada). O cálculo em si é coberto pelo teste Python
 * (test_sangria_saldo.py).
 *
 * Rodar: node meu_modulo_fiscal/tests/test_sangria_saldo.js
 */
const fs = require("fs");
const path = require("path");
const assert = require("assert");

const MODULE_ROOT = path.join(__dirname, "..");
const TEMPLATES = {
    popup: path.join(MODULE_ROOT, "static", "src", "xml", "fechamento_receipt.xml"),
    report: path.join(MODULE_ROOT, "views", "pos_session_fechamento_views.xml"),
};

// ── Helpers ────────────────────────────────────────────────────────────────
function readTemplate(name) {
    const source = fs.readFileSync(TEMPLATES[name], "utf8");
    return source;
}

function assertHasDinheiroEmCaixa(name, source) {
    assert(
        source.includes("DINHEIRO EM CAIXA"),
        `${name}: deve conter a seção "DINHEIRO EM CAIXA"`
    );
}

function assertUsaDinheiroLiquido(name, source) {
    assert(
        source.includes("dinheiro_liquido"),
        `${name}: deve referenciar data.dinheiro_liquido (RF-01)`
    );
}

function assertSangriaCondicional(name, source) {
    // A linha de sangria só deve aparecer se total_sangrias > 0.
    // No template OWL (popup): t-if="data.total_sangrias > 0"
    // No template QWeb server-side (report): t-if="data['total_sangrias'] &gt; 0"
    const condicional =
        source.includes('t-if="data.total_sangrias > 0"') ||
        source.includes("t-if=\"data['total_sangrias'] &gt; 0\"");
    assert(
        condicional,
        `${name}: a linha de sangria deve ser condicional a total_sangrias > 0 (RF-03)`
    );
}

// ── Caso 1: popup (FechamentoReceipt) ─────────────────────────────────────
{
    const source = readTemplate("popup");
    assertHasDinheiroEmCaixa("popup", source);
    assertUsaDinheiroLiquido("popup", source);
    assertSangriaCondicional("popup", source);
    console.log("✓ Popup (FechamentoReceipt): seção DINHEIRO EM CAIXA com dinheiro_liquido + sangria condicional");
}

// ── Caso 2: relatório (FechamentoReport) ──────────────────────────────────
{
    const source = readTemplate("report");
    assertHasDinheiroEmCaixa("report", source);
    assertUsaDinheiroLiquido("report", source);
    assertSangriaCondicional("report", source);
    console.log("✓ Relatório (FechamentoReport): seção DINHEIRO EM CAIXA com dinheiro_liquido + sangria condicional");
}

// ── Caso 3: consistência popup × relatório (AC-02) ────────────────────────
{
    const popup = readTemplate("popup");
    const report = readTemplate("report");
    // Ambos devem usar o MESMO campo (dinheiro_liquido) para o valor de dinheiro.
    assert(
        popup.includes("dinheiro_liquido") && report.includes("dinheiro_liquido"),
        "Popup e relatório devem usar o mesmo campo dinheiro_liquido (AC-02)"
    );
    console.log("✓ Consistência: popup e relatório usam o mesmo campo dinheiro_liquido");
}

console.log("\nTodos os testes passaram ✓");
