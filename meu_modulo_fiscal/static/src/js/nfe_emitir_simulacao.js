/** @odoo-module */
/**
 * nfe_emitir_simulacao.js
 *
 * Action client da simulação de envio da NF-e modelo 55 (ticket 09).
 *
 * O botão Emitir devolve ir.actions.client com `params.json` (JSON preliminar
 * montado no servidor). Esta action:
 *   - registra o JSON no console do navegador (conferência do operador);
 *   - mostra o aviso "Simulação: nenhuma NF-e foi emitida".
 *
 * NÃO faça requisição aqui: a transmissão ao middleware/SEFAZ é a próxima
 * etapa e acontecerá no servidor (_nfe_preparar_envio), não no navegador.
 *
 * Registro (Odoo 18, addons/web/static/src/webclient/actions/
 * action_service.js:1235-1255): se o item do registry "actions" NÃO é uma
 * subclasse de Component, ele é chamado como função `(env, action)` —
 * é o mesmo padrão do client action nativo "display_notification"
 * (addons/web/static/src/webclient/actions/client_actions.js:9-25).
 *
 * Bundle: web.assets_backend (NUNCA point_of_sale._assets_pos).
 */
import { registry } from "@web/core/registry";
import { _t } from "@web/core/l10n/translation";

export const NFE_SIMULACAO_TAG = "meu_modulo_fiscal.nfe_simulacao";

/**
 * @param {object} env - ambiente Owl (env.services.notification)
 * @param {object} action - ir.actions.client com params.json
 * @returns {object|undefined} próxima ação (aqui, nenhuma)
 */
export function nfeSimulacaoAction(env, action) {
    const params = action.params || {};
    // Log para conferência manual no console do navegador.
    console.log("[NF-e] JSON preliminar (simulação, nada foi emitido):", params.json);
    env.services.notification.add(_t("Simulação: nenhuma NF-e foi emitida"), {
        title: _t("NF-e"),
        type: "warning",
        sticky: false,
    });
    return params.next;
}

registry.category("actions").add(NFE_SIMULACAO_TAG, nfeSimulacaoAction);
