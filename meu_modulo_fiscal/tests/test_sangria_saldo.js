/**
 * Teste de consistência (Node puro, sem Odoo) da feature
 * sangria-reduzir-dinheiro (RF-01/RF-02/RF-03).
 *
 * O Odoo não roda localmente, então este teste verifica o CONTRATO entre os
 * dois templates que renderizam o fechamento de caixa:
 *   - static/src/xml/fechamento_receipt.xml  → FechamentoReceipt (popup POS)
 *   - views/pos_session_fechamento_views.xml  → FechamentoReport (backend)
 *
 * Contrato atual (limpar-nota-final):
 *   - NÃO exibe a seção "DINHEIRO EM CAIXA".
 *   - NÃO exibe a seção "SALDO DE DINHEIRO DO DIA" (nem suas linhas
 *     ENTRADAS(F+VD+I+R), SAIDAS(S) e SALDO DO CAIXA).
 *   - Exibe a seção própria "SANGRIAS(S)" somente se houver sangrias.
 *   - Exibe "MOVIMENTACAO TOTAL (TODOS METODOS)" (auditoria todos os métodos).
 *   - Exibe "SALDO DETALHADO DO CAIXA".
 *   - Exibe a assinatura.
 *
 * O cálculo em si continua existindo no payload (dinheiro_liquido,
 * saldo_movimentacao etc.) e é coberto pelo teste Python (test_sangria_saldo.py);
 * aqui só verificamos que as seções foram removidas dos templates.
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

function assertNaoTemDinheiroEmCaixa(name, source) {
    assert(
        !source.includes("DINHEIRO EM CAIXA"),
        `${name}: NÃO deve conter a seção "DINHEIRO EM CAIXA"`
    );
    assert(
        !source.includes("DINHEIRO LIQUIDO (V-S)"),
        `${name}: NÃO deve conter a linha "DINHEIRO LIQUIDO (V-S)"`
    );
}

function assertNaoTemSaldoDeDinheiroDoDia(name, source) {
    assert(
        !source.includes("SALDO DE DINHEIRO DO DIA"),
        `${name}: NÃO deve conter a seção "SALDO DE DINHEIRO DO DIA"`
    );
    assert(
        !source.includes("ENTRADAS(F+VD+I+R):"),
        `${name}: NÃO deve conter a linha "ENTRADAS(F+VD+I+R):"`
    );
}

function assertSangriasPropriaCondicional(name, source) {
    // A seção própria SANGRIAS(S) só deve aparecer se houver sangrias.
    // No template OWL (popup): t-if="data.sangrias.length > 0"
    // No template QWeb server-side (report): t-if="data['sangrias'] and len(...) > 0"
    const condicionalPopup = source.includes('t-if="data.sangrias.length > 0"');
    const condicionalReport = source.includes("t-if=\"data['sangrias'] and len(data['sangrias']) &gt; 0\"");
    assert(
        condicionalPopup || condicionalReport,
        `${name}: a seção SANGRIAS(S) deve ser condicional à existência de sangrias`
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

function assertSaldoDetalhadoDoCaixa(name, source) {
    assert(
        source.includes("SALDO DETALHADO DO CAIXA"),
        `${name}: deve conter a seção "SALDO DETALHADO DO CAIXA"`
    );
}

function assertAssinatura(name, source) {
    assert(
        source.includes("ASSINATURA"),
        `${name}: deve conter a área de assinatura`
    );
}

// ── Caso 1: popup (FechamentoReceipt) ─────────────────────────────────────
{
    const source = readTemplate("popup");
    assertNaoTemDinheiroEmCaixa("popup", source);
    assertNaoTemSaldoDeDinheiroDoDia("popup", source);
    assertSangriasPropriaCondicional("popup", source);
    assertMovimentacaoTotal("popup", source);
    assertSaldoDetalhadoDoCaixa("popup", source);
    assertAssinatura("popup", source);
    console.log("✓ Popup (FechamentoReceipt): seções removidas + SANGRIAS(S) + MOVIMENTACAO TOTAL + SALDO DETALHADO + ASSINATURA");
}

// ── Caso 2: relatório (FechamentoReport) ──────────────────────────────────
{
    const source = readTemplate("report");
    assertNaoTemDinheiroEmCaixa("report", source);
    assertNaoTemSaldoDeDinheiroDoDia("report", source);
    assertSangriasPropriaCondicional("report", source);
    assertMovimentacaoTotal("report", source);
    assertSaldoDetalhadoDoCaixa("report", source);
    assertAssinatura("report", source);
    console.log("✓ Relatório (FechamentoReport): seções removidas + SANGRIAS(S) + MOVIMENTACAO TOTAL + SALDO DETALHADO + ASSINATURA");
}

// ── Caso 3: consistência popup × relatório (AC-02) ────────────────────────
{
    const popup = readTemplate("popup");
    const report = readTemplate("report");
    assert(
        popup.includes("movimentacao_total") && report.includes("movimentacao_total"),
        "Popup e relatório devem usar o mesmo campo movimentacao_total (auditoria)"
    );
    assert(
        popup.includes("SALDO DETALHADO DO CAIXA") && report.includes("SALDO DETALHADO DO CAIXA"),
        "Popup e relatório devem manter a seção SALDO DETALHADO DO CAIXA"
    );
    console.log("✓ Consistência: popup e relatório mantêm MOVIMENTACAO TOTAL e SALDO DETALHADO DO CAIXA");
}

console.log("\nTodos os testes passaram ✓");
