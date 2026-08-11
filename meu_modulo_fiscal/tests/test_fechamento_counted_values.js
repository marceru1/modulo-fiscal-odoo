/**
 * Teste unitário (Node puro, sem Odoo) do seam `_getCountedValues()` do
 * fechamento de caixa (fechamento_button.js).
 *
 * O Odoo não roda localmente, então este teste extrai o método real do
 * arquivo-fonte e o executa com um `this` mockado. Ele valida o contrato
 * da spec (Seam 1):
 *   - Dinheiro: lê do state.payments[cashDetails.id].counted
 *   - Bank/PIX/pay_later: usa pm.amount (valor calculado do sistema),
 *     NÃO lê do state (que não tem mais input no popup)
 *
 * Rodar: node meu_modulo_fiscal/tests/test_fechamento_counted_values.js
 */
const fs = require("fs");
const path = require("path");
const assert = require("assert");

const SOURCE_PATH = path.join(
    __dirname,
    "..",
    "static",
    "src",
    "js",
    "fechamento_button.js"
);
const source = fs.readFileSync(SOURCE_PATH, "utf8");

// Extrai o corpo do método _getCountedValues() do arquivo-fonte real.
//
// ⚠️ FRÁGIL A FORMATAÇÃO: o regex casa o primeiro `\n\s*\},` após a abertura
// do método. Se _getCountedValues() ganhar um bloco aninhado que termine em
// `},` antes do fim (ex.: um if com callback), a captura para cedo e o teste
// fica verde sobre um corpo parcial, sem erro. Ao reformatar o método em
// fechamento_button.js, rodar este teste — se ele passar sem cobrir o caso
// novo, o regex pode ter capturado o corpo errado.
const match = source.match(/_getCountedValues\(\)\s*\{([\s\S]*?)\n\s*\},/);
assert(match, "Não encontrou o método _getCountedValues() em fechamento_button.js");
const methodBody = match[1];

// Constrói a função a partir do corpo extraído. `parseFloat` é injetado
// como parâmetro (no módulo Odoo ele vem de @web/views/fields/parsers).
const getCountedValues = new Function(
    "parseFloat",
    `return function() { ${methodBody} }`
)(parseFloat);

// ── Helpers ────────────────────────────────────────────────────────────────
function isValidFloat(value) {
    return !isNaN(parseFloat(value)) && isFinite(value);
}

function makeThis({ cash, nonCash, payments, valid = isValidFloat }) {
    return {
        props: {
            default_cash_details: cash,
            non_cash_payment_methods: nonCash,
        },
        state: { payments },
        env: {
            utils: { isValidFloat: valid },
        },
    };
}

// ── Caso 1: Dinheiro lê do state.counted ──────────────────────────────────
{
    const ctx = makeThis({
        cash: { id: 1, name: "Dinheiro" },
        nonCash: [],
        payments: { 1: { counted: "150.00" } },
    });
    const result = getCountedValues.call(ctx);
    assert.deepStrictEqual(result, { Dinheiro: 150 }, "Dinheiro deve ler do state.counted");
    console.log("✓ Caso 1: dinheiro lê do state.counted");
}

// ── Caso 2: Bank usa pm.amount, ignora state.counted ─────────────────────
{
    const ctx = makeThis({
        cash: { id: 1, name: "Dinheiro" },
        nonCash: [{ id: 2, name: "Cartão", amount: 50 }],
        // state.counted=999 existe (getInitialState nativo), mas deve ser IGNORADO
        payments: { 1: { counted: "0" }, 2: { counted: "999" } },
    });
    const result = getCountedValues.call(ctx);
    assert.deepStrictEqual(
        result,
        { Dinheiro: 0, "Cartão": 50 },
        "Bank deve usar pm.amount (50), não state.counted (999)"
    );
    console.log("✓ Caso 2: bank usa pm.amount, ignora state.counted");
}

// ── Caso 3: Pay_later usa pm.amount sem entry no state ───────────────────
{
    const ctx = makeThis({
        cash: { id: 1, name: "Dinheiro" },
        nonCash: [{ id: 3, name: "A Prazo", amount: 20 }],
        // pay_later não tem entry no state (patch removido no ticket 01)
        payments: { 1: { counted: "0" } },
    });
    const result = getCountedValues.call(ctx);
    assert.deepStrictEqual(
        result,
        { Dinheiro: 0, "A Prazo": 20 },
        "Pay_later deve usar pm.amount mesmo sem entry no state"
    );
    console.log("✓ Caso 3: pay_later usa pm.amount sem entry no state");
}

// ── Caso 4: Pay_later sem amount → 0 ──────────────────────────────────────
{
    const ctx = makeThis({
        cash: { id: 1, name: "Dinheiro" },
        nonCash: [{ id: 3, name: "A Prazo", amount: undefined }],
        payments: { 1: { counted: "0" } },
    });
    const result = getCountedValues.call(ctx);
    assert.deepStrictEqual(
        result,
        { Dinheiro: 0, "A Prazo": 0 },
        "Pay_later sem amount deve cair para 0"
    );
    console.log("✓ Caso 4: pay_later sem amount → 0");
}

// ── Caso 5: Dinheiro com counted inválido → skip ─────────────────────────
{
    const ctx = makeThis({
        cash: { id: 1, name: "Dinheiro" },
        nonCash: [],
        payments: { 1: { counted: "abc" } },
        valid: () => false,
    });
    const result = getCountedValues.call(ctx);
    assert.deepStrictEqual(result, {}, "Dinheiro com counted inválido deve ser pulado");
    console.log("✓ Caso 5: dinheiro com counted inválido é pulado");
}

// ── Caso 6: Cenário completo (spec: INFORMADO = CALCULADO p/ não-dinheiro) ─
{
    const ctx = makeThis({
        cash: { id: 1, name: "Dinheiro" },
        nonCash: [
            { id: 2, name: "Cartão", amount: 50 },
            { id: 4, name: "PIX", amount: 30 },
            { id: 3, name: "A Prazo", amount: 20 },
        ],
        payments: { 1: { counted: "100.00" } },
    });
    const result = getCountedValues.call(ctx);
    assert.deepStrictEqual(
        result,
        { Dinheiro: 100, "Cartão": 50, "PIX": 30, "A Prazo": 20 },
        "Cenário completo: dinheiro do state, não-dinheiro do pm.amount"
    );
    console.log("✓ Caso 6: cenário completo");
}

console.log("\nTodos os testes passaram ✓");
