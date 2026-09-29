/**
 * Teste unitário (Node puro, sem Odoo) do lado do PDV do cancelamento de cupom
 * (atalho N, TicketScreen) — redesign 29/09: cancelamento COMERCIAL 100% no
 * Odoo (estoque + caixa), fiscal ou não-fiscal, sem middleware/SEFAZ.
 *
 * Dois seams:
 *   1. `cupomCancelavel(order, agoraMs)` — função pura, decide se o atalho N
 *      age, é o único lugar que conhece a regra das 24h;
 *   2. `cancelarCupomNfce(tela)` — o fluxo guard → popup → RPC → feedback.
 *      Extraído do arquivo real e executado com `tela` mockada: o teste
 *      verifica a ORDEM dos efeitos (block antes da RPC, unblock antes do
 *      AlertDialog) e QUAIS campos do pedido o PDV mexe.
 *
 * O Odoo não roda localmente, então `parseUTCString` é injetado como stub.
 * O stub replica a semântica verificada do core (utils.js:132):
 * DateTime.utc(...).toMillis() — a string chega em UTC ("yyyy-MM-dd HH:mm:ss").
 * O que está sob teste é o guard, não o parse.
 *
 * Rodar: node meu_modulo_fiscal/tests/test_cancelar_cupom.js
 */
const fs = require("fs");
const path = require("path");
const assert = require("assert");

const MODULE_ROOT = path.join(__dirname, "..");
const SOURCE_PATH = path.join(
    MODULE_ROOT, "static", "src", "js", "atalhos_tabela_classica.js"
);
const source = fs.readFileSync(SOURCE_PATH, "utf8");

// ── Extração do arquivo real ─────────────────────────────────────────────

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

/** Extrai a declaração inteira de uma função nomeada (com ou sem async). */
function extractFunction(src, name) {
    const re = new RegExp(`(?:async )?function ${name}\\s*\\(`);
    const m = re.exec(src);
    assert(m, `não achou a função ${name}()`);
    const braceIdx = src.indexOf("{", m.index + m[0].length - 1);
    return src.slice(m.index, braceIdx) + extractBalanced(src, braceIdx);
}

/** Extrai `export const NAME = <literal>;` e devolve o valor avaliado. */
function extractConst(src, name) {
    const m = src.match(new RegExp(`export const ${name} = ([^;]+);`));
    assert(m, `não achou "export const ${name}"`);
    return new Function(`return (${m[1]});`)();
}

const JANELA_CANCELAMENTO_MS = extractConst(source, "JANELA_CANCELAMENTO_MS");
const cupomCancelavelSrc = extractFunction(source, "cupomCancelavel");
const cancelarCupomNfceSrc = extractFunction(source, "cancelarCupomNfce");

const MODULO_FONTE = `
    const JANELA_CANCELAMENTO_MS = ${JANELA_CANCELAMENTO_MS};
    ${cupomCancelavelSrc}
    ${cancelarCupomNfceSrc}
    return { cupomCancelavel, cancelarCupomNfce };
`;

/** Compila o módulo sob teste com as dependências injetadas. */
function carregar(deps) {
    return new Function(
        "parseUTCString",
        "makeAwaitable",
        "CancelamentoJustificativaPopup",
        "_t",
        "AlertDialog",
        MODULO_FONTE
    )(
        deps.parseUTCString,
        deps.makeAwaitable,
        deps.CancelamentoJustificativaPopup,
        deps._t,
        deps.AlertDialog
    );
}

// O stub de parseUTCString é um espião: além de converter, registra as strings
// que recebeu — é assim que o teste prova que o guard passa pelo seam certo em
// vez de construir um Date local.
let parseUTCChamadas = [];
function parseUTCString(str) {
    parseUTCChamadas.push(str);
    if (!str) {
        return undefined;
    }
    const [ano, mes, dia, hora, min, seg] = str.split(/[- :]/).map(Number);
    return { toMillis: () => Date.UTC(ano, mes - 1, dia, hora, min, seg) };
}

const SEM_DEPS = carregar({
    parseUTCString,
    makeAwaitable: null,
    CancelamentoJustificativaPopup: null,
    _t: (s) => s,
    AlertDialog: null,
});

/**
 * Instancia o fluxo com as dependências mockadas e devolve os espiões.
 *
 * @param {Object} opts
 * @param {Object} opts.order         cupom selecionado
 * @param {*}      opts.retorno       payload que a RPC devolve
 * @param {Error}  opts.excecao       se setado, a RPC rejeita
 * @param {boolean} opts.abortar      popup fechado sem confirmar (resolve undefined)
 * @param {string} opts.justificativa o que o popup resolve
 */
function montarFluxo({
    order = null,
    retorno = null,
    excecao = null,
    abortar = false,
    justificativa = "Venda cancelada a pedido do cliente.",
} = {}) {
    const eventos = [];
    const rpc = [];
    const dialog = [];
    const traduzidas = [];
    const setProps = [];

    let orderProxy = null;
    if (order) {
        // Proxy: registra TODO campo que o fluxo escreve no pedido. O teste
        // exige que sejam SÓ x_fiscal_cancelado (e x_fiscal_status quando o
        // cupom era fiscal) — o backend é quem executa o cancelamento.
        orderProxy = new Proxy(order, {
            set(alvo, prop, valor) {
                setProps.push({ prop, valor });
                alvo[prop] = valor;
                return true;
            },
        });
    }

    class AlertDialog {}
    class CancelamentoJustificativaPopup {}

    const api = carregar({
        parseUTCString,
        makeAwaitable: (dialogService, componente, props) => {
            eventos.push("popup");
            // close() sem getPayload: é o contrato do makeAwaitable — resolve
            // undefined (Esc, botão Voltar, clique fora).
            return abortar ? undefined : justificativa;
        },
        CancelamentoJustificativaPopup,
        _t: (s) => {
            traduzidas.push(s);
            return s;
        },
        AlertDialog,
    });

    const tela = {
        getSelectedOrder: () => orderProxy,
        dialog: {
            add: (componente, props) => {
                eventos.push("dialog");
                dialog.push({ componente, props });
            },
        },
        ui: {
            block: () => eventos.push("block"),
            unblock: () => eventos.push("unblock"),
        },
        env: {
            services: {
                orm: {
                    call: async (modelo, metodo, args, kwargs) => {
                        eventos.push("rpc");
                        rpc.push({ modelo, metodo, args, kwargs });
                        if (excecao) {
                            throw excecao;
                        }
                        return retorno;
                    },
                },
            },
        },
    };

    return {
        api,
        tela,
        eventos,
        rpc,
        dialog,
        traduzidas,
        setProps,
        logsErro: [],
        order: orderProxy,
        AlertDialog,
    };
}

/** Roda o fluxo do atalho N com um cenário e devolve os espiões.
 * O console.error do módulo é capturado (o prefixo [CANCELAR-CUPOM] é contrato
 * de operação: sem ele não há como achar a falha no log do PDV). */
async function rodar(opts) {
    const f = montarFluxo(opts);
    const original = console.error;
    console.error = (...args) => f.logsErro.push(args);
    try {
        await f.api.cancelarCupomNfce(f.tela);
    } finally {
        console.error = original;
    }
    return f;
}

/** Cupom pago recém-emitido (caso feliz). Fiscal por padrão; a flag
 * x_confirmacao_venda distingue os dois tipos no fluxo. */
const AGORA = Date.UTC(2026, 8, 29, 15, 0, 0); // 2026-09-29T15:00:00Z

function cupomPago(extra = {}) {
    return {
        pos_reference: "Order 00042-001-0001",
        date_order: "2026-09-29 14:30:00",
        finalized: true,
        x_confirmacao_venda: true,
        x_fiscal_status: "autorizado",
        x_fiscal_offline: false,
        x_fiscal_chave: "35260912345678901234567890123456789012345678",
        x_fiscal_cancelado: false,
        ...extra,
    };
}

// ─────────────────────────────────────────────────────────────────────────

async function main() {
    // ═══ Grupo A: cupomCancelavel — a regra das 24h ═══

    // A1: a janela é de 24h e vem do próprio arquivo (sem número mágico)
    assert.strictEqual(
        JANELA_CANCELAMENTO_MS,
        24 * 3600 * 1000,
        "a janela de cancelamento é de 24h"
    );
    console.log("✓ A1: JANELA_CANCELAMENTO_MS = 24h");

    // A2: sem cupom selecionado → não age
    assert.strictEqual(SEM_DEPS.cupomCancelavel(null, AGORA), false);
    assert.strictEqual(SEM_DEPS.cupomCancelavel(undefined, AGORA), false);
    console.log("✓ A2: sem cupom selecionado → false");

    // A3: cupom NÃO pago não é cancelável. finalized=false cobre rascunho e
    // cupom cancelado pelo core; é o equivalente no cache do POS a
    // state in ('paid','invoiced') no backend.
    assert.strictEqual(
        SEM_DEPS.cupomCancelavel(cupomPago({ finalized: false }), AGORA),
        false,
        "cupom não pago não é cancelável"
    );
    console.log("✓ A3: não-finalized → false");

    // A4: cancelado uma vez não pode ser cancelado de novo — em NENHUM dos
    // tipos (o backend recusaria, mas o guard evita o RPC inteiro).
    assert.strictEqual(
        SEM_DEPS.cupomCancelavel(cupomPago({ x_fiscal_cancelado: true }), AGORA),
        false,
        "cupom já cancelado não é cancelável de novo"
    );
    console.log("✓ A4: já cancelado → false");

    // A4b: fiscal OU não-fiscal são canceláveis (decisão do usuário 29/09) —
    // o cancelamento é comercial; a fiscalidade só muda o feedback.
    assert.strictEqual(
        SEM_DEPS.cupomCancelavel(cupomPago({ x_confirmacao_venda: false, x_fiscal_status: null }), AGORA),
        true,
        "venda não-fiscal TAMBÉM é cancelável (estoque + caixa voltam)"
    );
    console.log("✓ A4b: não-fiscal → true");

    // A5: sem data de emissão não dá pra medir a janela → no-op
    assert.strictEqual(
        SEM_DEPS.cupomCancelavel(cupomPago({ date_order: null }), AGORA),
        false
    );
    console.log("✓ A5: sem date_order → false");

    // A6: recém-emitido → cancelável
    assert.strictEqual(
        SEM_DEPS.cupomCancelavel(cupomPago(), AGORA),
        true,
        "emitido 30min atrás está na janela"
    );
    console.log("✓ A6: dentro da janela → true");

    // A7: a fronteira é exatamente 24h. Odoo serializa Datetime sem fração de
    // segundo ("yyyy-MM-dd HH:mm:ss"), então a borda se mede em segundos.
    const EMITIDO = "2026-09-29 15:00:00";
    const UM_SEGUNDO_ANTES = Date.UTC(2026, 8, 30, 14, 59, 59); // 23h59m59s
    const NA_BORDA = Date.UTC(2026, 8, 30, 15, 0, 0); // exatas 24h
    const UM_SEGUNDO_DEPOIS = Date.UTC(2026, 8, 30, 15, 0, 1);
    assert.strictEqual(
        SEM_DEPS.cupomCancelavel(cupomPago({ date_order: EMITIDO }), UM_SEGUNDO_ANTES),
        true,
        "23h59m59s → ainda dentro"
    );
    assert.strictEqual(
        SEM_DEPS.cupomCancelavel(cupomPago({ date_order: EMITIDO }), NA_BORDA),
        false,
        "exatamente 24h → false (política de negócio)"
    );
    assert.strictEqual(
        SEM_DEPS.cupomCancelavel(cupomPago({ date_order: EMITIDO }), UM_SEGUNDO_DEPOIS),
        false,
        "além de 24h → false"
    );
    console.log("✓ A7: fronteira das 24h é estrita");

    // A8: date_order é UTC — o guard TEM que passar pelo parseUTCString do
    // core. `new Date("2026-09-29 14:30:00")` leria como hora LOCAL do caixa e
    // deslocaria a janela pelo fuso (no Brasil, 3h menos de margem).
    parseUTCChamadas = [];
    const orderUtc = cupomPago();
    SEM_DEPS.cupomCancelavel(orderUtc, AGORA);
    assert.deepStrictEqual(
        parseUTCChamadas,
        [orderUtc.date_order],
        "o guard deve converter date_order via parseUTCString, e não com new Date()"
    );
    assert(
        !/new Date\(/.test(cupomCancelavelSrc),
        "o guard não pode construir Date a partir da string UTC (fuso do caixa)"
    );
    console.log("✓ A8: usa parseUTCString (UTC), não new Date() local");

    // ═══ Grupo B: fluxo do atalho N ═══

    // B1: cupom não cancelável → nada acontece (nem popup, nem RPC, nem UI)
    for (const cenário of [
        null,
        cupomPago({ finalized: false }),
        cupomPago({ x_fiscal_cancelado: true }),
    ]) {
        const f = await rodar({ order: cenário });
        assert.deepStrictEqual(f.eventos, [], "guard falhou → nenhum efeito");
        assert.strictEqual(f.rpc.length, 0, "não pode chamar o backend");
    }
    console.log("✓ B1: guard falho é no-op total");

    // B2: operador fechou o popup (Esc / Voltar) → aborta sem chamar o backend.
    // makeAwaitable resolve undefined no cancelamento — é esse contrato.
    {
        const f = await rodar({ order: cupomPago(), abortar: true });
        assert.deepStrictEqual(f.eventos, ["popup"], "abriu o popup e parou");
        assert.strictEqual(f.rpc.length, 0, "abortar não pode chamar action_cancelar_nfce");
        assert.strictEqual(f.dialog.length, 0, "abortar não mostra resultado");
        console.log("✓ B2: abortar no popup → sem RPC, sem diálogo");
    }

    // B3: caminho feliz — RPC no formato certo
    {
        const f = await rodar({
            order: cupomPago(),
            retorno: { success: true, mensagem: "Cupom cancelado" },
        });
        assert.strictEqual(f.rpc.length, 1, "uma única chamada ao backend");
        const { modelo, metodo, args, kwargs } = f.rpc[0];
        assert.strictEqual(modelo, "pos.order");
        assert.strictEqual(metodo, "action_cancelar_nfce");
        assert.deepStrictEqual(args, [], "@api.model: argumentos posicionais vazios");
        assert.deepStrictEqual(
            Object.keys(kwargs).sort(),
            ["justificativa", "pos_reference"],
            "kwargs = {pos_reference, justificativa}"
        );
        assert.strictEqual(kwargs.pos_reference, "Order 00042-001-0001");
        assert.strictEqual(kwargs.justificativa, "Venda cancelada a pedido do cliente.");
        console.log("✓ B3: RPC orm.call('pos.order','action_cancelar_nfce',[],{...})");
    }

    // B4: cupom FISCAL cancelado — o PDV marca x_fiscal_cancelado (o backend
    // JÁ executou: é sincrono) e x_fiscal_status (informativo), e mostra o
    // resultado.
    {
        const f = await rodar({ order: cupomPago(), retorno: { success: true } });
        assert.deepStrictEqual(
            f.setProps.sort((a, b) => a.prop.localeCompare(b.prop)),
            [
                { prop: "x_fiscal_cancelado", valor: true },
                { prop: "x_fiscal_status", valor: "cancelado" },
            ],
            "fiscal: marca cancelado + status informativo"
        );
        assert.strictEqual(f.dialog.length, 1, "mostra o resultado ao operador");
        assert.strictEqual(f.dialog[0].componente, f.AlertDialog, "feedback é um AlertDialog");
        assert(
            f.dialog[0].props.body && f.dialog[0].props.title,
            "o diálogo de sucesso precisa de título e corpo"
        );
        console.log("✓ B4: fiscal → x_fiscal_cancelado=true + status + AlertDialog");
    }

    // B4b: cupom NÃO-FISCAL cancelado — NÃO toca x_fiscal_status (não há
    // nota fiscal na SEFAZ cujo status mudou), mas marca o cancelado.
    {
        const f = await rodar({
            order: cupomPago({ x_confirmacao_venda: false, x_fiscal_status: null }),
            retorno: { success: true },
        });
        assert.deepStrictEqual(
            f.setProps,
            [{ prop: "x_fiscal_cancelado", valor: true }],
            "não-fiscal: só x_fiscal_cancelado"
        );
        console.log("✓ B4b: não-fiscal → só x_fiscal_cancelado=true");
    }

    // B5: backend recusa → mostra o motivo dele e NÃO marca nada no pedido
    {
        const f = await rodar({
            order: cupomPago(),
            retorno: { success: false, mensagem: "Prazo de 24h para cancelamento expirado" },
        });
        assert.deepStrictEqual(f.setProps, [], "recusa não muda o pedido");
        assert.strictEqual(f.dialog.length, 1, "mostra a recusa");
        assert.strictEqual(
            f.dialog[0].props.body,
            "Prazo de 24h para cancelamento expirado",
            "a mensagem do backend é o que o operador lê"
        );
        console.log("✓ B5: recusa → mensagem do backend, pedido intacto");
    }

    // B5b: recusa sem mensagem no payload → o operador não pode ver "undefined"
    {
        const f = await rodar({ order: cupomPago(), retorno: { success: false } });
        const body = f.dialog[0].props.body;
        assert(body && body !== "undefined", `corpo do diálogo não pode ser vazio: ${body}`);
        console.log("✓ B5b: recusa sem mensagem tem fallback");
    }

    // B6: exceção na RPC (backend fora do ar, timeout, JSON inválido) → erro
    // de comunicação pro operador, pedido intacto, e o `finally` solta a UI
    {
        const f = await rodar({ order: cupomPago(), excecao: new Error("boom") });
        assert.deepStrictEqual(f.setProps, [], "exceção não muda o pedido");
        assert.strictEqual(f.dialog.length, 1, "o operador precisa saber que falhou");
        assert(
            f.eventos.includes("unblock"),
            "a UI PRECISA ser destravada no finally (senão o PDV fica inoperável)"
        );
        assert.strictEqual(f.logsErro.length, 1, "a falha precisa ir pro log do PDV");
        assert(
            String(f.logsErro[0][0]).includes("[CANCELAR-CUPOM]"),
            `o log precisa do prefixo rastreável: ${f.logsErro[0][0]}`
        );
        console.log("✓ B6: exceção → erro de comunicação + UI destravada + log");
    }

    // B7: ordem dos efeitos — bloqueia a UI ANTES da RPC, solta ANTES do
    // diálogo. Um AlertDialog adicionado com a UI travada nasceria sob o
    // BlockUI e o operador não conseguiria fechá-lo.
    {
        const f = await rodar({ order: cupomPago(), retorno: { success: true } });
        assert.deepStrictEqual(
            f.eventos,
            ["popup", "block", "rpc", "unblock", "dialog"],
            `ordem dos efeitos inesperada: ${f.eventos.join(" → ")}`
        );
        console.log("✓ B7: popup → block → rpc → unblock → dialog");
    }

    // B8: block e unblock balanceados em TODOS os caminhos — um unblock órfão
    // não quebra nada, mas um block sem unblock deixa o PDV travado.
    for (const cenário of [
        { order: cupomPago(), retorno: { success: true } },
        { order: cupomPago(), retorno: { success: false, mensagem: "x" } },
        { order: cupomPago(), excecao: new Error("boom") },
    ]) {
        const f = await rodar(cenário);
        const block = f.eventos.filter((e) => e === "block").length;
        const unblock = f.eventos.filter((e) => e === "unblock").length;
        assert.strictEqual(
            block,
            unblock,
            `block/unblock desbalanceados: ${f.eventos.join(" → ")}`
        );
        assert.strictEqual(block, 1, "exatamente um block por tentativa");
    }
    console.log("✓ B8: block/unblock balanceados nos 3 caminhos");

    // ═══ Grupo C: contrato com a tabela de atalhos ═══

    // C1: a tabela é a fonte única — o N existe, aponta pro fluxo e vem DEPOIS
    // do R (a legenda renderiza na ordem da tabela)
    {
        const tabela = source.slice(source.indexOf("export const ATALHOS"));
        const blocoTicket = tabela.slice(
            tabela.indexOf("TicketScreen: ["),
            tabela.indexOf("ProductScreen: [")
        );
        const rIdx = blocoTicket.indexOf('tecla: "r"');
        const nIdx = blocoTicket.indexOf('tecla: "n"');
        assert(rIdx !== -1, "TicketScreen deve manter o R (reimprimir)");
        assert(nIdx !== -1, "TicketScreen deve ter o N (cancelar cupom)");
        assert(rIdx < nIdx, "o N vem depois do R na tabela (ordem da legenda)");
        assert(
            /tecla: "n"[^}]*executar: cancelarCupomNfce/.test(source),
            "o N deve executar cancelarCupomNfce"
        );
        console.log("✓ C1: N na seção TicketScreen, após o R");
    }

    // C2: sem colisão de tecla no TicketScreen
    {
        const tabela = source.slice(source.indexOf("export const ATALHOS"));
        const blocoTicket = tabela.slice(
            tabela.indexOf("TicketScreen: ["),
            tabela.indexOf("ProductScreen: [")
        );
        const teclas = [...blocoTicket.matchAll(/tecla: "([^"]+)"/g)].map((m) => m[1]);
        assert.deepStrictEqual(
            [...new Set(teclas)].length,
            teclas.length,
            `tecla duplicada no TicketScreen: ${teclas.join(", ")}`
        );
        console.log("✓ C2: sem tecla duplicada no TicketScreen");
    }

    // C3: os dois atalhos do TicketScreen apontam pros handlers certos e a
    // tabela segue sendo a única fonte (a legenda deriva dela)
    {
        assert(
            /export function atalhosDaTela/.test(source),
            "a legenda continua derivando da tabela"
        );
        console.log("✓ C3: atalhosDaTela segue derivando da tabela");
    }

    console.log("\nTodos os testes passaram ✓");
}

main().catch((erro) => {
    console.error(`\n✗ FALHOU: ${erro && erro.message ? erro.message : erro}`);
    process.exit(1);
});