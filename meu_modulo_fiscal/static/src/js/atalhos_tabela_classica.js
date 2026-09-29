/** @odoo-module */
/**
 * Tabela clássica fiscal A–V (feature atalhos-pdv-tabela-classica).
 *
 * Substitui integralmente o esquema antigo (atalhos_pagamento.js: A-E = método
 * de pagamento, S = acréscimo, R = desconto), removido no ticket 01.
 *
 * ── APIs verificadas no source do Odoo 18 (ticket 02) ────────────────────────
 *   onProductInfoClick(product)  → product_screen.js:527 (reusado p/ C)      ✓
 *   get_selected_orderline()     → app/models/pos_order.js:574 (método)      ✓
 *   removeOrderline(line)        → app/models/pos_order.js:546               ✓
 *   get_orderlines()             → app/models/pos_order.js:1063              ✓
 *   pos.showScreen(name, props)  → pos_store.js:1559 (core chama com 1 arg
 *                                  em navbar.xml:48)                        ✓
 *   pos.selectPartner()          → pos_store.js:1975                        ✓
 *   pos.add_new_order()          → pos_store.js:1100 (snake_case)           ✓
 *   pos.onDeleteOrder(order)     → pos_store.js:417 (ARG OBRIGATÓRIO,
 *                                  confirmação interna)  ⚠ ver DEC-009      ✓
 *   pos.cashMove()               → pos_store.js:364                         ✓
 *   pos.closeSession()           → pos_store.js:368 (abre ClosePosPopup)
 *                                  ⚠ DEC-008: NÃO é closePos(), que faz
 *                                  redirectToBackend() no Odoo 18           ✓
 *   seletor da busca             → .pos-topheader .input-container input
 *                                  (navbar.xml:5 + input.xml:20-24; o
 *                                  spec supunha name="search-product-input",
 *                                  que não existe)  ⚠ ver DEC-009          ✓
 *
 * Nenhuma dessas letras colide com hotkey do core: o único useHotkey() do
 * point_of_sale é o "enter" de partner_list.js:34.
 *
 * ── Proteções ────────────────────────────────────────────────────────────────
 * Popup aberto e input focado são tratados pelo hotkey_service do core (o
 * dispatch filtra por ui.activeElement e ignora tecla em elemento editável).
 * Nenhum listener próprio. As hotkeys desmontam com o componente — sem leak.
 * Por isso "L" precisa de guard manual: focar um input passa a bloquear as
 * outras teclas, que é exatamente o comportamento desejado (o operador está
 * digitando, não operando).
 */
import { PaymentScreen } from "@point_of_sale/app/screens/payment_screen/payment_screen";
import { ProductScreen } from "@point_of_sale/app/screens/product_screen/product_screen";
import { Navbar } from "@point_of_sale/app/navbar/navbar";
import { patch } from "@web/core/utils/patch";
import { useHotkey } from "@web/core/hotkeys/hotkey_hook";

// ── PaymentScreen: A = Acréscimo, D = Desconto ────────────────────────────────
// Handlers dos patches existentes (acrescimo_popup.js / desconto_popup.js) —
// zero lógica nova aqui. Sem Enter (fora de escopo nesta feature).
patch(PaymentScreen.prototype, {
    setup() {
        super.setup();
        useHotkey("a", () => this.clickAcrescimoButton());
        useHotkey("d", () => this.clickDescontoButton());
    },
});

// ── ProductScreen: C E F I J L P Q V ─────────────────────────────────────────
patch(ProductScreen.prototype, {
    setup() {
        super.setup();

        // C — Consulta preço/estoque do produto da linha selecionada.
        // DEC-009: não existe `selectedProduct` no ProductScreen do Odoo 18; o
        // conceito "produto selecionado" é a orderline selecionada. Reusa o
        // onProductInfoClick do core (mesmo handler do clique no card).
        useHotkey("c", () => {
            const linha = this.currentOrder?.get_selected_orderline();
            if (!linha) {
                return;
            }
            this.onProductInfoClick(linha.product_id);
        });

        // E — Cancela o último item do cupom (DEC-007: guard sem linhas).
        useHotkey("e", () => {
            const linhas = this.currentOrder?.get_orderlines();
            if (!linhas?.length) {
                return;
            }
            this.currentOrder.removeOrderline(linhas[linhas.length - 1]);
        });

        // F — Cliente.
        useHotkey("f", () => this.pos.selectPartner());

        // I — Nova venda.
        useHotkey("i", () => this.pos.add_new_order());

        // J — Reabrir venda. V — Vendas. Mesmo handler (DEC-005): o
        // TicketScreen do core já abre nos pedidos não finalizados
        // (ticket_screen.js:72 filter=null → activeOrderFilter).
        useHotkey("j", () => this.pos.showScreen("TicketScreen"));
        useHotkey("v", () => this.pos.showScreen("TicketScreen"));

        // L — Foca a busca de produto da navbar (DEC-006/009).
        // O input do core não tem name/class estável própria: ele é o
        // <input> do componente genérico Input, dentro de .input-container,
        // dentro da navbar (.pos-topheader). Guard null: em tela pequena o
        // input nem é renderizado (input.xml:15 t-if) → no-op.
        useHotkey("l", () => {
            const busca = document.querySelector(".pos-topheader .input-container input");
            if (busca) {
                busca.focus();
            }
        });

        // P — Exclui o cupom. DEC-009: onDeleteOrder(order) exige o arg; a
        // confirmação já é interna (pos_store.js:418-428).
        useHotkey("p", () => {
            const order = this.currentOrder;
            if (!order) {
                return;
            }
            this.pos.onDeleteOrder(order);
        });

        // Q — Cancela o item selecionado (DEC-007: guard sem linha).
        useHotkey("q", () => {
            const linha = this.currentOrder?.get_selected_orderline();
            if (!linha) {
                return;
            }
            this.currentOrder.removeOrderline(linha);
        });
    },
});

// ── Navbar: B = Recebimento, G = Sangria, M = Fechar Caixa ────────────────────
// Globais no Navbar (DEC-003): ele fica montado enquanto o POS está aberto.
// Patch separado do de recebimento_button.js (DEC-004) — o Odoo 18 encadeia
// múltiplos patches do mesmo prototype; super.setup() chama o setup anterior.
patch(Navbar.prototype, {
    setup() {
        super.setup();
        // B — Recebimento (método definido em recebimento_button.js).
        useHotkey("b", () => this.showRecebimento());
        // G — Sangria / suprimento (abre o CashMovePopup do core).
        useHotkey("g", () => this.pos.cashMove());
        // M — Fechar caixa. DEC-008: closeSession() (abre o ClosePosPopup, com
        // as customizações de fechamento deste módulo); closePos() no Odoo 18
        // apenas volta pro backend.
        useHotkey("m", () => this.pos.closeSession());
    },
});
