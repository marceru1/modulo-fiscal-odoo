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

function assertSaldoCaixaEGaveta(name, source) {
    // O "SALDO DO CAIXA" deve existir (gaveta física) e ser bindado em
    // saldo_movimentacao.saldo (agora só dinheiro, exclui cartão/PIX).
    assert(
        source.includes("SALDO DO CAIXA"),
        `${name}: deve conter a linha "SALDO DO CAIXA" (gaveta física)`
    );
    assert(
        source.includes("saldo_movimentacao"),
        `${name}: o SALDO DO CAIXA deve vir de saldo_movimentacao (gaveta física)`
    );
}

function assertMovimentacaoTotal(name, source) {
    // Auditoria todos-os-métodos (cartão/PIX/a prazo incluídos), rótulo sem "CAIXA".
    assert(
        source.includes("MOVIMENTACAO TOTAL"),
        `${name}: deve conter a seção "MOVIMENTACAO TOTAL" (auditoria todos-os-métodos)`
    );
    assert(
        source.includes("movimentacao_total"),
        `${name}: a seção deve referenciar data.movimentacao_total`
    );
    assert(
        !/SALDO DO CAIXA/.test(source.split("MOVIMENTACAO TOTAL")[1] || ""),
        `${name}: a seção MOVIMENTACAO TOTAL não deve usar a palavra "CAIXA"`
    );
}

// ── Caso 1: popup (FechamentoReceipt) ─────────────────────────────────────
{
    const source = readTemplate("popup");
    assertHasDinheiroEmCaixa("popup", source);
    assertUsaDinheiroLiquido("popup", source);
    assertSangriaCondicional("popup", source);
    assertSaldoCaixaEGaveta("popup", source);
    assertMovimentacaoTotal("popup", source);
    console.log("✓ Popup (FechamentoReceipt): DINHEIRO EM CAIXA + SALDO DO CAIXA (gaveta) + MOVIMENTACAO TOTAL (auditoria)");
}

// ── Caso 2: relatório (FechamentoReport) ──────────────────────────────────
{
    const source = readTemplate("report");
    assertHasDinheiroEmCaixa("report", source);
    assertUsaDinheiroLiquido("report", source);
    assertSangriaCondicional("report", source);
    assertSaldoCaixaEGaveta("report", source);
    assertMovimentacaoTotal("report", source);
    console.log("✓ Relatório (FechamentoReport): DINHEIRO EM CAIXA + SALDO DO CAIXA (gaveta) + MOVIMENTACAO TOTAL (auditoria)");
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

// ── Caso 4: consistência MOVIMENTACAO TOTAL popup × relatório ─────────────
{
    const popup = readTemplate("popup");
    const report = readTemplate("report");
    assert(
        popup.includes("movimentacao_total") && report.includes("movimentacao_total"),
        "Popup e relatório devem usar o mesmo campo movimentacao_total (auditoria)"
    );
    console.log("✓ Consistência: popup e relatório usam o mesmo campo movimentacao_total");
}

console.log("\nTodos os testes passaram ✓");
