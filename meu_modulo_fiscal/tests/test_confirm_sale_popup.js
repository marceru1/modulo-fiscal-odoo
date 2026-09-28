/**
 * Teste unitário (Node puro, sem Odoo) do ticket 02 da feature
 * atalhos-teclado-pdv: popup "Deseja confirmar a venda?" operável só por teclado
 * (Enter = Sim / Esc = Não), sem patch no SelectionPopup do core.
 *
 * Estratégia (a mesma de test_atalhos_pagamento.js): o Odoo não roda localmente,
 * então o teste lê o arquivo real e:
 *   1. extrai as constantes exportadas (ID_SIM / ID_NAO) DO PRÓPRIO ARQUIVO;
 *   2. extrai a classe ConfirmSalePopup (balanceando as chaves) e a instancia
 *      sobre um mock do SelectionPopup do core — o mock é a TRANSCRIÇÃO de
 *      selection_popup.js:33-47 (setup/selectItem/computePayload/confirm), para
 *      que o payload saia da mesma conta que o core faz em produção;
 *   3. mocka useHotkey para espiar as teclas registradas e disparar os callbacks.
 *
 * O mock só é fiel se o popup NÃO sobrescrever esses métodos — há teste pra isso
 * (G1): a classe adiciona teclas, não reimplementa o popup.
 *
 * Rodar: node meu_modulo_fiscal/tests/test_confirm_sale_popup.js
 */
const fs = require("fs");
const path = require("path");
const assert = require("assert");

const MODULE_ROOT = path.join(__dirname, "..");
const JS_PATH = path.join(MODULE_ROOT, "static", "src", "js", "confirm_sale_popup.js");
const XML_PATH = path.join(MODULE_ROOT, "static", "src", "xml", "confirm_sale_popup.xml");
const CONFIRM_POPUP_PATH = path.join(MODULE_ROOT, "static", "src", "js", "confirm_popup.js");
const CPF_POPUP_PATH = path.join(MODULE_ROOT, "static", "src", "js", "cpf_input_popup.js");
const MANIFEST_PATH = path.join(MODULE_ROOT, "__manifest__.py");

const source = fs.readFileSync(JS_PATH, "utf8");
const confirmPopupSource = fs.readFileSync(CONFIRM_POPUP_PATH, "utf8");
const cpfPopupSource = fs.readFileSync(CPF_POPUP_PATH, "utf8");
const xml = fs.readFileSync(XML_PATH, "utf8");
const manifest = fs.readFileSync(MANIFEST_PATH, "utf8");

/** Só a marcação conta: os comentários CITAM os padrões proibidos e dariam falso positivo. */
const markup = xml.replace(/<!--[\s\S]*?-->/g, "");
const jsSemComentario = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

// ── Extração do que o arquivo declara (sem reimplementar) ─────────────────

/** Extrai `export const NAME = <literal>;` e devolve o valor avaliado. */
function extractConst(src, name) {
    const re = new RegExp(`export const ${name} = ([^;]+);`);
    const m = src.match(re);
    assert(m, `não achou "export const ${name}" em confirm_sale_popup.js`);
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

const ID_SIM = extractConst(source, "ID_SIM");
const ID_NAO = extractConst(source, "ID_NAO");

// ── Mock do SelectionPopup do core (transcrição de selection_popup.js:33-47) ─

class SelectionPopupMock {
    static template = "point_of_sale.SelectionPopup";
    static components = { Dialog: class Dialog {} };
    static props = {
        title: { type: String, optional: true },
        list: { type: Array, optional: true },
        getPayload: Function,
        close: Function,
    };
    static defaultProps = { title: "Select", list: [] };

    // O ComponentNode do Owl faz `new C(props, env, node)` e depois chama
    // setup() (owl.js:2430-2434) — o construtor NÃO chama setup.
    constructor(props) {
        this.props = props;
    }
    setup() {
        this.__superSetupCalled = true;
        this.state = { selectedId: this.props.list.find((item) => item.isSelected) };
    }
    selectItem(itemId) {
        this.state.selectedId = itemId;
        this.confirm();
    }
    computePayload() {
        const selected = this.props.list.find((item) => this.state.selectedId === item.id);
        return selected && selected.item;
    }
    confirm() {
        this.props.getPayload(this.computePayload());
        this.props.close();
    }
}

/** A classe real, extraída do arquivo e instanciada sobre o mock. */
function extractClass(src) {
    const marker = "class ConfirmSalePopup extends SelectionPopup";
    const idx = src.indexOf(marker);
    assert(idx !== -1, `não achou "${marker}" em confirm_sale_popup.js`);
    const body = extractBalanced(src, src.indexOf("{", idx));
    const classSrc = src.slice(idx, src.indexOf("{", idx)) + body;
    const useHotkey = (tecla, cb) => {
        registrosGlobais.push({ tecla, cb });
    };
    const registrosGlobais = [];
    const ConfirmSalePopup = new Function(
        "SelectionPopup",
        "useHotkey",
        "ID_SIM",
        "ID_NAO",
        `${classSrc}; return ConfirmSalePopup;`
    )(SelectionPopupMock, useHotkey, ID_SIM, ID_NAO);
    return { ConfirmSalePopup, registrosGlobais };
}

/** Lista idêntica à que o confirm_popup.js monta (ids pelos constantes). */
const LISTA = [
    { id: ID_SIM, label: "Sim", item: true },
    { id: ID_NAO, label: "Não", item: false },
];

/**
 * Instancia o popup e roda setup(), devolvendo o mapa tecla -> callback.
 * O mock de getPayload modela a semântica de Promise do makeAwaitable
 * (make_awaitable_dialog.js:8-16): `resolve` só vale na PRIMEIRA chamada.
 */
function montar() {
    const { ConfirmSalePopup, registrosGlobais } = extractClass(source);
    const chamadas = { getPayload: [], close: 0 };
    let resolvido;
    let jaResolveu = false;

    const ctx = new ConfirmSalePopup({
        title: "Deseja confirmar a venda?",
        list: LISTA,
        getPayload: (v) => {
            chamadas.getPayload.push(v);
            if (!jaResolveu) {
                jaResolveu = true;
                resolvido = v;
            }
        },
        close: () => chamadas.close++,
    });

    ctx.setup();

    const mapa = {};
    for (const { tecla, cb } of registrosGlobais) {
        assert(!(tecla in mapa), `tecla "${tecla}" registrada duas vezes no popup`);
        mapa[tecla] = cb;
    }
    return {
        ctx,
        mapa,
        chamadas,
        get resolvido() {
            return resolvido;
        },
        get jaResolveu() {
            return jaResolveu;
        },
    };
}

// ── Grupo A: as teclas registradas ───────────────────────────────────────

// A1: exatamente Enter e Esc — nada mais (o popup é Sim/Não)
{
    const { ctx, mapa } = montar();
    assert(ctx.__superSetupCalled, "setup() deve chamar super.setup()");
    assert.deepStrictEqual(
        Object.keys(mapa).sort(),
        ["enter", "escape"],
        "o popup deve registrar apenas enter e escape"
    );
    console.log("✓ A1: registra somente enter e escape");
}

// A2: as teclas estão no whitelist do core (senão useHotkey LANÇA erro no
// registro — hotkey_service.js:411-415 — e o popup não abre).
{
    const WHITELIST_CORE = new Set([
        ..."abcdefghijklmnopqrstuvwxyz0123456789".split(""),
        "arrowleft", "arrowright", "arrowup", "arrowdown",
        "pageup", "pagedown", "home", "end", "backspace",
        "enter", "tab", "delete", "space", "escape",
    ]);
    const { mapa } = montar();
    for (const tecla of Object.keys(mapa)) {
        assert(
            WHITELIST_CORE.has(tecla),
            `"${tecla}" fora do AUTHORIZED_KEYS (hotkey_service.js:50) — useHotkey lançaria erro`
        );
    }
    console.log("✓ A2: teclas dentro do AUTHORIZED_KEYS do core");
}

// A3: escape dispara mesmo com input focado (o core abre exceção pro Esc —
// hotkey_service.js:181-186: `singleKey !== "escape"`), então não é preciso
// bypassEditableProtection.
{
    assert(
        !/bypassEditableProtection/.test(jsSemComentario),
        "Esc não precisa de bypassEditableProtection (o core já abre exceção pro escape)"
    );
    console.log("✓ A3: sem bypassEditableProtection desnecessário");
}

// ── Grupo B: Enter = Sim ─────────────────────────────────────────────────

// B1: Enter resolve true (emite NFC-e)
{
    const m = montar();
    m.mapa.enter();
    assert.strictEqual(m.resolvido, true, "Enter deve resolver getPayload(true)");
    assert.strictEqual(m.chamadas.close, 1, "Enter deve fechar o popup");
    console.log("✓ B1: Enter -> getPayload(true) + close");
}

// B2: Enter marca o item selecionado — o mesmo caminho do clique no botão
{
    const m = montar();
    m.mapa.enter();
    assert.strictEqual(m.ctx.state.selectedId, ID_SIM, "Enter deve selecionar o item Sim");
    console.log("✓ B2: Enter usa o selectItem() do core (mesmo caminho do clique)");
}

// ── Grupo C: Esc = Não ───────────────────────────────────────────────────

// C1: Esc resolve false (venda não-fiscal), NÃO undefined.
// Se a registration de escape não vencesse a do Dialog (dialog.js:75), o
// dispatch cairia em Dialog.dismiss() -> onClose -> resolve() -> undefined.
{
    const m = montar();
    m.mapa.escape();
    assert.strictEqual(
        m.resolvido,
        false,
        "Esc deve resolver getPayload(false) — explícito, não undefined"
    );
    assert.strictEqual(m.chamadas.close, 1, "Esc deve fechar o popup");
    console.log("✓ C1: Esc -> getPayload(false) + close");
}

// C2: Esc marca o item Não
{
    const m = montar();
    m.mapa.escape();
    assert.strictEqual(m.ctx.state.selectedId, ID_NAO, "Esc deve selecionar o item Não");
    console.log("✓ C2: Esc usa o selectItem() do core");
}

// C3: a PRIMEIRA tecla vence (sem guard de reentrância).
// O makeAwaitable resolve a Promise; resolve() depois do primeiro é no-op
// (make_awaitable_dialog.js:9-11). Ou seja, o comportamento já é "primeira
// tecla manda" sem precisar de flag — e é isso que estes dois casos fixam.
{
    const enterDepoisEsc = montar();
    enterDepoisEsc.mapa.enter();
    enterDepoisEsc.mapa.escape();
    assert.strictEqual(enterDepoisEsc.resolvido, true, "Enter antes de Esc -> venda fiscal");

    const escDepoisEnter = montar();
    escDepoisEnter.mapa.escape();
    escDepoisEnter.mapa.enter();
    assert.strictEqual(escDepoisEnter.resolvido, false, "Esc antes de Enter -> venda não-fiscal");
    console.log("✓ C3: primeira tecla vence (Promise resolve 1x)");
}

// ── Grupo D: forma da classe (DEC-006 — subclasse, não patch) ────────────

// D1: subclasse de SelectionPopup, sem patch()
{
    assert(
        /class ConfirmSalePopup extends SelectionPopup/.test(source),
        "deve ser SUBCLASSE de SelectionPopup"
    );
    assert(
        !/patch\(/.test(jsSemComentario),
        "não pode usar patch(): um patch em SelectionPopup.prototype vazaria pra todo o Odoo (DEC-006)"
    );
    assert(
        !/from "@web\/core\/utils\/patch"/.test(source),
        "não deve nem importar patch"
    );
    console.log("✓ D1: subclasse, sem patch no core (DEC-006)");
}

// D2: template próprio, apontando pro nome que o XML declara como t-name
// (contrato entre JS e XML — se divergir, o OWL não acha o template)
{
    const tam = source.match(/static template = "([^"]+)"/);
    assert(tam, "deve declarar static template");
    assert.strictEqual(tam[1], "meu_modulo_fiscal.ConfirmSalePopup", "template do popup");
    assert(
        new RegExp(`<t t-name="${tam[1]}"`).test(markup),
        `o XML deve registrar t-name="${tam[1]}" (o mesmo do static template)`
    );
    console.log("✓ D2: static template casa com o t-name do XML");
}

// D3: reaproveita o core em vez de reimplementar (o mock do teste só é fiel
// por causa disso).
// O regex procura DEFINIÇÃO de método (linha começando pelo nome, com `{` na
// assinatura) — `this.selectItem(...)` é CHAMADA e é justamente o que queremos.
{
    for (const metodo of ["selectItem", "computePayload"]) {
        assert(
            !new RegExp(`(^|\\n)\\s*${metodo}\\s*\\([^)]*\\)\\s*\\{`).test(jsSemComentario),
            `não deve sobrescrever ${metodo}() do core (reaproveitar, não reimplementar)`
        );
    }
    assert(/super\.setup\(\)/.test(source), "setup() deve chamar super.setup()");
    assert(
        /this\.selectItem\(ID_SIM\)/.test(jsSemComentario),
        "Enter deve delegar ao selectItem() do core (não recalcular payload)"
    );
    console.log("✓ D3: reaproveita selectItem/computePayload do core");
}

// ── Grupo E: contrato do XML ─────────────────────────────────────────────

// E1: XML bem-formado
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
    console.log("✓ E1: XML bem-formado");
}

// E2: herda a CARA do SelectionPopup do core, em modo primary.
// A armadilha: em "extension" o assetsbundle.py (471-480) IGNORA o t-name e só
// anexa as operações ao template pai — "meu_modulo_fiscal.ConfirmSalePopup" não
// existiria e o popup quebraria; e ainda alteraria o SelectionPopup do core
// GLOBALMENTE, que é o que DEC-006 proíbe.
{
    assert(
        /<t\s+t-name="meu_modulo_fiscal\.ConfirmSalePopup"\s+t-inherit="point_of_sale\.SelectionPopup"\s+t-inherit-mode="primary"/.test(
            markup
        ),
        "deve herdar point_of_sale.SelectionPopup com t-inherit-mode='primary' (e não 'extension')"
    );
    assert(
        !/t-inherit-mode="extension"/.test(markup),
        "modo extension ignoraria o t-name (assetsbundle.py:471-480) e vazaria pro core"
    );
    console.log("✓ E2: herda a cara do SelectionPopup em modo primary");
}

// E3: o expr do xpath é o valor VERIFICADO contra o template do core.
// Fixado literalmente de propósito: um regex frouxo passaria com um caminho que
// casa ZERO nós, e xpath que não casa falha em silêncio.
//   xmllint --xpath "count(//Dialog)" addons/point_of_sale/.../selection_popup.xml  ->  1
{
    const EXPR = "//Dialog";
    const exprMatch = markup.match(/<xpath expr="([^"]+)" position="inside"/);
    assert(exprMatch, "deve haver um xpath position='inside'");
    assert.strictEqual(exprMatch[1], EXPR, "expr deve ser exatamente o caminho verificado");
    assert(!/position="replace"/.test(markup), "position='replace' quebraria o DOM de outros módulos");
    console.log("✓ E3: xpath '//Dialog' position='inside' (verificado com xmllint)");
}

// E4: a ajuda de teclado aparece; nada de t-raw; sem o gotcha class+t-att-class
{
    assert(/<kbd>Enter<\/kbd>/.test(markup), "deve mostrar a tecla Enter");
    assert(/<kbd>Esc<\/kbd>/.test(markup), "deve mostrar a tecla Esc");
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
    console.log("✓ E4: ajuda Enter/Esc com kbd, sem t-raw nem class+t-att-class");
}

// E5: os botões Sim/Não NÃO são recriados aqui — vêm inteiros do template do
// core por herança (selection_popup.xml:6-15, `<span t-esc="item.label" />`).
// Se este XML reimplementasse o t-foreach, a herança primary deixaria de ser
// "a mesma cara do popup do core" e passaria a ser um segundo popup pra manter.
{
    assert(
        !/t-foreach="props\.list"/.test(markup),
        "não recriar os botões (t-foreach) — eles vêm do core por herança"
    );
    assert(
        !/t-esc="[^"]*item\.label/.test(markup),
        "não recriar os labels — vêm do core por herança (que já usa t-esc)"
    );
    console.log("✓ E5: botões Sim/Não vêm do core (só o hint é novo)");
}

// ── Grupo F: integração com o confirm_popup.js ───────────────────────────

// F1: o popup novo está em uso e o SelectionPopup do core saiu
{
    assert(
        /makeAwaitable\(\s*this\.dialog,\s*ConfirmSalePopup,/.test(confirmPopupSource),
        "confirm_popup.js deve usar ConfirmSalePopup no makeAwaitable"
    );
    assert(
        !/makeAwaitable\(\s*this\.dialog,\s*SelectionPopup,/.test(confirmPopupSource),
        "não pode mais usar o SelectionPopup do core"
    );
    assert(
        /import \{ ConfirmSalePopup/.test(confirmPopupSource),
        "deve importar ConfirmSalePopup"
    );
    assert(
        !/import \{ SelectionPopup \}/.test(confirmPopupSource),
        "não deve mais importar SelectionPopup do core"
    );
    console.log("✓ F1: confirm_popup.js usa o popup novo");
}

// F2: os ids da lista saem dos constantes exportados pelo popup — é o que
// impede o id de "Sim" divergir entre os dois arquivos em silêncio.
{
    assert.strictEqual(ID_SIM, 1, "ID_SIM = 1");
    assert.strictEqual(ID_NAO, 0, "ID_NAO = 0");
    assert(
        new RegExp(`import \\{[^}]*ID_SIM[^}]*ID_NAO[^}]*\\}`).test(confirmPopupSource),
        "confirm_popup.js deve importar ID_SIM e ID_NAO"
    );
    const bloco = confirmPopupSource.slice(
        confirmPopupSource.indexOf("makeAwaitable"),
        confirmPopupSource.indexOf("const emitirNfce")
    );
    assert(/id: ID_SIM, label: _t\("Sim"\), item: true/.test(bloco), "item Sim usa ID_SIM");
    assert(/id: ID_NAO, label: _t\("Não"\), item: false/.test(bloco), "item Não usa ID_NAO");
    console.log("✓ F2: ids compartilhados (ID_SIM/ID_NAO) — sem número mágico duplicado");
}

// F3: o tratamento de ESC/fechar-como-não-fiscal e a flag fiscal seguem intocados
{
    assert(
        /const emitirNfce = confirmed === true;/.test(confirmPopupSource),
        "emitirNfce deve continuar sendo confirmed === true (undefined -> não-fiscal)"
    );
    assert(
        /order\.x_confirmacao_venda = emitirNfce;/.test(confirmPopupSource),
        "x_confirmacao_venda intocado"
    );
    assert(
        /confirmed === undefined/.test(confirmPopupSource),
        "o caminho do clique fora (undefined) continua tratado"
    );
    console.log("✓ F3: emitirNfce / x_confirmacao_venda / caminho do clique fora intocados");
}

// ── Grupo G: CpfInputPopup — Esc = seguir sem CPF (DEC-007) ──────────────

// G1: Esc passa a chamar recusarCpf() explicitamente (antes caía no
// onClose -> undefined, que o confirm_popup.js coagia pra "" de qualquer forma)
{
    assert(
        /import \{ useHotkey \} from "@web\/core\/hotkeys\/hotkey_hook"/.test(cpfPopupSource),
        "CpfInputPopup deve importar useHotkey"
    );
    assert(
        /useHotkey\("escape", \(\) => this\.recusarCpf\(\)\)/.test(cpfPopupSource),
        "Esc deve chamar recusarCpf()"
    );
    console.log("✓ G1: CpfInputPopup Esc -> recusarCpf()");
}

// G2: recusarCpf envia "" e fecha; o Enter com campo vazio continua confirmando
{
    assert(
        /recusarCpf\(\) \{[\s\S]*?getPayload\(""\)[\s\S]*?close\(\)/.test(cpfPopupSource),
        "recusarCpf deve enviar getPayload(\"\") e fechar"
    );
    assert(
        /get cpfValido\(\) \{[\s\S]*?trim\(\) === ""/.test(cpfPopupSource),
        "campo vazio continua válido (DEC-007)"
    );
    console.log("✓ G2: recusarCpf -> \"\" ; Enter vazio segue confirmando (DEC-007)");
}

// ── Grupo H: manifest ────────────────────────────────────────────────────

{
    const start = manifest.indexOf("'point_of_sale._assets_pos'");
    const end = manifest.indexOf("'web.assets_web'");
    assert(start !== -1 && end > start, "não achou o bloco point_of_sale._assets_pos");
    const block = manifest.slice(start, end);

    const jsIdx = block.indexOf("static/src/js/confirm_sale_popup.js");
    const xmlIdx = block.indexOf("static/src/xml/confirm_sale_popup.xml");
    assert(jsIdx !== -1, "confirm_sale_popup.js deve estar em point_of_sale._assets_pos");
    assert(xmlIdx !== -1, "confirm_sale_popup.xml deve estar em point_of_sale._assets_pos");
    assert(jsIdx < xmlIdx, "o JS deve vir ANTES do XML");
    assert(
        !manifest.includes("tests/test_confirm_sale_popup.js"),
        "teste Node não vai no manifest"
    );
    console.log("✓ H1: JS e XML no manifest (JS antes); teste fora");
}

console.log("\nTodos os testes passaram ✓");
