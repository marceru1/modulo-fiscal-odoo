/**
 * Teste unitário (Node puro, sem Odoo) da simulação de envio da NF-e
 * modelo 55 (ticket 09).
 *
 * Valida o contrato do arquivo:
 *   - a action client registrada no registry "actions" com a tag que o
 *     servidor usa (mesma string do models/nfe_documento.py);
 *   - console.log do JSON recebido em params.json;
 *   - notificação "Simulação: nenhuma NF-e foi emitida";
 *   - retorno de params.next (padrão do client action nativo);
 *   - manifest: web.assets_backend e NUNCA point_of_sale._assets_pos.
 *
 * Rodar: node meu_modulo_fiscal/tests/test_nfe_emitir_simulacao.js
 */
const fs = require("fs");
const path = require("path");
const assert = require("assert");

const MODULE_ROOT = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(p, "utf8");

const js = read(path.join(MODULE_ROOT, "static", "src", "js", "nfe_emitir_simulacao.js"));
const manifest = read(path.join(MODULE_ROOT, "__manifest__.py"));
const modelo = read(path.join(MODULE_ROOT, "models", "nfe_documento.py"));

const TAG = "meu_modulo_fiscal.nfe_simulacao";
const MARKER = "export function nfeSimulacaoAction(env, action) {";

// ── Extrai a declaração da função por casamento de chaves ──────────────────
function extractDeclaration(marker) {
    const start = js.indexOf(marker);
    assert(start !== -1, `Marcador não encontrado: ${marker}`);
    let depth = 0;
    let i = marker.length - 1 + start; // posição da '{'
    for (; i < js.length; i++) {
        if (js[i] === "{") depth++;
        else if (js[i] === "}") {
            depth--;
            if (depth === 0) {
                return js.slice(start, i + 1);
            }
        }
    }
    assert.fail("Chaves não balanceadas na função");
}

const logs = [];
const notificacoes = [];
const fakeConsole = { log: (...args) => logs.push(args) };

const factory = new Function(
    "_t",
    "console",
    `
    const NFE_SIMULACAO_TAG = ${JSON.stringify(TAG)};
    ${extractDeclaration(MARKER).replace(/^export /, "")}
    return nfeSimulacaoAction;
    `
);
const acao = factory((texto) => texto, fakeConsole);
const env = {
    services: { notification: { add: (msg, opts) => notificacoes.push({ msg, opts }) } },
};

// ── 1. Tag idêntica à do servidor ──────────────────────────────────────────
assert.ok(js.includes(`"${TAG}"`), "tag da action client no JS");
assert.ok(
    modelo.includes(`'${TAG}'`),
    "o servidor precisa devolver a MESMA tag registrada no JS"
);

// ── 2. Registro no registry ────────────────────────────────────────────────
assert.ok(
    js.includes('registry.category("actions").add(NFE_SIMULACAO_TAG, nfeSimulacaoAction)'),
    "action registrada no registry de actions"
);

// ── 3. Não faz HTTP no navegador ───────────────────────────────────────────
assert.ok(!/fetch\(|XMLHttpRequest|orm\.call/.test(js), "nenhuma requisição no navegador");

// ── 4. Comportamento: console + notificação ────────────────────────────────
const payload = {
    nota: { id: 7, referencia: "NFE/00007", situacao: "validada" },
    itens: [{ descricao: "Camiseta", quantidade: 8, custo_unitario: 10 }],
};
const retorno = acao(env, { type: "ir.actions.client", tag: TAG, params: { json: payload } });

assert.strictEqual(logs.length, 1, "um log no console");
assert.ok(
    logs[0].some((parte) => JSON.stringify(parte) === JSON.stringify(payload)),
    "console.log precisa receber o JSON de params.json"
);
assert.strictEqual(notificacoes.length, 1, "uma notificação");
assert.strictEqual(notificacoes[0].msg, "Simulação: nenhuma NF-e foi emitida");
assert.strictEqual(notificacoes[0].opts.type, "warning");
assert.strictEqual(retorno, undefined, "sem params.next devolve undefined");

// ── 5. params.next é propagado (padrão do core) ────────────────────────────
const proxima = { type: "ir.actions.act_window_close" };
const comNext = acao(env, { params: { json: {}, next: proxima } });
assert.deepStrictEqual(comNext, proxima, "next repassado ao action manager");

// ── 6. Sem params não explode ──────────────────────────────────────────────
acao(env, {});
assert.strictEqual(logs.length, 3, "log também quando params ausente");

// ── 7. Manifest: backend, nunca POS ────────────────────────────────────────
const blocoBackend = manifest.slice(
    manifest.indexOf("'web.assets_backend'"),
    manifest.indexOf("'installable'")
);
assert.ok(
    blocoBackend.includes("static/src/js/nfe_emitir_simulacao.js"),
    "asset no web.assets_backend"
);
const blocoPos = manifest.slice(
    manifest.indexOf("'point_of_sale._assets_pos'"),
    manifest.indexOf("'web.assets_web'")
);
assert.ok(
    !blocoPos.includes("nfe_emitir_simulacao.js"),
    "NUNCA no bundle do POS"
);

console.log("OK test_nfe_emitir_simulacao.js — 7 blocos de contrato verificados");
