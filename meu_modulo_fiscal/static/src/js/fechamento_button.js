/** @odoo-module */
import { ClosePosPopup } from "@point_of_sale/app/navbar/closing_popup/closing_popup";
import { patch } from "@web/core/utils/patch";
import { renderToElement } from "@web/core/utils/render";
import { _t } from "@web/core/l10n/translation";

patch(ClosePosPopup.prototype, {
    async showFechamento() {
        console.log("[FECHAMENTO] Coletando dados do fechamento...");

        try {
            // 1. RPC: pega os dados do backend
            const dados = await this.env.services.orm.call(
                "pos.session",
                "get_fechamento_data",
                [[this.pos.session.id]]
            );
            console.log("[FECHAMENTO] Dados recebidos:", dados);

            // 2. Renderiza o template XML num elemento DOM
            const report = renderToElement("meu_modulo.FechamentoReceipt", {
                data: dados,
                formatCurrency: this.env.utils.formatCurrency,
            });

            // 3. Tenta impressora térmica; se não tiver, fallback pra window.print
            const printer = this.hardwareProxy.printer;
            if (printer) {
                const { successful, message } = await printer.printReceipt(report);
                if (!successful) {
                    console.warn("[FECHAMENTO] Impressora falhou, usando window.print");
                    this._printFallback(report);
                }
            } else {
                console.log("[FECHAMENTO] Sem impressora, usando window.print");
                this._printFallback(report);
            }
        } catch (error) {
            console.error("[FECHAMENTO] Erro:", error);
        }
    },

    _printFallback(el) {
        // Abre uma janela nova com o conteúdo e dispara o print do browser
        const win = window.open('', '_blank', 'width=400,height=600');
        if (!win) {
            console.error("[FECHAMENTO] Popup bloqueado pelo browser");
            return;
        }
        win.document.write(`
            <html>
            <head>
                <title>Fechamento de Caixa</title>
                <style>
                    body { font-family: 'Inconsolata', monospace; font-size: 12px; margin: 10px; }
                    @media print { body { margin: 0; } }
                </style>
            </head>
            <body>${el.outerHTML}</body>
            </html>
        `);
        win.document.close();
        win.focus();
        setTimeout(() => {
            win.print();
            win.close();
        }, 250);
    },
});