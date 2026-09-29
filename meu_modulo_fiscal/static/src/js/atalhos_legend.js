/** @odoo-module */
/**
 * Legenda visual dos atalhos (ticket 05): faixa fina de chips "tecla + ação"
 * com os atalhos VÁLIDOS na tela atual.
 *
 * A lista de chips sai de `atalhosDaTela()`, que lê a MESMA tabela ATALHOS que
 * registra as hotkeys (atalhos_tabela_classica.js) — os chips não podem
 * divergir das teclas que realmente funcionam.
 *
 * O componente é puramente decorativo: div passiva, sem foco, sem handler,
 * `aria-hidden` (a informação útil é a própria tecla funcionando). Não
 * intercepta clique nem teclado — as teclas continuam no hotkey_service do
 * core, inclusive a proteção de "input focado" (digitar na busca não dispara
 * atalho).
 */
import { Component } from "@odoo/owl";
import { PaymentScreen } from "@point_of_sale/app/screens/payment_screen/payment_screen";
import { ProductScreen } from "@point_of_sale/app/screens/product_screen/product_screen";
import { patch } from "@web/core/utils/patch";
import { atalhosDaTela } from "./atalhos_tabela_classica";

export class AtalhosLegend extends Component {
    static template = "meu_modulo.AtalhosLegend";
    static props = {
        /** Tela dona da legenda: define quais atalhos são exibidos. */
        tela: String,
    };

    get chips() {
        return atalhosDaTela(this.props.tela);
    }
}

// Registra a legenda como componente filho das duas telas que a renderizam.
// Padrão do core para injetar componente em tela existente: patch das statics
// (`components`), como pos_hr faz com ClosePosPopup e pos_restaurant com
// TicketScreen — o spread preserva os filhos já registrados pelo core.
patch(ProductScreen, {
    components: { ...ProductScreen.components, AtalhosLegend },
});

patch(PaymentScreen, {
    components: { ...PaymentScreen.components, AtalhosLegend },
});
