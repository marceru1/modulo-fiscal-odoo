/** @odoo-module */

import { OrderReceipt } from "@point_of_sale/app/screens/receipt_screen/receipt/order_receipt";
import { patch } from "@web/core/utils/patch";

patch(OrderReceipt.prototype, {
    // Aqui você pode adicionar novas funções ou sobrescrever existentes
    
    setup() {
        super.setup();
        // Lógica de inicialização extra, se necessário
    },


});