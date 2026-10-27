/**
 * Teste da UI do fechamento pendente (fechamento_pendente_ui.js + XML/CSS —
 * ticket 06): getters executados com `this` mockado + contrato textual do
 * banner e do popup somente leitura.
 *
 * Rodar: node meu_modulo_fiscal/tests/test_fechamento_pendente_ui.js
 */
const fs = require("fs");
const path = require("path");
const assert = require("assert");

const MODULE_ROOT = path.join(__dirname, "..");
const UI_JS = path.join(MODULE_ROOT, "static", "src", "js", "fechamento_pendente_ui.js");
const BANNER_XML = path.join(MODULE_ROOT, "static", "src", "xml", "fechamento_pendente.xml");
const POPUP_XML = path.join(MODULE_ROOT, "static", "src", "xml", "fechamento_button.xml");
const BANNER_CSS = path.join(MODULE_ROOT, "static", "src", "css", "fechamento_pendente.css");
const BUTTON_JS = path.join(MODULE_ROOT, "static", "src", "js", "fechamento_button.js");
const MANIFEST = path.join(MODULE_ROOT, "__manifest__.py");

const source = fs.readFileSync(UI_JS, "utf8");
const bannerXml = fs.readFileSync(BANNER_XML, "utf8");
const popupXml = fs.readFileSync(POPUP_XML, "utf8");
const bannerCss = fs.readFileSync(BANNER_CSS, "utf8");
const buttonJs = fs.readFileSync(BUTTON_JS, "utf8");
const manifest = fs.readFileSync(MANIFEST, "utf8");

// Extrai um bloco com chaves equilibradas (padrão test_fechamento_redirect.js).
function extractBlock(texto, marcador) {
    const start = texto.indexOf(marcador);
    assert(start !== -1, `Não encontrou "${marcador}"`);
    const braceStart = texto.indexOf("{", start);
    let depth = 0;
    for (let i = braceStart; i < texto.length; i++) {
        if (texto[i] === "{") {
            depth++;
        } else if (texto[i] === "}") {
            depth--;
            if (depth === 0) {
                return texto.slice(braceStart + 1, i);
            }
        }
    }
    assert.fail(`Bloco "${marcador}" sem fechamento`);
}

// Stub de _t com interpolação simples (%s) para os getters.
function _t(texto, ...args) {
    let i = 0;
    return String(texto).replace(/%s/g, () => String(args[i++]));
}

const FASE_POR_PASSO = {
    1: "enviando sangrias e suprimentos…",
    2: "enviando pedidos…",
    3: "gravando o dinheiro contado…",
    4: "mudando o caixa para fechamento…",
    5: "fechando…",
};

function makeGet(name, deps = {}) {
    const body = extractBlock(source, name);
    const nomes = Object.keys(deps);
    return new Function(...nomes, `return function() { ${body} }`)(...Object.values(deps));
}

const getAtivo = makeGet("get fechamentoPendenteAtivo()");
const getErro = makeGet("get fechamentoPendenteErro()");
const getTexto = makeGet("get fechamentoPendenteTexto()", {
    _t,
    FASE_POR_PASSO,
    contarVendasNaoEnviadas: () => 2,
});

function ctxTexto(pendencia) {
    const ctx = { fechamentoPendente: pendencia, fechamentoPendenteQuantidade: 2 };
    Object.defineProperty(ctx, "fechamentoPendenteErro", {
        get: getErro,
    });
    return ctx;
}

// ── 1. Getters: banner só com pendência ───────────────────────────────────
assert.strictEqual(getAtivo.call({ fechamentoPendente: null }), false);
assert.strictEqual(getAtivo.call({ fechamentoPendente: { status: "pendente" } }), true);
console.log("✓ 1: banner aparece só com pendência");

// ── 2. Vermelho só em erro_negocio ────────────────────────────────────────
assert.strictEqual(getErro.call({ fechamentoPendente: { status: "pendente" } }), false);
assert.strictEqual(getErro.call({ fechamentoPendente: { status: "executando" } }), false);
assert.strictEqual(getErro.call({ fechamentoPendente: { status: "erro_negocio" } }), true);
console.log("✓ 2: vermelho só em erro_negocio");

// ── 3. Textos por fase ────────────────────────────────────────────────────
assert.strictEqual(
    getTexto.call(ctxTexto({ status: "pendente", passo: -1 })),
    "Fechamento pendente — aguardando rede (2 pedidos na fila)"
);
assert.strictEqual(
    getTexto.call(ctxTexto({ status: "executando", passo: 1 })),
    "enviando pedidos…"
);
assert.strictEqual(
    getTexto.call(ctxTexto({ status: "executando", passo: 4 })),
    "fechando…"
);
assert.strictEqual(
    getTexto.call(ctxTexto({ status: "erro_negocio", passo: 2 })),
    "Fechamento recusado pelo servidor — chame o gerente"
);
console.log("✓ 3: texto do banner reflete a fase/erro");

// ── 4. addLineToOrder e pay bloqueados só com pendência ───────────────────
let bodyAdd = extractBlock(source, "async addLineToOrder()").replace(
    "super.addLineToOrder(...arguments)",
    "mockSuper(...arguments)"
);
const addLine = new Function("mockSuper", "_t", `return async function() { ${bodyAdd} }`)(
    async () => "linha",
    _t
);

let bodyPay = extractBlock(source, "async pay()").replace(
    "super.pay(...arguments)",
    "mockSuper(...arguments)"
);
const pay = new Function("mockSuper", "_t", `return async function() { ${bodyPay} }`)(
    async () => "pagou",
    _t
);

(async () => {
    {
        let avisos = 0;
        const ctx = {
            fechamentoPendenteAtivo: true,
            notification: { add: () => avisos++ },
        };
        assert.strictEqual(await addLine.call(ctx, {}, {}), undefined);
        assert.strictEqual(await pay.call(ctx), undefined);
        assert.strictEqual(avisos, 2, "Avisa o operador nos dois bloqueios");
    }
    {
        const ctx = { fechamentoPendenteAtivo: false, notification: { add: () => {} } };
        assert.strictEqual(await addLine.call(ctx, {}, {}), "linha");
        assert.strictEqual(await pay.call(ctx), "pagou");
    }
    console.log("✓ 4: addLineToOrder/pay bloqueados só com pendência");

    // ── 5. Contrato do banner XML ─────────────────────────────────────────
    assert.match(bannerXml, /t-if="pos\.fechamentoPendenteAtivo"/);
    assert.match(
        bannerXml,
        /t-att-class="\{\s*'meu-fechamento-pendente-erro':\s*pos\.fechamentoPendenteErro\s*\}"/,
        "Vermelho condicionado a fechamentoPendenteErro"
    );
    assert.match(bannerXml, /t-esc="pos\.fechamentoPendenteTexto"/, "Texto dinâmico com t-esc");
    assert.ok(
        !/position="replace"/.test(bannerXml),
        "Banner não pode usar position=replace"
    );
    assert.match(bannerCss, /\.meu-fechamento-pendente-banner\s*\{/);
    assert.match(bannerCss, /fechamento-pendente-erro[\s\S]{0,80}#b91c1c/);
    console.log("✓ 5: banner XML/CSS no contrato");

    // ── 6. Popup somente leitura ──────────────────────────────────────────
    assert.match(
        popupXml,
        /xpath expr="\/\/button\[@t-on-click='confirm'\]"[\s\S]{0,200}<attribute name="t-if">!pos\.fechamentoPendenteAtivo<\/attribute>/,
        "Sem botão Close Register com pendência"
    );
    assert.match(
        popupXml,
        /\/\/button\[@t-on-click='\(\) =&gt; this\.cashMove\(\)'\]"[\s\S]{0,220}t-if">!pos\.fechamentoPendenteAtivo/,
        "Sem novo Cash In/Out com pendência"
    );
    assert.match(
        popupXml,
        /pos\.fechamentoPendenteAtivo \? 'Reimprimir' : 'Fechamento'/,
        "Botão vira Reimprimir na pendência"
    );
    assert.match(
        popupXml,
        /state\.valor_confirmado/,
        "Lock do dinheiro continua no template"
    );
    assert.ok(!/position="replace"/.test(popupXml), "Popup não pode usar position=replace");

    assert.match(
        buttonJs,
        /this\.pos\.fechamentoPendenteAtivo[\s\S]{0,400}state\.valor_confirmado = true/,
        "getInitialState trava o dinheiro na pendência"
    );
    assert.match(
        buttonJs,
        /this\.pos\.fechamentoPendenteAtivo[\s\S]{0,300}Fechamento pendente: aguarde/,
        "closeSession não fecha de novo na pendência"
    );
    console.log("✓ 6: popup somente leitura (sem Fechar, dinheiro travado)");

    // ── 7. Manifest ───────────────────────────────────────────────────────
    for (const asset of [
        "static/src/js/fechamento_pendente_ui.js",
        "static/src/xml/fechamento_pendente.xml",
        "static/src/css/fechamento_pendente.css",
    ]) {
        assert.ok(
            manifest.includes(`meu_modulo_fiscal/${asset}`),
            `${asset} deve estar no manifest`
        );
    }
    console.log("✓ 7: manifest carrega os assets do estado pendente");

    console.log("\nTodos os testes passaram ✓");
})().catch((error) => {
    console.error(error);
    process.exit(1);
});
