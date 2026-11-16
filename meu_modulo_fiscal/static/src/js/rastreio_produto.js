/** @odoo-module **/
/**
 * rastreio_produto.js — widget do campo `is_storable` no form do produto.
 *
 * Feature rastreio-produto (DEC-002/003/004). Estende o boolean nativo do
 * backend (addons/web/static/src/views/fields/boolean/boolean_field.js) e
 * intercepta SÓ a transição marcado → desmarcado feita pelo usuário:
 *
 *   - pergunta pelo ConfirmationDialog nativo do web client
 *     (@web/core/confirmation_dialog/confirmation_dialog, DEC-002);
 *   - Cancelar (botão, X e ESC — ConfirmationDialog._dismiss cai no cancel)
 *     devolve a checkbox ao estado marcado, inclusive o visual: o toggle
 *     nativo altera o DOM (input.checked) ANTES do handler
 *     (addons/web/static/src/core/checkbox/checkbox.js, onChange), então o
 *     template usa um contador como t-key e remonta o CheckBox;
 *   - Confirmar aplica o valor no record pelo fluxo normal do boolean e segue
 *     a edição do form, sem save automático;
 *   - religar (desmarcado → marcado) e no-op nunca perguntam.
 *
 * Bundle: web.assets_backend (backend web, não POS).
 */
import { BooleanField, booleanField } from "@web/views/fields/boolean/boolean_field";
import { ConfirmationDialog } from "@web/core/confirmation_dialog/confirmation_dialog";
import { _t } from "@web/core/l10n/translation";
import { registry } from "@web/core/registry";

// Copy aprovada no DEC-004. NÃO afirmar que "movimentos deixam de ser
// gerados": no Odoo 18 o movimento continua sendo criado/validado para
// produto não rastreado — só o saldo para de atualizar
// (addons/stock/models/stock_move.py:1778 _should_bypass_reservation).
export const TITULO_DESMARCAR_RASTREIO = _t("Desativar rastreio de estoque?");
export const CORPO_DESMARCAR_RASTREIO = _t(
    'Ao desmarcar "Rastrear inventário", o Odoo deixa de controlar a quantidade em estoque deste produto: o saldo (On Hand) deixa de ser atualizado. Você pode marcar de novo depois, mas o que for vendido ou movimentado enquanto estiver desligado não entra no saldo. Deseja continuar?'
);
export const CONFIRMAR_DESMARCAR_RASTREIO = _t("Desativar rastreio");
export const CANCELAR_DESMARCAR_RASTREIO = _t("Cancelar");

/**
 * Decisão pura do widget (testada em Node, sem Odoo): só confirmar quando o
 * usuário está DESLIGANDO o rastreio de um produto que estava marcado.
 *
 * @param {boolean} valorAtual valor antes do clique
 * @param {boolean} novoValor valor pedido pelo clique
 * @returns {boolean}
 */
export function deveConfirmarDesmarcarRastreio(valorAtual, novoValor) {
    return valorAtual === true && novoValor === false;
}

export class DesmarcarRastreioBooleanField extends BooleanField {
    static template = "meu_modulo_fiscal.DesmarcarRastreioBooleanField";
    static props = { ...BooleanField.props };
    static components = { ...BooleanField.components };

    setup() {
        super.setup();
        // Contador usado como t-key do CheckBox: remontar re-cria o <input>
        // com checked = state.value, desfazendo o toggle nativo no cancelar.
        this.state.desmarcarRastreioRemontar = 0;
    }

    /**
     * @override
     * @param {boolean} newValue
     */
    onChange(newValue) {
        if (!deveConfirmarDesmarcarRastreio(this.state.value, newValue)) {
            super.onChange(newValue);
            return;
        }
        this.env.services.dialog.add(ConfirmationDialog, {
            title: TITULO_DESMARCAR_RASTREIO,
            body: CORPO_DESMARCAR_RASTREIO,
            confirmLabel: CONFIRMAR_DESMARCAR_RASTREIO,
            cancelLabel: CANCELAR_DESMARCAR_RASTREIO,
            confirm: () => super.onChange(newValue),
            cancel: () => {
                this.state.desmarcarRastreioRemontar += 1;
            },
        });
    }
}

export const desmarcarRastreioBooleanField = {
    ...booleanField,
    component: DesmarcarRastreioBooleanField,
};

registry.category("fields").add("desmarcar_rastreio_confirmacao", desmarcarRastreioBooleanField);
