/** @odoo-module */

import { OrderReceipt } from "@point_of_sale/app/screens/receipt_screen/receipt/order_receipt";
import { patch } from "@web/core/utils/patch";

patch(OrderReceipt.prototype, {
    /**
     * @override
     * Classe que renderiza o recibo HTML antes da impressão (Componente React/Owl nativo).
     * Odoo 18 delega os getters do Template XML para a export_for_printing localizada no export_data.js.
     * Esta Patch existe exclusivamente para permitir hooks de renderização de código de barras ou 
     * injeção de imagens vetoriais via JS (Caso necessário no futuro).
     */
    setup() {
        super.setup();
    },
});