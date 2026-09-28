/** @odoo-module */
import { SelectionPopup } from "@point_of_sale/app/utils/input_popups/selection_popup";
import { useHotkey } from "@web/core/hotkeys/hotkey_hook";

/**
 * Popup "Deseja confirmar a venda?" operável só pelo teclado
 * (feature atalhos-teclado-pdv, ticket 02 / DEC-006).
 *
 * Enter = Sim (emite NFC-e) · Esc = Não (venda não-fiscal).
 *
 * SUBCLASSE, não patch: um `patch(SelectionPopup.prototype, ...)` registraria o
 * Enter em TODOS os popups de seleção do Odoo (troca de lista de preço, lote/
 * serial, diário...) — é exatamente o que a DEC-006 proíbe. A subclasse herda
 * props, estado e o selectItem() do core (selection_popup.js:33-47) e só
 * acrescenta as teclas.
 */

/** id do item "Sim" — o confirm_popup.js monta a lista com estas constantes. */
export const ID_SIM = 1;
/** id do item "Não". */
export const ID_NAO = 0;

export class ConfirmSalePopup extends SelectionPopup {
    static template = "meu_modulo_fiscal.ConfirmSalePopup";

    setup() {
        super.setup();
        useHotkey("enter", () => this.confirmarComEnter());
        // Ver a nota abaixo: esta registration é a que ganha o Esc do Dialog.
        useHotkey("escape", () => this.selectItem(ID_NAO));
    }

    /**
     * Enter = Sim. Passa pelo selectItem() do core de propósito: reaproveita o
     * computePayload() (selection_popup.js:40-43) — o payload sai da mesma conta
     * que o clique no botão faz, zero duplicação.
     *
     * Sem guard de reentrância: o makeAwaitable resolve uma Promise
     * (make_awaitable_dialog.js:8-16), e resolve() depois do primeiro é no-op —
     * então "a primeira tecla vence" já é o comportamento, sem flag nenhuma.
     */
    confirmarComEnter() {
        this.selectItem(ID_SIM);
    }
}

/**
 * Por que o Esc daqui NÃO é código morto, apesar de o Dialog do webcore
 * registrar o próprio Esc (dialog.js:75 -> onEscape -> dismiss, dialog.js:135-137):
 *
 *  1. as duas registrations CASAM no dispatch — ambas capturam
 *     activeElement === o modal (a do Dialog porque useActiveElement o ativa,
 *     ui_service.js:69; a nossa porque o registerHotkey espera um microtask e lê
 *     o ui.activeElement já final, hotkey_service.js:440-441) e o filtro é
 *     `reg.activeElement === activeElement` (hotkey_service.js:242);
 *  2. o dispatch itera da registration MAIS NOVA para a mais antiga
 *     (hotkey_service.js:232) e o primeiro candidato vence;
 *  3. o Owl chama os onMounted de baixo para cima: os hooks são empilhados em
 *     fiber.root.mounted na ordem pai-depois-filho (owl.js:2444) e consumidos
 *     com pop() (owl.js:1828), LIFO. Ou seja, o Dialog — filho — registra ANTES
 *     deste componente, é mais antigo e perde o desempate.
 *
 * Sem esta registration, o Esc cairia em Dialog.dismiss() -> onClose ->
 * resolve() -> undefined. O confirm_popup.js trata undefined como não-fiscal
 * (linhas 127-131), então o RESULTADO seria o mesmo — mas o payload passaria a
 * mentir sobre a intenção do operador, e o log diria "fechado (ESC/clique fora)"
 * em vez de "operador recusou". O Esc explícito custa 1 linha e mantém a
 * distinção que a DEC-006 pediu.
 */
