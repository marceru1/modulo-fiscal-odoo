/** @odoo-module */
import { patch } from "@web/core/utils/patch";
import { usePos } from "@point_of_sale/app/store/pos_hook";
import { ProductCard } from "@point_of_sale/app/generic_components/product_card/product_card";

/**
 * preco-badge-produto-pdv: exibe o preço no card do produto (ProductScreen).
 *
 * O ProductCard do core recebe o `product` completo via props mas não mostra
 * o preço. Este patch adiciona o serviço pos + getter `priceDisplay` e o
 * template herdado (preco_badge_produto.xml) renderiza abaixo do nome.
 *
 * Preço = get_price(pricelist da sessão, qty=1) — mesmo método usado pelo
 * core ao adicionar a linha (pos_store.js:867), então a badge nunca diverge
 * do preço que a venda vai usar (promoções/pricelist respeitadas).
 * usePos (useState) garante re-render se a pricelist da sessão mudar.
 */
patch(ProductCard.prototype, {
    setup() {
        super.setup();
        this.pos = usePos();
    },

    get priceDisplay() {
        try {
            if (!this.props.product) {
                return "";
            }
            const price = this.props.product.get_price(this.pos.getDefaultPricelist(), 1);
            const moeda = this.pos.currency.symbol || "";
            // Formata o número sem a moeda e prefixa o símbolo colado nele:
            // formatCurrency insere NBSP (R$\u00a040,00) e a quebra de linha
            // ficava entre "R$" e o número no card estreito.
            return `${moeda} ${this.env.utils.formatCurrency(price, false)}`;
        } catch {
            return "";
        }
    },
});