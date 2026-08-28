/** @odoo-module */
/**
 * picking_print_helper.js
 *
 * Intercepta a impressão do delivery slip (stock.action_report_delivery /
 * stock.report_deliveryslip) e abre o print dialog do navegador em vez de
 * baixar o PDF.
 *
 * Escopo (D2): apenas pickings internal/incoming. Outgoing continua com
 * download normal (T3).
 *
 * Bundle: web.assets_backend (NÃO POS).
 *
 * NÃO modifica:
 *   - receipt_print_helper.js (impressão térmica 72mm do POS)
 *   - print_fix.js (retry/cloneNode do POS)
 *
 * API real (T01 — source-driven-development, verificado em
 * addons/web/static/src/webclient/actions/action_service.js do Odoo 18):
 *   - `_executeReportAction` é uma CLOSURE dentro de makeActionManager, NÃO
 *     um método de prototype — `patch(ActionService.prototype, ...)` não
 *     funciona (não existe classe ActionService exportada).
 *   - O ponto de extensão oficial é o registry "ir.actions.report handlers"
 *     (action_service.js:1294): handler recebe (action, options, env) e, se
 *     retornar truthy, o download default é pulado.
 *   - `report_name` do delivery slip é "stock.report_deliveryslip" (o model
 *     é "stock.picking" — a spec original assumia report_name == model).
 *   - URL do PDF: getReportUrl(action, "pdf", ...) →
 *     /report/pdf/stock.report_deliveryslip/<ids>.
 */
import { registry } from "@web/core/registry";
import { getReportUrl } from "@web/webclient/actions/reports/utils";

const DELIVERY_SLIP_REPORT_NAME = "stock.report_deliveryslip";
const PRINT_TYPES = new Set(["internal", "incoming"]);

registry.category("ir.actions.report handlers").add(
    "meu_modulo_fiscal.picking_print",
    async (action, options, env) => {
        if (
            action.report_name !== DELIVERY_SLIP_REPORT_NAME ||
            action.report_type !== "qweb-pdf"
        ) {
            return; // não é o delivery slip — cai no handler default
        }
        const ids = action.context?.active_ids || [];
        if (!ids.length) {
            return; // sem registros — cai no handler default
        }
        // D2: só intercepta internal/incoming. RPC para ler picking_type_code.
        let records;
        try {
            records = await env.services.orm.read(
                "stock.picking",
                ids,
                ["picking_type_code"]
            );
        } catch (_) {
            // offline/erro de RPC — cai no handler default (download)
            return;
        }
        if (
            !records.length ||
            !records.every((r) => PRINT_TYPES.has(r.picking_type_code))
        ) {
            return; // outgoing ou misto — cai no handler default
        }
        return _openPickingPrintDialog(action, env);
    }
);

/**
 * Abre o PDF do picking em nova aba e dispara window.print().
 * Fallback (D4/F3): notificação Odoo se popup for bloqueado.
 *
 * @param {object} action - action ir.actions.report
 * @param {object} env - ambiente Odoo OWL (env.services.notification, env._t)
 * @returns {true} sempre true — o download default é pulado
 */
async function _openPickingPrintDialog(action, env) {
    const url = getReportUrl(action, "pdf", env.services.user.context);
    const win = window.open(url, "_blank");
    if (!win) {
        env.services.notification.add(
            env._t(
                "Popup bloqueado. Libere popups ou imprima após restaurar conexão."
            ),
            { type: "warning", sticky: false }
        );
        return true;
    }
    win.onload = () => {
        try {
            win.print();
        } catch (_) {
            // silencioso — browser pode bloquear win.print() em cross-origin
        }
    };
    return true;
}
