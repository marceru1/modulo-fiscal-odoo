/** @odoo-module */
/**
 * Fix: TypeError: Cannot read properties of null (reading 'cloneNode')
 *
 * Causa raiz: O afterOrderValidation do Odoo core chama this.pos.printReceipt()
 * SEM await (payment_screen.js:375). A impressão dispara async e concorre com
 * a transição de tela. O renderer.toHtml() pode retornar null se o componente
 * OrderReceipt não terminou de montar no RenderContainer hidden — aí o
 * applyWhenMounted faz el.cloneNode(true) com el=null e estoura.
 *
 * Fix: Patch do PosStore.printReceipt com try-catch + retry. Se pegar TypeError
 * de cloneNode, espera 200ms e tenta de novo — o DOM já estabilizou.
 */
import { PosStore } from "@point_of_sale/app/store/pos_store";
import { patch } from "@web/core/utils/patch";

patch(PosStore.prototype, {
    async printReceipt(...args) {
        try {
            return await super.printReceipt(...args);
        } catch (error) {
            // Verifica se é o erro conhecido de cloneNode null
            const isCloneNodeError =
                error instanceof TypeError &&
                error.message &&
                error.message.includes("cloneNode");

            if (isCloneNodeError) {
                console.warn(
                    "[FIX-PRINT] cloneNode null detectado — Race condition no renderer. " +
                    "Tentando novamente em 200ms..."
                );
                await new Promise((r) => setTimeout(r, 200));
                return await super.printReceipt(...args);
            }

            // Outro erro: relança
            throw error;
        }
    },
});