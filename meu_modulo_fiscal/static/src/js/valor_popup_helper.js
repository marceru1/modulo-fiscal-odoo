/** @odoo-module */
import { NumberPopup } from "@point_of_sale/app/utils/input_popups/number_popup";

/**
 * I9: helper compartilhado entre acrescimo_popup.js e desconto_popup.js.
 *
 * Estes dois popups eram idênticos exceto pelo nome do botão, campo e título
 * do popup. O _clearPaymentLines() era copiado 100%. Aqui ficam as funções
 * exportadas simples (sem mixin de prototype) que ambos importam.
 */

/**
 * Limpa todas as linhas de pagamento do pedido.
 * Chamado antes de aplicar acréscimo/desconto para evitar valores residuais
 * de troco quando o operador seleciona a forma de pagamento antes de aplicar
 * acréscimo/desconto.
 *
 * @param {object} order - pos.order atual (this.pos.get_order())
 */
export function _clearPaymentLines(order) {
    const lines = [...(order.payment_ids || [])];
    for (const line of lines) {
        line.delete();
    }
}

/**
 * Abre o NumberPopup para editar um campo de valor (acréscimo ou desconto).
 * Se já houver linhas de pagamento, limpa-as antes de abrir o popup.
 *
 * @param {object} dialog - serviço de diálogo (this.dialog)
 * @param {object} env - ambiente Owl (this.env) para parseValidFloat
 * @param {object} order - pos.order atual (this.pos.get_order())
 * @param {string} fieldName - nome do campo no order (ex: x_amount_other_value)
 * @param {string} title - título do popup (ex: "Valor do Acréscimo")
 */
export function showValorPopup(dialog, env, order, fieldName, title) {
    const current = order[fieldName] || 0.0;

    // Se já tem linhas de pagamento, limpa antes de aplicar o valor
    if (order.payment_ids && order.payment_ids.length > 0) {
        _clearPaymentLines(order);
    }

    dialog.add(NumberPopup, {
        title: title,
        startingValue: current ? current.toString() : "",
        getPayload: (num) => {
            const val = env.utils.parseValidFloat(num ?? "0");
            const cleanVal = isNaN(val) ? 0.0 : Math.max(0, val);
            order[fieldName] = cleanVal;
        },
    });
}