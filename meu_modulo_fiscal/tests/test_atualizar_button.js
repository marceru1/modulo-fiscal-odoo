/**
 * Teste unitário (Node puro, sem Odoo) do seam `canRefreshPOS` do botão
 * "Atualizar" do menu sanduíche do PDV (atualizar_button.js).
 *
 * O Odoo não roda localmente, então este teste extrai o getter real do
 * arquivo-fonte e o executa com um `this` mockado. Ele valida o contrato
 * da spec (Testing Decisions):
 *   - offline === true            → false (nunca reload com rede caída)
 *   - unsyncData.length > 0       → false (nunca perder pedido de contingência)
 *   - online + unsyncData vazio   → true
 *
 * Rodar: node meu_modulo_fiscal/tests/test_atualizar_button.js
 */
const fs = require("fs");
const path = require("path");
const assert = require("assert");

const MODULE_ROOT = path.join(__dirname, "..");
const SOURCE_PATH = path.join(
    MODULE_ROOT,
    "static",
    "src",
    "js",
    "atualizar_button.js"
);
const source = fs.readFileSync(SOURCE_PATH, "utf8");

// ── Extração do getter ───────────────────────────────────────────────────────
// Envolve o corpo extraído num object literal com o mesmo getter, para que
// `this` dentro do corpo aponte para o objeto mockado.
const match = source.match(/get canRefreshPOS\(\)\s*\{([\s\S]*?)\n\s*\},/);
assert(match, "Não encontrou o getter canRefreshPOS() em atualizar_button.js");
const getterBody = match[1];

function buildGetter() {
    const holder = new Function(
        `return { get canRefreshPOS() { ${getterBody} } };`
    )();
    return Object.getOwnPropertyDescriptor(holder, "canRefreshPOS").get;
}

const canRefreshPOS = buildGetter();

// ── Caso 1: offline → botão oculto (false) ──────────────────────────────────
{
    const self = { pos: { data: { network: { offline: true, unsyncData: [] } } } };
    assert.strictEqual(
        canRefreshPOS.call(self),
        false,
        "Offline deve ocultar o botão Atualizar"
    );
    console.log("✓ Caso 1: offline === true → false");
}

// ── Caso 2: pedido de contingência pendente → botão oculto (false) ──────────
{
    const self = {
        pos: {
            data: {
                network: { offline: false, unsyncData: [{ uuid: "x" }, { uuid: "y" }] },
            },
        },
    };
    assert.strictEqual(
        canRefreshPOS.call(self),
        false,
        "unsyncData não vazio deve ocultar o botão Atualizar"
    );
    console.log("✓ Caso 2: unsyncData.length > 0 → false");
}

// ── Caso 3: online e sem pendências → botão visível (true) ──────────────────
{
    const self = { pos: { data: { network: { offline: false, unsyncData: [] } } } };
    assert.strictEqual(
        canRefreshPOS.call(self),
        true,
        "Online e sem pendências deve exibir o botão Atualizar"
    );
    console.log("✓ Caso 3: online + unsyncData vazio → true");
}

// ── Caso 4: offline E com pendências → continua false (guarda dupla) ────────
{
    const self = {
        pos: { data: { network: { offline: true, unsyncData: [{ uuid: "z" }] } } },
    };
    assert.strictEqual(
        canRefreshPOS.call(self),
        false,
        "Offline com pendências deve ocultar o botão Atualizar"
    );
    console.log("✓ Caso 4: offline + unsyncData não vazio → false");
}

// ── Caso 5: contrato do arquivo — sem imports de serviço extras ─────────────
{
    const imports = [...source.matchAll(/^import .*from "([^"]+)";$/gm)].map(
        (m) => m[1]
    );
    assert.deepStrictEqual(
        imports.sort(),
        ["@point_of_sale/app/navbar/navbar", "@web/core/utils/patch"],
        `atualizar_button.js deve importar apenas Navbar e patch (achou: ${imports.join(", ")})`
    );
    assert(
        source.includes("/** @odoo-module */"),
        "atualizar_button.js deve ter o header /** @odoo-module */"
    );
    console.log("✓ Caso 5: imports restritos a Navbar + patch (this.pos.data.network)");
}

console.log("\nTodos os testes passaram ✓");
