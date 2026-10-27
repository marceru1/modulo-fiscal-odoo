/**
 * Teste de integração do replay automático (ticket 07), sem Owl:
 * máquina real (fechamento_replay.js) + outbox real (fechamento_outbox.js) +
 * RPCs fake com estado de servidor, simulando o ciclo offline → online.
 *
 * Cenários: sucesso no boot/online; rede cai no meio e retoma sem repetir;
 * erro de negócio sem retry; sessão já fechada no passo 0 e no meio; sangria
 * offline enviada uma única vez. Inclui o contrato textual dos gatilhos.
 *
 * Rodar: node meu_modulo_fiscal/tests/test_fechamento_replay_integracao.js
 */
const fs = require("fs");
const path = require("path");
const assert = require("assert");
const vm = require("vm");

const REPLAY_SOURCE = path.join(
    __dirname,
    "..",
    "static",
    "src",
    "js",
    "fechamento_replay.js"
);
const OUTBOX_SOURCE = path.join(
    __dirname,
    "..",
    "static",
    "src",
    "js",
    "fechamento_outbox.js"
);
const TRIGGERS_SOURCE = path.join(
    __dirname,
    "..",
    "static",
    "src",
    "js",
    "fechamento_replay_triggers.js"
);
const MANIFEST = path.join(__dirname, "..", "__manifest__.py");

function loadModule(file, exportNames) {
    let src = fs.readFileSync(file, "utf8");
    src = src.replace(/^\/\*\* @odoo-module \*\/\s*/m, "");
    src = src.replace(/\bexport\s+(const|function|class)\s+/g, "$1 ");
    return vm.runInNewContext(`(() => { ${src}\n return { ${exportNames.join(", ")} }; })()`, {
        console,
    });
}

const { createReplayMachine } = loadModule(REPLAY_SOURCE, ["createReplayMachine"]);
const { createOutbox } = loadModule(OUTBOX_SOURCE, ["createOutbox"]);

const CONFIG_ID = 9;
const SESSION_ID = 77;

function makeStorage() {
    const mapa = new Map();
    return {
        getItem: (k) => (mapa.has(k) ? mapa.get(k) : null),
        setItem: (k, v) => mapa.set(k, v),
        removeItem: (k) => mapa.delete(k),
    };
}

function redeError() {
    return Object.assign(new Error("Connection lost"), { name: "ConnectionLostError" });
}

/** Servidor fake com estado (sessão, pedidos, outbox) e falhas controláveis. */
function makeServidor(overrides = {}) {
    return {
        estado: "opened",
        pedidosPendentes: 2,
        sangriasServidor: [],
        chamadas: [],
        rede: true,
        falhaNegocio: null,
        falhaPedidosUmaVez: false,
        ...overrides,
    };
}

function fazerRpc(servidor, outbox) {
    const guardaRede = () => {
        if (!servidor.rede) {
            throw redeError();
        }
    };
    return {
        async lerEstadoSessao() {
            servidor.chamadas.push("lerEstadoSessao");
            guardaRede();
            return servidor.estado;
        },
        async drenarOutbox() {
            servidor.chamadas.push("drenarOutbox");
            guardaRede();
            const resultado = await outbox.drenar(async (item) => {
                guardaRede();
                servidor.sangriasServidor.push(item.uuid);
            });
            if (resultado.erroNegocio) {
                throw new Error(resultado.mensagem);
            }
            if (resultado.erroRede) {
                throw redeError();
            }
        },
        async drenarPedidos() {
            servidor.chamadas.push("drenarPedidos");
            guardaRede();
            if (servidor.falhaPedidosUmaVez) {
                servidor.falhaPedidosUmaVez = false;
                throw redeError();
            }
            servidor.pedidosPendentes = 0;
        },
        async gravarDinheiroContado() {
            servidor.chamadas.push("gravarDinheiroContado");
            guardaRede();
            if (servidor.falhaNegocio === "dinheiro") {
                throw new Error("dinheiro recusado");
            }
        },
        async mudarParaFechamento() {
            servidor.chamadas.push("mudarParaFechamento");
            guardaRede();
            if (servidor.falhaNegocio === "estado") {
                throw new Error("This session is already closed.");
            }
            servidor.estado = "closing_control";
        },
        async fecharSessao() {
            servidor.chamadas.push("fecharSessao");
            guardaRede();
            if (servidor.falhaNegocio === "fechar") {
                return { successful: false, message: "Diferença não autorizada" };
            }
            if (servidor.estado === "closed") {
                return {
                    successful: false,
                    type: "alert",
                    title: "Session already closed",
                    message: "The session has been already closed",
                };
            }
            servidor.estado = "closed";
            return { successful: true };
        },
    };
}

function preparar({ servidor, storage, pendencia = true, sangriaOffline = true }) {
    const outbox = createOutbox({
        storage,
        configId: CONFIG_ID,
        sessionId: SESSION_ID,
        uuid: (() => {
            let n = 0;
            return () => `uuid-${++n}`;
        })(),
        relogio: () => "2026-10-27T18:00:00",
        logger: { warn: () => {}, error: () => {} },
    });
    const machine = createReplayMachine({
        storage,
        configId: CONFIG_ID,
        sessionId: SESSION_ID,
        rpcs: fazerRpc(servidor, outbox),
        controleCaixa: true,
        contarVendasNaoEnviadas: () => servidor.pedidosPendentes,
        logger: { warn: () => {}, error: () => {} },
    });
    if (pendencia) {
        machine.criarPendencia({
            dinheiro_contado: 100,
            notas: "fechamento",
            diferencas_bancarias: [],
            relatorio: { total_vendas: 100 },
            closing: { orders_details: { quantity: 1, amount: 100 } },
            confirmado_em: "27/10/2026 18:00:00",
        });
    }
    if (sangriaOffline) {
        outbox.adicionar({ tipo: "out", valor: 30, motivo: "Sangria" });
    }
    return { outbox, machine };
}

async function caso1_ciclo_sucesso() {
    const servidor = makeServidor();
    const storage = makeStorage();
    const { machine } = preparar({ servidor, storage });

    // Offline: a rede cai no passo 0 → pendente, nada fechado.
    servidor.rede = false;
    const offline = await machine.run();
    assert.strictEqual(offline.resultado, "pendente");
    assert.strictEqual(servidor.estado, "opened");
    assert.strictEqual(machine.temPendencia(), true);

    // Online: replay conclui sozinho; sangria enviada 1x.
    servidor.rede = true;
    const online = await machine.run();
    assert.strictEqual(online.resultado, "concluido");
    assert.strictEqual(servidor.estado, "closed");
    assert.strictEqual(servidor.pedidosPendentes, 0);
    assert.strictEqual(servidor.sangriasServidor.length, 1, "Sangria enviada uma única vez");
    assert.strictEqual(machine.temPendencia(), false);
    console.log("✓ Caso 1: ciclo offline → online conclui e envia a sangria 1x");
}

async function caso2_rede_no_meio() {
    const servidor = makeServidor({ falhaPedidosUmaVez: true });
    const storage = makeStorage();
    const { machine } = preparar({ servidor, storage, sangriaOffline: false });

    const primeira = await machine.run();
    assert.strictEqual(primeira.resultado, "pendente");
    assert.deepStrictEqual(servidor.chamadas, ["lerEstadoSessao", "drenarOutbox", "drenarPedidos"]);
    assert.strictEqual(JSON.parse(storage.getItem("meu_modulo.fechamento.pendencia." + CONFIG_ID)).passo, 1);

    servidor.chamadas.length = 0;
    const segunda = await machine.run();
    assert.strictEqual(segunda.resultado, "concluido");
    assert.ok(!servidor.chamadas.includes("drenarOutbox"), "Passo 1 não repete");
    assert.ok(!servidor.chamadas.includes("lerEstadoSessao"), "Passo 0 não repete");
    assert.deepStrictEqual(servidor.chamadas, [
        "drenarPedidos",
        "gravarDinheiroContado",
        "mudarParaFechamento",
        "fecharSessao",
    ]);
    console.log("✓ Caso 2: rede cai no meio e retoma sem repetir os passos");
}

async function caso3_erro_negocio() {
    const servidor = makeServidor({ falhaNegocio: "fechar" });
    const storage = makeStorage();
    const { machine } = preparar({ servidor, storage, sangriaOffline: false });

    const primeira = await machine.run();
    assert.strictEqual(primeira.resultado, "erro_negocio");
    assert.ok(primeira.mensagem.includes("Diferença não autorizada"));
    assert.strictEqual(servidor.estado, "closing_control");
    const chamadasAntes = servidor.chamadas.length;

    const segunda = await machine.run();
    assert.strictEqual(segunda.resultado, "erro_negocio");
    assert.strictEqual(servidor.chamadas.length, chamadasAntes, "Sem retry automático");
    assert.strictEqual(machine.podeTentarNovamente(), false);
    console.log("✓ Caso 3: erro de negócio para o replay sem retry");
}

async function caso4_sessao_fechada_boot() {
    const servidor = makeServidor({ estado: "closed", pedidosPendentes: 3 });
    const storage = makeStorage();
    const { machine } = preparar({ servidor, storage, sangriaOffline: false });

    const resultado = await machine.run();
    assert.strictEqual(resultado.resultado, "abortado_sessao_fechada");
    assert.strictEqual(resultado.vendasNaoEnviadas, 3);
    assert.strictEqual(machine.temPendencia(), false);
    console.log("✓ Caso 4: sessão já fechada no boot aborta com contagem");
}

async function caso5_sessao_fechada_no_meio() {
    const servidor = makeServidor({ falhaNegocio: "estado" });
    const storage = makeStorage();
    const { machine } = preparar({ servidor, storage, sangriaOffline: false });

    const resultado = await machine.run();
    assert.strictEqual(resultado.resultado, "abortado_sessao_fechada");
    assert.strictEqual(machine.temPendencia(), false);
    console.log("✓ Caso 5: sessão fechada no meio aborta com limpeza");
}

// ── Contrato textual dos gatilhos ─────────────────────────────────────────
function contratoGatilhos() {
    const source = fs.readFileSync(TRIGGERS_SOURCE, "utf8");
    const manifest = fs.readFileSync(MANIFEST, "utf8");

    assert.match(source, /window\.addEventListener\("online"/, "Gatilho do evento online");
    assert.match(source, /setInterval\(/, "Retentativa por intervalo");
    assert.match(source, /INTERVALO_RETENTATIVA_MS = 30000/, "Intervalo de 30 s");
    assert.match(source, /ATRASO_ONLINE_MS/, "Atraso para não passar na frente do core");
    assert.match(source, /this\.data\.network\.offline/, "Só tenta com rede");
    assert.match(source, /podeTentarNovamente\(\)/, "Não retenta erro de negócio");
    assert.match(source, /replay\.run\(\)/, "Executa a máquina do ticket 04");
    assert.match(source, /replaceState\(null, "", "\/odoo"\)/, "Redirect para /odoo");
    assert.match(source, /window\.location\.reload\(\)/, "Recarrega após concluir");
    assert.match(source, /AlertDialog/, "Conflito usa um único alerta");
    assert.match(source, /já foi fechado pelo sistema/, "Mensagem do conflito");
    assert.match(source, /vendas não foram enviadas, avise o gerente/, "Contagem de vendas");
    assert.match(source, /console\.warn\([\s\S]{0,200}Divergência/, "Divergência só no console");
    assert.match(source, /_drenarOutboxSePuder\(\)/, "Drena outbox sem pendência");
    assert.match(source, /temPendencia\(\)[\s\S]{0,200}_iniciarReplayFechamento\(\)/, "Boot com pendência");

    assert.ok(
        manifest.includes("meu_modulo_fiscal/static/src/js/fechamento_replay_triggers.js"),
        "Gatilhos devem estar no manifest"
    );
    // Webhook não muda nesta feature.
    assert.ok(
        !/webhook|_prepare_nfce_payload/i.test(source),
        "Gatilhos não tocam o payload do webhook"
    );
    console.log("✓ Contrato: gatilhos, redirect, conflito e divergência");
}

async function main() {
    await caso1_ciclo_sucesso();
    await caso2_rede_no_meio();
    await caso3_erro_negocio();
    await caso4_sessao_fechada_boot();
    await caso5_sessao_fechada_no_meio();
    contratoGatilhos();
    console.log("\nTodos os testes passaram ✓");
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
