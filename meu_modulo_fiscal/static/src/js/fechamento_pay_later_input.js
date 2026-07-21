/** @odoo-module */
import { ClosePosPopup } from "@point_of_sale/app/navbar/closing_popup/closing_popup";
import { patch } from "@web/core/utils/patch";

/**
 * Patch no ClosePosPopup para que métodos de pagamento do tipo `pay_later`
 * (A Prazo / conta do cliente) também tenham um campo "Counted" no popup
 * de fechamento de caixa, igual já existe para métodos `bank`.
 *
 * O operador pode informar o valor que vendeu em conta do cliente e ver a
 * diferença em relação ao valor do sistema.
 *
 * Não-invasivo: só faz override de `getInitialState`, chamando o super e
 * adicionando a entrada em `state.payments` para pay_later. O `getDifference()`
 * do core já funciona para qualquer método em `non_cash_payment_methods`, e o
 * `canConfirm()` valida que todos os valores sejam floats válidos — como
 * pré-preenchemos com `formatCurrency(pm.amount, false)`, o valor inicial é
 * sempre um float válido.
 */
patch(ClosePosPopup.prototype, {
    getInitialState() {
        const initialState = super.getInitialState(...arguments);
        this.props.non_cash_payment_methods.forEach((pm) => {
            if (pm.type === "pay_later") {
                initialState.payments[pm.id] = {
                    counted: "0",
                };
            }
        });
        return initialState;
    },
});