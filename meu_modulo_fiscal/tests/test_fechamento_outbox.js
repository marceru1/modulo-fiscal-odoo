/**
 * Teste unitário (Node puro, sem Odoo) da outbox persistida + espelho local
 * de sangria/suprimento (fechamento_outbox.js — ticket 03).
 *
 * Cobre: gravação offline, sobrevivência ao refresh (releitura), drenagem em
 * ordem com remoção só após sucesso, erro de rede, erro de negócio visível,
 * duplo disparo simultâneo, espelho online e limpeza pós-snapshot.
 *
 * Rodar: node meu_modulo_fiscal/tests/test_fechamento_outbox.js
 */
const fs = require("fs");
const path = require("path");
const assert = require("assert");
const vm = require("vm");

const SOURCE = path.join(__dirname, "..", "static", "src", "js", "fechamento_outbox.js");

function loadModule(file, exportNames) {
    let src = fs.readFileSync(file, "utf8");
    src = src.replace(/^\/\*\* @odoo-module \*\/\s*/m, "");
    src = src.replace(/\bexport\s+(const|function|class)\s+/g, "$1 ");
    return vm.runInNewContext(`(() => { ${src}\n return { ${exportNames.join(", ")} }; })()`, {
        console,
    });
}

const {
    createOutbox,
    chaveOutbox,
    chaveEspelho,
    registrarRefreshSnapshot,
    solicitarRefreshSnapshot,
} = loadModule(SOURCE, [
    "createOutbox",
    "chaveOutbox",
    "chaveEspelho",
    "registrarRefreshSnapshot",
    "solicitarRefreshSnapshot",
]);

const CONFIG_ID = 3;
const SESSION_ID = 42;

function makeStorage() {
    const mapa = new Map();
    return {
        getItem: (k) => (mapa.has(k) ? mapa.get(k) : null),
        setItem: (k, v) => mapa.set(k, v),
        removeItem: (k) => mapa.delete(k),
        _mapa: mapa,
    };
}

function uuidSeq() {
    let n = 0;
    return () => `uuid-${++n}`;
}

function makeOutbox(storage, extra = {}) {
    return createOutbox({
        storage,
        configId: CONFIG_ID,
        sessionId: SESSION_ID,
        uuid: uuidSeq(),
        relogio: () => "2026-10-27T18:00:00",
        logger: { warn: () => {}, error: () => {} },
        ...extra,
    });
}

function redeError() {
    const err = new Error("Connection lost");
    err.name = "ConnectionLostError";
    return err;
}

// ── Casos ──────────────────────────────────────────────────────────────────
function caso1_grava() {
    const storage = makeStorage();
    const outbox = makeOutbox(storage);
    const item = outbox.adicionar({ tipo: "out", valor: 30, motivo: "Sangria" });

    assert.strictEqual(item.uuid, "uuid-1");
    assert.strictEqual(item.synced, false);
    assert.strictEqual(outbox.listar().length, 1);
    assert.strictEqual(outbox.listarMovimentos().length, 1);
    assert.strictEqual(outbox.listarMovimentos()[0].synced, false);
    assert.ok(storage.getItem(chaveOutbox(CONFIG_ID, SESSION_ID)));
    assert.ok(storage.getItem(chaveEspelho(CONFIG_ID, SESSION_ID)));
    console.log("✓ Caso 1: adicionar grava na outbox e no espelho");
}

function caso2_reload() {
    const storage = makeStorage();
    makeOutbox(storage).adicionar({ tipo: "in", valor: 20, motivo: "Suprimento" });

    // Nova instância = página recarregada.
    const depoisDoReload = makeOutbox(storage);
    const itens = depoisDoReload.listar();
    assert.strictEqual(itens.length, 1);
    assert.strictEqual(itens[0].motivo, "Suprimento");
    assert.strictEqual(itens[0].tipo, "in");
    console.log("✓ Caso 2: outbox sobrevive ao reload");
}

async function caso3_drenagem() {
    const storage = makeStorage();
    const outbox = makeOutbox(storage);
    outbox.adicionar({ tipo: "out", valor: 10, motivo: "A" });
    outbox.adicionar({ tipo: "in", valor: 5, motivo: "B" });

    const enviados = [];
    const resultado = await outbox.drenar(async (item) => {
        enviados.push(item.motivo);
        if (item.motivo === "A") {
            assert.strictEqual(outbox.listar().length, 2, "Remove só depois do envio");
        }
    });

    assert.strictEqual(resultado.ok, true);
    assert.strictEqual(resultado.enviados, 2);
    assert.strictEqual(JSON.stringify(enviados), JSON.stringify(["A", "B"]));
    assert.strictEqual(outbox.listar().length, 0);
    assert.ok(
        outbox.listarMovimentos().every((m) => m.synced === true),
        "Espelho marca os enviados como sincronizados"
    );
    console.log("✓ Caso 3: drenagem em ordem, remoção só após sucesso");
}

async function caso4_rede() {
    const storage = makeStorage();
    const outbox = makeOutbox(storage);
    outbox.adicionar({ tipo: "out", valor: 10, motivo: "A" });
    outbox.adicionar({ tipo: "in", valor: 5, motivo: "B" });

    const resultado = await outbox.drenar(async (item) => {
        if (item.motivo === "B") {
            throw redeError();
        }
    });

    assert.strictEqual(resultado.ok, false);
    assert.strictEqual(resultado.erroRede, true);
    assert.strictEqual(resultado.enviados, 1);
    assert.strictEqual(outbox.listar().length, 1);
    assert.strictEqual(outbox.listar()[0].motivo, "B");
    console.log("✓ Caso 4: erro de rede para e mantém o item");
}

async function caso5_negocio() {
    const storage = makeStorage();
    const erros = [];
    const outbox = makeOutbox(storage, {
        logger: { warn: () => {}, error: (m) => erros.push(m) },
    });
    outbox.adicionar({ tipo: "out", valor: 10, motivo: "A" });

    const resultado = await outbox.drenar(async () => {
        const erro = new Error("Motivo inválido");
        erro.name = "UserError";
        throw erro;
    });

    assert.strictEqual(resultado.ok, false);
    assert.strictEqual(resultado.erroNegocio, true);
    assert.ok(resultado.mensagem.includes("Motivo inválido"));
    assert.ok(erros.length >= 1, "Erro de negócio vai para console.error");
    assert.strictEqual(outbox.listar().length, 1, "Item permanece para o gerente resolver");
    console.log("✓ Caso 5: erro de negócio visível e para");
}

async function caso6_duplo_disparo() {
    const storage = makeStorage();
    const outbox = makeOutbox(storage);
    outbox.adicionar({ tipo: "out", valor: 10, motivo: "A" });

    let liberar;
    const bloqueio = new Promise((resolve) => (liberar = resolve));
    let chamadas = 0;
    const enviar = async () => {
        chamadas += 1;
        await bloqueio;
    };

    const p1 = outbox.drenar(enviar);
    const p2 = outbox.drenar(enviar);
    liberar();
    const [r1, r2] = await Promise.all([p1, p2]);

    assert.strictEqual(r1, r2, "As duas chamadas compartilham a mesma drenagem");
    assert.strictEqual(chamadas, 1, "Movimento não é enviado duas vezes");
    console.log("✓ Caso 6: duplo disparo não duplica o envio");
}

function caso7_espelho() {
    const storage = makeStorage();
    const outbox = makeOutbox(storage);
    outbox.adicionar({ tipo: "out", valor: 10, motivo: "Offline" });
    outbox.espelharOnline({ tipo: "in", valor: 25, motivo: "Online" });

    assert.strictEqual(outbox.listarMovimentos().length, 2);
    const online = outbox.listarMovimentos().find((m) => m.motivo === "Online");
    assert.strictEqual(online.synced, true);

    outbox.limparSincronizados();
    const restantes = outbox.listarMovimentos();
    assert.strictEqual(restantes.length, 1);
    assert.strictEqual(restantes[0].motivo, "Offline");
    console.log("✓ Caso 7: espelho online e limpeza pós-snapshot");
}

function caso8_chaves() {
    assert.notStrictEqual(
        chaveOutbox(1, 10),
        chaveOutbox(1, 11),
        "Outbox de sessões diferentes não colide"
    );
    assert.notStrictEqual(chaveEspelho(1, 10), chaveEspelho(2, 10));
    console.log("✓ Caso 8: chaves por config/sessão");
}

function caso9_corrompido() {
    const storage = makeStorage();
    storage.setItem(chaveOutbox(CONFIG_ID, SESSION_ID), "{não é json");
    const outbox = makeOutbox(storage);
    assert.strictEqual(outbox.listar().length, 0);
    console.log("✓ Caso 9: storage corrompido não quebra");
}

function caso10_refresh() {
    let chamadas = 0;
    registrarRefreshSnapshot(() => {
        chamadas += 1;
    });
    solicitarRefreshSnapshot();
    assert.strictEqual(chamadas, 1);
    // Um gancho que explode não pode derrubar o movimento.
    registrarRefreshSnapshot(() => {
        throw new Error("boom");
    });
    solicitarRefreshSnapshot();
    registrarRefreshSnapshot(() => {});
    console.log("✓ Caso 10: gancho de refresh do snapshot");
}

async function main() {
    caso1_grava();
    caso2_reload();
    await caso3_drenagem();
    await caso4_rede();
    await caso5_negocio();
    await caso6_duplo_disparo();
    caso7_espelho();
    caso8_chaves();
    caso9_corrompido();
    caso10_refresh();
    console.log("\nTodos os testes passaram ✓");
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
