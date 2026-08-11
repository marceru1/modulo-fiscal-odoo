/** @odoo-module */
import { PaymentScreen } from "@point_of_sale/app/screens/payment_screen/payment_screen";
import { patch } from "@web/core/utils/patch";

/**
 * Avalia se o cliente pode comprar a prazo dentro do limite configurado.
 *
 * Função pura (sem side effects, sem ORM, sem dialog) — recebe os dados já
 * carregados do ORM e retorna `{ ok, msg, tipo }`. Seam de teste da spec
 * modal-limite-prazo: testável em isolamento com dados mockados, sem Odoo.
 *
 * @param {object} partner - res.partner do pedido (usa .name)
 * @param {number} orderTotal - total da compra com imposto
 * @param {Array} partnerData - resultado de orm.read("res.partner", ...) → [{ credit, credit_limit }]
 * @param {Array} employees - resultado de orm.searchRead("hr.employee", ...) → [{ x_limite_prazo }]
 * @returns {{ok: boolean, msg?: string, tipo?: string}}
 *   - { ok: true } quando credit + orderTotal <= limite
 *   - { ok: false, tipo: 'excedido', msg } quando limite excedido
 *   - { ok: false, tipo: 'sem_limite', msg } quando limite === 0 ou null/undefined
 */
export function _checkLimitePrazo(partner, orderTotal, partnerData, employees) {
    const credit = partnerData && partnerData[0] ? partnerData[0].credit || 0 : 0;

    // Limite vem do hr.employee vinculado (x_limite_prazo); sem vínculo,
    // cai no credit_limit do res.partner.
    let limite = 0;
    if (employees && employees.length > 0) {
        limite = employees[0].x_limite_prazo || 0;
    } else {
        limite = partnerData && partnerData[0] ? partnerData[0].credit_limit || 0 : 0;
    }

    if (limite <= 0) {
        return {
            ok: false,
            tipo: "sem_limite",
            msg: `⚠️ Cliente não está apto a comprar a prazo. Nenhum limite configurado para ${partner.name}.`,
        };
    }

    if (credit + orderTotal > limite) {
        return {
            ok: false,
            tipo: "excedido",
            msg:
                `⚠️ Saldo a prazo (${credit.toFixed(2)}) + esta compra (${orderTotal.toFixed(2)}) = ` +
                `${(credit + orderTotal).toFixed(2)} excede o limite de ${limite.toFixed(2)} para ${partner.name}.`,
        };
    }

    return { ok: true };
}

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
            // ── Credit-limit check (non-blocking) ────────────────────────────
            let limiteMsg = null;
            const partner = order.get_partner();
            if (partner) {
                try {
                    const orderTotal =
                        typeof order.get_total_with_tax === "function"
                            ? order.get_total_with_tax()
                            : order.amount_total || 0;

                    // 1. Read current outstanding credit from the partner
                    const partnerData = await this.env.services.orm.call(
                        "res.partner",
                        "read",
                        [[partner.id], ["credit", "credit_limit"]]
                    );

                    // 2. Look for a linked hr.employee to get x_limite_prazo
                    const employees = await this.env.services.orm.searchRead(
                        "hr.employee",
                        [
                            "|",
                            ["work_contact_id", "=", partner.id],
                            ["user_id.partner_id", "=", partner.id],
                        ],
                        ["x_limite_prazo"]
                    );

                    // 3. Pure helper: avalia limite e monta a mensagem.
                    //    Ticket 01 mantém comportamento externo idêntico ao atual:
                    //    só excedido gera notification (sem_limite será modal no ticket 02).
                    const result = _checkLimitePrazo(
                        partner,
                        orderTotal,
                        partnerData,
                        employees
                    );
                    if (result.tipo === "excedido") {
                        limiteMsg = result.msg;
                    }
                } catch (err) {
                    // Never block the sale due to a limit-check failure
                    console.warn("[LIMITE-CREDITO] Erro ao verificar limite:", err);
                }
            }
            // ── End credit-limit check ────────────────────────────────────────

            // Use the model API so assert_editable() is respected
            order.set_to_invoice(true);
            console.log(
                "[AUTO-INVOICE] pay_later detectado — pedido marcado como to_invoice=true."
            );

            // Store the message to show after super.validateOrder (after ui.unblock)
            this._limiteMsg = limiteMsg;
        }

        await super.validateOrder(...arguments);

        // Show limit warning AFTER the loading screen is gone
        if (this._limiteMsg) {
            setTimeout(() => {
                const notif =
                    this.notification ||
                    (this.env.services && this.env.services.notification);
                if (notif && typeof notif.add === "function") {
                    notif.add(this._limiteMsg, { type: "warning", sticky: false });
                } else {
                    console.warn("[LIMITE-CREDITO]", this._limiteMsg);
                }
                this._limiteMsg = null;
            }, 500);
        }
    },
});

