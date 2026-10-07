/** @odoo-module */
/**
 * picking_print_helper.js
 *
 * Intercepta a impressão do delivery slip (stock.action_report_delivery /
 * stock.report_deliveryslip) e abre o print dialog do navegador em vez de
 * baixar o PDF.
 *
 * Escopo (pedido do Marcelo, 2026-10-07): TODOS os pickings — o operador não
 * quer download, quer o dialog de imprimir do navegador. (Antes: só
 * internal/incoming; outgoing caía no download default do core, que usa
 * /report/download com Content-Disposition: attachment — report.py:138 —
 * e salvava o PDF.)
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
 *   - Contexto do usuário: o core importa o singleton `user` de
 *     "@web/core/user" (action_service.js:8) — `env.services.user` NÃO
 *     existe no Odoo 18 (fix 2026-09-25: TypeError reading 'context').
 *   - Tradução: `_t` vem de "@web/core/l10n/translation" — `env._t` também
 *     não existe no 18 (só em helper legado de teste).
 */
import { registry } from "@web/core/registry";
import { getReportUrl } from "@web/webclient/actions/reports/utils";
import { user } from "@web/core/user";
import { _t } from "@web/core/l10n/translation";

const DELIVERY_SLIP_REPORT_NAME = "stock.report_deliveryslip";

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
            // Sem picking salvo: nosso handler pula (não há o que imprimir).
            // Se o core seguir com o download default sem docids (ex.: URL
            // /odoo/action-308/new), ele mesmo estoura lxml ParserError
            // "Document is empty" — bug do core, fora do nosso escopo.
            return;
        }
        // RPC para checar que os registros ainda existem (o core estouraria
        // ParserError num id órfão). O tipo (internal/incoming/outgoing) NÃO
        // decide mais: o operador pediu o dialog em todos os casos.
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
        if (!records.length) {
            return; // ids órfãos — cai no handler default
        }
        return _openPickingPrintDialog(action, env);
    }
);

/**
 * Abre o dialog de imprimir do navegador com o relatório do picking.
 *
 * IMPORTANTE (bug encontrado em 07/10/2026): NÃO abrir o PDF direto. O
 * Chrome renderiza o PDF no VISOR embutido dele, que NÃO é scriptável —
 * `win.onload` não dispara e `win.print()` nunca roda: fica só a aba com
 * o PDF e nenhum dialog (o sintoma que o Marcelo viu).
 *
 * Caminho que funciona (mesma técnica do printFallback dos comprovantes
 * térmicos, que imprime certo na loja): popup about:blank herda a origem
 * da janela, busca o HTML do relatório na rota /report/html/ (mesmo
 * template, o core suporta converter=html para qualquer qweb-pdf), injeta
 * na janela e chama win.print() — documento HTML normal, dialog abre.
 * O PDF fica só como fallback se a rota HTML falhar.
 *
 * @param {object} action - action ir.actions.report
 * @param {object} env - ambiente Odoo OWL (env.services.notification)
 * @returns {true} sempre true — o download default é pulado
 */
async function _openPickingPrintDialog(action, env) {
    const ids = action.context?.active_ids || [];
    const contexto = encodeURIComponent(JSON.stringify(user.context || {}));
    const urlHtml = `/report/html/${action.report_name}/${ids.join(",")}?context=${contexto}`;
    const urlPdf = getReportUrl(action, "pdf", user.context);

    const win = window.open("", "_blank");
    if (!win) {
        env.services.notification.add(
            _t(
                "Popup bloqueado. Libere popups ou imprima após restaurar conexão."
            ),
            { type: "warning", sticky: false }
        );
        return true;
    }
    try {
        const html = await fetch(urlHtml, { credentials: "same-origin" }).then(
            (r) => {
                if (!r.ok) {
                    throw new Error(`/report/html respondeu ${r.status}`);
                }
                return r.text();
            }
        );
        win.document.open();
        win.document.write(html);
        win.document.close();

        // Espera a fonte/estilos carregarem (mesma regra do printFallback):
        // imprimir antes disso sai com fonte errada/sem estilo. O load do
        // documento escrito não é confiável em todos os browsers — race de 1,5s.
        const disparar = () => {
            try {
                win.focus();
                win.print();
            } catch (_) {
                // silencioso — browser pode bloquear win.print()
            }
        };
        const fontsReady = win.document.fonts && win.document.fonts.ready;
        if (fontsReady) {
            Promise.race([
                fontsReady,
                new Promise((r) => setTimeout(r, 1500)),
            ]).then(() => setTimeout(disparar, 200));
        } else {
            setTimeout(disparar, 400);
        }
    } catch (_) {
        // HTML falhou (rota indisponível/rede) — comportamento anterior: PDF.
        window.open(urlPdf, "_blank");
    }
    return true;
}