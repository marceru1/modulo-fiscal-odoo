/**
 * Teste unitário (Node puro, sem Odoo) do seam `priceDisplay` do badge de
 * preço no card do produto (preco_badge_produto.js) + contrato dos arquivos
 * da feature (xml/css/manifest).
 *
 * O Odoo não roda localmente: o teste extrai o getter real do fonte e o
 * executa com um `this` mockado (mesmo padrão de tests/test_atualizar_button.js).
 *
 * Contratos travados:
 *   - preço da pricelist da sessão (mesmo método do core ao adicionar a linha)
 *   - símbolo da moeda colado no número, com espaço simples ("R$ 40,00") —
 *     formatCurrency(true) usa NBSP e a quebra de linha saía entre "R$" e o valor
 *   - produto ausente / erro de pricelist → "" (badge some, card intacto)
 *   - XML: badge continua com position="after" no nome e t-if/t-esc
 *   - CSS: fonte menor que os 14px do nome do produto
 *
 * Rodar: node meu_modulo_fiscal/tests/test_preco_badge_produto.js
 */
const fs = require("fs");
const path = require("path");
const assert = require("assert");

const MODULE_ROOT = path.join(__dirname, "..");
const SRC = path.join(MODULE_ROOT, "static", "src");
const read = (p) => fs.readFileSync(p, "utf8");

const jsSource = read(path.join(SRC, "js", "preco_badge_produto.js"));
const xmlSource = read(path.join(SRC, "xml", "preco_badge_produto.xml"));
const cssSource = read(path.join(SRC, "css", "preco_badge_produto.css"));
const manifest = read(path.join(MODULE_ROOT, "__manifest__.py"));

// ── Extração do getter (balanceamento de chaves) ─────────────────────────────
function extractGetterBody(src, getterName) {
    const startIdx = src.indexOf(`get ${getterName}()`);
    assert(startIdx !== -1, `Não encontrou o getter ${getterName}()`);
    const braceIdx = src.indexOf("{", startIdx);
    let depth = 0;
    for (let i = braceIdx; i < src.length; i++) {
        if (src[i] === "{") depth++;
        else if (src[i] === "}") {
            depth--;
            if (depth === 0) return src.slice(braceIdx + 1, i);
        }
    }
    throw new Error(`Corpo do getter ${getterName}() desbalanceado`);
}

const priceDisplay = Object.getOwnPropertyDescriptor(
    new Function(
        `return { get priceDisplay() { ${extractGetterBody(jsSource, "priceDisplay")} } };`
    )(),
    "priceDisplay"
).get;

// ── Caso 1: preço da pricelist da sessão, símbolo colado com espaço simples ──
{
    const chamadas = [];
    const self = {
        props: { product: { get_price: (pl, qty) => (chamadas.push([pl, qty]), 40) } },
        pos: { getDefaultPricelist: () => "PL-SESSAO", currency: { symbol: "R$" } },
        env: { utils: { formatCurrency: (v, withSymbol) => (withSymbol ? "BOGUS" : `40,00`) } },
    };
    const out = priceDisplay.call(self);
    assert.strictEqual(out, "R$ 40,00", `Esperava "R$ 40,00", veio "${out}"`);
    assert.deepStrictEqual(
        chamadas,
        [["PL-SESSAO", 1]],
        "Preço deve vir de get_price(pricelist da sessão, qty=1) — o mesmo do core"
    );
    console.log("✓ Caso 1: R$ 40,00 (símbolo + número, sem NBSP) da pricelist da sessão");
}

// ── Caso 2: sem símbolo de moeda → só o número, sem espaço à esquerda ───────
{
    const self = {
        props: { product: { get_price: () => 1 } },
        pos: { getDefaultPricelist: () => "PL", currency: {} },
        env: { utils: { formatCurrency: () => "1,00" } },
    };
    assert.strictEqual(priceDisplay.call(self), " 1,00");
    console.log("✓ Caso 2: moeda sem symbol não quebra (só o número)");
}

// ── Caso 3: produto ausente → "" (badge não renderiza, card intacto) ────────
{
    const self = {
        props: {},
        pos: { getDefaultPricelist: () => "PL", currency: { symbol: "R$" } },
        env: { utils: { formatCurrency: () => "0,00" } },
    };
    assert.strictEqual(priceDisplay.call(self), "");
    console.log("✓ Caso 3: sem product → string vazia");
}

// ── Caso 4: erro na pricelist/format → degrada pra "" (try/catch) ───────────
{
    const self = {
        props: { product: { get_price: () => { throw new Error("pricelist quebrada"); } } },
        pos: { getDefaultPricelist: () => "PL", currency: { symbol: "R$" } },
        env: { utils: { formatCurrency: () => "x" } },
    };
    assert.strictEqual(priceDisplay.call(self), "");
    console.log("✓ Caso 4: exceção → string vazia (sem derrubar o card)");
}

// ── Caso 5: contrato do XML — âncora no nome, position=after, t-esc/t-if ────
{
    assert(
        /xpath expr="\/\/div\[hasclass\('product-name'\)]" position="after"/.test(xmlSource),
        "O badge deve ser injetado com position=\"after\" no node .product-name (nunca replace)"
    );
    assert(
        /class="product-price-badge[^"]*text-nowrap"/.test(xmlSource),
        "O badge deve ter text-nowrap (sem quebra entre símbolo e valor)"
    );
    assert(
        /t-esc="priceDisplay" t-if="priceDisplay"/.test(xmlSource),
        "t-esc + t-if no getter priceDisplay"
    );
    console.log("✓ Caso 5: XML ancora no nome, position=after, text-nowrap + t-esc/t-if");
}

// ── Caso 6: contrato do CSS — valor ABAIXO do nome (grid), fonte menor que o
//    nome, e o contador do carrinho preservado à direita ─────────────────────
{
    const semComentarios = cssSource.replace(/\/\*[\s\S]*?\*\//g, "");
    assert(
        /\.product \.product-content\s*\{[^}]*display:\s*grid\s*!important/.test(semComentarios),
        "O container deve virar grid com !important (o .d-flex do Bootstrap vence sem ele)"
    );
    assert(
        /\.product-price-badge\s*\{[^}]*grid-area:\s*2\s*\/\s*1/.test(semComentarios),
        "O badge deve ocupar a LINHA 2 da coluna 1 (abaixo do nome)"
    );
    assert(
        /\.product-name\s*\{[^}]*grid-area:\s*1\s*\/\s*1/.test(semComentarios),
        "O nome deve ficar na linha 1 (acima do valor)"
    );
    assert(
        /\.product-cart-qty\s*\{[^}]*grid-area:\s*1\s*\/\s*2\s*\/\s*span\s*2/.test(semComentarios),
        "O contador do carrinho deve continuar na coluna 2, ocupando as 2 linhas"
    );
    const m = cssSource.match(/\.product-price-badge\s*\{([^}]*)\}/);
    assert(m, "O CSS deve estilizar .product-price-badge");
    const fontMatch = m[1].match(/font-size:\s*([\d.]+)rem/);
    assert(fontMatch, "font-size em rem esperado");
    const px = parseFloat(fontMatch[1]) * 16;
    assert(
        px < 14,
        `Fonte do valor (${px}px) deve ser MENOR que o nome do produto (14px)`
    );
    console.log(`✓ Caso 6: badge em ${px}px e empilhado na linha 2 (grid), contador preservado`);
}

// ── Caso 7: os 3 assets da feature estão no manifest, JS antes do XML ───────
{
    for (const asset of [
        "meu_modulo_fiscal/static/src/js/preco_badge_produto.js",
        "meu_modulo_fiscal/static/src/xml/preco_badge_produto.xml",
        "meu_modulo_fiscal/static/src/css/preco_badge_produto.css",
    ]) {
        assert(manifest.includes(asset), `Manifest sem o asset ${asset}`);
    }
    const idxJs = manifest.indexOf("static/src/js/preco_badge_produto.js");
    const idxXml = manifest.indexOf("static/src/xml/preco_badge_produto.xml");
    assert(idxJs < idxXml, "JS deve vir antes do XML que usa o getter do patch");
    console.log("✓ Caso 7: JS/XML/CSS no manifest, JS antes do XML");
}

console.log("\nTodos os testes passaram ✓");
