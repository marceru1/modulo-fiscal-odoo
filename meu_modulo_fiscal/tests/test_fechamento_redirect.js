/**
 * Teste unitário (Node puro, sem Odoo) do contrato "fechar caixa sai do POS".
 *
 * Bug: o fluxo nativo de fechamento termina em location.reload(); ao recarregar
 * /pos/ui sem sessão aberta, o controller pos_web cria uma nova pos.session em
 * opening_control, e o caixa do dia seguinte abre com a sessão de ontem.
 *
 * O patch em fechamento_button.js troca a URL para /odoo (history.replaceState)
 * quando close_session_from_ui responde successful — o reload do core então cai
 * na home do Odoo.
 *
 * O teste extrai o método closeSession() do patch e o executa com `this` e
 * `window` mockados (mesmo padrão de test_fechamento_lock.js).
 *
 * Rodar: node meu_modulo_fiscal/tests/test_fechamento_redirect.js
 */
const fs = require("fs");
const path = require("path");
const assert = require("assert");

const MODULE_ROOT = path.join(__dirname, "..");
const JS_PATH = path.join(MODULE_ROOT, "static", "src", "js", "fechamento_button.js");

// ⚠️ FRÁGIL A FORMATAÇÃO: casa o primeiro `\n\s*\},` após a abertura do método.
function extractMethodBody(source, methodName) {
    const re = new RegExp(`${methodName}\\(\\)\\s*\\{([\\s\\S]*?)\\n\\s*\\},`);
    const m = source.match(re);
    assert(m, `Não encontrou ${methodName}() em fechamento_button.js`);
    return m[1];
}

const source = fs.readFileSync(JS_PATH, "utf8");
let body = extractMethodBody(source, "closeSession");
body = body.replace("super.closeSession(...arguments)", "mockSuperCloseSession.call(this)");

// ── Mock de window (history + location) ────────────────────────────────────
function resetWindow() {
    const state = { replaceState: [], href: "/pos/ui?config_id=1" };
    global.window = {
        history: {
            replaceState: (...args) => state.replaceState.push(args),
        },
        location: {
            get href() {
                return state.href;
            },
            set href(value) {
                state.href = value;
            },
        },
    };
    return state;
}

// ── Mock do core: chama close_session_from_ui e "recarrega" ────────────────
function makeSuperMock() {
    return async function mockSuperCloseSession() {
        // O core chama outros métodos antes; só o close_session_from_ui
        // interessa ao patch.
        await this.pos.data.call(
            "pos.session",
            "update_closing_control_state_session",
            [1, ""],
            {}
        );
        const result = await this.pos.data.call(
            "pos.session",
            "close_session_from_ui",
            [1, []],
            {}
        );
        if (result && result.successful) {
            this.reloadChamado = true;
        }
        return result;
    };
}

function buildCloseSession() {
    return new Function(
        "mockSuperCloseSession",
        `return async function() { ${body} }`
    )(makeSuperMock());
}

function makeCtx() {
    const calls = [];
    const originalCall = async (model, method, args, kwargs) => {
        calls.push({ model, method, args });
        if (method === "close_session_from_ui") {
            return global.__closeResponse;
        }
        return { successful: true };
    };
    return {
        ctx: { pos: { data: { call: originalCall } } },
        calls,
        originalCall,
    };
}

async function run({ successful }) {
    const state = resetWindow();
    global.__closeResponse = { successful };
    const { ctx, originalCall, calls } = makeCtx();
    const closeSession = buildCloseSession();

    await closeSession.call(ctx);

    return { state, ctx, originalCall, calls };
}

(async () => {
    // ── Caso 1: backend fechou → vai para /odoo (replaceState antes do reload)
    {
        const { state, ctx, originalCall } = await run({ successful: true });

        assert.strictEqual(state.replaceState.length, 1, "replaceState deve ser chamado 1x");
        assert.deepStrictEqual(
            state.replaceState[0],
            [null, "", "/odoo"],
            "URL trocada para /odoo antes do reload do core"
        );
        assert.strictEqual(state.href, "/odoo", "segurança: navega para /odoo");
        assert.strictEqual(ctx.pos.data.call, originalCall, "data.call restaurado");
        assert.strictEqual(ctx.reloadChamado, true, "fluxo de sucesso do core executou");
        console.log("✓ Caso 1: fechamento OK → /odoo");
    }

    // ── Caso 2: backend não fechou (handleClosingError) → fica no POS ──────
    {
        const { state, ctx, originalCall } = await run({ successful: false });

        assert.strictEqual(state.replaceState.length, 0, "não troca a URL em erro");
        assert.strictEqual(state.href, "/pos/ui?config_id=1", "continua no POS");
        assert.strictEqual(ctx.pos.data.call, originalCall, "data.call restaurado");
        console.log("✓ Caso 2: falha no fechamento → continua no POS");
    }

    // ── Caso 3: exceção no core → finally restaura data.call e não navega ──
    {
        const state = resetWindow();
        const { ctx, originalCall } = makeCtx();
        const superComErro = async function () {
            throw new Error("ConnectionLost");
        };
        const bodyErro = body.replace(
            "mockSuperCloseSession.call(this)",
            "superComErro.call(this)"
        );
        const comErro = new Function(
            "superComErro",
            `return async function() { ${bodyErro} }`
        )(superComErro);

        await assert.rejects(() => comErro.call(ctx), /ConnectionLost/);
        assert.strictEqual(state.replaceState.length, 0, "sem navegação em exceção");
        assert.strictEqual(ctx.pos.data.call, originalCall, "data.call restaurado no erro");
        console.log("✓ Caso 3: exceção propaga e restaura data.call");
    }

    console.log("\nTodos os casos passaram.");
})().catch((err) => {
    console.error(err);
    process.exit(1);
});
