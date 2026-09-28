/** @odoo-module */
import { PaymentScreen } from "@point_of_sale/app/screens/payment_screen/payment_screen";
import { patch } from "@web/core/utils/patch";
import { useHotkey } from "@web/core/hotkeys/hotkey_hook";

/**
 * Atalhos de teclado da PaymentScreen (feature atalhos-teclado-pdv).
 *
 * O operador fecha a venda sem mouse: letra do método -> Enter -> popup.
 *
 * Por que tudo passa pelo hotkey service do core (e nenhum listener próprio):
 * o serviço já resolve, sem código nosso, os três casos que a spec pedia:
 *   1. popup aberto -> NÃO dispara. O Dialog vira o ui.activeElement
 *      (dialog.js:73 useActiveElement -> ui_service.js:69 activateElement) e o
 *      dispatch filtra por activeElement (hotkey_service.js:242).
 *   2. input focado -> NÃO dispara. Proteção de editável em
 *      hotkey_service.js:181-186 (não passamos bypassEditableProtection), então
 *      digitar na busca de cliente continua digitando.
 *   3. só dispara tecla autorizada, e o serviço já faz preventDefault +
 *      stopImmediatePropagation do que tratou (hotkey_service.js:196-203).
 *
 * O que o serviço NÃO faz: F-keys. Ver TECLA_ACRESCIMO abaixo.
 */

/** Letras dos métodos de pagamento, na ordem de render da tela. */
export const LETRAS_METODO = ["a", "b", "c", "d", "e"];

/**
 * Acréscimo e Desconto — letras, NÃO F2/F3.
 *
 * O hotkey service do Odoo 18 não roteia F-keys: AUTHORIZED_KEYS só tem
 * alfabeto/dígitos, NAV_KEYS e escape (hotkey_service.js:33-50); registrar
 * "f2" LANÇA erro (hotkey_service.js:411-415) — e como isso acontece dentro de
 * setup(), derrubaria a PaymentScreen inteira, não só o atalho. Um data-hotkey
 * ="f2" também morreria no early return da linha 175. Daí "s" (Soma) e
 * "r" (Redução).
 *
 * "r" e não "d": "d" já é a letra do 4º método de pagamento (A,B,C,D,E) e o
 * dispatch entregaria a tecla a um dos dois só — ambiguidade silenciosa.
 */
export const TECLA_ACRESCIMO = "s";
export const TECLA_DESCONTO = "r";

/** Enter = Validar. */
export const TECLA_VALIDAR = "enter";

/**
 * Letra do método na posição `indice` da ordem de render.
 * Método 6+ não tem atalho (limitação registrada na spec).
 *
 * @param {number} indice
 * @returns {string|null}
 */
export function letraDoMetodo(indice) {
    if (!Number.isInteger(indice) || indice < 0 || indice >= LETRAS_METODO.length) {
        return null;
    }
    return LETRAS_METODO[indice];
}

patch(PaymentScreen.prototype, {
    setup() {
        super.setup();
        this._registrarAtalhosPagamento();
    },

    /**
     * Registra os atalhos. As letras seguem a ordem de render
     * (payment_methods_from_config, já ordenado por sequence no core) — a mesma
     * lista que o template itera, então o badge e a tecla nunca divergem.
     */
    _registrarAtalhosPagamento() {
        this._registrarLetrasMetodo();

        useHotkey(TECLA_VALIDAR, () => this._validarComEnter());

        // Handlers dos patches de acréscimo/desconto — zero lógica nova aqui.
        useHotkey(TECLA_ACRESCIMO, () => this.clickAcrescimoButton());
        useHotkey(TECLA_DESCONTO, () => this.clickDescontoButton());
    },

    /**
     * Registra as letras A–E para os métodos de pagamento na ordem de render.
     * Método 6+ fica sem atalho (limitação documentada na spec).
     */
    _registrarLetrasMetodo() {
        this.payment_methods_from_config.forEach((metodo, indice) => {
            const letra = letraDoMetodo(indice);
            if (letra) {
                // Mesmo handler do clique no botão do método.
                useHotkey(letra, () => this.addNewPaymentLine(metodo));
            }
        });
    },

    /**
     * DEC-003: com uma linha de pagamento selecionada o Enter pertence ao
     * NumberBuffer (edição de valor) — o atalho não intercepta, senão validaria
     * a venda no meio da digitação.
     */
    _validarComEnter() {
        if (this.selectedPaymentLine) {
            return;
        }
        // Espelha o botão Validar (o core trata o caso não-validável).
        this.validateOrder();
    },

    /**
     * Letra exibida no badge do botão do método. Vazio para método sem atalho
     * (o t-if do template esconde o badge).
     *
     * @param {number} indice
     * @returns {string}
     */
    letraAtalhoMetodo(indice) {
        const letra = letraDoMetodo(indice);
        return letra ? letra.toUpperCase() : "";
    },
});
