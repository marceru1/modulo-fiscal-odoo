/** @odoo-module */

import { registry } from "@web/core/registry";
import { standardFieldProps } from "@web/views/fields/standard_field_props";
import { Component, useState } from "@odoo/owl";
import { useService } from "@web/core/utils/hooks";

let _qzScriptPromise = null;

/**
 * Carrega o qz-tray.js uma vez (servido pelo próprio Odoo, em
 * /meu_modulo_fiscal/static/lib/qz-tray.js). O QZ Tray é um programa que roda
 * no Windows, na mesma máquina do navegador, e conversa com a impressora USB —
 * o navegador sozinho não alcança a impressora da loja.
 */
function loadQzTray() {
    if (window.qz) {
        return Promise.resolve(window.qz);
    }
    if (!_qzScriptPromise) {
        _qzScriptPromise = new Promise((resolve, reject) => {
            const s = document.createElement("script");
            s.src = "/meu_modulo_fiscal/static/lib/qz-tray.js";
            s.onload = () => (window.qz ? resolve(window.qz) : reject(new Error("qz-tray.js carregou mas não expôs qz")));
            s.onerror = () => reject(new Error("não foi possível baixar o qz-tray.js do Odoo"));
            document.head.appendChild(s);
        });
    }
    return _qzScriptPromise;
}

/**
 * Imprime a etiqueta direto na impressora, pelo QZ Tray.
 *
 * O modo `pixel` é o que funciona nesta impressora: o modo `raw + pdf + ZPL`
 * reporta sucesso e não imprime nada. A rotação (180) e o tamanho da página
 * vêm do servidor, porque são a mesma decisão do layout da etiqueta.
 */
export class XQzPrintField extends Component {
    static template = "meu_modulo_fiscal.XQzPrintField";
    static props = { ...standardFieldProps };

    setup() {
        this.notification = useService("notification");
        this.state = useState({ printer: "", busy: false, status: "" });
    }

    get wizard() {
        return this.props.record;
    }

    /** Assina o QZ Tray sem certificado (a sessão é local). */
    async _connect(qz) {
        qz.security.setPromise(() => Promise.resolve(null));
        if (!qz.websocket.isActive()) {
            await qz.websocket.connect();
        }
    }

    async _findPrinter(qz) {
        // Atenção: uma máquina da loja tem "ELGIN i9(USB)" E "ELGIN L42PRO FULL".
        // Casar /elgin/ pega a errada — o modelo L42 tem prioridade.
        const printers = await qz.printers.find();
        return printers.find((n) => /l42/i.test(n)) || printers.find((n) => /elgin/i.test(n));
    }

    async onClick() {
        if (this.state.busy) {
            return;
        }
        this.state.busy = true;
        this.state.status = "conectando ao QZ Tray...";
        try {
            const qz = await loadQzTray();
            await this._connect(qz);

            this.state.status = "gerando o PDF...";
            const payload = await this.wizard.model.orm.call(
                this.wizard.resModel,
                "x_get_print_payload",
                [this.wizard.resId],
                { context: this.wizard.context }
            );

            const printer = this.state.printer || (await this._findPrinter(qz));
            if (!printer) {
                throw new Error("Não achei a impressora (ELGIN L42PRO). Ela está ligada e instalada neste PC?");
            }
            this.state.printer = printer;

            this.state.status = `enviando para ${printer}...`;
            const config = qz.configs.create(printer, {
                colorType: "blackwhite",
                units: "mm",
                size: payload.page,
                scaleContent: true,
                rotation: payload.rotation,
            });
            await qz.print(config, [
                { type: "pixel", format: "pdf", flavor: "base64", data: payload.pdf_base64 },
            ]);

            this.state.status = `enviado para ${printer}`;
            this.notification.add(`Etiqueta enviada para ${printer}`, { type: "success" });
        } catch (e) {
            this.state.status = "falhou";
            this.notification.add(
                `Não deu para imprimir direto: ${e.message || e}. ` +
                    "Confira o QZ Tray aberto no PC da impressora, ou use o botão Imprimir (PDF).",
                { type: "danger", sticky: true }
            );
        } finally {
            this.state.busy = false;
        }
    }
}

registry.category("fields").add("x_qz_print", {
    component: XQzPrintField,
    displayName: "Imprimir direto (QZ Tray)",
    supportedTypes: ["boolean"],
});
