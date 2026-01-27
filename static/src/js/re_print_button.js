/** @odoo-module */

import { PosStore } from "@point_of_sale/app/store/pos_store";
import { patch } from "@web/core/utils/patch";

patch(PosStore.prototype, {
    async printReceipt(options) {
        const order = this.get_order();

        const posReference = order.pos_reference || order.name; //acha o pedido feito

try {
            // No Odoo JS, o método é searchRead (sem underline)
            const result = await this.env.services.orm.searchRead(
                "pos.order",
                [["pos_reference", "=", posReference]],
                ["x_fiscal_status", "x_fiscal_qrcode_url", "x_fiscal_chave", "x_fiscal_numero", "x_fiscal_serie", "x_fiscal_protocolo", "x_fiscal_offline"]
            );

            if (result && result.length > 0) {
                const data = result[0];
                console.log("Sucesso! Status recuperado:", data.x_fiscal_status);

                // Mesclamos os dados novos no objeto da ordem atual
                Object.assign(order, data);
            } else {
                console.warn("Nenhum dado encontrado no servidor para esta referência.");
            }
        } catch (error) {
            console.error("Erro técnico na chamada searchRead:", error);
        }


        return await super.printReceipt(...arguments);
    },
});