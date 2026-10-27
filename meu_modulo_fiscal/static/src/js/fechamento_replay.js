/** @odoo-module */
// Máquina de estados do fechamento deferido (spec fechamento-offline-fila,
// ticket 04). Módulo JS PURO: sem Owl, sem import de @odoo — os RPCs entram
// por injeção de dependência e o armazenamento também. É testado em Node
// (tests/test_fechamento_replay.js) e consumido pela integração do ticket 07.
//
// Pipeline (ordem obrigatória da spec):
//   0 ler o estado da sessão no servidor
//   1 drenar sangrias/suprimentos pendentes (outbox do ticket 03)
//   2 drenar pedidos pendentes (falha NÃO avança)
//   3 gravar o dinheiro contado (só com controle de caixa)
//   4 mudar a sessão para controle de fechamento (com as notas)
//   5 fechar a sessão com as diferenças bancárias
//
// Os passos 1 e 2 vêm antes do fechamento porque o servidor recalcula os
// valores sobre os pedidos já sincronizados.

export const PASSO_SESSAO = 0;
export const PASSO_OUTBOX = 1;
export const PASSO_PEDIDOS = 2;
export const PASSO_DINHEIRO = 3;
export const PASSO_ESTADO = 4;
export const PASSO_FECHAR = 5;

export const STATUS_PENDENTE = "pendente";
export const STATUS_EXECUTANDO = "executando";
export const STATUS_ERRO_NEGOCIO = "erro_negocio";

/** Chave da pendência: uma por pos.config (1 caixa = 1 terminal, fora de escopo). */
export function chavePendencia(configId) {
    return `meu_modulo.fechamento.pendencia.${configId}`;
}

/** Erro de rede padrão (ConnectionLostError do core ou falha de fetch). */
export function ehErroDeRede(error) {
    if (!error) {
        return false;
    }
    const nome = error.name || (error.constructor && error.constructor.name);
    return nome === "ConnectionLostError";
}

/** "Sessão já fechada" — a resposta/dict que o core usa em _cannot_close_session. */
function pareceSessaoFechada(texto) {
    return /already closed|já foi fechada|ja foi fechada/i.test(texto || "");
}

/**
 * Classifica um erro vindo de um passo.
 * Retorna: "rede" | "sessao_fechada" | {tipo: "negocio", mensagem}.
 */
function classificar(error, isNetworkError) {
    // O core às vezes devolve o erro como DICT em vez de lançar.
    if (error && typeof error === "object" && error.successful === false) {
        const texto = `${error.title || ""} ${error.message || ""}`.trim();
        if (error.type === "alert" || pareceSessaoFechada(texto)) {
            return "sessao_fechada";
        }
        return { tipo: "negocio", mensagem: texto || "Fechamento recusado pelo servidor" };
    }
    if (isNetworkError(error)) {
        return "rede";
    }
    // Pedidos que não foram drenados são retentáveis: o passo NÃO avança.
    if (error && error.name === "OrdersPendingError") {
        return "rede";
    }
    const mensagem = (error && error.message) || String(error || "");
    if (pareceSessaoFechada(mensagem)) {
        return "sessao_fechada";
    }
    return { tipo: "negocio", mensagem };
}

/**
 * Cria a máquina de replay.
 *
 * @param {object} deps
 * @param {object} deps.storage armazenamento injetável (getItem/setItem/removeItem)
 * @param {number} deps.configId id do pos.config
 * @param {number|string} deps.sessionId id da pos.session
 * @param {object} deps.rpcs
 * @param {Function} deps.rpcs.lerEstadoSessao         passo 0 → 'opened'|'closing_control'|'closed'
 * @param {Function} deps.rpcs.drenarOutbox            passo 1
 * @param {Function} deps.rpcs.drenarPedidos           passo 2 (lança OrdersPendingError se sobrar pedido)
 * @param {Function} deps.rpcs.gravarDinheiroContado   passo 3 (recebe o valor)
 * @param {Function} deps.rpcs.mudarParaFechamento     passo 4 (recebe as notas)
 * @param {Function} deps.rpcs.fecharSessao            passo 5 (recebe as diferenças bancárias)
 * @param {Function} [deps.isNetworkError] default: ehErroDeRede
 * @param {boolean}  [deps.controleCaixa]  se false, pula o passo 3
 * @param {Function} [deps.contarVendasNaoEnviadas] contagem para o alerta de conflito
 * @param {object}   [deps.logger]
 */
export function createReplayMachine(deps) {
    const {
        storage,
        configId,
        sessionId,
        rpcs,
        isNetworkError = ehErroDeRede,
        controleCaixa = false,
        contarVendasNaoEnviadas = () => 0,
        logger = console,
    } = deps;

    const key = chavePendencia(configId);
    let emAndamento = null;

    // ── Persistência (tolerante a storage bloqueado/cheio) ────────────────
    function lerPendencia() {
        let bruto = null;
        try {
            bruto = storage.getItem(key);
        } catch (error) {
            logger.warn("[FECHAMENTO] Storage indisponível ao ler pendência:", error);
            return null;
        }
        if (!bruto) {
            return null;
        }
        let pendencia;
        try {
            pendencia = JSON.parse(bruto);
        } catch (error) {
            logger.warn("[FECHAMENTO] Pendência corrompida, descartando:", error);
            apagarPendencia();
            return null;
        }
        // Pendência de outra sessão (ex.: caixa de ontem) é descartada no boot.
        if (String(pendencia.session_id) !== String(sessionId)) {
            apagarPendencia();
            return null;
        }
        return pendencia;
    }

    function escreverPendencia(pendencia) {
        try {
            storage.setItem(key, JSON.stringify(pendencia));
        } catch (error) {
            logger.warn("[FECHAMENTO] Não foi possível persistir a pendência:", error);
        }
    }

    function apagarPendencia() {
        try {
            storage.removeItem(key);
        } catch (error) {
            logger.warn("[FECHAMENTO] Não foi possível apagar a pendência:", error);
        }
    }

    function criarPendencia(dados = {}) {
        const pendencia = {
            session_id: sessionId,
            dinheiro_contado: dados.dinheiro_contado ?? 0,
            notas: dados.notas ?? "",
            diferencas_bancarias: dados.diferencas_bancarias ?? [],
            relatorio: dados.relatorio ?? null,
            // Dados do popup no instante da confirmação: o popup somente
            // leitura (ticket 06) reabre com eles, sem recalcular.
            closing: dados.closing ?? null,
            confirmado_em: dados.confirmado_em ?? null,
            passo: -1,
            status: STATUS_PENDENTE,
            mensagem: "",
        };
        escreverPendencia(pendencia);
        return pendencia;
    }

    function temPendencia() {
        return Boolean(lerPendencia());
    }

    function podeTentarNovamente() {
        const pendencia = lerPendencia();
        return !pendencia || pendencia.status !== STATUS_ERRO_NEGOCIO;
    }

    // ── Execução ───────────────────────────────────────────────────────────
    function abortarSessaoFechada() {
        apagarPendencia();
        let vendasNaoEnviadas = 0;
        try {
            vendasNaoEnviadas = Number(contarVendasNaoEnviadas() || 0);
        } catch (error) {
            logger.warn("[FECHAMENTO] Falha ao contar vendas não enviadas:", error);
        }
        return { resultado: "abortado_sessao_fechada", vendasNaoEnviadas };
    }

    async function executarPasso(passo, pendencia) {
        switch (passo) {
            case PASSO_OUTBOX:
                return rpcs.drenarOutbox();
            case PASSO_PEDIDOS:
                return rpcs.drenarPedidos();
            case PASSO_DINHEIRO:
                return rpcs.gravarDinheiroContado(pendencia.dinheiro_contado);
            case PASSO_ESTADO:
                return rpcs.mudarParaFechamento(pendencia.notas);
            case PASSO_FECHAR:
                return rpcs.fecharSessao(pendencia.diferencas_bancarias);
            default:
                return undefined;
        }
    }

    async function executar() {
        let pendencia = lerPendencia();
        if (!pendencia) {
            return { resultado: "sem_pendencia" };
        }
        // Erro de negócio para o replay: nunca retenta sozinho (DEC-010).
        if (pendencia.status === STATUS_ERRO_NEGOCIO) {
            return {
                resultado: "erro_negocio",
                passo: pendencia.passo,
                mensagem: pendencia.mensagem,
            };
        }

        pendencia.status = STATUS_EXECUTANDO;
        escreverPendencia(pendencia);

        try {
            let passoAtual = Number.isInteger(pendencia.passo) ? pendencia.passo : -1;

            // Passo 0 só roda se nada foi concluído ainda.
            if (passoAtual < PASSO_SESSAO) {
                const estado = await rpcs.lerEstadoSessao();
                if (estado !== "opened" && estado !== "closing_control") {
                    return abortarSessaoFechada();
                }
                // Já em closing_control: os passos 3 e 4 foram feitos (pelo
                // core ou por outra tentativa) — vai direto ao fechamento.
                passoAtual = estado === "closing_control" ? PASSO_ESTADO : PASSO_SESSAO;
                pendencia.passo = passoAtual;
                escreverPendencia(pendencia);
            }

            for (let passo = passoAtual + 1; passo <= PASSO_FECHAR; passo++) {
                if (passo === PASSO_DINHEIRO && !controleCaixa) {
                    pendencia.passo = passo;
                    escreverPendencia(pendencia);
                    continue;
                }
                const resposta = await executarPasso(passo, pendencia);
                // O core devolve {successful: false} em vez de lançar nos
                // RPCs de fechamento — trata como recusa e cai no catch.
                if (resposta && typeof resposta === "object" && resposta.successful === false) {
                    throw resposta;
                }
                pendencia.passo = passo;
                pendencia.status = STATUS_EXECUTANDO;
                escreverPendencia(pendencia);
            }

            apagarPendencia();
            return { resultado: "concluido", passo: PASSO_FECHAR };
        } catch (error) {
            const tipo = classificar(error, isNetworkError);

            if (tipo === "sessao_fechada") {
                return abortarSessaoFechada();
            }
            if (tipo === "rede") {
                pendencia.status = STATUS_PENDENTE;
                pendencia.mensagem = "";
                escreverPendencia(pendencia);
                return {
                    resultado: "pendente",
                    passo: pendencia.passo,
                    motivo: "rede",
                    deveTentarDeNovo: true,
                };
            }

            // Erro de negócio: para de tentar sozinho; o gerente resolve no backend.
            pendencia.status = STATUS_ERRO_NEGOCIO;
            pendencia.mensagem = tipo.mensagem;
            escreverPendencia(pendencia);
            logger.error("[FECHAMENTO] Replay recusado pelo servidor:", tipo.mensagem);
            return {
                resultado: "erro_negocio",
                passo: pendencia.passo,
                mensagem: tipo.mensagem,
            };
        }
    }

    function run() {
        // Serializa: duas chamadas simultâneas (online + intervalo) compartilham
        // a mesma execução — nunca rodam passos em paralelo.
        if (!emAndamento) {
            emAndamento = executar().finally(() => {
                emAndamento = null;
            });
        }
        return emAndamento;
    }

    return {
        key,
        run,
        lerPendencia,
        criarPendencia,
        apagarPendencia,
        temPendencia,
        podeTentarNovamente,
    };
}
