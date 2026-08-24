/**
 * Teste unitário (Node puro, sem Odoo) da feature
 * lock-dinheiro-pos-impressao: confirmar o valor do dinheiro antes de
 * imprimir fechamento.
 *
 * O Odoo não roda localmente, então este teste:
 *   1. Extrai os métodos reais do patch em fechamento_button.js
 *      (getInitialState + confirmValorDinheiro) e os executa com um `this`
 *      mockado — valida o estado `valor_confirmado`.
 *   2. Verifica o CONTRATO do template fechamento_button.xml — valida os
 *      bindings que a spec exige:
 *        - Botão "Confirmar Valor" (t-on-click + t-if)
 *        - Trava do campo de dinheiro (pe-none)
 *        - Botão "Fechamento" desabilitado até confirmar
 *        - Botão nativo "Close Register" desabilitado até confirmar
 *
 * Seams da spec: ClosePosPopup patched.
 *
 * Rodar: node meu_modulo_fiscal/tests/test_fechamento_lock.js
 */
const fs = require("fs");
const path = require("path");
const assert = require("assert");

const MODULE_ROOT = path.join(__dirname, "..");
const JS_PATH = path.join(MODULE_ROOT, "static", "src", "js", "fechamento_button.js");
const XML_PATH = path.join(MODULE_ROOT, "static", "src", "xml", "fechamento_button.xml");

// ── Helpers de extração ─────────────────────────────────────────────────────
// ⚠️ FRÁGIL A FORMATAÇÃO: o regex casa o primeiro `\n\s*\},` após a abertura
// do método. Se o método ganhar um bloco aninhado que termine em `},` antes
// do fim, a captura para cedo e o teste fica verde sobre um corpo parcial.
function extractMethodBody(source, methodName) {
    const re = new RegExp(`${methodName}\\(\\)\\s*\\{([\\s\\S]*?)\\n\\s*\\},`);
    const m = source.match(re);
    assert(m, `Não encontrou ${methodName}() em fechamento_button.js`);
    return m[1];
}

// findMethodBody é fragil a regex — ver aviso acima.
const source = fs.readFileSync(JS_PATH, "utf8");

// mockGetInitialState devolve o estado-base do componente (notes/payments)
const mockGetInitialState = () => ({ notes: "", payments: {} });

// getInitialState() chama super() — injeta um mock no lugar. O `(...)` final
// invoca a função externa, devolvendo a função interna pronta pra `.call(this)`.
let gisBody = extractMethodBody(source, "getInitialState");
gisBody = gisBody.replace("super.getInitialState(...arguments)", "mockGetInitialState()");
const getInitialState = new Function(
    "mockGetInitialState",
    `return function() { ${gisBody} }`
)(mockGetInitialState);

const confirmValorDinheiro = new Function(
    `return function() { ${extractMethodBody(source, "confirmValorDinheiro")} }`
)();

function getInitialStateWith({ cash_control }) {
    return getInitialState.call({ pos: { config: { cash_control } } });
}

// ── Caso 1: cash_control ON → valor_confirmado inicia FALSE ────────────────
{
    const state = getInitialStateWith({ cash_control: true });
    assert.strictEqual(
        state.valor_confirmado,
        false,
        "Com cash_control ON, valor_confirmado deve iniciar false (exige confirmação)"
    );
    console.log("✓ Caso 1: cash_control ON → valor_confirmado=false");
}

// ── Caso 2: cash_control OFF → valor_confirmado inicia TRUE ────────────────
{
    const state = getInitialStateWith({ cash_control: false });
    assert.strictEqual(
        state.valor_confirmado,
        true,
        "Sem cash_control não há valor de dinheiro a confirmar — não pode travar os botões"
    );
    console.log("✓ Caso 2: cash_control OFF → valor_confirmado=true (não bloqueia)");
}

// ── Caso 3: confirmValorDinheiro() seta valor_confirmado = true ────────────
{
    const state = { valor_confirmado: false, payments: { 1: { counted: "100.00" } } };
    confirmValorDinheiro.call({ state });
    assert.strictEqual(state.valor_confirmado, true, "confirmValorDinheiro deve confirmar");
    // Não pode mexer nos payments (reimpressão usa o mesmo valor congelado)
    assert.deepStrictEqual(
        state.payments,
        { 1: { counted: "100.00" } },
        "confirmar não deve alterar o valor contado"
    );
    console.log("✓ Caso 3: confirmValorDinheiro trava sem alterar payments");
}

// ── Caso 4: reimpressão usa valor congelado ─────────────────────────────────
{
    const state = { valor_confirmado: false, payments: { 1: { counted: "42.50" } } };
    confirmValorDinheiro.call({ state });
    confirmValorDinheiro.call({ state }); // reimprimir = chamar de novo
    assert.strictEqual(state.valor_confirmado, true);
    assert.strictEqual(
        state.payments[1].counted,
        "42.50",
        "Reimprimir não pode alterar o valor — campo está congelado"
    );
    console.log("✓ Caso 4: reimpressão mantém valor congelado");
}

// ── Template: contrato do XML ───────────────────────────────────────────────
{
    const xml = fs.readFileSync(XML_PATH, "utf8");

    // AC 01: botão "Confirmar Valor" presente, some após clicar
    assert(
        xml.includes('t-on-click="confirmValorDinheiro"'),
        "Template deve ter o botão Confirmar Valor (t-on-click=confirmValorDinheiro)"
    );
    assert(
        xml.includes('t-if="!state.valor_confirmado"'),
        "Botão 'Confirmar Valor' deve sumir após confirmar (t-if=!state.valor_confirmado)"
    );

    // AC 01: campo de dinheiro trava via pe-none quando confirmado
    assert(
        xml.includes("pe-none"),
        "Campo de dinheiro deve travar via pe-none quando valor confirmado"
    );

    // AC 02: botão "Fechamento" (imprimir) desabilitado até confirmar
    assert(
        xml.includes('t-att-disabled="!state.valor_confirmado"'),
        "Botão 'Fechamento' deve ficar desabilitado até confirmar o valor"
    );

    // AC 02: botão nativo "Close Register" também desabilitado até confirmar
    assert(
        xml.includes("!state.valor_confirmado || !canConfirm()"),
        "Botão nativo 'Close Register' deve juntar a trava de valor com canConfirm()"
    );

    console.log("✓ Template: contrato completo (botão, trava, botões desabilitados)");
}

console.log("\nTodos os testes passaram ✓");
