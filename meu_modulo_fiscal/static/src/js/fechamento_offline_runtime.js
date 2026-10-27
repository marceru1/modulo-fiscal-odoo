/** @odoo-module */
// Runtime do fechamento offline (spec fechamento-offline-fila, tickets 05/07):
// guarda o snapshot do servidor em memória, monta o delta local a partir do
// PosStore, cria a outbox e a máquina de replay, e define os RPCs reais do
// replay. A UI (popup, banner) fica nos patches — aqui nada de Owl.

import { calcularFechamentoOffline } from "./fechamento_offline_core";
import { createOutbox, registrarRefreshSnapshot } from "./fechamento_outbox";
import { createReplayMachine } from "./fechamento_replay";

let _estado = null;

function mesmoEscopo(estado, configId, sessionId) {
    return (
        estado &&
        String(estado.configId) === String(configId) &&
        String(estado.sessionId) === String(sessionId)
    );
}

function formatarData(valor) {
    try {
        if (valor && typeof valor.toFormat === "function") {
            return valor.toFormat("dd/MM/yyyy HH:mm");
        }
        if (typeof valor === "string") {
            return valor;
        }
    } catch (error) {
        // Data inválida não pode quebrar o fechamento.
    }
    return "";
}

function nomeCliente(ordem) {
    const parceiro = typeof ordem.get_partner === "function" ? ordem.get_partner() : null;
    const nome = parceiro && parceiro.name;
    return nome && nome !== "Public" ? nome : "CONSUMIDOR";
}

/**
 * Inicializa (uma vez) o estado do fechamento offline para a sessão atual.
 *
 * @param {object} pos PosStore
 * @returns {object} estado ({configId, sessionId, snapshot, outbox, replay, ...})
 */
export function initFechamentoOffline(pos) {
    const configId = pos.config.id;
    const sessionId = pos.session.id;
    if (mesmoEscopo(_estado, configId, sessionId)) {
        return _estado;
    }
    _estado = {
        configId,
        sessionId,
        snapshot: null,
        dadosOffline: null,
        modoOffline: false,
        outbox: createOutbox({
            storage: window.localStorage,
            configId,
            sessionId,
        }),
        replay: null,
        refreshing: null,
        refreshPendente: false,
    };
    registrarRefreshSnapshot(() => refrescarSnapshot(pos));
    return _estado;
}

export function obterEstado() {
    return _estado;
}

export function obterSnapshot() {
    return _estado ? _estado.snapshot : null;
}

/** Tira um snapshot novo do servidor e limpa do espelho o que já está nele. */
export async function tirarSnapshot(pos) {
    const estado = initFechamentoOffline(pos);
    const snapshot = await pos.env.services.orm.call(
        "pos.session",
        "get_fechamento_offline_snapshot",
        [[estado.sessionId]]
    );
    estado.snapshot = snapshot;
    // Os movimentos sincronizados já estão neste snapshot.
    estado.outbox.limparSincronizados();
    return snapshot;
}

/**
 * Refresca o snapshot (best-effort). Se um refresh for pedido enquanto outro
 * roda, repete ao final para não perder um movimento que chegou no meio.
 */
export function refrescarSnapshot(pos) {
    const estado = _estado;
    if (!estado) {
        return Promise.resolve(null);
    }
    if (estado.refreshing) {
        estado.refreshPendente = true;
        return estado.refreshing;
    }
    estado.refreshing = (async () => {
        do {
            estado.refreshPendente = false;
            await tirarSnapshot(pos);
        } while (estado.refreshPendente);
    })()
        .catch((error) => {
            // Snapshot é best-effort: sem ele o fechamento offline fica
            // indisponível, mas o PDV segue funcionando.
            console.warn("[FECHAMENTO] Falha ao tirar snapshot:", error);
            return null;
        })
        .finally(() => {
            estado.refreshing = null;
        });
    return estado.refreshing;
}

/** Pedidos pagos em memória (o delta entra no cálculo; rascunhos ficam fora). */
export function montarPedidosLocais(pos) {
    return pos.models["pos.order"]
        .filter((ordem) => ordem.finalized && ordem.state !== "cancel")
        .map((ordem) => ({
            id: ordem.id,
            amount_total: ordem.get_total_with_tax ? ordem.get_total_with_tax() : 0,
            cliente: nomeCliente(ordem),
            data: formatarData(ordem.date_order),
            payments: (ordem.payment_ids || [])
                .filter((pagamento) => pagamento.is_done())
                .map((pagamento) => ({
                    method_id: pagamento.payment_method_id && pagamento.payment_method_id.id,
                    method_name:
                        (pagamento.payment_method_id && pagamento.payment_method_id.name) || "",
                    type: (pagamento.payment_method_id && pagamento.payment_method_id.type) || "",
                    amount: pagamento.amount || 0,
                })),
        }));
}

/**
 * Calcula os dados do fechamento offline e guarda em `estado.dadosOffline`.
 * Devolve o `closing` (shape do popup) para abrir o ClosePosPopup nativo.
 */
export function calcularDadosOffline(pos) {
    const estado = initFechamentoOffline(pos);
    if (!estado.snapshot) {
        return null;
    }
    const dados = calcularFechamentoOffline({
        snapshot: estado.snapshot,
        pedidos: montarPedidosLocais(pos),
        movimentos: estado.outbox.listarMovimentos(),
        agora: new Date().toLocaleString(),
    });
    estado.dadosOffline = dados;
    estado.modoOffline = true;
    return dados.closing;
}

/** Conta vendas offline ainda não enviadas (alerta de conflito do replay). */
export function contarVendasNaoEnviadas(pos) {
    return pos.models["pos.order"].filter(
        (ordem) =>
            ordem.finalized && ordem.state !== "cancel" && typeof ordem.id !== "number"
    ).length;
}

function erroPedidosPendentes() {
    const erro = new Error("Ainda há pedidos pendentes de envio");
    erro.name = "OrdersPendingError";
    return erro;
}

/** Envia um movimento da outbox ao servidor (usado na drenagem e no replay). */
export async function enviarMovimento(pos, item) {
    return pos.data.call(
        "pos.session",
        "try_cash_in_out",
        [
            pos.session.id,
            item.tipo,
            item.valor,
            item.motivo,
            // `clientUuid` não tem dedupe no servidor (exigiria schema): fica
            // registrado para o gerente reconhecer um reenvio no backend.
            { translatedType: item.tipo, clientUuid: item.uuid },
        ],
        {},
        false
    );
}

/** RPCs reais do replay (mesma sequência do core). */
export function criarRpcsReplay(pos) {
    const sessionId = pos.session.id;
    return {
        lerEstadoSessao: async () => {
            const [sessao] = await pos.env.services.orm.read("pos.session", [sessionId], ["state"]);
            return sessao ? sessao.state : "closed";
        },
        drenarOutbox: async () => {
            const resultado = await initFechamentoOffline(pos).outbox.drenar((item) =>
                enviarMovimento(pos, item)
            );
            if (resultado.erroNegocio) {
                throw new Error(resultado.mensagem);
            }
            if (resultado.erroRede) {
                const erro = new Error("Rede caiu durante a drenagem da outbox");
                erro.name = "ConnectionLostError";
                throw erro;
            }
        },
        drenarPedidos: async () => {
            await pos.syncAllOrders({ throw: true });
            const { orderToCreate, orderToUpdate } = pos.getPendingOrder();
            if (orderToCreate.length || orderToUpdate.length) {
                throw erroPedidosPendentes();
            }
        },
        gravarDinheiroContado: async (valor) => {
            const resposta = await pos.data.call(
                "pos.session",
                "post_closing_cash_details",
                [sessionId],
                { counted_cash: valor }
            );
            if (resposta && resposta.successful === false) {
                return resposta;
            }
        },
        mudarParaFechamento: async (notas) => {
            await pos.data.call("pos.session", "update_closing_control_state_session", [
                sessionId,
                notas,
            ]);
        },
        fecharSessao: async (diferencas) => {
            return pos.data.call(
                "pos.session",
                "close_session_from_ui",
                [sessionId, diferencas],
                { context: { login_number: odoo.login_number } }
            );
        },
    };
}

/** Máquina de replay da sessão atual (criada sob demanda). */
export function obterReplay(pos) {
    const estado = initFechamentoOffline(pos);
    if (!estado.replay) {
        estado.replay = createReplayMachine({
            storage: window.localStorage,
            configId: estado.configId,
            sessionId: estado.sessionId,
            rpcs: criarRpcsReplay(pos),
            controleCaixa: Boolean(pos.config.cash_control),
            contarVendasNaoEnviadas: () => contarVendasNaoEnviadas(pos),
        });
    }
    return estado.replay;
}
