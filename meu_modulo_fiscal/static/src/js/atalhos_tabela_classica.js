/** @odoo-module */
/**
 * Tabela clássica fiscal A–V (feature atalhos-pdv-tabela-classica).
 *
 * Substitui integralmente o esquema antigo (atalhos_pagamento.js: A-E = método
 * de pagamento, S = acréscimo, R = desconto), removido no ticket 01.
 *
 * ATALHOS (abaixo) é a FONTE ÚNICA DE VERDADE da feature: ela alimenta tanto o
 * registro das hotkeys (registrarAtalhos) quanto a legenda visual na tela
 * (atalhos_legend.js). Acrescentar/remover um atalho é mexer só nesta tabela —
 * não há segunda lista para dessincronizar (ticket 05).
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
 *   pos.pay()                    → pos_store.js:1296 (mesmo handler do botão
 *                                  "Payment" do Actionpad; guards internos:
 *                                  canPay() = cupom não vazio
 *                                  [pos_order.js:298] + lotes/serial)         ✓
 *   pos.closeSession()           → pos_store.js:368 (abre ClosePosPopup)
 *                                  ⚠ DEC-008: NÃO é closePos(), que faz
 *                                  redirectToBackend() no Odoo 18           ✓
 *   seletor da busca             → .pos-topheader .input-container input
 *                                  (navbar.xml:5 + input.xml:20-24; o
 *                                  spec supunha name="search-product-input",
 *                                  que não existe)  ⚠ ver DEC-009          ✓
 *
 * Nenhuma dessas letras colide com hotkey do core: o único useHotkey() do
 * point_of_sale é o "enter" de partner_list.js:34, e o number_buffer só
 * consome dígitos/+-., (ALLOWED_KEYS) — nenhuma letra da tabela é engolida.
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
import { TicketScreen } from "@point_of_sale/app/screens/ticket_screen/ticket_screen";
import { Navbar } from "@point_of_sale/app/navbar/navbar";
import { patch } from "@web/core/utils/patch";
import { useHotkey } from "@web/core/hotkeys/hotkey_hook";

// ── Guards e ações (os corpos que a tabela referencia) ───────────────────────

/** C — Consulta preço/estoque do produto da linha selecionada.
 * DEC-009: não existe `selectedProduct` no ProductScreen do Odoo 18; o conceito
 * "produto selecionado" é a orderline selecionada. Reusa o onProductInfoClick
 * do core (mesmo handler do clique no card do produto). */
function consultarProdutoSelecionado(tela) {
    const linha = tela.currentOrder?.get_selected_orderline();
    if (!linha) {
        return;
    }
    tela.onProductInfoClick(linha.product_id);
}

/** E — Cancela o último item do cupom (DEC-007: guard sem linhas). */
function cancelarUltimoItem(tela) {
    const linhas = tela.currentOrder?.get_orderlines();
    if (!linhas?.length) {
        return;
    }
    tela.currentOrder.removeOrderline(linhas[linhas.length - 1]);
}

/** Q — Cancela o item selecionado (DEC-007: guard sem linha selecionada). */
function cancelarItemSelecionado(tela) {
    const linha = tela.currentOrder?.get_selected_orderline();
    if (!linha) {
        return;
    }
    tela.currentOrder.removeOrderline(linha);
}

/** L — Foca a busca de produto da navbar (DEC-006/009).
 * O input do core não tem name/class estável própria: ele é o `<input>` do
 * componente genérico Input, dentro de .input-container, dentro da navbar
 * (.pos-topheader). Guard null: em tela pequena o input nem é renderizado
 * (input.xml:15 t-if) → no-op. */
function focarBuscaDeProduto() {
    const busca = document.querySelector(".pos-topheader .input-container input");
    if (busca) {
        busca.focus();
    }
}

/** P — Exclui o cupom. DEC-009: onDeleteOrder(order) exige o arg; a
 * confirmação já é interna (pos_store.js:418-428). */
function excluirCupom(tela) {
    const order = tela.currentOrder;
    if (!order) {
        return;
    }
    tela.pos.onDeleteOrder(order);
}

/** R — Reimprimir cupom selecionado no TicketScreen. Reuso puro do botão
 * "Print Receipt" do core (ticket_screen.xml:163): doPrint é o useTrackedAsync
 * do setup (loading + lock anti-double-print). Guard espelha a condição do
 * botão (isOrderSynced, ticket_screen.js:333): sem ordem selecionada ou não
 * finalizada = no-op — reimpressão só de cupom PAGO.
 */
function reimprimirCupomSelecionado(tela) {
    const order = tela.getSelectedOrder();
    if (!order || !tela.isOrderSynced) {
        return;
    }
    tela.doPrint.call(order);
}

/** J / V — Lista de vendas. Mesmo handler de propósito (DEC-005): o
 * TicketScreen do core já abre nos pedidos não finalizados
 * (ticket_screen.js:72 filter=null → activeOrderFilter). */
function abrirListaDeVendas(tela) {
    // Abre JÁ no filtro "Pagos" (SYNCED) — decisão do usuário: J/V devem
    // mostrar pedidos PAGOS, não os em andamento. stateOverride é prop nativa
    // do TicketScreen (ticket_screen.js:47, aplicada em :77); "SYNCED" é o id
    // do option "Pagos" do _getFilterOptions() (ticket_screen.js:595). O
    // onMounted roda onFilterSelected("SYNCED") (_fetchSyncedOrders) — mesma
    // RPC do core ao clicar no filtro manualmente, nada adicional.
    tela.pos.showScreen("TicketScreen", { stateOverride: { filter: "SYNCED" } });
}

// ── A tabela ─────────────────────────────────────────────────────────────────
/**
 * Atalhos por tela. `executar(tela)` recebe a instância do componente
 * (ProductScreen/Navbar/PaymentScreen). A ordem das entradas é a ordem em que
 * aparecem na legenda.
 */
export const ATALHOS = {
    PaymentScreen: [
        { tecla: "a", acao: "Acréscimo", executar: (tela) => tela.clickAcrescimoButton() },
        { tecla: "d", acao: "Desconto", executar: (tela) => tela.clickDescontoButton() },
    ],
    TicketScreen: [
        { tecla: "r", acao: "Reimprimir cupom", executar: reimprimirCupomSelecionado },
    ],
    ProductScreen: [
        { tecla: "c", acao: "Consultar produto", executar: consultarProdutoSelecionado },
        { tecla: "e", acao: "Cancelar último item", executar: cancelarUltimoItem },
        { tecla: "f", acao: "Cliente", executar: (tela) => tela.pos.selectPartner() },
        { tecla: "i", acao: "Nova venda", executar: (tela) => tela.pos.add_new_order() },
        { tecla: "j", acao: "Reabrir venda", executar: abrirListaDeVendas },
        { tecla: "l", acao: "Buscar produto", executar: focarBuscaDeProduto },
        { tecla: "p", acao: "Excluir cupom", executar: excluirCupom },
        { tecla: "q", acao: "Cancelar item", executar: cancelarItemSelecionado },
        { tecla: "s", acao: "Receber pagamento", executar: (tela) => tela.pos.pay() },
        { tecla: "v", acao: "Vendas", executar: abrirListaDeVendas },
    ],
    // Globais: vivem no Navbar, que fica montado enquanto o POS está aberto
    // (DEC-003) — qualquer outra tela os desmontaria ao navegar.
    Navbar: [
        { tecla: "b", acao: "Recebimento", executar: (tela) => tela.showRecebimento() },
        { tecla: "g", acao: "Sangria", executar: (tela) => tela.pos.cashMove() },
        // DEC-008: closeSession() abre o ClosePosPopup (com as customizações de
        // fechamento deste módulo); closePos() no Odoo 18 volta pro backend.
        { tecla: "m", acao: "Fechar caixa", executar: (tela) => tela.pos.closeSession() },
    ],
};

/**
 * Entradas visíveis numa tela: as da própria tela + as globais (Navbar).
 * É o que a legenda renderiza — assim as teclas dos chips são, por construção,
 * exatamente as registradas.
 *
 * @param {string} nomeDaTela "ProductScreen" | "PaymentScreen"
 * @returns {Array<{tecla: string, acao: string}>}
 */
export function atalhosDaTela(nomeDaTela) {
    return [...(ATALHOS[nomeDaTela] || []), ...ATALHOS.Navbar];
}

/** Registra as hotkeys de uma lista de entradas no componente atual. */
function registrarAtalhos(tela, entradas) {
    for (const { tecla, executar } of entradas) {
        useHotkey(tecla, () => executar(tela));
    }
}

// ── PaymentScreen: A = Acréscimo, D = Desconto ────────────────────────────────
// Handlers dos patches existentes (acrescimo_popup.js / desconto_popup.js) —
// zero lógica nova aqui. Sem Enter (fora de escopo nesta feature).
patch(PaymentScreen.prototype, {
    setup() {
        super.setup();
        registrarAtalhos(this, ATALHOS.PaymentScreen);
    },
});

// ── ProductScreen: C E F I J L P Q V ─────────────────────────────────────────
patch(ProductScreen.prototype, {
    setup() {
        super.setup();
        registrarAtalhos(this, ATALHOS.ProductScreen);
    },
});

// ── TicketScreen: R = Reimprimir cupom selecionado ───────────────────────────
patch(TicketScreen.prototype, {
    setup() {
        super.setup();
        registrarAtalhos(this, ATALHOS.TicketScreen);
    },
});

// ── Navbar: B = Recebimento, G = Sangria, M = Fechar Caixa ────────────────────
// Patch separado do de recebimento_button.js (DEC-004) — o Odoo 18 encadeia
// múltiplos patches do mesmo prototype; super.setup() chama o setup anterior.
patch(Navbar.prototype, {
    setup() {
        super.setup();
        registrarAtalhos(this, ATALHOS.Navbar);
    },
});
