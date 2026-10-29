/**
 * Contrato textual do fechamento offline no popup (fechamento_button.js —
 * ticket 05), no padrão de test_fechamento_lock.js.
 *
 * Garante que:
 *   - confirmar offline NÃO chama nenhum RPC de fechamento do core;
 *   - confirmar online continua no caminho nativo (super.closeSession);
 *   - há recusa de fechamento com venda em andamento (DEC-011);
 *   - o relatório offline leva "Gerado offline" e o online não;
 *   - o snapshot é tirado no boot e o popup offline usa o cálculo local;
 *   - manifest carrega os módulos novos antes do fechamento_button.js.
 *
 * Rodar: node meu_modulo_fiscal/tests/test_fechamento_offline_popup.js
 */
const fs = require("fs");
const path = require("path");
const assert = require("assert");

const MODULE_ROOT = path.join(__dirname, "..");
const JS_PATH = path.join(MODULE_ROOT, "static", "src", "js", "fechamento_button.js");
const XML_PATH = path.join(MODULE_ROOT, "static", "src", "xml", "fechamento_receipt.xml");
const MANIFEST_PATH = path.join(MODULE_ROOT, "__manifest__.py");

const source = fs.readFileSync(JS_PATH, "utf8");
const xml = fs.readFileSync(XML_PATH, "utf8");
const manifest = fs.readFileSync(MANIFEST_PATH, "utf8");

function trecho(inicio, fim) {
    const idxInicio = source.indexOf(inicio);
    const idxFim = source.indexOf(fim, idxInicio);
    assert.ok(idxInicio !== -1, `Não encontrou "${inicio}"`);
    assert.ok(idxFim > idxInicio, `Não encontrou "${fim}" depois de "${inicio}"`);
    return source.slice(idxInicio, idxFim);
}

// ── 1. Confirmar offline não chama os RPCs de fechamento do core ──────────
const confirmacaoOffline = trecho(
    "async _confirmarFechamentoOffline(estado) {",
    "async showFechamento() {"
);
for (const rpc of [
    "close_session_from_ui",
    "post_closing_cash_details",
    "update_closing_control_state_session",
    "try_cash_in_out",
]) {
    assert.ok(
        !confirmacaoOffline.includes(rpc),
        `Fechamento offline não pode chamar ${rpc}`
    );
}
assert.match(confirmacaoOffline, /criarPendencia\(/, "Deve gravar a pendência");
assert.match(
    confirmacaoOffline,
    /_imprimirFechamento\([^)]*,\s*true\s*\)/,
    "Deve imprimir o relatório offline uma vez"
);
console.log("✓ 1: confirmar offline não chama RPC de fechamento e grava a pendência");

// ── 2. Recusa com venda em andamento (DEC-011) ────────────────────────────
assert.match(
    confirmacaoOffline,
    /!ordem\.finalized/,
    "Precisa achar pedido em rascunho"
);
assert.match(
    confirmacaoOffline,
    /get_orderlines\(\)\.length\s*>\s*0/,
    "Rascunho vazio não conta: exige itens"
);
assert.match(confirmacaoOffline, /Finalize ou cancele a venda em andamento/);
assert.ok(
    confirmacaoOffline.indexOf("get_orderlines") < confirmacaoOffline.indexOf("criarPendencia"),
    "A recusa precisa vir ANTES de gravar a pendência"
);
console.log("✓ 2: recusa fechamento com venda em andamento");

// ── 3. Online continua no caminho nativo ──────────────────────────────────
const closeSession = trecho("async closeSession() {", "async _confirmarFechamentoOffline");
assert.match(closeSession, /super\.closeSession\(/, "Online deve chamar super.closeSession");
assert.match(
    closeSession,
    /close_session_from_ui/,
    "Redirect /odoo do fechamento online deve continuar existindo"
);
assert.ok(
    closeSession.indexOf("modoOffline") < closeSession.indexOf("super.closeSession"),
    "O desvio offline deve vir antes do fluxo nativo"
);
console.log("✓ 3: online segue o fluxo nativo com o redirect /odoo");

// ── 4. Relatório: "Gerado offline" só quando offline ──────────────────────
assert.match(
    trecho(
        "async _imprimirFechamento(dados, offline, jaContado = false) {",
        "/** Aplica os valores informados"
    ),
    /offline:\s*Boolean\(offline\)/,
    "O template precisa receber a flag offline"
);
assert.match(
    xml,
    /t-if="offline"[\s\S]{0,200}Gerado offline/,
    "A linha 'Gerado offline' precisa estar condicionada a offline"
);
console.log("✓ 4: 'Gerado offline' só aparece no relatório offline");

// ── 5. Snapshot no boot e popup offline local ─────────────────────────────
assert.match(source, /afterProcessServerData\(\)[\s\S]{0,400}tirarSnapshot\(this\)/);
assert.match(source, /this\.data\.network\.offline[\s\S]{0,200}_fechamentoInfoOffline/);
assert.match(source, /_fechamentoInfoOffline\(\)[\s\S]{0,200}calcularDadosOffline\(this\)/);
assert.match(source, /_aplicarContagem\(estado\.dadosOffline\.fechamento\)/);
console.log("✓ 5: snapshot no boot + popup offline usando o cálculo local");

// ── 6. showFechamento offline usa o relatório já computado ────────────────
const showFechamento = trecho("async showFechamento() {", "async _imprimirFechamento");
assert.match(showFechamento, /estado\.modoOffline[\s\S]{0,200}dadosOffline/);
assert.match(showFechamento, /get_fechamento_data/, "Online mantém o RPC get_fechamento_data");
console.log("✓ 6: botão Fechamento funciona offline e mantém o RPC online");

// ── 7. Manifest: módulos novos antes do fechamento_button.js ──────────────
const idxBotao = manifest.indexOf(
    "meu_modulo_fiscal/static/src/js/fechamento_button.js"
);
for (const modulo of [
    "fechamento_offline_core.js",
    "fechamento_replay.js",
    "fechamento_outbox.js",
    "fechamento_offline_runtime.js",
    "cash_move_popup_patch.js",
]) {
    const idx = manifest.indexOf(`meu_modulo_fiscal/static/src/js/${modulo}`);
    assert.ok(idx !== -1, `${modulo} deve estar no manifest`);
    assert.ok(idx < idxBotao, `${modulo} deve vir antes de fechamento_button.js`);
}
console.log("✓ 7: manifest carrega os módulos novos antes do patch do popup");

// ── 8. Recebimento online refresca o snapshot ─────────────────────────────
const RECEBIMENTO_PATH = path.join(
    MODULE_ROOT,
    "static",
    "src",
    "js",
    "recebimento_button.js"
);
const recebimento = fs.readFileSync(RECEBIMENTO_PATH, "utf8");
assert.match(
    recebimento,
    /import\s*\{[^}]*solicitarRefreshSnapshot[^}]*\}\s*from\s*["']\.\/fechamento_outbox["']/,
    "Recebimento deve importar o gancho de refresh"
);
assert.match(
    recebimento,
    /response\.success[\s\S]{0,400}solicitarRefreshSnapshot\(\)/,
    "Recebimento confirmado deve pedir refresh do snapshot"
);
const idxRecebimento = manifest.indexOf(
    "meu_modulo_fiscal/static/src/js/recebimento_button.js"
);
const idxOutbox = manifest.indexOf(
    "meu_modulo_fiscal/static/src/js/fechamento_outbox.js"
);
assert.ok(idxOutbox !== -1 && idxOutbox < idxRecebimento, "Outbox antes do recebimento");
console.log("✓ 8: recebimento online refresca o snapshot");

console.log("\nTodos os testes passaram ✓");
