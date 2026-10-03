/** @odoo-module */
/**
 * Setas ↑/↓ percorrem os itens da PaymentScreen; Enter aciona o item destacado
 * (feature atalhos-pagamento-setas).
 *
 * A lista navegável é, na ordem VISUAL da tela: os métodos de pagamento (topo)
 * e, no FIM, o botão Validar (base). Descer até o fim e dar Enter em Validar
 * fecha a venda — o fluxo pedido pelo operador.
 *
 * ── Enter NÃO é "validar" ────────────────────────────────────────────────────
 * Enter aciona o ITEM DESTACADO: método (adiciona a linha) ou Validar (fecha a
 * venda). Por isso o Enter virou hotkey de verdade (entrada "enter" na tabela
 * ATALHOS) e o triggerAtEnter que este módulo instalou na PaymentScreen em
 * 55ec546 foi REMOVIDO: com os dois, o mesmo Enter adicionaria a linha no
 * keydown (hotkey_service) e validaria a venda no keyup (number_buffer), sem o
 * operador conferir.
 *
 * ── Por que acionar = el.click() ─────────────────────────────────────────────
 * O handler do botão é do core: método → addNewPaymentLine(paymentMethod)
 * (payment_screen.xml:144) e Validar → validateOrder() (:71). Clicar o próprio
 * elemento reusa esses handlers — e os guards internos deles (terminal em
 * andamento, canBeValidated, confirmação de valor alto) — em vez de
 * reimplementá-los; se o core mudar o botão, o atalho acompanha.
 *
 * ── Por que as setas são seguras ─────────────────────────────────────────────
 * ↑/↓ estão em NAV_KEYS do hotkey_service (hotkey_service.js:34-48) e NÃO estão
 * em INPUT_KEYS do number_buffer (só `0123456789+-.,`, Delete e Backspace —
 * number_buffer_service.js:7-11): nenhum valor da venda é afetado. O único
 * useHotkey do core em todo o point_of_sale é o "enter" do partner_list
 * (partner_list.js:34), de outra tela; as demais setas do POS vivem dentro de
 * inputs (search_bar do TicketScreen, edit_list_input do lote), onde a proteção
 * de editável do hotkey_service bloqueia as nossas. Quando despacha, o
 * hotkey_service chama preventDefault() (hotkey_service.js:197-200) — a seta
 * não rola a tela.
 *
 * ── O destaque mora no DOM, não em estado do Owl ─────────────────────────────
 * Marcar é setar `data-atalho-destacado` no elemento; o CSS pinta. Nenhum
 * template conhece o destaque (nada de t-att-data-*): o atributo é escrito pelo
 * handler de teclado, fora do ciclo reativo do Owl, e sobrevive aos re-renders
 * porque o blockdom só patcheia atributos dinâmicos que o template declarou
 * (owl.js:798-820 — `block-attribute-N` / `block-attributes`).
 */

/** Botões de método: só eles têm a class LITERAL "paymentmethod" no core. */
const SELETOR_METODO = ".paymentmethods .paymentmethod";
/** Botão Validar — `.next` desempata do Voltar, que TAMBÉM é .validation-button. */
const SELETOR_VALIDAR = ".payment-screen .validation-button.next";
/** Atributo pintado pelo CSS (static/src/css/atalhos_pagamento_setas.css). */
const ATRIBUTO = "data-atalho-destacado";

/** Botões de método, na ordem em que aparecem na tela. */
function metodos() {
    return [...document.querySelectorAll(SELETOR_METODO)];
}

/**
 * Itens navegáveis, na ordem visual: métodos (topo) e o Validar no fim.
 * @returns {HTMLElement[]}
 */
export function itensNavegaveis() {
    return [...metodos(), ...document.querySelectorAll(SELETOR_VALIDAR)];
}

/** Tira o destaque de todos os itens (nenhum item destacado). */
export function limparDestaque() {
    for (const item of document.querySelectorAll(`[${ATRIBUTO}]`)) {
        item.removeAttribute(ATRIBUTO);
    }
}

/**
 * Move o destaque `passo` posições. NÃO cicla: para nas pontas — quem desce
 * chega em Validar e para lá (um passo a mais não pode pular de volta pro
 * primeiro método e adicionar uma linha que o operador não pediu).
 *
 * Sem destaque nenhum, a seta já entra: ↓ pega o primeiro item; ↑ pega o último
 * MÉTODO (nunca o Validar — entrar nele sem querer e dar Enter fecharia a venda
 * sem o operador ter descido até ele).
 *
 * @param {import("@point_of_sale/app/screens/payment_screen/payment_screen").PaymentScreen} tela
 * @param {number} passo +1 = ↓ (desce), -1 = ↑ (sobe)
 */
export function moverDestaque(tela, passo) {
    const itens = itensNavegaveis();
    if (!itens.length) {
        return;
    }
    // Valor digitado ainda pendente no buffer (barcode atrasa o handler ~150ms)
    // vai para a linha ATUAL antes de o operador trocar de alvo — senão o
    // dígito seria aplicado no método errado depois.
    tela.numberBuffer?.capture();
    const atual = itens.findIndex((item) => item.hasAttribute(ATRIBUTO));
    let proximo;
    if (atual < 0) {
        proximo = passo > 0 ? 0 : Math.max(metodos().length - 1, 0);
    } else {
        proximo = Math.min(Math.max(atual + passo, 0), itens.length - 1);
    }
    itens.forEach((item, indice) => {
        if (indice === proximo) {
            item.setAttribute(ATRIBUTO, "");
            // A lista de métodos rola dentro de .paymentmethods-container (CSS
            // deste módulo: flex 1 + overflow-y auto). Sem trazer o item para a
            // área visível, descer até o 5º método destacaria algo fora da tela
            // e o operador daria Enter no escuro. `block: "nearest"` só rola o
            // necessário e não mexe na página quando o item já está visível.
            item.scrollIntoView({ block: "nearest" });
        } else {
            item.removeAttribute(ATRIBUTO);
        }
    });
}

/**
 * Enter: aciona o item destacado (mesmo handler do clique nele).
 *
 * O destaque NÃO é consumido de propósito: manter a posição deixa o operador
 * descer direto para o Validar (↓ continua de onde parou) e repetir o mesmo
 * método num pagamento dividido.
 *
 * @returns {boolean} true quando havia item destacado e o Enter foi tratado.
 */
export function acionarDestacado() {
    const item = document.querySelector(`[${ATRIBUTO}]`);
    if (!item) {
        return false;
    }
    item.click();
    return true;
}
