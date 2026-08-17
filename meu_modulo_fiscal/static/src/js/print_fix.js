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
 */
import { PosStore } from "@point_of_sale/app/store/pos_store";
import { patch } from "@web/core/utils/patch";

patch(PosStore.prototype, {
    async printReceipt(...args) {
        try {
            return await super.printReceipt(...args);
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
                    return await super.printReceipt(...args);
                } catch (error2) {
                    if (
                        error2 instanceof TypeError &&
                        error2.message &&
                        error2.message.includes("cloneNode")
                    ) {
                        // Segundo retry: 600ms
                        console.warn("[FIX-PRINT] cloneNode null — retry 2 (600ms)");
                        await new Promise((r) => setTimeout(r, 600));
                        return await super.printReceipt(...args);
                    }
                    throw error2;
                }
            }

            throw error;
        }
    },
});