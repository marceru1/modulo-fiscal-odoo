/**
 * Teste unitário (Node puro, sem Odoo) do ticket 01 da feature
 * atalhos-teclado-pdv: atalhos de teclado na PaymentScreen do POS.
 *
 * Estratégia (a mesma de test_filtro_pedidos.js): o Odoo não roda localmente,
 * então o teste lê static/src/js/atalhos_pagamento.js e:
 *   1. extrai as constantes exportadas (LETRAS_METODO, TECLA_*) e a função pura
 *      letraDoMetodo() DO PRÓPRIO ARQUIVO — nada de lógica reimplementada aqui;
 *   2. extrai o objeto literal passado a patch(PaymentScreen.prototype, {...})
 *      e o monta sobre um protótipo mockado (o mock faz o papel de `super`);
 *   3. mocka useHotkey para ESPIAR quais teclas foram registradas e o que cada
 *      callback faz quando disparado.
 *
 * Seams: as teclas registradas (o que o operador aperta) e os handlers do
 * PaymentScreen (addNewPaymentLine / validateOrder / clickAcrescimoButton /
 * clickDescontoButton) — comportamento observável na tela.
 *
 * O grupo B é a prova source-driven do ticket 01, ponto 3: o hotkey service do
 * Odoo 18 NÃO roteia F-keys, por isso F2/F3 viraram letras (S/R). Se alguém
 * tentar voltar pra F2/F3, o teste falha com a citação do core.
 *
 * Rodar: node meu_modulo_fiscal/tests/test_atalhos_pagamento.js
 */
const fs = require("fs");
const path = require("path");
const assert = require("assert");

const MODULE_ROOT = path.join(__dirname, "..");
const JS_PATH = path.join(MODULE_ROOT, "static", "src", "js", "atalhos_pagamento.js");
const MANIFEST_PATH = path.join(MODULE_ROOT, "__manifest__.py");
const source = fs.readFileSync(JS_PATH, "utf8");
const manifest = fs.readFileSync(MANIFEST_PATH, "utf8");

// ── Extração do que o arquivo declara (sem reimplementar) ─────────────────

/** Extrai `export const NAME = <literal>;` e devolve o valor avaliado. */
function extractConst(src, name) {
    const re = new RegExp(`export const ${name} = ([^;]+);`);
    const m = src.match(re);
    assert(m, `não achou "export const ${name}" em atalhos_pagamento.js`);
    return new Function(`return (${m[1]});`)();
}

/** Extrai `export function NAME(...) {...}` e devolve a função de verdade. */
function extractFunction(src, name, injected = {}) {
    const re = new RegExp(`export function ${name}\\([\\s\\S]*?\\n\\}`);
    const m = src.match(re);
    assert(m, `não achou "export function ${name}" em atalhos_pagamento.js`);
    const fnSource = m[0].replace(/^export /, "");
    const argNames = Object.keys(injected);
    return new Function(...argNames, `return (${fnSource});`)(...argNames.map((k) => injected[k]));
}

/** Balanceia chaves/parênteses/colchetes ignorando strings (prior art filtro_pedidos). */
function extractBalanced(src, openIdx) {
    const openers = "{([";
    const closers = "})]";
    let depth = 0;
    let quote = null;
    for (let i = openIdx; i < src.length; i++) {
        const ch = src[i];
        if (quote) {
            if (ch === "\\") {
                i++;
            } else if (ch === quote) {
                quote = null;
            }
            continue;
        }
        if (ch === '"' || ch === "'" || ch === "`") {
            quote = ch;
            continue;
        }
        if (openers.includes(ch)) {
            depth++;
        } else if (closers.includes(ch)) {
            depth--;
            if (depth === 0) {
                return src.slice(openIdx, i + 1);
            }
        }
    }
    throw new Error("Objeto do patch não balanceado em atalhos_pagamento.js");
}

const LETRAS_METODO = extractConst(source, "LETRAS_METODO");
const TECLA_ACRESCIMO = extractConst(source, "TECLA_ACRESCIMO");
const TECLA_DESCONTO = extractConst(source, "TECLA_DESCONTO");
const TECLA_VALIDAR = extractConst(source, "TECLA_VALIDAR");
const letraDoMetodo = extractFunction(source, "letraDoMetodo", { LETRAS_METODO });

// ── Montagem do patch sobre um mock da base (o que `super` enxerga) ───────

const baseMock = {
    setup() {
        this.__superSetupCalled = true;
        // o core define payment_methods_from_config (payment_screen.js:42-44)
        this.payment_methods_from_config = this.__metodos;
    },
};

const PATCH_MARKER = "patch(PaymentScreen.prototype,";
const markerIdx = source.indexOf(PATCH_MARKER);
assert(markerIdx !== -1, `não achou "${PATCH_MARKER}" em atalhos_pagamento.js`);
const objLiteral = extractBalanced(source, source.indexOf("{", markerIdx));

/** Cria um `this` mockado, com o patch na cadeia de protótipos. */
function makeThis({ metodos = [], linhaSelecionada = null } = {}) {
    const registros = [];
    const useHotkey = (tecla, cb) => registros.push({ tecla, cb });
    const patchObj = new Function(
        "useHotkey",
        "letraDoMetodo",
        "TECLA_VALIDAR",
        "TECLA_ACRESCIMO",
        "TECLA_DESCONTO",
        `return (${objLiteral});`
    )(useHotkey, letraDoMetodo, TECLA_VALIDAR, TECLA_ACRESCIMO, TECLA_DESCONTO);

    Object.setPrototypeOf(patchObj, baseMock);

    const ctx = Object.create(patchObj);
    Object.assign(ctx, {
        __metodos: metodos,
        registros,
        chamadas: { addNewPaymentLine: [], validateOrder: 0, acrescimo: 0, desconto: 0 },
        addNewPaymentLine(metodo) {
            this.chamadas.addNewPaymentLine.push(metodo.id);
        },
        validateOrder() {
            this.chamadas.validateOrder++;
        },
        clickAcrescimoButton() {
            this.chamadas.acrescimo++;
        },
        clickDescontoButton() {
            this.chamadas.desconto++;
        },
    });
    Object.defineProperty(ctx, "selectedPaymentLine", {
        get: () => linhaSelecionada,
        configurable: true,
    });
    return ctx;
}

/** Roda setup() e devolve o mapa tecla -> callback registrado. */
function registrar(ctx) {
    ctx.setup();
    const mapa = {};
    for (const { tecla, cb } of ctx.registros) {
        assert(!(tecla in mapa), `tecla "${tecla}" registrada duas vezes (colisão de atalho)`);
        mapa[tecla] = cb;
    }
    return mapa;
}

const metodos = (n) => Array.from({ length: n }, (_, i) => ({ id: i + 1, name: "PM" + (i + 1) }));

// ── Grupo A: mapping índice -> letra ─────────────────────────────────────

// A1: as 5 primeiras posições da ordem de render ganham A..E
{
    assert.deepStrictEqual(
        [...LETRAS_METODO],
        ["a", "b", "c", "d", "e"],
        "LETRAS_METODO deve ser a..e (ordem de render dos métodos)"
    );
    assert.deepStrictEqual(
        [0, 1, 2, 3, 4].map(letraDoMetodo),
        ["a", "b", "c", "d", "e"],
        "letraDoMetodo(0..4) deve dar a..e"
    );
    console.log("✓ A1: letraDoMetodo(0..4) = a..e");
}

// A2: método 6+ fica sem atalho (limitação documentada na spec)
{
    for (const indice of [5, 6, 9, 42]) {
        assert.strictEqual(
            letraDoMetodo(indice),
            null,
            `letraDoMetodo(${indice}) deve ser null (método 6+ sem atalho)`
        );
    }
    console.log("✓ A2: método 6+ sem atalho (null)");
}

// A3: índice inválido não explode nem vaza letra.
// (Índice numérico-em-string — "2" — cai na semântica de array do JS e devolve
// "c"; o chamador real é sempre o índice do t-foreach/forEach, que é number.
// Não vale um guard de Number.isInteger para um input impossível.)
{
    for (const indice of [-1, -10, 1.5, undefined, null, {}, [], true]) {
        assert.strictEqual(letraDoMetodo(indice), null, `letraDoMetodo(${indice}) deve ser null`);
    }
    console.log("✓ A3: índice inválido -> null");
}

// A4: o badge usa a MESMA fonte do atalho, em maiúscula
{
    const ctx = makeThis({ metodos: metodos(2) });
    assert.strictEqual(ctx.letraAtalhoMetodo(0), "A", "badge da posição 0 = A");
    assert.strictEqual(ctx.letraAtalhoMetodo(1), "B", "badge da posição 1 = B");
    assert.strictEqual(ctx.letraAtalhoMetodo(5), "", "posição 5 não tem badge (falsy -> t-if esconde)");
    assert.strictEqual(
        ctx.letraAtalhoMetodo(3),
        letraDoMetodo(3).toUpperCase(),
        "badge e atalho saem do mesmo letraDoMetodo()"
    );
    console.log("✓ A4: badge alinhado ao atalho (mesma fonte)");
}

// ── Grupo B: teclas registradas — sem colisão e dentro do whitelist ───────

// Whitelist do core, transcrita de:
//   addons/web/static/src/core/hotkeys/hotkey_service.js:33-50
//   ALPHANUM_KEYS = a-z + 0-9 ; NAV_KEYS = setas, page*, home/end, backspace,
//   enter, tab, delete, space ; MODIFIERS = alt/control/shift ;
//   AUTHORIZED_KEYS = ALPHANUM + NAV + ["escape"]
const WHITELIST_CORE = new Set([
    ..."abcdefghijklmnopqrstuvwxyz0123456789".split(""),
    "arrowleft", "arrowright", "arrowup", "arrowdown",
    "pageup", "pagedown", "home", "end", "backspace",
    "enter", "tab", "delete", "space", "escape",
]);

// B1: nenhuma tecla registrada pode estar fora do whitelist do core.
// Se estiver, `useHotkey` LANÇA erro no registro (hotkey_service.js:411-415)
// — o que derrubaria o setup() inteiro da PaymentScreen, não só o atalho.
{
    const ctx = makeThis({ metodos: metodos(5) });
    const teclas = Object.keys(registrar(ctx));
    for (const tecla of teclas) {
        assert(
            WHITELIST_CORE.has(tecla),
            `tecla "${tecla}" não está no AUTHORIZED_KEYS do core (hotkey_service.js:50) ` +
                `— useHotkey lançaria erro (hotkey_service.js:411) e quebraria a PaymentScreen`
        );
    }
    console.log(`✓ B1: todas as teclas no whitelist do core (${teclas.join(", ")})`);
}

// B2: F2/F3 NÃO podem ser usadas — é a razão de S/R existirem.
{
    for (const tecla of ["f1", "f2", "f3", "f12"]) {
        assert(
            !WHITELIST_CORE.has(tecla),
            `"${tecla}" deveria estar FORA do whitelist do core (a prova que motivou trocar por letras)`
        );
    }
    const ctx = makeThis({ metodos: metodos(5) });
    const teclas = Object.keys(registrar(ctx));
    assert(
        !teclas.some((t) => /^f\d+$/.test(t)),
        "nenhum atalho pode ser F-key: useHotkey('f2') lança erro no Odoo 18"
    );
    console.log("✓ B2: nenhuma F-key registrada (F2/F3 impossíveis via hotkey service)");
}

// B3: as teclas fixas não podem colidir com as letras dos métodos.
// "d" seria o 4º método (A,B,C,D,E) — por isso o desconto NÃO é "d".
{
    const fixas = [TECLA_ACRESCIMO, TECLA_DESCONTO, TECLA_VALIDAR];
    for (const tecla of fixas) {
        assert(
            !LETRAS_METODO.includes(tecla),
            `tecla fixa "${tecla}" colide com uma letra de método (${LETRAS_METODO.join(", ")})`
        );
    }
    assert.strictEqual(TECLA_ACRESCIMO, "s", "acréscimo = s (Soma)");
    assert.strictEqual(TECLA_DESCONTO, "r", "desconto = r (Redução); 'd' é o 4º método");
    assert.strictEqual(TECLA_VALIDAR, "enter", "validar = enter");
    console.log("✓ B3: teclas fixas (s/r/enter) disjuntas das letras de método");
}

// ── Grupo C: setup() registra os atalhos ─────────────────────────────────

// C1: 5 métodos -> A..E + enter + s + r
{
    const ctx = makeThis({ metodos: metodos(5) });
    const mapa = registrar(ctx);
    assert(ctx.__superSetupCalled, "setup() deve chamar super.setup()");
    assert.deepStrictEqual(
        Object.keys(mapa).sort(),
        ["a", "b", "c", "d", "e", "enter", "r", "s"],
        "com 5 métodos deve registrar a-e + enter + r + s"
    );
    console.log("✓ C1: 5 métodos -> a-e + enter + s + r");
}

// C2: 8 métodos -> só as 5 letras (a..e), o resto sem atalho
{
    const ctx = makeThis({ metodos: metodos(8) });
    const mapa = registrar(ctx);
    const letras = Object.keys(mapa).filter((t) => LETRAS_METODO.includes(t));
    assert.deepStrictEqual(letras.sort(), ["a", "b", "c", "d", "e"], "no máximo 5 letras");
    console.log("✓ C2: 8 métodos -> 5 letras + fixas");
}

// C3: sem método nenhum (ou 1) -> só as teclas fixas, sem explode
{
    for (const n of [0, 1]) {
        const ctx = makeThis({ metodos: metodos(n) });
        const mapa = registrar(ctx);
        const letras = Object.keys(mapa).filter((t) => LETRAS_METODO.includes(t));
        assert.strictEqual(letras.length, n, `com ${n} método(s) deve ter ${n} letra(s)`);
        assert(mapa.enter && mapa[TECLA_ACRESCIMO] && mapa[TECLA_DESCONTO], "fixas sempre presentes");
    }
    console.log("✓ C3: 0/1 método -> só teclas fixas");
}

// C4: a letra adiciona a linha do método CERTO (o daquela posição na tela)
{
    const lista = metodos(5); // ids 1..5
    const ctx = makeThis({ metodos: lista });
    const mapa = registrar(ctx);
    for (const [indice, letra] of LETRAS_METODO.entries()) {
        mapa[letra]();
        assert.deepStrictEqual(
            ctx.chamadas.addNewPaymentLine,
            [lista[indice].id],
            `"${letra}" deve adicionar o método da posição ${indice}`
        );
        ctx.chamadas.addNewPaymentLine.length = 0;
    }
    console.log("✓ C4: cada letra adiciona o método da sua posição");
}

// C5: as letras usam o MESMO handler do clique (addNewPaymentLine)
{
    const ctx = makeThis({ metodos: metodos(1) });
    const mapa = registrar(ctx);
    assert.strictEqual(typeof ctx.addNewPaymentLine, "function");
    mapa.a();
    assert.strictEqual(ctx.chamadas.addNewPaymentLine.length, 1, "letra delega ao handler do clique");
    console.log("✓ C5: letra delega para addNewPaymentLine");
}

// ── Grupo D: guard do Enter (DEC-003) ────────────────────────────────────

// D1: sem linha selecionada -> valida
{
    const ctx = makeThis({ metodos: metodos(3), linhaSelecionada: null });
    registrar(ctx).enter();
    assert.strictEqual(ctx.chamadas.validateOrder, 1, "Enter sem linha selecionada deve validar");
    console.log("✓ D1: Enter sem linha selecionada valida");
}

// D2: com linha selecionada -> NÃO intercepta (o core segue dono do Enter/buffer)
{
    const ctx = makeThis({ metodos: metodos(3), linhaSelecionada: { uuid: "line-1" } });
    registrar(ctx).enter();
    assert.strictEqual(
        ctx.chamadas.validateOrder,
        0,
        "com linha selecionada o Enter NÃO pode validar (senão valida no meio da edição de valor)"
    );
    console.log("✓ D2: Enter com linha selecionada não valida (guard do DEC-003)");
}

// D3: o atalho espelha o botão Validar — sem guard extra de canBeValidated
// (o botão do core chama validateOrder() direto; o core mostra o alerta dele)
{
    const ctx = makeThis({ metodos: metodos(1), linhaSelecionada: null });
    ctx.currentOrder = { canBeValidated: () => false };
    registrar(ctx).enter();
    assert.strictEqual(
        ctx.chamadas.validateOrder,
        1,
        "deve espelhar o botão Validar (validateOrder cuida do caso não-validável)"
    );
    console.log("✓ D3: Enter espelha o botão Validar");
}

// ── Grupo E: acréscimo / desconto (handlers existentes, zero lógica nova) ─

// E1/E2: as teclas chamam os handlers já existentes dos patches do módulo
{
    const ctx = makeThis({ metodos: metodos(2) });
    const mapa = registrar(ctx);
    mapa[TECLA_ACRESCIMO]();
    assert.strictEqual(ctx.chamadas.acrescimo, 1, "'s' deve chamar clickAcrescimoButton()");
    mapa[TECLA_DESCONTO]();
    assert.strictEqual(ctx.chamadas.desconto, 1, "'r' deve chamar clickDescontoButton()");
    console.log("✓ E1/E2: s -> clickAcrescimoButton, r -> clickDescontoButton");
}

// E3: nenhum listener de teclado próprio no arquivo (só useHotkey do core)
{
    assert(
        !/addEventListener|onKeydown|window\./.test(source),
        "atalhos_pagamento.js não pode ter listener de teclado próprio (DEC-002)"
    );
    assert(
        /from "@web\/core\/hotkeys\/hotkey_hook"/.test(source),
        "deve importar useHotkey de @web/core/hotkeys/hotkey_hook"
    );
    console.log("✓ E3: só useHotkey do core, sem listener próprio");
}

// ── Grupo F: manifest ────────────────────────────────────────────────────

{
    const start = manifest.indexOf("'point_of_sale._assets_pos'");
    const end = manifest.indexOf("'web.assets_web'");
    assert(start !== -1 && end > start, "não achou o bloco point_of_sale._assets_pos");
    const block = manifest.slice(start, end);

    const jsIdx = block.indexOf("static/src/js/atalhos_pagamento.js");
    const xmlIdx = block.indexOf("static/src/xml/atalhos_pagamento.xml");
    assert(jsIdx !== -1, "atalhos_pagamento.js deve estar em point_of_sale._assets_pos");
    assert(xmlIdx !== -1, "atalhos_pagamento.xml deve estar em point_of_sale._assets_pos");
    assert(jsIdx < xmlIdx, "o JS deve vir ANTES do XML");
    console.log("✓ F1: JS e XML registrados em _assets_pos (JS antes)");

    // O CSS do badge precisa estar num arquivo que o manifest realmente carrega,
    // senão o badge sai sem estilo em produção.
    const cssDir = path.join(MODULE_ROOT, "static", "src", "css");
    const comBadge = fs
        .readdirSync(cssDir)
        .filter((f) => fs.readFileSync(path.join(cssDir, f), "utf8").includes("payment-method-hotkey"));
    assert(comBadge.length === 1, `exatamente 1 css deve ter a regra do badge (achou ${comBadge})`);
    assert(
        block.includes(`static/src/css/${comBadge[0]}`),
        `static/src/css/${comBadge[0]} (regra .payment-method-hotkey) deve estar em _assets_pos`
    );
    console.log(`✓ F2: CSS do badge (${comBadge[0]}) registrado em _assets_pos`);
}

// ── Grupo G: manifest declara o teste? (o manifest não lista tests/) ─────
{
    // Sanidade: o arquivo de teste vive em tests/ (convenção do repo) e o
    // manifest não precisa (nem deve) registrá-lo em assets.
    assert(
        !manifest.includes("tests/test_atalhos_pagamento.js"),
        "teste Node não vai no manifest"
    );
    console.log("✓ G1: teste fora do manifest (assets são só de runtime)");
}

// ── Grupo H: contrato do XML do badge ────────────────────────────────────
// O Odoo não roda localmente: validar a forma do template pega o erro que
// quebraria a tela inteira (xpath errado, tag aberta, t-raw).
{
    const xml = fs.readFileSync(
        path.join(MODULE_ROOT, "static", "src", "xml", "atalhos_pagamento.xml"),
        "utf8"
    );
    // Comentários fora: eles CITAM os padrões proibidos ("nada de
    // position=replace") e dariam falso positivo. Só a marcação conta.
    const markup = xml.replace(/<!--[\s\S]*?-->/g, "");

    // H1: tags balanceadas
    {
        const tagRe = /<(\/?)([A-Za-z_][\w.:-]*)([\s\S]*?)(\/?)>/g;
        const stack = [];
        let m;
        while ((m = tagRe.exec(markup))) {
            const [, closing, name, , selfClosing] = m;
            if (name.startsWith("?") || name.startsWith("!")) continue;
            if (closing) {
                assert.strictEqual(stack.pop(), name, `tag </${name}> fecha a tag certa`);
            } else if (!selfClosing) {
                stack.push(name);
            }
        }
        assert.deepStrictEqual(stack, [], `tags não fechadas: ${stack.join(", ")}`);
        console.log("✓ H1: XML bem-formado");
    }

    // H2: herda o template dos métodos do core, em modo extension (modifica o
    // core de propósito: é o botão da tela que ganha o badge)
    assert(
        /<t\s+t-inherit="point_of_sale\.PaymentScreenMethods"\s+t-inherit-mode="extension"/.test(markup),
        "deve herdar point_of_sale.PaymentScreenMethods com t-inherit-mode='extension'"
    );
    console.log("✓ H2: herda point_of_sale.PaymentScreenMethods");

    // H3: position="inside" no botão do método, nunca "replace".
    //
    // O expr é fixado LITERALMENTE de propósito: um regex frouxo passaria com
    // um caminho que casa ZERO nós, e o xpath que não casa falha em silêncio
    // (o badge só não aparece, sem erro nenhum). Este valor foi verificado
    // contra o template do core:
    //   xmllint --xpath "count(//div[contains(concat(' ', @class, ' '),
    //     ' paymentmethods ')]//div[contains(concat(' ', @class, ' '),
    //     ' paymentmethod ')])" addons/point_of_sale/.../payment_screen.xml  ->  1
    // A armadilha: entre o container e o botão existe um <t t-foreach>, então
    // "div/div" (filho direto) casa 0. Por isso o "//" é obrigatório.
    {
        const EXPR =
            "//div[hasclass('paymentmethods')]//div[hasclass('paymentmethod')]";
        const exprMatch = markup.match(/<xpath expr="([^"]+)" position="inside"/);
        assert(exprMatch, "deve haver um xpath position='inside'");
        assert.strictEqual(
            exprMatch[1],
            EXPR,
            "expr deve ser exatamente o caminho verificado (o '//' pula o <t t-foreach>; " +
                "'div/div' casaria 0 nós e o badge não apareceria)"
        );
        assert(!/position="replace"/.test(markup), "position='replace' quebraria o DOM de outros módulos");
        console.log("✓ H3: position='inside' com o expr verificado (sem replace)");
    }

    // H4: letra sai por t-esc, nunca t-raw
    assert(/<span class="payment-method-hotkey" t-esc="[^"]+"/.test(markup), "badge via t-esc");
    assert(!/t-raw/.test(markup), "t-raw é XSS-unsafe");
    console.log("✓ H4: badge com t-esc (sem t-raw)");

    // H5: nenhum node mistura class estático com t-att-class/t-attf-class
    // (o motor do QWeb SOBRESCREVE a chave class em vez de fazer merge)
    {
        const tagRe = /<([A-Za-z_][\w.:-]*)((?:[^>"']|"[^"]*"|'[^']*')*)\/?>/g;
        const misturados = [];
        let m;
        while ((m = tagRe.exec(markup))) {
            const attrs = m[2];
            if (/(^|\s)class="/.test(attrs) && /t-att-?f?-class=/.test(attrs)) {
                misturados.push(m[1]);
            }
        }
        assert.deepStrictEqual(misturados, [], `misturam class + t-att-class: ${misturados}`);
        console.log("✓ H5: sem o gotcha class + t-att-class");
    }

    // H6: o badge é gated por letraAtalhoMetodo (método 6+ fica sem badge) e
    // usa o índice do t-foreach do core (mesma ordem dos atalhos)
    assert(
        /t-if="letraAtalhoMetodo\(paymentMethod_index\)"/.test(markup),
        "badge deve ser condicionado a letraAtalhoMetodo(paymentMethod_index)"
    );
    console.log("✓ H6: badge gated pelos métodos com atalho");
}

console.log("\nTodos os testes passaram ✓");
