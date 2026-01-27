/** @odoo-module */

import { PosOrder } from "@point_of_sale/app/models/pos_order";
import { patch } from "@web/core/utils/patch";
import { formatCurrency } from "@web/core/currency";


patch(PosOrder.prototype, {

    init_from_JSON(json) {
        super.init_from_JSON(...arguments);

        // Se o pedido tiver mensagem fiscal (vindo do loader_params), salva na memória
        this.x_fiscal_mensagem = json.x_fiscal_mensagem || "";

        this.x_fiscal_status = json.x_fiscal_status || "";
        this.x_fiscal_chave = json.x_fiscal_chave || "";
        this.x_fiscal_qrcode_url = json.x_fiscal_qrcode_url || "";
        this.x_fiscal_url_consulta = json.x_fiscal_url_consulta || "";
        this.x_fiscal_numero = json.x_fiscal_numero || "";
        this.x_fiscal_serie = json.x_fiscal_serie || "";
        this.x_fiscal_protocolo = json.x_fiscal_protocolo || "";
        
        // Booleano precisa de tratamento especial se vier null
        this.x_fiscal_offline = Boolean(json.x_fiscal_offline);
    },

    export_as_JSON() {
        const json = super.export_as_JSON();

        //se nao tiver cpf ele envia a string vazia ""
        json.x_cpf_nota = this.x_cpf_nota || "";


        //força o boolean a ser true ou false.
        json.x_confirmacao_venda = !!this.x_confirmacao_venda;


        return json;
    },



    export_for_printing() {
        const result = super.export_for_printing(...arguments);
        // Adiciona dados extras ao objeto que chega no 'props.data' do recibo

        const orderlines = this.get_orderlines();


        let qtd_itens = 0;

        // const metodo_nome = result.paymentlines.map(p => p.name); //pega o metodo de pagamento
        // const metodo_valor = result.paymentlines.map(p => p.amount);

        const metodos = result.paymentlines.map(p => ({
            metodo_nome: p.name,
            metodo_valor: p.amount,
        }));

        //console.log(metodos);






        const danfe_items = orderlines.map((line, index) => {
            qtd_itens += line.get_quantity();

            const product = line.get_product();



            return {
                //item + cod + desc
                index: String(index + 1).padStart(3, '0'),
                code: product.barcode || '',
                description: product.display_name,

                //qntd + un
                qntd: line.get_quantity(),
                unit: line.get_unit() ? line.get_unit().name : '', //tenho que arrumar isso pra puxar o nome de 'un',

                //vlr unit + desc + total
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

        // console.log('teste log')



        
       result.x_fiscal = {
            mensagem: this.x_fiscal_mensagem,
            status: this.x_fiscal_status,
            chave: this.x_fiscal_chave,
            qrcode_url: this.x_fiscal_qrcode_url,
            url_consulta: this.x_fiscal_url_consulta,
            numero: this.x_fiscal_numero,
            serie: this.x_fiscal_serie,
            protocolo: this.x_fiscal_protocolo,
            offline: this.x_fiscal_offline,
        };

//         console.log("=== RECIBO REIMPRESSO ===");

// console.log("Status:", this.x_fiscal_status);
//         console.log("QR Code:", this.x_fiscal_qrcode_url);
//         console.log("Contingência:", this.x_fiscal_offline);
//         console.log("Objeto Completo:", result.x_fiscal);

        return result;


    }
});
