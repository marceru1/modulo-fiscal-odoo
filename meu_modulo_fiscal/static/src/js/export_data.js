/** @odoo-module */

import { PosOrder } from "@point_of_sale/app/models/pos_order";
import { patch } from "@web/core/utils/patch";

patch(PosOrder.prototype, {

    // carrega os dados do banco para abrir o pdv e sincroniza os campos customizados
    init_from_JSON(json) {
        super.init_from_JSON(...arguments);

        // campos fiscais
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
        
        // dados do cliente
        this.x_confirmacao_venda = json.x_confirmacao_venda;
        this.x_email_cliente = json.x_email_cliente;
        this.x_cpf_nota = json.x_cpf_nota;
    },

    export_as_JSON() {
        const json = super.export_as_JSON();

        json.x_cpf_nota = this.x_cpf_nota || "";
        json.x_email_cliente = this.x_email_cliente || "";
        json.x_confirmacao_venda = !!this.x_confirmacao_venda;

        return json;
    },

    // prepara os dadaods pra impressao do cupom
    export_for_printing() {
        const result = super.export_for_printing(...arguments);
        
        // montagem dos itens
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

        // processa qrCode
        let qrcodeFinal = this.x_fiscal_qrcode_url;

        if (this.x_fiscal_qrcode_b64) {
            const b64Limpo = this.x_fiscal_qrcode_b64.trim().replace(/\s/g, '');
            qrcodeFinal = `data:image/png;base64,${b64Limpo}`;
        }

        // monta o objeto fiscal
        result.x_fiscal = {
            mensagem: this.x_fiscal_mensagem || "",
            status: this.x_fiscal_status || "",
            chave: this.x_fiscal_chave || "",
            qrcode_b64: this.x_fiscal_qrcode_b64 || "", 
            qrcode_url: qrcodeFinal, 
            url_consulta: this.x_fiscal_url_consulta || "",
            numero: this.x_fiscal_numero || "",
            serie: this.x_fiscal_serie || "",
            protocolo: this.x_fiscal_protocolo || "",
            offline: this.x_fiscal_offline || false,
        };
        console.log("==== CONTINGENCIA?", result.x_fiscal_offline);
        result.x_cpf_nota = this.x_cpf_nota;
        result.x_confirmacao_venda = this.x_confirmacao_venda;
        
        // operador sai apenas na reimpressão
      
        result.cashier = result.cashier || (this.pos.get_cashier() ? this.pos.get_cashier().name : null);

        return result;
    }
});