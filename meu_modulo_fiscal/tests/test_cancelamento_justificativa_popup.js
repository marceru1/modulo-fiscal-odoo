/**
 * Teste unitário (Node puro, sem Odoo) do ticket 05 da feature
 * cancelar-cupom-nfce-pdv: popup de justificativa do cancelamento na SEFAZ.
 *
 * O Odoo não roda localmente, então o teste lê o arquivo real e:
 *   1. extrai a constante MIN_JUSTIFICATIVA DO PRÓPRIO ARQUIVO (o piso de 15
 *      mora num lugar só — middleware e frontend não podem divergir em
 *      silêncio);
 *   2. extrai a classe CancelamentoJustificativaPopup (balanceando chaves) e a
 *      instancia sobre mocks de useState/useRef/onMounted/useHotkey;
 *   3. confere o contrato do XML (t-name casa com o static template, sem
 *      t-raw, sem class+t-att-class misturados, XML bem-formado).
 *
 * Por que o popup existe em vez de reusar o TextInputPopup do core: o do core
 * (input_popups/text_input_popup.js) não tem prop `minLength` — o botão Apply
 * fica sempre habilitado. Há teste pra isso (grupo E).
 *
 * Rodar: node meu_modulo_fiscal/tests/test_cancelamento_justificativa_popup.js
 */
const fs = require("fs");
const path = require("path");
const assert = require("assert");

const MODULE_ROOT = path.join(__dirname, "..");
const JS_PATH = path.join(
    MODULE_ROOT, "static", "src", "js", "cancelamento_justificativa_popup.js"
);
const XML_PATH = path.join(
    MODULE_ROOT, "static", "src", "xml", "cancelamento_justificativa_popup.xml"
);
const MANIFEST_PATH = path.join(MODULE_ROOT, "__manifest__.py");

const source = fs.readFileSync(JS_PATH, "utf8");
const xml = fs.readFileSync(XML_PATH, "utf8");
const manifest = fs.readFileSync(MANIFEST_PATH, "utf8");

/** Só a marcação conta: os comentários dão falso positivo nos padrões proibidos. */
const markup = xml.replace(/<!--[\s\S]*?-->/g, "");

// ── Extração do que o arquivo declara (sem reimplementar) ─────────────────

/** Extrai `export const NAME = <literal>;` e devolve o valor avaliado. */
function extractConst(src, name) {
    const re = new RegExp(`export const ${name} = ([^;]+);`);
    const m = src.match(re);
    assert(m, `não achou "export const ${name}"`);
    return new Function(`return (${m[1]});`)();
}

/** Balanceia chaves/parênteses/colchetes ignorando strings. */
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
    throw new Error("bloco não balanceado");
}

const MIN_JUSTIFICATIVA = extractConst(source, "MIN_JUSTIFICATIVA");

/**
 * Instancia o popup real sobre mocks dos hooks do Owl.
 * `getPayload` modela o makeAwaitable: resolve só na PRIMEIRA chamada.
 */
function montar() {
    const marker = "class CancelamentoJustificativaPopup extends Component";
    const idx = source.indexOf(marker);
    assert(idx !== -1, `não achou "${marker}"`);
    const body = extractBalanced(source, source.indexOf("{", idx));
    const classSrc = source.slice(idx, source.indexOf("{", idx)) + body;

    // O ComponentNode do Owl faz `new C(props, env, node)` (o mesmo contrato
    // que test_confirm_sale_popup.js documenta): é o construtor da base que
    // pendura this.props — a subclasse não declara construtor próprio.
    class Component {
        constructor(props) {
            this.props = props;
        }
    }
    class Dialog {}
    const registrosGlobais = [];
    const useHotkey = (tecla, cb) => registrosGlobais.push({ tecla, cb });
    const useState = (obj) => obj;
    let focado = false;
    let refAtual = null;
    const useRef = (name) => {
        refAtual = { name, el: { focus: () => (focado = true) } };
        return refAtual;
    };
    // Owl chama o callback do hook com o componente como `this` (é por isso que
    // o core escreve `onMounted(this.onMounted)`), então o mock faz o mesmo.
    let componenteAtual = null;
    const onMounted = (cb) => cb.call(componenteAtual);

    const Cls = new Function(
        "Component",
        "Dialog",
        "useState",
        "useRef",
        "onMounted",
        "useHotkey",
        // O corpo da classe fecha sobre a constante de módulo — o piso de
        // caracteres entra aqui pelo valor lido do arquivo (A1 garante que ele
        // continua sendo 15).
        "MIN_JUSTIFICATIVA",
        `${classSrc}; return CancelamentoJustificativaPopup;`
    )(Component, Dialog, useState, useRef, onMounted, useHotkey, MIN_JUSTIFICATIVA);

    const chamadas = { getPayload: [], close: 0 };
    let resolvido;
    let jaResolveu = false;
    const ctx = new Cls({
        title: "Cancelar cupom na SEFAZ",
        getPayload: (v) => {
            chamadas.getPayload.push(v);
            if (!jaResolveu) {
                jaResolveu = true;
                resolvido = v;
            }
        },
        close: () => chamadas.close++,
    });
    componenteAtual = ctx;
    ctx.setup();

    const mapa = {};
    for (const { tecla, cb } of registrosGlobais) {
        mapa[tecla] = cb;
    }
    return {
        ctx,
        mapa,
        chamadas,
        refAtual,
        get focado() {
            return focado;
        },
        get resolvido() {
            return resolvido;
        },
        digitar(texto) {
            ctx.state.inputValue = texto;
        },
    };
}

// ── Grupo A: o piso de caracteres é UM só ────────────────────────────────

// A1: o arquivo é a fonte do 15 (o teste não repete o número mágico)
{
    assert.strictEqual(MIN_JUSTIFICATIVA, 15, "MIN_JUSTIFICATIVA deve ser 15");
    console.log("✓ A1: MIN_JUSTIFICATIVA = 15, lido do próprio arquivo");
}

// A2: o XML não repete o número — fala pelo getter `faltam`
{
    assert(
        /t-esc="faltam"/.test(markup),
        "o contador deve usar o getter faltam, não um literal"
    );
    console.log("✓ A2: contador vem do getter faltam");
}

// ── Grupo B: validação do mínimo ─────────────────────────────────────────

// B1: 14 caracteres → botão desabilitado
{
    const m = montar();
    m.digitar("x".repeat(MIN_JUSTIFICATIVA - 1));
    assert.strictEqual(m.ctx.valido, false, "14 chars não é válido");
    assert.strictEqual(m.ctx.confirmDisabled, true, "14 chars → Confirmar desabilitado");
    console.log("✓ B1: 14 caracteres → Confirmar desabilitado");
}

// B2: 15 caracteres → habilitado (limite inclusivo)
{
    const m = montar();
    m.digitar("Venda cancelada a pedido do cliente.".slice(0, MIN_JUSTIFICATIVA));
    assert.strictEqual(m.ctx.justificativa.length, MIN_JUSTIFICATIVA);
    assert.strictEqual(m.ctx.valido, true, "15 chars é válido");
    assert.strictEqual(m.ctx.confirmDisabled, false, "15 chars → Confirmar habilitado");
    console.log("✓ B2: 15 caracteres → Confirmar habilitado");
}

// B3: espaço em branco não conta (trim antes de medir) — "               "
// passaria no length() cru e mandaria uma justificativa vazia pra SEFAZ
{
    const m = montar();
    m.digitar(" ".repeat(MIN_JUSTIFICATIVA));
    assert.strictEqual(m.ctx.valido, false, "só espaços não é justificativa");
    assert.strictEqual(m.ctx.confirmDisabled, true, "só espaços → desabilitado");
    console.log("✓ B3: só espaços não habilita");
}

// B4: contador de restantes
{
    const m = montar();
    m.digitar("abc");
    assert.strictEqual(m.ctx.faltam, MIN_JUSTIFICATIVA - 3, "'abc' → faltam 12");
    m.digitar("a".repeat(MIN_JUSTIFICATIVA + 5));
    assert.strictEqual(m.ctx.faltam, 0, "acima do mínimo → faltam 0 (nunca negativo)");
    console.log("✓ B4: faltam satura em 0");
}

// B5: confirmar com menos do que o mínimo não manda NADA
{
    const m = montar();
    m.digitar("curta");
    m.ctx.confirmar();
    assert.deepStrictEqual(m.chamadas.getPayload, [], "não pode enviar payload inválido");
    assert.strictEqual(m.chamadas.close, 0, "não pode fechar");
    console.log("✓ B5: confirmar inválido é no-op");
}

// ── Grupo C: confirmação ─────────────────────────────────────────────────

// C1: confirmar válido envia a justificativa SEM espaços nas pontas e fecha
{
    const m = montar();
    m.digitar("  Venda cancelada a pedido do cliente.  ");
    m.ctx.confirmar();
    assert.deepStrictEqual(
        m.chamadas.getPayload,
        ["Venda cancelada a pedido do cliente."],
        "envia o texto trimado"
    );
    assert.strictEqual(m.resolvido, "Venda cancelada a pedido do cliente.");
    assert.strictEqual(m.chamadas.close, 1, "fecha o popup");
    console.log("✓ C1: confirmar envia trimado + close");
}

// C2: duplo-clique no Confirmar não manda duas solicitações
{
    const m = montar();
    m.digitar("Venda cancelada a pedido do cliente.");
    m.ctx.confirmar();
    m.ctx.confirmar();
    assert.strictEqual(m.chamadas.getPayload.length, 1, "só um payload (trava de duplo-clique)");
    assert.strictEqual(m.chamadas.close, 1, "só um close");
    console.log("✓ C2: duplo-clique manda uma só");
}

// ── Grupo D: abortar ─────────────────────────────────────────────────────

// D1: cancelar() fecha SEM payload — o makeAwaitable resolve undefined e o
// atalho N não chama o backend (mesmo caminho do Esc)
{
    const m = montar();
    m.ctx.cancelar();
    assert.deepStrictEqual(m.chamadas.getPayload, [], "cancelar não pode enviar payload");
    assert.strictEqual(m.chamadas.close, 1, "cancelar fecha");
    assert.strictEqual(m.resolvido, undefined, "resolve undefined (operador desistiu)");
    console.log("✓ D1: cancelar() → undefined, sem payload");
}

// D2: Esc aborta
{
    const m = montar();
    assert(m.mapa.escape, "deve registrar a tecla escape");
    m.mapa.escape();
    assert.deepStrictEqual(m.chamadas.getPayload, [], "Esc não pode enviar payload");
    assert.strictEqual(m.chamadas.close, 1, "Esc fecha");
    console.log("✓ D2: Esc aborta sem payload");
}

// D3: NÃO registra Enter — o campo é textarea, Enter é nova linha.
// Um Enter-confirma cortaria a justificativa no meio da digitação.
{
    const m = montar();
    assert(
        !m.mapa.enter,
        "não pode registrar Enter: em textarea ele insere nova linha"
    );
    console.log("✓ D3: sem Enter (textarea)");
}

// D4: o campo é focado ao montar (o operador só digita)
{
    const m = montar();
    assert.strictEqual(m.refAtual.name, "input", "usa t-ref='input'");
    assert.strictEqual(m.focado, true, "foca o textarea no onMounted");
    console.log("✓ D4: textarea focado ao abrir");
}

// ── Grupo E: contrato com o template e o manifest ────────────────────────

// E1: static template casa com o t-name do XML
{
    const tam = source.match(/static template = "([^"]+)"/);
    assert(tam, "deve declarar static template");
    assert.strictEqual(
        tam[1], "meu_modulo_fiscal.CancelamentoJustificativaPopup"
    );
    assert(
        new RegExp(`<t t-name="${tam[1]}"`).test(markup),
        "o XML deve registrar t-name igual ao static template"
    );
    console.log("✓ E1: static template casa com o t-name");
}

// E2: XML bem-formado (tag stack)
{
    const tagRe = /<(\/?)([A-Za-z_][\w.:-]*)([\s\S]*?)(\/?)>/g;
    const stack = [];
    let m;
    while ((m = tagRe.exec(markup))) {
        const [, closing, name, , selfClosing] = m;
        if (name.startsWith("?") || name.startsWith("!")) continue;
        if (closing) {
            assert.strictEqual(stack.pop(), name, `tag </${name}> fecha a certa`);
        } else if (!selfClosing) {
            stack.push(name);
        }
    }
    assert.deepStrictEqual(stack, [], `tags não fechadas: ${stack.join(", ")}`);
    console.log("✓ E2: XML bem-formado");
}

// E3: sem t-raw (XSS) e sem misturar class com t-att-class no mesmo nó
{
    assert(!/t-raw/.test(markup), "t-raw é XSS-unsafe");
    const tagRe = /<([A-Za-z_][\w.:-]*)((?:[^>"']|"[^"]*"|'[^']*')*)\/?>/g;
    const misturados = [];
    let m;
    while ((m = tagRe.exec(markup))) {
        if (/(^|\s)class="/.test(m[2]) && /t-att-?f?-class=/.test(m[2])) {
            misturados.push(m[1]);
        }
    }
    assert.deepStrictEqual(misturados, [], `misturam class + t-att-class: ${misturados}`);
    console.log("✓ E3: sem t-raw nem class+t-att-class");
}

// E4: sem entidades HTML nomeadas no XML (lxml do Odoo é estrito: entidade não
// declarada derruba o bundle do POS inteiro)
{
    const entidades = markup.match(/&[a-zA-Z]{2,};/g) || [];
    assert.deepStrictEqual(entidades, [], `entidades HTML: ${entidades.join(", ")}`);
    console.log("✓ E4: sem entidades HTML nomeadas");
}

// E5: o botão Confirmar é desabilitado pelo getter, não por lógica no XML
{
    assert(
        /t-att-disabled="confirmDisabled"/.test(markup),
        "o Confirmar usa confirmDisabled"
    );
    console.log("✓ E5: Confirmar dirigido por confirmDisabled");
}

// E6: manifest — JS antes do XML, teste fora
{
    const start = manifest.indexOf("'point_of_sale._assets_pos'");
    const end = manifest.indexOf("'web.assets_web'");
    assert(start !== -1 && end > start, "não achou o bloco point_of_sale._assets_pos");
    const block = manifest.slice(start, end);
    const jsIdx = block.indexOf("static/src/js/cancelamento_justificativa_popup.js");
    const xmlIdx = block.indexOf("static/src/xml/cancelamento_justificativa_popup.xml");
    assert(jsIdx !== -1, "o JS deve estar em point_of_sale._assets_pos");
    assert(xmlIdx !== -1, "o XML deve estar em point_of_sale._assets_pos");
    assert(jsIdx < xmlIdx, "o JS deve vir ANTES do XML");
    assert(
        !manifest.includes("tests/test_cancelamento_justificativa_popup.js"),
        "teste Node não vai no manifest"
    );
    console.log("✓ E6: JS e XML no manifest (JS antes); teste fora");
}

console.log("\nTodos os testes passaram ✓");
