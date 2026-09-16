/** @odoo-module */
/**
 * Fix: TypeError: Cannot read properties of null (reading 'cloneNode')
 *
 * Causa raiz: O afterOrderValidation do Odoo core chama this.pos.printReceipt()
 * SEM await. A impressão dispara async e concorre com a transição de tela.
 * O renderer.toHtml() pode retornar null se o componente OrderReceipt não
 * terminou de montar no RenderContainer hidden — aí o applyWhenMounted faz
 * el.cloneNode(true) com el=null e estoura.
 *
 * Fix: Patch do PosStore.printReceipt com try-catch + retry escalonado.
 * Se pegar TypeError de cloneNode, espera 300ms e tenta de novo.
 * Se falhar de novo, espera 600ms e tenta uma última vez.
 * Se TODOS os retries falharem, faz fallback via renderToElement + window.print
 * (mesmo template, mesmos dados, sem depender do RenderContainer).
 */
import { PosStore } from "@point_of_sale/app/store/pos_store";
import { patch } from "@web/core/utils/patch";
import { renderToElement } from "@web/core/utils/render";
import { printFallback } from "./receipt_print_helper";

patch(PosStore.prototype, {
    async printReceipt({
        basic = false,
        order = this.get_order(),
        printBillActionTriggered = false,
    } = {}) {
        try {
            return await super.printReceipt(...arguments);
        } catch (error) {
            const isCloneNodeError =
                error instanceof TypeError &&
                error.message &&
                error.message.includes("cloneNode");

            if (isCloneNodeError) {
                // Primeiro retry: 300ms
                console.warn("[FIX-PRINT] cloneNode null — retry 1 (300ms)");
                await new Promise((r) => setTimeout(r, 300));
                try {
                    return await super.printReceipt(...arguments);
                } catch (error2) {
                    if (
                        error2 instanceof TypeError &&
                        error2.message &&
                        error2.message.includes("cloneNode")
                    ) {
                        // Segundo retry: 600ms
                        console.warn("[FIX-PRINT] cloneNode null — retry 2 (600ms)");
                        await new Promise((r) => setTimeout(r, 600));
                        try {
                            return await super.printReceipt(...arguments);
                        } catch (error3) {
                            // Fallback final: renderiza via QWeb puro (sem RenderContainer)
                            // e imprime numa window nova — não depende do componente Owl.
                            console.warn("[FIX-PRINT] todos os retries falharam, tentando fallback via renderToElement");
                            try {
                                const data = this.orderExportForPrinting(order);
                                const el = renderToElement("point_of_sale.OrderReceipt", {
                                    data,
                                    formatCurrency: this.env.utils.formatCurrency,
                                    basic_receipt: basic,
                                });
                                if (el) {
                                    printFallback(el, "Recibo");
                                    if (!printBillActionTriggered) {
                                        order.nb_print += 1;
                                        if (typeof order.id === "number") {
                                            await this.data.write("pos.order", [order.id], { nb_print: order.nb_print });
                                        }
                                    }
                                    return true;
                                }
                            } catch (fallbackError) {
                                console.error("[FIX-PRINT] fallback também falhou:", fallbackError);
                            }
                            // Último recurso: loga e engole — a venda já está salva
                            console.error("[FIX-PRINT] impressão não foi possível, venda está salva");
                            return;
                        }
                    }
                    throw error2;
                }
            }

            throw error;
        }
    },
});