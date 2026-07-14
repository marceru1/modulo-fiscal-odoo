/** @odoo-module */
import { PaymentScreen } from "@point_of_sale/app/screens/payment_screen/payment_screen";
import { patch } from "@web/core/utils/patch";

/**
 * Task 4 — Auto-invoice on pay_later (Conta do Cliente)
 *
 * When the operator validates a payment that includes a pay_later line,
 * we force to_invoice = true BEFORE super.validateOrder() is called so
 * that Odoo generates an account.move when the order is synced to the
 * backend.
 *
 * NOTE: confirm_popup.js already patches validateOrder; OWL applies
 * patches in sequence, so both overrides will run safely as long as
 * each calls super.validateOrder(...arguments).
 */
patch(PaymentScreen.prototype, {
    async validateOrder(isForceValidate) {
        const order = this.pos.get_order();

        // payment_ids is the canonical Odoo 18 array of PosPayment records
        const hasPayLater = (order.payment_ids || []).some(
            (p) => p.payment_method_id && p.payment_method_id.type === "pay_later"
        );

        if (hasPayLater) {
            // Use the model API so assert_editable() is respected
            order.set_to_invoice(true);
            console.log(
                "[AUTO-INVOICE] pay_later detectado — pedido marcado como to_invoice=true."
            );
        }

        await super.validateOrder(...arguments);
    },
});
