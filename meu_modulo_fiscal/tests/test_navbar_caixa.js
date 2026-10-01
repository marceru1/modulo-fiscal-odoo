/**
 * Teste unitário (Node puro, sem Odoo) do getter `caixaLabel` da feature
 * caixa-no-navbar-pdv (pos_navbar_logo.js) + contrato do template/CSS/manifest.
 *
 * O nome do caixa é `pos.config.name`. Em Odoo 18 o pos.config é carregado
 * com os campos do `_load_pos_data_fields` do `pos.load.mixin` (default `[]`),
 * então o read traz todos os campos acessíveis — `name` chega no cache do POS
 * sem loader novo (mesma premissa do filtro de pedidos, campo `state`).
 * O teste trava o getter, não o transporte: por isso o guard contra import
 * novo no arquivo (o Navbar do core já chama usePos()).
 *
 * Rodar: node meu_modulo_fiscal/tests/test_navbar_caixa.js
 */
const fs = require("fs");
const path = require("path");
const assert = require("assert");

const MODULE_ROOT = path.join(__dirname, "..");
const SRC = path.join(MODULE_ROOT, "static", "src");
const read = (p) => fs.readFileSync(p, "utf8");

const jsSource = read(path.join(SRC, "js", "pos_navbar_logo.js"));
const xmlSource = read(path.join(SRC, "xml", "pos_navbar_logo.xml"));
const cssSource = read(path.join(SRC, "css", "pos_navbar_caixa.css"));
const manifest = read(path.join(MODULE_ROOT, "__manifest__.py"));

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

const caixaLabel = Object.getOwnPropertyDescriptor(
    new Function(
        `return { get caixaLabel() { ${extractGetterBody(jsSource, "caixaLabel")} } };`
    )(),
    "caixaLabel"
).get;

// ── Caso 1: nome do caixa vem do pos.config ─────────────────────────────────
{
    assert.strictEqual(caixaLabel.call({ pos: { config: { name: "Caixa 01" } } }), "Caixa 01");
    console.log("✓ Caso 1: pos.config.name → rótulo (Caixa 01)");
}

// ── Caso 2: espaços nas pontas são removidos ────────────────────────────────
{
    assert.strictEqual(caixaLabel.call({ pos: { config: { name: "  Caixa 02  " } } }), "Caixa 02");
    console.log("✓ Caso 2: trim no nome");
}

// ── Caso 3: config ausente/`name` ausente/`name=false` → "" (span não renderiza)
{
    assert.strictEqual(caixaLabel.call({}), "");
    assert.strictEqual(caixaLabel.call({ pos: {} }), "");
    assert.strictEqual(caixaLabel.call({ pos: { config: {} } }), "");
    assert.strictEqual(caixaLabel.call({ pos: { config: { name: false } } }), "");
    assert.strictEqual(caixaLabel.call({ pos: { config: { name: "   " } } }), "");
    console.log("✓ Caso 3: config/nome ausente ou em branco → string vazia");
}

// ── Caso 4: nome não-string não vaza pro DOM ────────────────────────────────
{
    assert.strictEqual(caixaLabel.call({ pos: { config: { name: 42 } } }), "");
    console.log("✓ Caso 4: nome não-string → string vazia (guard de tipo)");
}

// ── Caso 5: template — rótulo dentro do .pos-centerheader, t-esc/t-if ──────
{
    assert(
        /xpath expr="\/\/div\[hasclass\('pos-centerheader'\)]" position="inside"/.test(xmlSource),
        "O rótulo deve entrar no .pos-centerheader (junto da logo) com position=inside"
    );
    assert(
        /t-esc="caixaLabel" t-if="caixaLabel"/.test(xmlSource),
        "t-esc (XSS-safe) + t-if no getter caixaLabel"
    );
    assert(
        /hasclass\('pos-logo'\)/.test(xmlSource) && /height">56/.test(xmlSource),
        "A troca da logo Grupo 20+ (attributes no img.pos-logo) deve continuar no template"
    );
    console.log("✓ Caso 5: XML mantém a logo e injeta o rótulo no centerheader");
}

// ── Caso 6: CSS do rótulo — centralizado na vertical, legível e com ellipsis ─
{
    const semComentarios = cssSource.replace(/\/\*[\s\S]*?\*\//g, "");
    assert(
        /\.pos-navbar-caixa\s*\{[^}]*display:\s*flex/.test(semComentarios) &&
            /\.pos-navbar-caixa\s*\{[^}]*align-items:\s*center/.test(semComentarios) &&
            /\.pos-navbar-caixa\s*\{[^}]*align-self:\s*stretch/.test(semComentarios),
        "O rótulo precisa de display:flex + align-self:stretch + align-items:center " +
            "(sem isso o texto encosta no TOPO do bloco de 56px — o centro do logo fica 29px abaixo)"
    );
    const m = cssSource.match(/\.pos-navbar-caixa\s*\{([^}]*)\}/);
    const fontMatch = m && m[1].match(/font-size:\s*([\d.]+)rem/);
    assert(fontMatch, "font-size em rem esperado no .pos-navbar-caixa");
    const px = parseFloat(fontMatch[1]) * 16;
    assert(px >= 14, `Rótulo deve ser legível (>= 14px), veio ${px}px`);
    assert(
        /font-weight:\s*700/.test(m[1]),
        "Rótulo deve estar destacado (font-weight 700)"
    );
    assert(
        /text-overflow:\s*ellipsis/.test(m[1]),
        "Rótulo longo precisa de ellipsis (orçamento de 55px no centerheader)"
    );
    assert(
        !/text-muted/.test(cssSource) || /color:\s*#212529/.test(m[1]),
        "Cor deve ser escura (#212529), não o cinza apagado do text-muted"
    );
    console.log(`✓ Caso 6: rótulo ${px}px/700, centralizado na vertical, com ellipsis`);
}

// ── Caso 7: imports restritos ao patch + Navbar (sem serviço novo) ─────────
{
    const imports = [...jsSource.matchAll(/^import .*from "([^"]+)";$/gm)].map((m) => m[1]);
    assert.deepStrictEqual(
        imports.sort(),
        ["@point_of_sale/app/navbar/navbar", "@web/core/utils/patch"],
        `pos_navbar_logo.js deve importar apenas patch e Navbar (achou: ${imports.join(", ")})`
    );
    assert(jsSource.includes("/** @odoo-module */"), "Header /** @odoo-module */ obrigatório");
    console.log("✓ Caso 7: só patch + Navbar (this.pos já existe no setup do core)");
}

// ── Caso 8: assets no manifest, JS antes do XML ────────────────────────────
{
    for (const asset of [
        "meu_modulo_fiscal/static/src/js/pos_navbar_logo.js",
        "meu_modulo_fiscal/static/src/xml/pos_navbar_logo.xml",
        "meu_modulo_fiscal/static/src/css/pos_navbar_caixa.css",
    ]) {
        assert(manifest.includes(asset), `Manifest sem o asset ${asset}`);
    }
    const idxJs = manifest.indexOf("static/src/js/pos_navbar_logo.js");
    const idxXml = manifest.indexOf("static/src/xml/pos_navbar_logo.xml");
    assert(idxJs < idxXml, "JS deve vir antes do XML que usa o getter do patch");
    console.log("✓ Caso 8: JS/XML/CSS no manifest, JS antes do XML");
}

console.log("\nTodos os testes passaram ✓");
