/** @odoo-module */

import { PosOrder } from "@point_of_sale/app/models/pos_order";
import { patch } from "@web/core/utils/patch";

patch(PosOrder.prototype, {

    /**
     * @override
     * Chamado toda vez que o Odoo recarrega os dados do Banco (PostgreSQL) para a Memória (Navegador).
     * Ocorre principalmente no refresh da página (F5) ou fechamento de caixa, permitindo 
     * não perder os dados fiscais injetados que são desenhados na UI.
     * 
     * @param {Object} json Payload nativo reconstruido pelo env.services.orm
     */
    init_from_JSON(json) {
        super.init_from_JSON(...arguments);

        Object.assign(this, {
            x_fiscal_mensagem: json.x_fiscal_mensagem || "",
            x_fiscal_status: json.x_fiscal_status || "",
            x_fiscal_chave: json.x_fiscal_chave || "",
            x_fiscal_qrcode_url: json.x_fiscal_qrcode_url || "",
            x_fiscal_url_consulta: json.x_fiscal_url_consulta || "",
            x_fiscal_numero: json.x_fiscal_numero || "",
            x_fiscal_serie: json.x_fiscal_serie || "",
            x_fiscal_protocolo: json.x_fiscal_protocolo || "",
            x_fiscal_qrcode_b64: json.x_fiscal_qrcode_b64 || "",
            x_fiscal_offline: Boolean(json.x_fiscal_offline),
            x_confirmacao_venda: json.x_confirmacao_venda,
            // x_email_cliente: json.x_email_cliente,  // REMOVIDO: Email não é mais coletado no PDV
            x_cpf_nota: json.x_cpf_nota,
            x_contingencia_payload: json.x_contingencia_payload || "",
        });
    },

    /**
     * @override
     * Disparado quando a venda finaliza e o Odoo envia os dados do Frontend (UI/Caixa) 
     * para o Backend Odoo Python (models/pos_order.py).
     * 
     * @returns {Object} JSON estruturado com os dados injetáveis nativos + os customizados.
     */
    export_as_JSON() {
        const json = super.export_as_JSON();

        // Envia as decisões do operador pro Banco de Dados 
        json.x_cpf_nota = this.x_cpf_nota || "";
        // json.x_email_cliente = this.x_email_cliente || "";  // REMOVIDO: Email não é mais coletado no PDV
        json.x_confirmacao_venda = !!this.x_confirmacao_venda;
        json.x_contingencia_payload = this.x_contingencia_payload || "";

        return json;
    },

    /**
     * @override
     * Chamado na Tela de Recibo, monta o dicionário que o XML `order_receipt.xml`
     * consegue ler para imprimir o cupom térmico (DANFE NFC-e).
     * Aqui tratamos a lógica visual de contagem, mascara de linhas e renderização do QR Code em Base64.
     */
    export_for_printing() {
        const result = super.export_for_printing(...arguments);
        
        const orderlines = this.get_orderlines();
        let qtd_itens = 0;

        // Limpeza dos métodos de pagamento para o rodape do Danfe
        const metodos = result.paymentlines.map(p => ({
            metodo_nome: p.name,
            metodo_valor: p.amount,
        }));

        // Estruturação tabular padrão da Receita: Código, Descrição, Qtd, UN, Vlr e Subtotal.
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

        // Regra de Exibição do QR Code 
        // Em notas online (100) usa-se a URL, porém em contingência OFFLINE Focus
        // Usa-se um Code Base64 criptografado internamente
        let qrcodeFinal = this.x_fiscal_qrcode_url;

        if (this.x_fiscal_qrcode_b64) {
            const b64Limpo = this.x_fiscal_qrcode_b64.trim().replace(/\s/g, '');
            qrcodeFinal = `data:image/png;base64,${b64Limpo}`;
        }

        let chaveFinal = this.x_fiscal_chave || "";
        let chaveFormatada = chaveFinal;
        if (chaveFinal.length === 44) {
             chaveFormatada = chaveFinal.match(/.{1,4}/g).join(' ');
        }

        result.x_fiscal = {
            mensagem: this.x_fiscal_mensagem || "",
            status: this.x_fiscal_status || "",
            chave: chaveFinal,
            chave_formatada: chaveFormatada,
            qrcode_b64: this.x_fiscal_qrcode_b64 || "", 
            qrcode_url: qrcodeFinal, 
            url_consulta: this.x_fiscal_url_consulta || "",
            numero: this.x_fiscal_numero || "",
            serie: this.x_fiscal_serie || "",
            protocolo: this.x_fiscal_protocolo || "",
            offline: this.x_fiscal_offline || false,
        };
        result.x_cpf_nota = this.x_cpf_nota;
        result.x_confirmacao_venda = this.x_confirmacao_venda;
        
        result.cashier = result.cashier || (this.cashier ? this.cashier.name : null);
        
        const my_company = this.company;
        result.empresa = {
            nome: my_company.name || "",
            cnpj: my_company.x_cnpj || "",
            ie: my_company.x_ie || "",
            endereco_linha1: my_company.x_endereco_linha1 || "",
            endereco_linha2: my_company.x_endereco_linha2 || "",
            telefone: my_company.phone || "",
        };

        return result;
    }
});