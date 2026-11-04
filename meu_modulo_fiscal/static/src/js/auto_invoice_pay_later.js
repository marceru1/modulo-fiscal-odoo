/** @odoo-module */
import { PaymentScreen } from "@point_of_sale/app/screens/payment_screen/payment_screen";
import { patch } from "@web/core/utils/patch";
import { ask } from "@point_of_sale/app/store/make_awaitable_dialog";

/**
 * Avalia se o cliente pode comprar a prazo dentro do limite configurado.
 *
 * Função pura (sem side effects, sem ORM, sem dialog) — recebe os dados já
 * carregados do ORM e retorna `{ ok, msg, tipo }`. Seam de teste da spec
 * prazo-por-contato: a conta a prazo vive no contato, então o limite vem só
 * do `credit_limit` dele (sem funcionário).
 *
 * @param {object} partner - res.partner do pedido (usa .name)
 * @param {number} orderTotal - total da compra com imposto
 * @param {object} limiteData - retorno de _prazo_limite_credito → { credit, credit_limit }
 * @returns {{ok: boolean, msg?: string, tipo?: string}}
 *   - { ok: true } quando credit + orderTotal <= limite
 *   - { ok: false, tipo: 'excedido', msg } quando limite excedido
 *   - { ok: false, tipo: 'sem_limite', msg } quando limite === 0 ou null/undefined (DEC-C: hard block)
 */
export function _checkLimitePrazo(partner, orderTotal, limiteData) {
    const credit = (limiteData && limiteData.credit) || 0;
    const limite = (limiteData && limiteData.credit_limit) || 0;

    if (limite <= 0) {
        return {
            ok: false,
            tipo: "sem_limite",
            msg:
                `⚠️ ${partner.name} não tem limite a prazo cadastrado. ` +
                "Peça ao responsável para cadastrar o limite na ficha do contato " +
                "(aba Faturamento > Credit Limits).",
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
            // ── Credit-limit check (modal pré-validate) ──────────────────────
            const partner = order.get_partner();
            if (partner) {
                try {
                    const orderTotal =
                        typeof order.get_total_with_tax === "function"
                            ? order.get_total_with_tax()
                            : order.amount_total || 0;

                    // 1. UMA chamada ao seam com sudo: o caixa não tem os
                    //    grupos de contabilidade, e o método devolve só
                    //    {credit, credit_limit} do contato (DEC-G).
                    const limiteData = await this.env.services.orm.call(
                        "res.partner",
                        "_prazo_limite_credito",
                        [partner.id]
                    );

                    // 2. Pure helper: avalia limite e monta a mensagem
                    const result = _checkLimitePrazo(
                        partner,
                        orderTotal,
                        limiteData
                    );

                    // 3. Modal ANTES de super.validateOrder().
                    //    "excedido" e "sem_limite" são HARD BLOCK (DEC-C):
                    //    informativo, único botão "Entendi", e a venda a prazo
                    //    NÃO valida. O operador troca de método ou de cliente.
                    if (result.tipo === "excedido" || result.tipo === "sem_limite") {
                        await ask(this.dialog, {
                            title:
                                result.tipo === "excedido"
                                    ? "⚠️ Limite a Prazo Excedido"
                                    : "⚠️ Cliente Sem Limite a Prazo",
                            body: result.msg,
                            confirmLabel: "Entendi",
                        });
                        // Sempre aborta — não passa sem cobertura do limite.
                        return;
                    }
                } catch (err) {
                    // Offline/ORM failure com pay_later no pedido → HARD BLOCK.
                    // Não é seguro emitir a prazo sem verificar o limite.
                    console.warn("[LIMITE-CREDITO] Erro ao verificar limite:", err);
                    await ask(this.dialog, {
                        title: "⚠️ Não foi possível verificar limite a prazo",
                        body:
                            "A verificação de limite de crédito está indisponível no momento. " +
                            "A compra a prazo não será emitida agora. Tente novamente ou use outra forma de pagamento.",
                        confirmLabel: "Entendi",
                    });
                    return;
                }
            }
            // ── End credit-limit check ────────────────────────────────────────

            // Use the model API so assert_editable() is respected
            order.set_to_invoice(true);
            console.log(
                "[AUTO-INVOICE] pay_later detectado — pedido marcado como to_invoice=true."
            );
        }

        await super.validateOrder(...arguments);
    },
});

