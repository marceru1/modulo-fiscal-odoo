/** @odoo-module */
import { SelectionPopup } from "@point_of_sale/app/utils/input_popups/selection_popup";
import { Dialog } from "@web/core/dialog/dialog";

/**
 * SelectionPopup com um RODAPÉ de total (feature recebimento-total-faturas).
 *
 * SUBCLASSE, não patch — mesma razão da ConfirmSalePopup (confirm_sale_popup.js):
 * patchar o SelectionPopup do core mudaria TODOS os popups de seleção do
 * sistema (troca de lista de preço, lote/serial, diário...). A subclasse herda
 * props/estado/selectItem() do core (selection_popup.js:33-47) e só acrescenta
 * o footer com o total.
 *
 * O total vem do BACKEND (pos.session.faturas_aberto_data, soma em Python) —
 * este popup só exibe; nada de somar no cliente.
 */
export class SelectionPopupComTotal extends SelectionPopup {
    static template = "meu_modulo_fiscal.SelectionPopupComTotal";
    static components = { ...SelectionPopup.components, Dialog };
    static props = {
        ...SelectionPopup.props,
        totalLabel: { type: String, optional: true },
    };
}