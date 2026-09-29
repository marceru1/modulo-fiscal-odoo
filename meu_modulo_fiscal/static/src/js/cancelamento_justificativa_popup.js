/** @odoo-module */
import { Component, onMounted, useRef, useState } from "@odoo/owl";
import { Dialog } from "@web/core/dialog/dialog";
import { useHotkey } from "@web/core/hotkeys/hotkey_hook";

/**
 * Popup de justificativa do cancelamento de cupom (evento 110111 na SEFAZ).
 *
 * Por que não reusar o TextInputPopup do core (DEC-008, verificado no source):
 * point_of_sale/static/src/app/utils/input_popups/text_input_popup.js tem
 * props `title, buttons, startingValue, placeholder, rows, getPayload, close`
 * — NÃO existe `minLength`. O botão Apply do core fica sempre habilitado, então
 * o operador conseguiria mandar uma justificativa curta pra SEFAZ e tomar
 * rejeição. Daí o componente próprio: o Confirmar só habilita com o mínimo.
 *
 * Sem Enter de propósito: o campo é um <textarea> (Enter = nova linha). Um
 * atalho de Enter cortaria a justificativa no meio da digitação — o operador
 * confirma clicando.
 *
 * Esc aborta sem payload: `close()` sem `getPayload` faz o makeAwaitable
 * resolver `undefined`, e o chamador trata isso como "operador desistiu".
 * (O Dialog do core também registra Esc e resolve undefined — o resultado é o
 * mesmo caminho; registramos aqui pra o comportamento ser do componente.)
 */

/** Mínimo de caracteres da justificativa. Mesmo piso do
 * FocusNfceService::cancelar no middleware — repetido aqui de propósito: o
 * operador precisa ver o bloqueio ANTES de a requisição sair. Exportado para
 * os testes lerem o valor do próprio arquivo (sem número mágico duplicado). */
export const MIN_JUSTIFICATIVA = 15;

export class CancelamentoJustificativaPopup extends Component {
    static template = "meu_modulo_fiscal.CancelamentoJustificativaPopup";
    static components = { Dialog };
    static props = {
        title: String,
        getPayload: Function,
        close: Function,
    };

    setup() {
        this.state = useState({
            inputValue: "",
            confirmado: false,
        });
        this.inputRef = useRef("input");
        onMounted(this.onMounted);

        useHotkey("escape", () => this.cancelar());
    }

    onMounted() {
        // Campo vazio de propósito (não é edição de texto existente): foca
        // direto pra o operador só digitar.
        this.inputRef.el.focus();
    }

    /** Texto sem espaços nas pontas — é o que vale para o mínimo e o que vai
     * pra SEFAZ (justificativa de "               " não é justificativa). */
    get justificativa() {
        return (this.state.inputValue || "").trim();
    }

    get valido() {
        return this.justificativa.length >= MIN_JUSTIFICATIVA;
    }

    get faltam() {
        return Math.max(0, MIN_JUSTIFICATIVA - this.justificativa.length);
    }

    get confirmDisabled() {
        return !this.valido || this.state.confirmado;
    }

    confirmar() {
        if (this.confirmDisabled) {
            return;
        }
        this.state.confirmado = true; // trava duplo-clique / clique repetido
        this.props.getPayload(this.justificativa);
        this.props.close();
    }

    cancelar() {
        // Sem getPayload: o makeAwaitable resolve undefined e o atalho N não
        // dispara nenhuma chamada ao backend.
        this.props.close();
    }
}
