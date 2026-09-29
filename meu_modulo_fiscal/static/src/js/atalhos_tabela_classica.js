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
 *   getSelectedOrder()           → ticket_screen.js:325 (cupom selecionado
 *                                  na lista de vendas)                      ✓
 *   this.dialog / this.ui        → ticket_screen.js:61-62 (já vêm do setup do
 *                                  core — NÃO precisa de patch extra como o
 *                                  ticket 06 supunha)                       ✓
 *   ui.block()/ui.unblock()      → web ui_service.js:161-180 (closures sobre
 *                                  blockCount, não usam `this` — funcionam
 *                                  através do useState(useService("ui")) do
 *                                  TicketScreen)                            ✓
 *   parseUTCString()             → point_of_sale/utils.js:132 (date_order é
 *                                  UTC; new Date() o leria como hora local) ✓
 *
 * Nenhuma dessas letras colide com hotkey do core: o único useHotkey() do
 * point_of_sale é o "enter" de partner_list.js:34, e o number_buffer só
 * consome dígitos/+-., (ALLOWED_KEYS) — nenhuma letra da tabela é engolida.
 * Varredura repetida ao entrar o N do cancelamento: nenhum useHotkey de letra
 * em point_of_sale/ nem em pos_restaurant/ (o TicketScreen é compartilhado
 * com o módulo de restaurante).
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
import { AlertDialog } from "@web/core/confirmation_dialog/confirmation_dialog";
import { _t } from "@web/core/l10n/translation";
import { makeAwaitable } from "@point_of_sale/app/store/make_awaitable_dialog";
import { parseUTCString } from "@point_of_sale/utils";
import { patch } from "@web/core/utils/patch";
import { useHotkey } from "@web/core/hotkeys/hotkey_hook";
import { CancelamentoJustificativaPopup } from "./cancelamento_justificativa_popup";

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

// ── Cancelamento de cupom no Odoo (estoque + caixa, fiscal ou não-fiscal) ────

/** Janela de cancelamento: 24h da emissão (política de negócio herdada da
 * janela do evento 110111 da NFC-e; o usuário a manteve para ambos os tipos).
 * Exportado para o teste ler daqui. */
export const JANELA_CANCELAMENTO_MS = 24 * 3600 * 1000;

/** Um cupom é cancelável pelo PDV? (guard do atalho N)
 *
 * Função pura de propósito: é o único ponto que decide se o atalho N age ou
 * fica em silêncio, então é o seam de teste do fluxo do operador.
 *
 * Regras, todas no-op silencioso quando falham (o operador não precisa do
 * motivo técnico na tela):
 *   - precisa de cupom selecionado;
 *   - cupom pago (finalized — a TicketScreen lista só esses no filtro PAGOS);
 *   - ainda não cancelado (x_fiscal_cancelado false/undefined);
 *   - dentro da janela de 24h.
 *
 * Tanto faz ser fiscal ou não-fiscal: o cancelamento é comercial (estoque +
 * caixa voltam, decisão do usuário 29/09). A NFC-e autorizada, quando houve,
 * permanece autorizada na SEFAZ.
 *
 * date_order vem em UTC ("yyyy-MM-dd HH:mm:ss"). `new Date(...)` trataria essa
 * string como hora LOCAL e deslocaria a janela pelo fuso do caixa — por isso
 * o parseUTCString do core (utils.js:132), o mesmo que a TicketScreen usa para
 * ordenar os pedidos.
 *
 * @param {Object} order cupom selecionado no TicketScreen
 * @param {number} agoraMs agora em epoch ms (injetável para teste)
 * @returns {boolean}
 */
export function cupomCancelavel(order, agoraMs = Date.now()) {
    if (!order) {
        return false;
    }
    if (order.x_fiscal_cancelado) {
        return false;
    }
    if (!order.finalized) {
        return false;
    }
    if (!order.date_order) {
        return false;
    }
    const emissaoMs = parseUTCString(order.date_order).toMillis();
    return agoraMs - emissaoMs < JANELA_CANCELAMENTO_MS;
}

/** N — Cancela o cupom selecionado (estoque volta, caixa desconta).
 *
 * Fluxo: guard → popup de justificativa → RPC → feedback. O backend é
 * autoritativo e sincrono (decisão do usuário 29/09): ele marca
 * x_fiscal_cancelado e reverte o estoque na mesma chamada — a resposta
 * "aceito" significa já executado. O x_fiscal_status local vira 'cancelado'
 * quando o cupom era fiscal (só informativo — a nota SEFAZ permanece como
 * está).
 *
 * O popup de resultado abre DEPOIS do unblock — um AlertDialog adicionado com
 * a UI bloqueada nasceria sob o BlockUI e o operador não conseguiria fechá-lo.
 */
async function cancelarCupomNfce(tela) {
    const order = tela.getSelectedOrder();
    if (!cupomCancelavel(order)) {
        return;
    }

    const justificativa = await makeAwaitable(
        tela.dialog,
        CancelamentoJustificativaPopup,
        { title: _t("Cancelar cupom") }
    );
    // undefined = operador fechou o popup (Esc / Voltar): aborta sem chamar nada.
    if (!justificativa) {
        return;
    }

    let titulo;
    let mensagem;
    tela.ui.block({ message: _t("Cancelando cupom...") });
    try {
        const result = await tela.env.services.orm.call(
            "pos.order",
            "action_cancelar_nfce",
            [],
            { pos_reference: order.pos_reference, justificativa }
        );
        if (result?.success) {
            if (order.x_confirmacao_venda) {
                // Cupom fiscal: status informativo. A NFC-e autorizada segue
                // autorizada na SEFAZ (decisão do usuário) — nenhum evento
                // fiscal é feito.
                order.x_fiscal_status = "cancelado";
            }
            order.x_fiscal_cancelado = true;
            titulo = _t("Cupom cancelado");
            mensagem = _t(
                "Estoque reposto e valor descontado do fechamento do caixa."
            );
        } else {
            titulo = _t("Não foi possível cancelar");
            mensagem = result?.mensagem || _t("Erro desconhecido.");
        }
    } catch (error) {
        console.error("[CANCELAR-CUPOM] Falha na chamada do backend:", error);
        titulo = _t("Não foi possível cancelar");
        mensagem = _t("Falha de comunicação com o servidor. Tente novamente.");
    } finally {
        tela.ui.unblock();
    }
    tela.dialog.add(AlertDialog, { title: titulo, body: mensagem });
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
        { tecla: "n", acao: "Cancelar cupom", executar: cancelarCupomNfce },
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
