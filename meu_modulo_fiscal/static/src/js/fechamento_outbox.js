/** @odoo-module */
// Outbox persistida + espelho local de sangria/suprimento (spec
// fechamento-offline-fila, ticket 03 — DEC-002).
//
// A fila genérica do data_service do core é EM MEMÓRIA: uma sangria offline
// seguida de refresh (com rede) se perde. A outbox daqui grava no
// armazenamento do navegador (sobrevive a refresh) e é drenada quando a rede
// volta e no boot.
//
// O espelho local é o que alimenta o cálculo do ticket 02: ele guarda TODOS
// os movimentos desde o último snapshot bem-sucedido — os offline (synced
// false, ainda na outbox) e os online (synced true, já no servidor mas talvez
// ainda fora do snapshot). Quando o snapshot é refrescado, os `synced` podem
// ser descartados (limparSincronizados) sem perder nada.
//
// Módulo JS PURO: armazenamento, gerador de uuid e relógio entram por injeção.

/** Nome da chave da outbox (por pos.config + pos.session). */
export function chaveOutbox(configId, sessionId) {
    return `meu_modulo.fechamento.outbox.${configId}.${sessionId}`;
}

/** Nome da chave do espelho local de movimentos. */
export function chaveEspelho(configId, sessionId) {
    return `meu_modulo.fechamento.movimentos.${configId}.${sessionId}`;
}

function gerarUuid() {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
        return crypto.randomUUID();
    }
    return `uuid-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function ehErroDeRede(error) {
    if (!error) {
        return false;
    }
    const nome = error.name || (error.constructor && error.constructor.name);
    return nome === "ConnectionLostError";
}

/**
 * Cria a outbox + espelho.
 *
 * @param {object} deps
 * @param {object} deps.storage armazenamento (getItem/setItem/removeItem)
 * @param {number} deps.configId
 * @param {number|string} deps.sessionId
 * @param {Function} [deps.uuid] gerador de identificador único
 * @param {Function} [deps.relogio] timestamp do movimento
 * @param {Function} [deps.isNetworkError]
 * @param {object}   [deps.logger]
 */
export function createOutbox(deps) {
    const {
        storage,
        configId,
        sessionId,
        uuid = gerarUuid,
        relogio = () => new Date().toISOString(),
        isNetworkError = ehErroDeRede,
        logger = console,
    } = deps;

    const keyOutbox = chaveOutbox(configId, sessionId);
    const keyEspelho = chaveEspelho(configId, sessionId);
    let drenando = null;

    function ler(chave) {
        let bruto = null;
        try {
            bruto = storage.getItem(chave);
        } catch (error) {
            logger.warn("[FECHAMENTO] Storage indisponível ao ler:", error);
            return [];
        }
        if (!bruto) {
            return [];
        }
        try {
            const dados = JSON.parse(bruto);
            return Array.isArray(dados) ? dados : [];
        } catch (error) {
            logger.warn("[FECHAMENTO] Registro corrompido, descartando:", error);
            return [];
        }
    }

    function escrever(chave, itens) {
        try {
            storage.setItem(chave, JSON.stringify(itens));
        } catch (error) {
            logger.warn("[FECHAMENTO] Não foi possível gravar no storage:", error);
        }
    }

    function novoItem(movimento, synced) {
        return {
            uuid: movimento.uuid || uuid(),
            tipo: movimento.tipo,
            valor: Number(movimento.valor) || 0,
            motivo: movimento.motivo || "",
            quando: movimento.quando || relogio(),
            synced: Boolean(synced),
        };
    }

    // ── Espelho ────────────────────────────────────────────────────────────
    function espelhar(item) {
        const espelho = ler(keyEspelho);
        if (espelho.some((existente) => existente.uuid === item.uuid)) {
            return;
        }
        espelho.push({
            uuid: item.uuid,
            tipo: item.tipo,
            valor: item.valor,
            motivo: item.motivo,
            quando: item.quando,
            synced: item.synced,
        });
        escrever(keyEspelho, espelho);
    }

    /** Movimento online já no servidor: entra no espelho como sincronizado. */
    function espelharOnline(movimento) {
        const item = novoItem(movimento, true);
        espelhar(item);
        return item;
    }

    /** Movimentos desde o último snapshot (o cálculo do ticket 02 consome). */
    function listarMovimentos() {
        return ler(keyEspelho);
    }

    /** Depois de um snapshot bem-sucedido, os sincronizados já estão nele. */
    function limparSincronizados() {
        escrever(
            keyEspelho,
            ler(keyEspelho).filter((item) => !item.synced)
        );
    }

    // ── Outbox ─────────────────────────────────────────────────────────────
    /** Movimento offline: grava na outbox E no espelho (synced=false). */
    function adicionar(movimento) {
        const item = novoItem(movimento, false);
        const pendentes = ler(keyOutbox);
        pendentes.push(item);
        escrever(keyOutbox, pendentes);
        espelhar(item);
        return item;
    }

    function listar() {
        return ler(keyOutbox);
    }

    function remover(uuidItem) {
        escrever(
            keyOutbox,
            ler(keyOutbox).filter((item) => item.uuid !== uuidItem)
        );
    }

    function marcarSincronizado(uuidItem) {
        escrever(
            keyEspelho,
            ler(keyEspelho).map((item) =>
                item.uuid === uuidItem ? { ...item, synced: true } : item
            )
        );
    }

    /**
     * Drena a outbox em ordem. Remove o item só após o envio bem-sucedido.
     * - erro de rede: para e mantém o item para a próxima tentativa;
     * - erro de negócio: `console.error` e para (DEC-010). O item permanece na
     *   outbox para o gerente/backend resolver — a parada é visível, nunca
     *   silenciosa.
     *
     * @param {Function} enviar async (item) => void
     * @returns {Promise<{ok, enviados, erroRede, erroNegocio, mensagem}>}
     */
    function drenar(enviar) {
        if (drenando) {
            return drenando;
        }
        drenando = (async () => {
            const resultado = {
                ok: true,
                enviados: 0,
                erroRede: false,
                erroNegocio: false,
                mensagem: "",
            };
            for (const item of ler(keyOutbox)) {
                try {
                    await enviar(item);
                    remover(item.uuid);
                    marcarSincronizado(item.uuid);
                    resultado.enviados += 1;
                } catch (error) {
                    resultado.ok = false;
                    if (isNetworkError(error)) {
                        resultado.erroRede = true;
                        return resultado;
                    }
                    resultado.erroNegocio = true;
                    resultado.mensagem = (error && error.message) || String(error);
                    logger.error("[FECHAMENTO] Movimento recusado no envio:", error);
                    return resultado;
                }
            }
            return resultado;
        })().finally(() => {
            drenando = null;
        });
        return drenando;
    }

    return {
        keyOutbox,
        keyEspelho,
        adicionar,
        listar,
        remover,
        marcarSincronizado,
        espelharOnline,
        listarMovimentos,
        limparSincronizados,
        drenar,
    };
}

// ── Gancho de refresh do snapshot (consumido pelo ticket 05) ──────────────
let _refreshSnapshot = () => {};

/** Registra a função que tira um novo snapshot do servidor (ticket 05). */
export function registrarRefreshSnapshot(funcao) {
    _refreshSnapshot = typeof funcao === "function" ? funcao : () => {};
}

/** Pede um refresh do snapshot (no-op enquanto ninguém registrou). */
export function solicitarRefreshSnapshot() {
    try {
        _refreshSnapshot();
    } catch (error) {
        // O refresh é best-effort: nunca pode quebrar um movimento já confirmado.
        console.warn("[FECHAMENTO] Falha ao solicitar refresh do snapshot:", error);
    }
}
