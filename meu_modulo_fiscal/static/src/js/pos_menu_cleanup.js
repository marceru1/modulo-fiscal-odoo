/** @odoo-module */

import { Navbar } from "@point_of_sale/app/navbar/navbar";
import { patch } from "@web/core/utils/patch";

patch(Navbar.prototype, {
    setup() {
        super.setup(...arguments);
        // Esconde o botão "Instalar app" ao simular que a app já está em execução no modo standalone.
        this.isDisplayStandalone = true;
    },
    // Esconde o botão "Criar produto" para todos os operadores do PDV.
    get showCreateProductButton() {
        return false;
    }
});
