/**
 * Teste unitário (Node puro, sem Odoo) da máquina de estados do fechamento
 * deferido (fechamento_replay.js — ticket 04).
 *
 * Os RPCs e o armazenamento entram por injeção; o teste simula sucesso,
 * queda de rede em cada passo, erro de negócio, sessão já fechada, retomada
 * por passo e execução serializada.
 *
 * Rodar: node meu_modulo_fiscal/tests/test_fechamento_replay.js
 */
const fs = require("fs");
const path = require("path");
const assert = require("assert");
const vm = require("vm");

const SOURCE = path.join(
    __dirname,
    "..",
    "static",
    "src",
    "js",
    "fechamento_replay.js"
);

// Carrega um módulo ES do fonte como objetos comuns: remove `export ` e
// devolve os símbolos pedidos. Mantém o teste fiel ao fonte real.
function loadModule(file, exportNames) {
    let src = fs.readFileSync(file, "utf8");
    src = src.replace(/^\/\*\* @odoo-module \*\/\s*/m, "");
    src = src.replace(/\bexport\s+(const|function|class)\s+/g, "$1 ");
    return vm.runInNewContext(`(() => { ${src}\n return { ${exportNames.join(", ")} }; })()`, {
        console,
    });
}

const { createReplayMachine, chavePendencia, PASSO_OUTBOX, STATUS_ERRO_NEGOCIO } = loadModule(
    SOURCE,
    ["createReplayMachine", "chavePendencia", "PASSO_OUTBOX", "STATUS_ERRO_NEGOCIO"]
);

const CONFIG_ID = 7;
const SESSION_ID = 55;
const KEY = chavePendencia(CONFIG_ID);

// ── Helpers ────────────────────────────────────────────────────────────────
function makeStorage(seed = {}) {
    const mapa = new Map(Object.entries(seed));
    return {
        getItem: (k) => (mapa.has(k) ? mapa.get(k) : null),
        setItem: (k, v) => mapa.set(k, v),
        removeItem: (k) => mapa.delete(k),
        _mapa: mapa,
    };
}

function redeError() {
    const err = new Error("Connection lost");
    err.name = "ConnectionLostError";
    return err;
}

function pedidosPendentesError() {
    const err = new Error("pedidos pendentes");
    err.name = "OrdersPendingError";
    return err;
}

function negocioError(mensagem = "recusado pelo servidor") {
    const err = new Error(mensagem);
    err.name = "UserError";
    return err;
}

const PASSOS_RPC = [
    "drenarOutbox",
    "drenarPedidos",
    "gravarDinheiroContado",
    "mudarParaFechamento",
    "fecharSessao",
];
const ORDEM_COMPLETA = ["lerEstadoSessao", ...PASSOS_RPC];

function makeRpcs(overrides = {}, estadoInicial = "opened") {
    const chamadas = [];
    const rpcs = {
        lerEstadoSessao: async () => {
            chamadas.push("lerEstadoSessao");
            return estadoInicial;
        },
        drenarOutbox: async () => {
            chamadas.push("drenarOutbox");
        },
        drenarPedidos: async () => {
            chamadas.push("drenarPedidos");
        },
        gravarDinheiroContado: async (valor) => {
            chamadas.push("gravarDinheiroContado");
            rpcs._dinheiro = valor;
        },
        mudarParaFechamento: async (notas) => {
            chamadas.push("mudarParaFechamento");
            rpcs._notas = notas;
        },
        fecharSessao: async (diferencas) => {
            chamadas.push("fecharSessao");
            rpcs._diferencas = diferencas;
            return { successful: true };
        },
    };
    for (const [nome, fn] of Object.entries(overrides)) {
        rpcs[nome] = async (...args) => {
            chamadas.push(nome);
            return fn(...args);
        };
    }
    return { rpcs, chamadas };
}

function makeMachine({ storage, rpcs, controleCaixa = true, contar = () => 0 }) {
    const erros = [];
    const machine = createReplayMachine({
        storage,
        configId: CONFIG_ID,
        sessionId: SESSION_ID,
        rpcs,
        controleCaixa,
        contarVendasNaoEnviadas: contar,
        logger: { warn: () => {}, error: (m) => erros.push(m) },
    });
    return { machine, erros };
}

function pendenciaValida() {
    return {
        session_id: SESSION_ID,
        dinheiro_contado: 150,
        notas: "fechamento do dia",
        diferencas_bancarias: [[2, -5]],
        relatorio: { identificacao: { qtd_vendas: 3 } },
        confirmado_em: "27/10/2026 18:00:00",
        passo: -1,
    };
}

function seedPendencia(storage, dados = pendenciaValida()) {
    storage.setItem(KEY, JSON.stringify({ status: "pendente", mensagem: "", ...dados }));
}

// ── Casos ──────────────────────────────────────────────────────────────────
async function caso1_sucesso() {
    const storage = makeStorage();
    seedPendencia(storage);
    const { rpcs, chamadas } = makeRpcs();
    const { machine } = makeMachine({ storage, rpcs });

    const resultado = await machine.run();

    assert.strictEqual(resultado.resultado, "concluido");
    assert.deepStrictEqual(chamadas, ORDEM_COMPLETA, "Passos devem rodar na ordem da spec");
    assert.strictEqual(storage.getItem(KEY), null, "Pendência deve ser apagada no sucesso");
    assert.strictEqual(rpcs._dinheiro, 150, "Dinheiro contado deve ser repassado");
    assert.strictEqual(rpcs._notas, "fechamento do dia", "Notas devem ser repassadas");
    // Compare via JSON: objetos vindos do vm têm outro protótipo de Array.
    assert.strictEqual(
        JSON.stringify(rpcs._diferencas),
        JSON.stringify([[2, -5]]),
        "Diferenças bancárias devem ser repassadas"
    );
    console.log("✓ Caso 1: sucesso completo na ordem dos passos");
}

async function caso2_rede_retomada() {
    for (const passoQueFalha of PASSOS_RPC) {
        const storage = makeStorage();
        seedPendencia(storage);

        const falho = makeRpcs({
            [passoQueFalha]: async () => {
                throw redeError();
            },
        });
        const primeira = makeMachine({ storage, rpcs: falho.rpcs });
        const r1 = await primeira.machine.run();
        assert.strictEqual(r1.resultado, "pendente", `${passoQueFalha}: rede mantém pendente`);
        assert.strictEqual(r1.deveTentarDeNovo, true);
        assert.strictEqual(JSON.parse(storage.getItem(KEY)).status, "pendente");

        // Nova instância = "reload" do PDV: retoma do armazenamento.
        const ok = makeRpcs();
        const segunda = makeMachine({ storage, rpcs: ok.rpcs });
        const r2 = await segunda.machine.run();
        assert.strictEqual(r2.resultado, "concluido", `${passoQueFalha}: retomada conclui`);

        const idx = PASSOS_RPC.indexOf(passoQueFalha);
        for (const anterior of PASSOS_RPC.slice(0, idx)) {
            assert.ok(
                !ok.chamadas.includes(anterior),
                `${passoQueFalha}: passo ${anterior} não deve repetir na retomada`
            );
        }
        assert.ok(ok.chamadas.includes(passoQueFalha), `${passoQueFalha}: retoma no passo que falhou`);
    }
    console.log("✓ Caso 2: falha de rede em cada passo e retomada sem repetir");
}

async function caso3_erro_negocio() {
    for (const passoQueFalha of PASSOS_RPC) {
        const storage = makeStorage();
        seedPendencia(storage);
        const falho = makeRpcs({
            [passoQueFalha]: async () => {
                throw negocioError();
            },
        });
        const { machine, erros } = makeMachine({ storage, rpcs: falho.rpcs });

        const r1 = await machine.run();
        assert.strictEqual(r1.resultado, "erro_negocio", `${passoQueFalha}: para`);
        assert.ok(r1.mensagem.includes("recusado"));
        assert.strictEqual(JSON.parse(storage.getItem(KEY)).status, STATUS_ERRO_NEGOCIO);
        assert.strictEqual(machine.podeTentarNovamente(), false);
        assert.ok(erros.length >= 1, "Erro de negócio vai para console.error");

        const chamadasAntes = falho.chamadas.length;
        const r2 = await machine.run();
        assert.strictEqual(r2.resultado, "erro_negocio", `${passoQueFalha}: sem retry`);
        assert.strictEqual(falho.chamadas.length, chamadasAntes, "RPC não é chamado de novo");
    }
    console.log("✓ Caso 3: erro de negócio em cada passo para e não retenta");
}

async function caso3b_successful_false() {
    const storage = makeStorage();
    seedPendencia(storage);
    const { rpcs } = makeRpcs();
    rpcs.fecharSessao = async () => ({ successful: false, message: "Diferença não autorizada" });
    const { machine } = makeMachine({ storage, rpcs });

    const resultado = await machine.run();
    assert.strictEqual(resultado.resultado, "erro_negocio");
    assert.ok(resultado.mensagem.includes("Diferença não autorizada"));
    console.log("✓ Caso 3b: successful:false é erro de negócio");
}

async function caso4_sessao_fechada_passo0() {
    const storage = makeStorage();
    seedPendencia(storage);
    const { rpcs, chamadas } = makeRpcs({}, "closed");
    const { machine } = makeMachine({ storage, rpcs, contar: () => 4 });

    const resultado = await machine.run();
    assert.strictEqual(resultado.resultado, "abortado_sessao_fechada");
    assert.strictEqual(resultado.vendasNaoEnviadas, 4);
    assert.deepStrictEqual(chamadas, ["lerEstadoSessao"], "Não roda passos após o conflito");
    assert.strictEqual(storage.getItem(KEY), null, "Pendência apagada no conflito");
    console.log("✓ Caso 4: sessão já fechada no passo 0 aborta com contagem");
}

async function caso5_sessao_fechada_no_meio() {
    const cenarios = [
        {
            nome: "mudarParaFechamento lança UserError",
            passo: "mudarParaFechamento",
            impl: async () => {
                throw new Error("This session is already closed.");
            },
        },
        {
            nome: "fecharSessao devolve alerta",
            passo: "fecharSessao",
            impl: async () => ({
                successful: false,
                type: "alert",
                title: "Session already closed",
                message: "...",
            }),
        },
    ];
    for (const cenario of cenarios) {
        const storage = makeStorage();
        seedPendencia(storage);
        const { rpcs } = makeRpcs({ [cenario.passo]: cenario.impl });
        const { machine } = makeMachine({ storage, rpcs });
        const resultado = await machine.run();
        assert.strictEqual(resultado.resultado, "abortado_sessao_fechada", cenario.nome);
        assert.strictEqual(storage.getItem(KEY), null);
    }
    console.log("✓ Caso 5: sessão fechada no meio aborta com limpeza");
}

async function caso6_closing_control() {
    const storage = makeStorage();
    seedPendencia(storage);
    const { rpcs, chamadas } = makeRpcs({}, "closing_control");
    const { machine } = makeMachine({ storage, rpcs });

    const resultado = await machine.run();
    assert.strictEqual(resultado.resultado, "concluido");
    assert.deepStrictEqual(
        chamadas,
        ["lerEstadoSessao", "fecharSessao"],
        "Em closing_control só o passo final roda"
    );
    console.log("✓ Caso 6: sessão em closing_control pula para o passo final");
}

async function caso7_pedidos_pendentes() {
    const storage = makeStorage();
    seedPendencia(storage);
    const { rpcs, chamadas } = makeRpcs({
        drenarPedidos: async () => {
            throw pedidosPendentesError();
        },
    });
    const { machine } = makeMachine({ storage, rpcs });

    const resultado = await machine.run();
    assert.strictEqual(resultado.resultado, "pendente");
    assert.ok(!chamadas.includes("gravarDinheiroContado"), "Não avança para o passo 3");
    assert.strictEqual(JSON.parse(storage.getItem(KEY)).passo, PASSO_OUTBOX);
    console.log("✓ Caso 7: pedidos não drenados bloqueiam o passo 3");
}

async function caso8_outra_sessao() {
    const storage = makeStorage();
    storage.setItem(
        KEY,
        JSON.stringify({ ...pendenciaValida(), session_id: SESSION_ID + 1, status: "pendente" })
    );
    const { rpcs, chamadas } = makeRpcs();
    const { machine } = makeMachine({ storage, rpcs });

    assert.strictEqual(machine.lerPendencia(), null);
    const resultado = await machine.run();
    assert.strictEqual(resultado.resultado, "sem_pendencia");
    assert.deepStrictEqual(chamadas, [], "Nenhum RPC roda com pendência de outra sessão");
    console.log("✓ Caso 8: pendência de outra sessão é descartada");
}

async function caso9_serializado() {
    const storage = makeStorage();
    seedPendencia(storage);
    let liberar;
    const bloqueio = new Promise((resolve) => (liberar = resolve));
    const { rpcs, chamadas } = makeRpcs();
    const drenarBase = rpcs.drenarOutbox;
    rpcs.drenarOutbox = async () => {
        await bloqueio;
        return drenarBase();
    };
    const { machine } = makeMachine({ storage, rpcs });

    const p1 = machine.run();
    const p2 = machine.run();
    liberar();
    const [r1, r2] = await Promise.all([p1, p2]);

    assert.deepStrictEqual(r1, r2, "As duas chamadas compartilham a mesma execução");
    assert.strictEqual(r1.resultado, "concluido");
    assert.strictEqual(
        chamadas.filter((c) => c === "lerEstadoSessao").length,
        1,
        "Passos não rodam em paralelo"
    );
    assert.strictEqual(chamadas.filter((c) => c === "fecharSessao").length, 1);
    console.log("✓ Caso 9: execução serializada");
}

async function caso10_sem_cash_control() {
    const storage = makeStorage();
    seedPendencia(storage);
    const { rpcs, chamadas } = makeRpcs();
    const { machine } = makeMachine({ storage, rpcs, controleCaixa: false });

    const resultado = await machine.run();
    assert.strictEqual(resultado.resultado, "concluido");
    assert.ok(!chamadas.includes("gravarDinheiroContado"), "Sem cash_control não grava dinheiro");
    console.log("✓ Caso 10: sem controle de caixa pula o passo 3");
}

async function main() {
    await caso1_sucesso();
    await caso2_rede_retomada();
    await caso3_erro_negocio();
    await caso3b_successful_false();
    await caso4_sessao_fechada_passo0();
    await caso5_sessao_fechada_no_meio();
    await caso6_closing_control();
    await caso7_pedidos_pendentes();
    await caso8_outra_sessao();
    await caso9_serializado();
    await caso10_sem_cash_control();
    console.log("\nTodos os testes passaram ✓");
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
