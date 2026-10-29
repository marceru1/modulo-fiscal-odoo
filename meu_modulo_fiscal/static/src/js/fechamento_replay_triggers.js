/** @odoo-module */
// Gatilhos e desfecho do replay automático do fechamento deferido (spec
// fechamento-offline-fila, ticket 07). Liga a máquina pura (fechamento_replay)
// ao PosStore real, sem interação do operador:
//   - evento "online" (depois da drenagem de pedidos do core);
//   - boot com pendência da sessão atual;
//   - intervalo de 30 s apenas com rede, pendência e passo falhando.
//
// Também drena a outbox de sangria/suprimento no boot e ao voltar a rede,
// MESMO sem fechamento pendente (senão uma sangria offline seguida de refresh
// se perderia).

import { PosStore } from "@point_of_sale/app/store/pos_store";
import { patch } from "@web/core/utils/patch";
import { _t } from "@web/core/l10n/translation";
import { AlertDialog } from "@web/core/confirmation_dialog/confirmation_dialog";
import {
    enviarMovimento,
    obterOutbox,
    obterReplay,
} from "./fechamento_offline_runtime";

const INTERVALO_RETENTATIVA_MS = 30000;
// O core drena pedidos com debounce de 100 ms ao voltar a rede. Esperamos um
// pouco para o replay NÃO passar na frente dessa drenagem.
const ATRASO_ONLINE_MS = 500;
// No boot, deixa o PosStore terminar (snapshot do ticket 05 incluso) antes de
// disparar o replay — evita corrida entre o snapshot de abertura e o fechamento.
const ATRASO_BOOT_MS = 1000;

patch(PosStore.prototype, {
    async afterProcessServerData() {
        const resultado = await super.afterProcessServerData(...arguments);
        this._registrarGatilhosReplay();

        // Adiado: o PosStore ainda está terminando o boot (snapshot incluso).
        setTimeout(() => {
            if (obterReplay(this).temPendencia()) {
                // Boot com pendência da sessão atual: retoma sozinho.
                this._iniciarReplayFechamento();
            } else {
                // Sem fechamento pendente, ainda assim drena a outbox.
                this._drenarOutboxSePuder();
            }
        }, ATRASO_BOOT_MS);
        return resultado;
    },

    _registrarGatilhosReplay() {
        if (this._gatilhosReplay) {
            return;
        }
        this._gatilhosReplay = true;

        window.addEventListener("online", () => {
            clearTimeout(this._timeoutReplayOnline);
            this._timeoutReplayOnline = setTimeout(() => {
                if (obterReplay(this).temPendencia()) {
                    this._iniciarReplayFechamento();
                } else {
                    this._drenarOutboxSePuder();
                }
            }, ATRASO_ONLINE_MS);
        });

        this._intervaloReplay = setInterval(() => {
            if (this.data.network.offline) {
                return;
            }
            const replay = obterReplay(this);
            if (replay.temPendencia() && replay.podeTentarNovamente()) {
                this._iniciarReplayFechamento();
            }
        }, INTERVALO_RETENTATIVA_MS);
    },

    /** Uma execução por vez: online + intervalo compartilham o resultado. */
    _iniciarReplayFechamento() {
        if (this._replayEmAndamento) {
            return this._replayEmAndamento;
        }
        this._replayEmAndamento = (async () => {
            const replay = obterReplay(this);
            if (!replay.temPendencia()) {
                return null;
            }
            const pendencia = replay.lerPendencia();
            const resultado = await replay.run();
            this._atualizarFechamentoPendente();
            return this._tratarResultadoReplay(resultado, pendencia);
        })().finally(() => {
            this._replayEmAndamento = null;
        });
        return this._replayEmAndamento;
    },

    async _tratarResultadoReplay(resultado, pendencia) {
        if (!resultado) {
            return;
        }
        switch (resultado.resultado) {
            case "concluido":
                // Diferença recibo offline x servidor: só console.warn (DEC-009).
                await this._avisarDivergenciaReplay(pendencia);
                this._voltarParaHomeOdoo();
                break;
            case "abortado_sessao_fechada":
                // Um único alerta simples; depois do OK vai para /odoo.
                this._alertarSessaoJaFechada(resultado.vendasNaoEnviadas || 0);
                break;
            case "erro_negocio":
            case "pendente":
            case "sem_pendencia":
            default:
                // Erro de negócio: banner vermelho (estado já atualizado) e
                // nenhum retry automático. Rede: tenta de novo no próximo gatilho.
                break;
        }
    },

    async _avisarDivergenciaReplay(pendencia) {
        if (!pendencia || !pendencia.relatorio) {
            return;
        }
        try {
            const servidor = await this.env.services.orm.call(
                "pos.session",
                "get_fechamento_data",
                [[this.session.id]]
            );
            const campos = [
                "total_vendas",
                "total_sangrias",
                "total_suprimentos",
                "total_recebimentos",
                "dinheiro_liquido",
            ];
            const divergencias = campos.filter(
                (campo) =>
                    Math.abs(
                        (Number(pendencia.relatorio[campo]) || 0) - (Number(servidor[campo]) || 0)
                    ) > 0.005
            );
            if (divergencias.length) {
                console.warn(
                    "[FECHAMENTO] Divergência entre o recibo offline e o servidor:",
                    divergencias.map((campo) => ({
                        campo,
                        offline: pendencia.relatorio[campo],
                        servidor: servidor[campo],
                    }))
                );
            }
        } catch (error) {
            // Divergência é diagnóstico: nunca impede o redirect.
            console.warn("[FECHAMENTO] Não foi possível comparar recibo e servidor:", error);
        }
    },

    _alertarSessaoJaFechada(vendasNaoEnviadas) {
        const body = vendasNaoEnviadas
            ? _t(
                  "Este caixa já foi fechado pelo sistema. %s vendas não foram enviadas, avise o gerente.",
                  vendasNaoEnviadas
              )
            : _t("Este caixa já foi fechado pelo sistema.");
        this.dialog.add(
            AlertDialog,
            { title: _t("Caixa já fechado"), body },
            { onClose: () => this._voltarParaHomeOdoo() }
        );
    },

    /** Mesmo mecanismo do fechamento online: /odoo, sem nova sessão. */
    _voltarParaHomeOdoo() {
        try {
            window.history.replaceState(null, "", "/odoo");
        } catch (error) {
            console.warn("[FECHAMENTO] Falha ao trocar a URL para /odoo:", error);
        }
        window.location.reload();
    },

    /** Drena a outbox no boot/online mesmo sem fechamento pendente. */
    async _drenarOutboxSePuder() {
        if (this.data.network.offline) {
            return;
        }
        // Com pendência, o passo 1 do replay já drena a outbox.
        if (obterReplay(this).temPendencia()) {
            return;
        }
        const outbox = obterOutbox(this);
        if (!outbox.listar().length) {
            return;
        }
        const resultado = await outbox.drenar((item) => enviarMovimento(this, item));
        if (resultado.erroNegocio) {
            // O outbox já loga o detalhe; aqui só destacamos que a drenagem parou.
            console.error("[FECHAMENTO] Drenagem da outbox parou por recusa do servidor.");
        }
    },
});
