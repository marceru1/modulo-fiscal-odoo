/** @odoo-module */
import { PosStore } from "@point_of_sale/app/store/pos_store";
import { patch } from "@web/core/utils/patch";

patch(PosStore.prototype, {
    async printReceipt(options) {
        const order = this.get_order();
        const posReference = order.pos_reference || order.name;

        try {
            const result = await this.env.services.orm.searchRead(
                "pos.order",
                [["pos_reference", "=", posReference]],
                ["x_fiscal_status", "x_fiscal_qrcode_b64", "x_fiscal_chave", "x_fiscal_numero", "x_fiscal_serie", "x_fiscal_protocolo", "x_fiscal_offline"]
            );

            if (result && result.length > 0) {
                const data = result[0];

                // 1. Mesclamos os dados (isso traz o x_fiscal_qrcode_b64 de 652 caracteres)
                Object.assign(order, data);

                // 2. Criamos a URL completa SEM CORTAR
                if (data.x_fiscal_qrcode_b64) {
                    // Usamos o valor direto do 'data' para garantir que temos os 652 caracteres
                    const base64Completo = data.x_fiscal_qrcode_b64.trim().replace(/\s/g, '');
                    order.x_fiscal_qrcode_url = "data:image/png;base64," + base64Completo;
                    
                    // LOG DE CONFERÊNCIA (Não use substring na variável de impressão!)
                    console.log(">>> Sucesso! Tamanho enviado ao recibo:", order.x_fiscal_qrcode_url.length);
                }
            }
        } catch (error) {
            console.error("Erro na busca fiscal:", error);
        }

        return await super.printReceipt(...arguments);
    },
});