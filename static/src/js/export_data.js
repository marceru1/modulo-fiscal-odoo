/** @odoo-module */

import { PosOrder } from "@point_of_sale/app/models/pos_order";
import { patch } from "@web/core/utils/patch";

patch(PosOrder.prototype, {

    init_from_JSON(json) {
        super.init_from_JSON(...arguments);

        // ✅ Carrega todos os campos fiscais
        this.x_fiscal_mensagem = json.x_fiscal_mensagem || "";
        this.x_fiscal_status = json.x_fiscal_status || "";
        this.x_fiscal_chave = json.x_fiscal_chave || "";
        this.x_fiscal_qrcode_url = json.x_fiscal_qrcode_url || "";
        this.x_fiscal_url_consulta = json.x_fiscal_url_consulta || "";
        this.x_fiscal_numero = json.x_fiscal_numero || "";
        this.x_fiscal_serie = json.x_fiscal_serie || "";
        this.x_fiscal_protocolo = json.x_fiscal_protocolo || "";
        this.x_fiscal_qrcode_b64 = json.x_fiscal_qrcode_b64 || "";
        this.x_fiscal_offline = Boolean(json.x_fiscal_offline);
    },

    export_as_JSON() {
        const json = super.export_as_JSON();

        // ✅ Campos de cliente
        json.x_cpf_nota = this.x_cpf_nota || "";
        json.x_email_cliente = this.x_email_cliente || "";  // ✅ ADICIONADO
        json.x_confirmacao_venda = !!this.x_confirmacao_venda;

        return json;
    },

    export_for_printing() {
        const result = super.export_for_printing(...arguments);
        
        const orderlines = this.get_orderlines();
        let qtd_itens = 0;

        const metodos = result.paymentlines.map(p => ({
            metodo_nome: p.name,
            metodo_valor: p.amount,
        }));

        const danfe_items = orderlines.map((line, index) => {
            qtd_itens += line.get_quantity();
            const product = line.get_product();

            return {
                index: String(index + 1).padStart(3, '0'),
                code: product.barcode || 'SEM CÓDIGO',
                description: product.display_name,
                qntd: line.get_quantity(),
                unit: line.get_unit() ? line.get_unit().name : 'UN',
                vlr_unit: line.get_unit_price(),
                desc: line.get_discount(),
                vlr_total: line.get_price_with_tax()
            };
        });

        result.danfe_items = danfe_items;
        result.danfe_totais = {
            qtd_itens: qtd_itens,
            linhas: orderlines.length,
            valor_total: this.get_total_with_tax(),
            desconto_total: this.get_total_discount(),
            metodos: metodos,
        };

        // ✅ MONTA O QR CODE CORRETAMENTE
        let qrcodeUrl = this.x_fiscal_qrcode_url;

        // Se tiver base64 mas não tiver Data URI, monta agora
        if (this.x_fiscal_qrcode_b64 && !qrcodeUrl.startsWith('data:image')) {
            qrcodeUrl = `data:image/png;base64,${this.x_fiscal_qrcode_b64}`;
            console.log("✅ QR Code montado no export_for_printing:", qrcodeUrl.length, "chars");
        }

        result.x_fiscal = {
            mensagem: this.x_fiscal_mensagem || "",
            status: this.x_fiscal_status || "",
            chave: this.x_fiscal_chave || "",
            qrcode_url: qrcodeUrl,  // ✅ URL COMPLETA
            url_consulta: this.x_fiscal_url_consulta || "",
            numero: this.x_fiscal_numero || "",
            serie: this.x_fiscal_serie || "",
            protocolo: this.x_fiscal_protocolo || "",
            offline: this.x_fiscal_offline || false,
        };

        return result;
    }
});